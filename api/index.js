const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;

// Алиса ждёт ответ навыка 4,5 секунды. Если Gemini не успевает за QUICK_REPLY_MS,
// навык отвечает «Секунду, думаю», а Gemini дорабатывает в фоне и кладёт ответ в Redis.
const QUICK_REPLY_MS = 3500;
const SERPER_TIMEOUT_MS = 1500;
const GEMINI_TIMEOUT_MS = 20000;
const JOB_TTL_SECONDS = 600;
const JOB_STALE_MS = 45000;

const THINKING_TEXT = "Секунду, думаю. Скажите «ну что», и я отвечу.";
const STILL_THINKING_TEXT = "Ещё думаю. Спросите «ну что» через пару секунд.";

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function isFollowUp(text) {
  const t = String(text || "").toLowerCase().replace(/[?!.,]/g, "").trim();
  return /^(ну|ну что|ну и|и что|ну как|ну давай|дальше|готово|ответ|что там|продолжай|давай|да|говори|скажи|рассказывай|жду)$/.test(t);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

function withTurn(history, question, answer) {
  return [
    ...history,
    { role: "user", text: String(question).slice(0, MAX_HISTORY_MESSAGE_CHARS) },
    { role: "model", text: String(answer).slice(0, MAX_HISTORY_MESSAGE_CHARS) }
  ].slice(-MAX_HISTORY_MESSAGES);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Redis (Upstash REST API, без зависимостей) ----------

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

async function redisCommand(command) {
  const cfg = redisConfig();
  if (!cfg) return null;
  const { response, data } = await fetchJson(
    cfg.url,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command)
    },
    2000
  );
  if (!response.ok) throw new Error(`REDIS_HTTP_${response.status}`);
  return data?.result ?? null;
}

const jobKey = sessionId => `alice:job:${sessionId}`;

async function getJob(sessionId) {
  try {
    const raw = await redisCommand(["GET", jobKey(sessionId)]);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn("Redis read failed:", error?.message);
    return null;
  }
}

async function saveJob(sessionId, job) {
  await redisCommand(["SET", jobKey(sessionId), JSON.stringify(job), "EX", String(JOB_TTL_SECONDS)]);
}

async function deleteJob(sessionId) {
  try {
    await redisCommand(["DEL", jobKey(sessionId)]);
  } catch (error) {
    console.warn("Redis delete failed:", error?.message);
  }
}

// Позволяет функции Vercel доработать после отправки ответа (аналог waitUntil из @vercel/functions).
function getWaitUntil() {
  const ctx = globalThis[Symbol.for("@vercel/request-context")]?.get?.();
  return typeof ctx?.waitUntil === "function" ? ctx.waitUntil.bind(ctx) : null;
}

// ---------- Поиск и Gemini ----------

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 240
        }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error("Gemini request failed with HTTP", status);
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

async function answerQuestion(text, history) {
  let searchContext = "";
  if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
    searchContext = await searchWeb(text, SERPER_TIMEOUT_MS);
  }
  return askGemini(text, history, searchContext, GEMINI_TIMEOUT_MS);
}

function normalizeError(error) {
  const isAbort = error?.name === "AbortError" || error?.message === "AbortError";
  return isAbort ? "TIME_BUDGET_EXHAUSTED" : String(error?.message || "unknown error");
}

function errorForUser(error) {
  const code = typeof error === "string" ? error : error?.message;
  switch (code) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

// ---------- Обработчик запросов Алисы ----------

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      async: Boolean(redisConfig()),
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);
  const sessionId = String(body?.session?.session_id || "");
  const canDefer = Boolean(redisConfig() && sessionId);

  if (body?.session?.new && canDefer) await deleteJob(sessionId);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  // 1. Есть ли недоданный ответ на прошлый вопрос?
  if (canDefer) {
    let job = await getJob(sessionId);
    if (job?.status === "pending" && Date.now() - Number(job.createdAt || 0) > JOB_STALE_MS) {
      await deleteJob(sessionId);
      job = null;
    }
    if (job) {
      while (job?.status === "pending" && elapsed() < QUICK_REPLY_MS - 300) {
        await sleep(400);
        job = await getJob(sessionId);
      }
      if (!job) {
        // ключ исчез (например, истёк) — обрабатываем как новый вопрос ниже
      } else if (job.status === "pending") {
        return res.status(200).json(aliceResponse(STILL_THINKING_TEXT, false, oldHistory));
      } else {
        await deleteJob(sessionId);
        if (job.status === "error") {
          return res.status(200).json(aliceResponse(errorForUser(job.error), false, oldHistory));
        }
        const history = withTurn(oldHistory, job.question, job.answer);
        const tail = isFollowUp(text) || text === job.question
          ? ""
          : " А теперь повторите, пожалуйста, ваш новый вопрос.";
        return res.status(200).json(aliceResponse(job.answer + tail, false, history));
      }
    }
  }

  if (isFollowUp(text) && canDefer) {
    // «ну что» без ожидающего ответа — сюда попадаем, если ответ уже озвучен или потерян
    return res.status(200).json(aliceResponse("Я вас слушаю. Задайте вопрос.", false, oldHistory));
  }

  // 2. Новый вопрос: пробуем ответить сразу, иначе — «думаю» и доработка в фоне.
  const work = answerQuestion(text, oldHistory).then(
    answer => ({ ok: true, answer }),
    error => ({ ok: false, error: normalizeError(error) })
  );
  const quick = await Promise.race([work, sleep(QUICK_REPLY_MS - elapsed()).then(() => null)]);

  if (quick) {
    if (quick.ok) {
      return res.status(200).json(aliceResponse(quick.answer, false, withTurn(oldHistory, text, quick.answer)));
    }
    console.warn("Alice webhook returned a fallback response:", quick.error);
    return res.status(200).json(aliceResponse(errorForUser(quick.error), false, oldHistory));
  }

  const waitUntil = getWaitUntil();
  if (!canDefer || !waitUntil) {
    if (canDefer && !waitUntil) console.warn("waitUntil is not available; cannot finish in background.");
    console.warn("Alice webhook returned a fallback response:", "TIME_BUDGET_EXHAUSTED");
    return res.status(200).json(aliceResponse(errorForUser("TIME_BUDGET_EXHAUSTED"), false, oldHistory));
  }

  try {
    await saveJob(sessionId, { status: "pending", question: text, createdAt: Date.now() });
  } catch (error) {
    console.warn("Redis write failed:", error?.message);
    return res.status(200).json(aliceResponse(errorForUser("TIME_BUDGET_EXHAUSTED"), false, oldHistory));
  }

  waitUntil(work.then(async result => {
    const job = result.ok
      ? { status: "done", question: text, answer: result.answer, createdAt: Date.now() }
      : { status: "error", question: text, error: result.error, createdAt: Date.now() };
    if (!result.ok) console.warn("Background answer failed:", result.error);
    try {
      await saveJob(sessionId, job);
    } catch (error) {
      console.warn("Redis write failed:", error?.message);
    }
  }));

  return res.status(200).json(aliceResponse(THINKING_TEXT, false, oldHistory));
}

export { aliceResponse, fitAliceText, isSearchIntent, isFollowUp, safeHistory };
