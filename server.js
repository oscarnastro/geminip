require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3004;
const API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB per file
const MAX_FILES = 5;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: MAX_FILES },
});

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const DEFAULT_MODELS = ["deepseek-chat", "deepseek-reasoner"];
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES_PER_MODEL = parseNonNegativeInteger(process.env.DEEPSEEK_MAX_RETRIES_PER_MODEL, 2);
const MAX_ATTEMPTS_PER_MODEL = MAX_RETRIES_PER_MODEL + 1;
const INITIAL_RETRY_DELAY_MS = parseNonNegativeInteger(process.env.DEEPSEEK_INITIAL_RETRY_DELAY_MS, 1000);
const MAX_RETRY_DELAY_MS = 8000;

if (!API_KEY) {
  console.error("ERROR: DEEPSEEK_API_KEY is not set. Please configure it in your .env file.");
  process.exit(1);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function getErrorStatus(err) {
  return err?.status || err?.statusCode || err?.code || err?.response?.status;
}

function getModelSequence() {
  const configuredModel = process.env.DEEPSEEK_MODEL?.trim();
  if (!configuredModel) {
    return DEFAULT_MODELS;
  }

  return [configuredModel, ...DEFAULT_MODELS.filter((model) => model !== configuredModel)];
}

function isModelNotFoundError(err) {
  const status = getErrorStatus(err);
  const message = String(err?.message || "").toLowerCase();
  return status === 404 || (message.includes("model") && (message.includes("not found") || message.includes("does not exist")));
}

function isTransientError(err) {
  const status = getErrorStatus(err);
  const message = String(err?.message || "").toLowerCase();

  if (RETRYABLE_STATUS_CODES.has(status)) {
    return true;
  }

  return (
    message.includes("high demand") ||
    message.includes("service unavailable") ||
    message.includes("temporarily unavailable") ||
    message.includes("timed out") ||
    message.includes("timeout")
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHistory(rawHistory) {
  if (!rawHistory) {
    return [];
  }

  const parsedHistory = typeof rawHistory === "string" ? JSON.parse(rawHistory) : rawHistory;
  return Array.isArray(parsedHistory) ? parsedHistory : [];
}

function buildDeepSeekMessages(history, message) {
  const messages = history
    .map((turn) => {
      const content = typeof turn?.parts === "string" ? turn.parts : typeof turn?.content === "string" ? turn.content : "";
      if (!content.trim()) {
        return null;
      }
      return {
        role: turn?.role === "model" || turn?.role === "assistant" ? "assistant" : "user",
        content: content.trim(),
      };
    })
    .filter(Boolean);

  if (message && message.trim()) {
    messages.push({ role: "user", content: message.trim() });
  }

  return messages;
}

async function callDeepSeekChat(modelName, messages) {
  const response = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + API_KEY,
    },
    body: JSON.stringify({
      model: modelName,
      messages,
      stream: false,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `DeepSeek API request failed with status ${response.status}.`);
    err.status = response.status;
    throw err;
  }

  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    const err = new Error("Risposta DeepSeek non valida.");
    err.status = 502;
    throw err;
  }

  return text;
}

async function generateResponse({ history, message }) {
  const modelsToTry = getModelSequence();
  const messages = buildDeepSeekMessages(history, message);
  let lastError;

  for (const modelName of modelsToTry) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        return await callDeepSeekChat(modelName, messages);
      } catch (err) {
        lastError = err;
        const status = getErrorStatus(err);

        if (isModelNotFoundError(err)) {
          console.warn(`DeepSeek model not available: ${modelName}. Trying next fallback model.`);
          break;
        }

        if (!isTransientError(err)) {
          throw err;
        }

        if (attempt < MAX_RETRIES_PER_MODEL) {
          const delay = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
          console.warn(
            `Transient DeepSeek error (status: ${status || "unknown"}) on model ${modelName}. Retry ${
              attempt + 1
            }/${MAX_RETRIES_PER_MODEL} in ${delay}ms.`
          );
          await wait(delay);
          continue;
        }

        console.warn(`Transient DeepSeek error persisted on model ${modelName}. Trying next fallback model.`);
      }
    }
  }

  throw lastError;
}

// POST /api/chat
// Accepts multipart/form-data or application/json.
// Fields: history (JSON string), message (string)
// Files:  files[] (optional, up to MAX_FILES)
// Returns: { response: string }
app.post("/api/chat", upload.array("files", MAX_FILES), async (req, res) => {
  // Support both multipart (req.body from multer) and plain JSON bodies
  let history = [];
  let message = "";

  try {
    history = normalizeHistory(req.body.history);
  } catch {
    return res.status(400).json({ error: "Campo 'history' non è un JSON valido." });
  }

  message = req.body.message || "";
  const files = req.files || [];

  if ((!message || message.trim() === "") && files.length === 0) {
    return res.status(400).json({ error: "Il messaggio non può essere vuoto." });
  }

  if (files.length > 0) {
    return res
      .status(400)
      .json({ error: "Gli allegati non sono ancora supportati nella versione DeepSeek. Invia solo testo." });
  }

  try {
    const text = await generateResponse({ history, message });
    res.json({ response: text });
  } catch (err) {
    console.error("DeepSeek API error:", err.message || err);
    const status = err.status || 500;
    res.status(status).json({ error: "Errore nella comunicazione con DeepSeek. Riprova." });
  }
});

app.listen(PORT, () => {
  console.log(`GeminiP (DeepSeek) avviato su http://localhost:${PORT}`);
});

// Multer error handler (must be 4-argument middleware)
// eslint-disable-next-line no-unused-vars
app.use(function (err, _req, res, _next) {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  console.error("Unhandled error:", err.message || err);
  res.status(500).json({ error: "Errore interno del server." });
});
