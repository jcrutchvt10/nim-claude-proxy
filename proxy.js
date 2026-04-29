import express from "express";
import fetch from "node-fetch";
import modelConfig from "./config/models.js";
import { toOpenAI, toOpenAITools, toOpenAIToolChoice, toClaude, writeClaudeStream } from "./utils/convert.js";

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
const NIM_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.NIM_REQUEST_TIMEOUT_MS || "30000", 10);
const NIM_DEGRADED_MODEL_TTL_MS = Number.parseInt(process.env.NIM_DEGRADED_MODEL_TTL_MS || "300000", 10);
const NIM_MINIMAX_TIMEOUT_MS = Number.parseInt(process.env.NIM_MINIMAX_TIMEOUT_MS || "8000", 10);
const NIM_MINIMAX_MAX_RETRIES = Number.parseInt(process.env.NIM_MINIMAX_MAX_RETRIES || "1", 10);
const NIM_MIN_OUTPUT_TOKENS = Number.parseInt(process.env.NIM_MIN_OUTPUT_TOKENS || "256", 10);
const NIM_ROUTE_DEPRIORITIZE_MS = Number.parseInt(process.env.NIM_ROUTE_DEPRIORITIZE_MS || "180000", 10);
const NIM_SLOW_REQUEST_THRESHOLD_MS = Number.parseInt(process.env.NIM_SLOW_REQUEST_THRESHOLD_MS || "12000", 10);
const NIM_TOOL_UNSUPPORTED_TTL_MS = Number.parseInt(process.env.NIM_TOOL_UNSUPPORTED_TTL_MS || "300000", 10);
const RETRYABLE_FETCH_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED"
]);
const MODEL_SELECTOR_PATTERN = "([A-Za-z0-9._/-]+)";
const MODEL_CONTEXT_WINDOWS = {
  "meta/llama-3.1-70b-instruct": 131072,
  "mistralai/mixtral-8x7b-instruct-v0.1": 32768
};

const app = express();
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

let availableModelsCache = {
  expiresAt: 0,
  models: []
};
const degradedModelCache = new Map();
const routeHealthCache = new Map();
const toolUnsupportedCache = new Map();

let requestSequence = 0;

function nextRequestId() {
  requestSequence += 1;
  return `req-${requestSequence}`;
}

function isKnownDegradedNimError(message) {
  if (typeof message !== "string") return false;

  return message.includes("DEGRADED function cannot be invoked");
}

function isKnownToolParserUnavailableError(message) {
  if (typeof message !== "string") return false;

  return (
    message.includes("tool choice requires --enable-auto-tool-choice")
    || message.includes("--tool-call-parser")
  );
}

function rememberToolUnsupportedModel(modelId, message) {
  toolUnsupportedCache.set(modelId, {
    expiresAt: Date.now() + NIM_TOOL_UNSUPPORTED_TTL_MS,
    message
  });
}

function getToolUnsupportedModelMessage(modelId) {
  const cached = toolUnsupportedCache.get(modelId);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    toolUnsupportedCache.delete(modelId);
    return null;
  }

  return cached.message;
}

function rememberDegradedModel(modelId, message) {
  degradedModelCache.set(modelId, {
    expiresAt: Date.now() + NIM_DEGRADED_MODEL_TTL_MS,
    message
  });
}

function getDegradedModelMessage(modelId) {
  const cached = degradedModelCache.get(modelId);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    degradedModelCache.delete(modelId);
    return null;
  }

  return cached.message;
}

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

function shouldRouteToAlternateModel(err) {
  const message = err?.message || "";
  return (
    err?.name === "AbortError"
    || isRetryableFetchError(err)
    || message.includes("timed out")
    || message.includes("ECONNRESET")
    || isKnownDegradedNimError(message)
    || isKnownToolParserUnavailableError(message)
    || message.includes("does not currently support tool calling")
  );
}

function getRouteHealth(modelId) {
  const cached = routeHealthCache.get(modelId);
  if (!cached) {
    return {
      deprioritizedUntil: 0,
      lastLatencyMs: null
    };
  }

  if (cached.deprioritizedUntil > 0 && cached.deprioritizedUntil <= Date.now()) {
    cached.deprioritizedUntil = 0;
    routeHealthCache.set(modelId, cached);
  }

  return cached;
}

function markRouteSuccess(modelId, latencyMs) {
  const cached = getRouteHealth(modelId);
  routeHealthCache.set(modelId, {
    ...cached,
    lastLatencyMs: latencyMs,
    deprioritizedUntil: latencyMs >= NIM_SLOW_REQUEST_THRESHOLD_MS
      ? Date.now() + NIM_ROUTE_DEPRIORITIZE_MS
      : 0
  });
}

function markRouteFailure(modelId) {
  const cached = getRouteHealth(modelId);
  routeHealthCache.set(modelId, {
    ...cached,
    deprioritizedUntil: Date.now() + NIM_ROUTE_DEPRIORITIZE_MS
  });
}

function getDefaultDispatchConfig() {
  return modelConfig.models[modelConfig.default] || Object.values(modelConfig.models)[0] || {
    temperature: 0.3,
    max_tokens: 4096
  };
}

function estimateInputTokens(messages, system) {
  const serialized = JSON.stringify(toOpenAI(messages, system));
  return Math.max(1, Math.ceil(serialized.length / 4));
}

function clampMaxTokens(modelId, messages, system, requestedMaxTokens, defaultMaxTokens) {
  const resolvedRequested = Number.isFinite(requestedMaxTokens) ? requestedMaxTokens : defaultMaxTokens;
  const contextWindow = MODEL_CONTEXT_WINDOWS[modelId];

  if (!contextWindow) {
    return resolvedRequested;
  }

  const estimatedInputTokens = estimateInputTokens(messages, system);
  const availableOutputTokens = Math.max(NIM_MIN_OUTPUT_TOKENS, contextWindow - estimatedInputTokens);

  return Math.max(1, Math.min(resolvedRequested, defaultMaxTokens, availableOutputTokens));
}

async function requestNIMJson(path, init = {}) {
  let lastError;
  const logLabel = init.logLabel || path;
  const timeoutMs = init.timeoutMs ?? NIM_REQUEST_TIMEOUT_MS;
  const maxRetries = init.maxRetries ?? NIM_MAX_RETRIES;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const res = await fetch(`${process.env.NIM_BASE_URL}${path}`, {
        ...init,
        headers: {
          ...buildNimHeaders(),
          ...(init.headers || {})
        },
        signal: controller.signal
      });

      const rawBody = await res.text();
      let data;

      try {
        data = rawBody.length > 0 ? JSON.parse(rawBody) : {};
      } catch {
        if (attempt <= maxRetries && isRetryableStatus(res.status)) {
          const delayMs = computeBackoffMs(attempt, res.headers.get("retry-after"));
          console.warn(
            `NIM non-JSON response on attempt ${attempt}/${maxRetries + 1}; retrying in ${delayMs}ms`
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

        if (attempt <= maxRetries && isRetryableStatus(res.status)) {
          const delayMs = computeBackoffMs(attempt, res.headers.get("retry-after"));
          console.warn(
            `NIM ${res.status} on attempt ${attempt}/${maxRetries + 1}; retrying in ${delayMs}ms`
          );
          await sleep(delayMs);
          continue;
        }

        throw new Error(`NIM returned ${res.status} ${res.statusText}: ${message}`);
      }

      console.log(`[${logLabel}] NIM ${path} attempt ${attempt} succeeded in ${Date.now() - startedAt}ms`);

      return data;
    } catch (err) {
      if (err.name === "AbortError") {
        const message = `NIM request timed out after ${timeoutMs}ms`;
        if (attempt <= maxRetries) {
          const delayMs = computeBackoffMs(attempt);
          console.warn(
            `NIM request timed out on attempt ${attempt}/${maxRetries + 1}; retrying in ${delayMs}ms`
          );
          await sleep(delayMs);
          lastError = new Error(message);
          continue;
        }
        console.error(`[${logLabel}] NIM ${path} timed out after ${Date.now() - startedAt}ms`);
        throw new Error(message);
      }

      if (attempt <= maxRetries && isRetryableFetchError(err)) {
        const delayMs = computeBackoffMs(attempt);
        console.warn(
          `NIM network error (${err.code}) on attempt ${attempt}/${maxRetries + 1}; retrying in ${delayMs}ms`
        );
        await sleep(delayMs);
        lastError = err;
        continue;
      }

      console.error(`[${logLabel}] NIM ${path} failed after ${Date.now() - startedAt}ms: ${err.message}`);

      throw err;
    } finally {
      clearTimeout(timeoutId);
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

async function resolveRouteConfigs(requestedModel) {
  const requested = typeof requestedModel === "string" ? requestedModel.trim() : "";
  const aliasKey = requested.toLowerCase();
  const aliasConfig = modelConfig.models[aliasKey];

  if (!aliasConfig) {
    return [{ ...(await resolveModelConfig(requested)), routeOrder: 0 }];
  }

  const candidateKeys = [aliasKey, ...(aliasConfig.routeAliases || [])]
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);

  const resolved = [];
  const seenModels = new Set();

  for (let index = 0; index < candidateKeys.length; index += 1) {
    const cfg = await resolveModelConfig(candidateKeys[index]);
    if (seenModels.has(cfg.model)) {
      continue;
    }

    seenModels.add(cfg.model);
    resolved.push({ ...cfg, routeOrder: index });
  }

  return resolved.sort((left, right) => {
    const leftHealth = getRouteHealth(left.model);
    const rightHealth = getRouteHealth(right.model);
    const leftDeprioritized = leftHealth.deprioritizedUntil > Date.now() ? 1 : 0;
    const rightDeprioritized = rightHealth.deprioritizedUntil > Date.now() ? 1 : 0;

    if (leftDeprioritized !== rightDeprioritized) {
      return leftDeprioritized - rightDeprioritized;
    }

    return left.routeOrder - right.routeOrder;
  });
}

async function callNIM(modelKey, messages, system, overrides = {}) {
  const requestId = overrides.requestId || "nim";
  const routeConfigs = await resolveRouteConfigs(modelKey);
  let lastError;

  for (let index = 0; index < routeConfigs.length; index += 1) {
    const cfg = routeConfigs[index];
    const hasTools = Array.isArray(overrides.tools) && overrides.tools.length > 0;
    const toolChoiceType = overrides.tool_choice?.type;

    if (hasTools && toolChoiceType !== "none") {
      const unsupportedMessage = getToolUnsupportedModelMessage(cfg.model);
      if (unsupportedMessage) {
        lastError = new Error(`NIM model '${cfg.model}' has no tool-calling support: ${unsupportedMessage}`);
        markRouteFailure(cfg.model);
        if (index < routeConfigs.length - 1) {
          console.warn(`[${requestId}] Skipping tool-unsupported model ${cfg.model}; trying next route candidate.`);
          continue;
        }
        throw lastError;
      }
    }

    const degradedMessage = getDegradedModelMessage(cfg.model);
    if (degradedMessage) {
      lastError = new Error(`NIM model '${cfg.model}' is temporarily degraded: ${degradedMessage}`);
      markRouteFailure(cfg.model);
      if (index < routeConfigs.length - 1) {
        console.warn(`[${requestId}] Skipping degraded model ${cfg.model}; trying next route candidate.`);
        continue;
      }
      throw lastError;
    }

    const requestMaxTokens = clampMaxTokens(
      cfg.model,
      messages,
      system,
      overrides.max_tokens,
      cfg.max_tokens
    );

    const startedAt = Date.now();
    const mappedToolChoice = toOpenAIToolChoice(overrides.tool_choice);

    const buildRequestBody = (skipTools = false) => ({
      model: cfg.model,
      messages: toOpenAI(messages, system),
      temperature: overrides.temperature ?? cfg.temperature,
      max_tokens: requestMaxTokens,
      ...(!skipTools && hasTools ? { tools: toOpenAITools(overrides.tools) } : {}),
      ...(!skipTools && mappedToolChoice !== undefined ? { tool_choice: mappedToolChoice } : {})
    });

    try {
      let data;

      try {
        data = await requestNIMJson("/chat/completions", {
          method: "POST",
          logLabel: `${requestId} ${cfg.model}`,
          timeoutMs: cfg.model === modelConfig.models.minimax.model ? NIM_MINIMAX_TIMEOUT_MS : undefined,
          maxRetries: cfg.model === modelConfig.models.minimax.model ? NIM_MINIMAX_MAX_RETRIES : undefined,
          body: JSON.stringify(buildRequestBody(false))
        });
      } catch (innerErr) {
        if (
          hasTools
          && isKnownToolParserUnavailableError(innerErr?.message)
          && toolChoiceType === "none"
        ) {
          console.warn(
            `[${requestId}] NIM tool parser unavailable on ${cfg.model}; retrying without tools because tool_choice=none.`
          );

          data = await requestNIMJson("/chat/completions", {
            method: "POST",
            logLabel: `${requestId} ${cfg.model} no-tools-retry`,
            timeoutMs: cfg.model === modelConfig.models.minimax.model ? NIM_MINIMAX_TIMEOUT_MS : undefined,
            maxRetries: cfg.model === modelConfig.models.minimax.model ? NIM_MINIMAX_MAX_RETRIES : undefined,
            body: JSON.stringify(buildRequestBody(true))
          });
        } else if (hasTools && isKnownToolParserUnavailableError(innerErr?.message)) {
          rememberToolUnsupportedModel(cfg.model, innerErr.message);
          markRouteFailure(cfg.model);
          throw new Error(
            `Upstream NIM deployment does not currently support tool calling for this route (${cfg.model}). `
            + "Enable NIM tool parser flags or use a route with tool support."
          );
        } else {
          throw innerErr;
        }
      }

      markRouteSuccess(cfg.model, Date.now() - startedAt);
      return data;
    } catch (err) {
      lastError = err;
      markRouteFailure(cfg.model);

      if (isKnownDegradedNimError(err.message)) {
        rememberDegradedModel(cfg.model, err.message);
        console.error(`[${requestId}] Marked model ${cfg.model} as degraded for ${NIM_DEGRADED_MODEL_TTL_MS}ms`);
      }

      if (index < routeConfigs.length - 1 && shouldRouteToAlternateModel(err)) {
        console.warn(`[${requestId}] Routing away from ${cfg.model} after failure: ${err.message}`);
        continue;
      }

      throw err;
    }
  }

  throw lastError || new Error(`No route candidates available for model '${modelKey}'.`);
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
  const requestId = nextRequestId();
  const requestStartedAt = Date.now();

  try {
    const { messages, system, temperature, max_tokens, stream, tools, tool_choice } = req.body;

    const modelKey = pickModel(req, messages);
    const cleanedMessages = sanitizeMessages(messages);
    console.log(`[${requestId}] /v1/messages started model=${modelKey} stream=${Boolean(stream)} messages=${Array.isArray(messages) ? messages.length : 0}`);

    const data = await callNIM(modelKey, cleanedMessages, system, {
      requestId,
      temperature,
      max_tokens,
      tools,
      tool_choice
    });

    const msg = data.choices?.[0]?.message;
    const finishReason = data.choices?.[0]?.finish_reason;
    const claudeMessage = toClaude(msg || {}, data.model, data.usage, finishReason);

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      writeClaudeStream(res, claudeMessage);
      res.end();
      console.log(`[${requestId}] /v1/messages stream completed in ${Date.now() - requestStartedAt}ms`);
      return;
    }

    res.json(claudeMessage);
    console.log(`[${requestId}] /v1/messages completed in ${Date.now() - requestStartedAt}ms`);
  } catch (err) {
    console.error(`[${requestId}] /v1/messages failed after ${Date.now() - requestStartedAt}ms: ${err.message}`);
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