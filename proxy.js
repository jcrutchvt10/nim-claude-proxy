import express from "express";
import fetch from "node-fetch";
import modelConfig from "./config/models.js";
import { toOpenAI, toClaude, writeClaudeStream } from "./utils/convert.js";

// Validate required environment variables
if (!process.env.NIM_BASE_URL) {
  console.error("❌ Error: NIM_BASE_URL environment variable is not set");
  process.exit(1);
}
if (!process.env.NIM_API_KEY) {
  console.error("❌ Error: NIM_API_KEY environment variable is not set");
  process.exit(1);
}

const NIM_MAX_RETRIES = Number.parseInt(process.env.NIM_MAX_RETRIES || "4", 10);
const NIM_RETRY_BASE_MS = Number.parseInt(process.env.NIM_RETRY_BASE_MS || "700", 10);
const NIM_MODEL_CACHE_TTL_MS = Number.parseInt(process.env.NIM_MODEL_CACHE_TTL_MS || "300000", 10);
const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || "32mb";
const RETRYABLE_FETCH_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED"
]);
const MODEL_SELECTOR_PATTERN = "([A-Za-z0-9._/-]+)";

const app = express();
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

let availableModelsCache = {
  expiresAt: 0,
  models: []
};

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "nim-claude-proxy" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

function parseModelSelector(content) {
  if (typeof content !== "string") return null;

  const trimmed = content.trimStart();
  const slashMatch = trimmed.match(new RegExp(`^\\/nim\\s+${MODEL_SELECTOR_PATTERN}\\b`, "i"));
  if (slashMatch) return slashMatch[1];

  const plainMatch = trimmed.match(new RegExp(`^(?:nim|model)\\s*:?\\s*${MODEL_SELECTOR_PATTERN}\\b`, "i"));
  if (plainMatch) return plainMatch[1];

  const hashMatch = trimmed.match(new RegExp(`^#model\\s*:\\s*${MODEL_SELECTOR_PATTERN}\\b`, "i"));
  if (hashMatch) return hashMatch[1];

  return null;
}

function stripModelSelector(content) {
  if (typeof content !== "string") return content;

  const stripped = content
    .replace(new RegExp(`^\\s*\\/nim\\s+${MODEL_SELECTOR_PATTERN}\\b\\s*\\n?`, "i"), "")
    .replace(new RegExp(`^\\s*(?:nim|model)\\s*:?\\s*${MODEL_SELECTOR_PATTERN}\\b\\s*\\n?`, "i"), "")
    .replace(new RegExp(`^\\s*#model\\s*:\\s*${MODEL_SELECTOR_PATTERN}\\b\\s*\\n?`, "i"), "");

  return stripped.trimStart();
}

function resolveModelFromChat(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "user") continue;

    const parts = Array.isArray(m.content)
      ? m.content.map(c => c?.text || "")
      : [typeof m.content === "string" ? m.content : ""];

    for (const part of parts) {
      const found = parseModelSelector(part);
      if (found) return found;
    }
  }

  return null;
}

function sanitizeMessages(messages = []) {
  return messages.map(m => {
    if (!m || typeof m !== "object") return m;

    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map(c => {
          if (!c || typeof c !== "object") return c;
          if (typeof c.text !== "string") return c;

          return {
            ...c,
            text: stripModelSelector(c.text)
          };
        })
      };
    }

    if (typeof m.content === "string") {
      return {
        ...m,
        content: stripModelSelector(m.content)
      };
    }

    return m;
  });
}

function pickModel(req, messages) {
  const fromChat = resolveModelFromChat(messages);
  if (fromChat) return fromChat;

  const forced = req.headers["x-model"];
  if (typeof forced === "string" && forced.trim().length > 0) return forced.trim();

  const text = JSON.stringify(messages).toLowerCase();

  if (text.includes("debug") || text.includes("code")) return "minimax";
  if (text.length > 12000) return "mixtral";
  if (text.includes("fast") || text.includes("offline")) return "llama";

  return modelConfig.default;
}

function buildNimHeaders() {
  return {
    Authorization: `Bearer ${process.env.NIM_API_KEY}`,
    "Content-Type": "application/json"
  };
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function parseRetryAfterSeconds(value) {
  if (!value) return null;

  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && asNumber >= 0) return asNumber;

  const asDate = Date.parse(value);
  if (Number.isNaN(asDate)) return null;

  const seconds = Math.ceil((asDate - Date.now()) / 1000);
  return seconds > 0 ? seconds : null;
}

function computeBackoffMs(attempt, retryAfterHeader) {
  const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader);
  if (retryAfterSeconds != null) {
    return retryAfterSeconds * 1000;
  }

  const exp = Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * 350);
  return NIM_RETRY_BASE_MS * (2 ** exp) + jitter;
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function isRetryableFetchError(err) {
  return RETRYABLE_FETCH_CODES.has(err?.code);
}

function getDefaultDispatchConfig() {
  return modelConfig.models[modelConfig.default] || Object.values(modelConfig.models)[0] || {
    temperature: 0.3,
    max_tokens: 4096
  };
}

async function requestNIMJson(path, init = {}) {
  let lastError;

  for (let attempt = 1; attempt <= NIM_MAX_RETRIES + 1; attempt += 1) {
    try {
      const res = await fetch(`${process.env.NIM_BASE_URL}${path}`, {
        ...init,
        headers: {
          ...buildNimHeaders(),
          ...(init.headers || {})
        }
      });

      const rawBody = await res.text();
      let data;

      try {
        data = rawBody.length > 0 ? JSON.parse(rawBody) : {};
      } catch {
        if (attempt <= NIM_MAX_RETRIES && isRetryableStatus(res.status)) {
          const delayMs = computeBackoffMs(attempt, res.headers.get("retry-after"));
          console.warn(
            `NIM non-JSON response on attempt ${attempt}/${NIM_MAX_RETRIES + 1}; retrying in ${delayMs}ms`
          );
          await sleep(delayMs);
          continue;
        }

        throw new Error(
          `NIM returned ${res.status} ${res.statusText}: ${rawBody.slice(0, 300)}`
        );
      }

      if (!res.ok) {
        const message = data.error?.message || data.error || rawBody.slice(0, 300);

        if (attempt <= NIM_MAX_RETRIES && isRetryableStatus(res.status)) {
          const delayMs = computeBackoffMs(attempt, res.headers.get("retry-after"));
          console.warn(
            `NIM ${res.status} on attempt ${attempt}/${NIM_MAX_RETRIES + 1}; retrying in ${delayMs}ms`
          );
          await sleep(delayMs);
          continue;
        }

        throw new Error(`NIM returned ${res.status} ${res.statusText}: ${message}`);
      }

      return data;
    } catch (err) {
      if (attempt <= NIM_MAX_RETRIES && isRetryableFetchError(err)) {
        const delayMs = computeBackoffMs(attempt);
        console.warn(
          `NIM network error (${err.code}) on attempt ${attempt}/${NIM_MAX_RETRIES + 1}; retrying in ${delayMs}ms`
        );
        await sleep(delayMs);
        lastError = err;
        continue;
      }

      throw err;
    }
  }

  throw lastError || new Error("NIM request failed after retries");
}

async function getAvailableModels(forceRefresh = false) {
  if (!forceRefresh && availableModelsCache.expiresAt > Date.now()) {
    return availableModelsCache.models;
  }

  const data = await requestNIMJson("/models", { method: "GET" });
  const models = Array.isArray(data.data) ? data.data : [];

  availableModelsCache = {
    expiresAt: Date.now() + NIM_MODEL_CACHE_TTL_MS,
    models
  };

  return models;
}

async function resolveModelConfig(requestedModel) {
  const requested = typeof requestedModel === "string" ? requestedModel.trim() : "";
  const aliasKey = requested.toLowerCase();
  const aliasConfig = modelConfig.models[aliasKey];

  if (aliasConfig) {
    return {
      key: aliasKey,
      model: aliasConfig.model,
      temperature: aliasConfig.temperature,
      max_tokens: aliasConfig.max_tokens
    };
  }

  const availableModels = await getAvailableModels();
  const exactMatch = availableModels.find(model => model?.id === requested);

  if (exactMatch) {
    const defaults = getDefaultDispatchConfig();
    return {
      key: requested,
      model: exactMatch.id,
      temperature: defaults.temperature,
      max_tokens: defaults.max_tokens
    };
  }

  throw new Error(
    `Unknown model '${requested}'. Use /nim/models to list models available to this API key.`
  );
}

async function callNIM(modelKey, messages, system, overrides = {}) {
  const cfg = await resolveModelConfig(modelKey);

  return requestNIMJson("/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: cfg.model,
      messages: toOpenAI(messages, system),
      temperature: overrides.temperature ?? cfg.temperature,
      max_tokens: overrides.max_tokens ?? cfg.max_tokens
    })
  });
}

app.get("/nim/models", async (_req, res) => {
  try {
    const models = await getAvailableModels();
    const aliases = Object.entries(modelConfig.models).map(([alias, cfg]) => ({
      alias,
      model: cfg.model
    }));

    res.json({
      object: "list",
      aliases,
      data: models
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      type: "error",
      error: {
        type: "api_error",
        message: err.message
      }
    });
  }
});

app.get("/v1/models", async (_req, res) => {
  try {
    const models = await getAvailableModels();
    const aliasModels = Object.entries(modelConfig.models).map(([alias, cfg]) => ({
      id: alias,
      object: "model",
      created: 0,
      owned_by: "nim-proxy-alias",
      root: cfg.model,
      parent: null
    }));

    res.json({
      object: "list",
      data: [...aliasModels, ...models]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      type: "error",
      error: {
        type: "api_error",
        message: err.message
      }
    });
  }
});

app.post("/v1/messages", async (req, res) => {
  try {
    const { messages, system, temperature, max_tokens, stream } = req.body;

    const modelKey = pickModel(req, messages);
    const cleanedMessages = sanitizeMessages(messages);
    console.log("Using model:", modelKey);

    const data = await callNIM(modelKey, cleanedMessages, system, {
      temperature,
      max_tokens
    });

    const msg = data.choices?.[0]?.message;
    const claudeMessage = toClaude(msg?.content || "", data.model, data.usage);

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      writeClaudeStream(res, claudeMessage);
      res.end();
      return;
    }

    res.json(claudeMessage);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      type: "error",
      error: {
        type: "api_error",
        message: err.message
      }
    });
  }
});

app.use((err, _req, res, next) => {
  if (err?.type === "entity.too.large") {
    res.status(413).json({
      type: "error",
      error: {
        type: "request_too_large",
        message: `Request body exceeded proxy limit (${REQUEST_BODY_LIMIT}). Reduce context size or raise REQUEST_BODY_LIMIT.`
      }
    });
    return;
  }

  next(err);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Proxy running");
});