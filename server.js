require("dotenv").config();
const express = require("express");
const multer = require("multer");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB per file
const MAX_FILES = 5;
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  // Excel
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  // Word
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "video/mp4",
  "video/webm",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: MAX_FILES },
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname);
      err.message = `Tipo di file non supportato: ${file.mimetype}`;
      cb(err);
    }
  },
});

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const DEFAULT_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-lite"];
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES_PER_MODEL = parseNonNegativeInteger(process.env.GEMINI_MAX_RETRIES_PER_MODEL, 2);
const MAX_ATTEMPTS_PER_MODEL = MAX_RETRIES_PER_MODEL + 1;
const INITIAL_RETRY_DELAY_MS = parseNonNegativeInteger(process.env.GEMINI_INITIAL_RETRY_DELAY_MS, 1000);
const MAX_RETRY_DELAY_MS = 8000;

if (!API_KEY) {
  console.error("ERROR: GEMINI_API_KEY is not set. Please configure it in your .env file.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function getErrorStatus(err) {
  return err?.status || err?.statusCode || err?.code || err?.response?.status;
}

function getModelSequence() {
  const configuredModel = process.env.GEMINI_MODEL?.trim();
  if (!configuredModel) {
    return DEFAULT_MODELS;
  }

  return [configuredModel, ...DEFAULT_MODELS.filter((model) => model !== configuredModel)];
}

function isModelNotFoundError(err) {
  const status = getErrorStatus(err);
  const message = String(err?.message || "").toLowerCase();
  return status === 404 || (message.includes("not found") && message.includes("models/"));
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

/**
 * Build Gemini parts for the current user turn.
 * @param {string} message
 * @param {Express.Multer.File[]} files
 * @returns {Array}
 */
function buildMessageParts(message, files) {
  const parts = [];
  if (message && message.trim()) {
    parts.push({ text: message.trim() });
  }
  for (const file of files) {
    parts.push({
      inlineData: {
        mimeType: file.mimetype,
        data: file.buffer.toString("base64"),
      },
    });
  }
  return parts;
}

async function generateResponse({ history, message, files = [] }) {
  const modelsToTry = getModelSequence();
  let lastError;

  for (const modelName of modelsToTry) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const chat = model.startChat({
          history: history.map((turn) => ({
            role: turn.role,
            parts: [{ text: turn.parts }],
          })),
        });

        const messageParts = buildMessageParts(message, files);
        const result = await chat.sendMessage(messageParts);
        return result.response.text();
      } catch (err) {
        lastError = err;
        const status = getErrorStatus(err);

        if (isModelNotFoundError(err)) {
          console.warn(`Gemini model not available: ${modelName}. Trying next fallback model.`);
          break;
        }

        if (!isTransientError(err)) {
          throw err;
        }

        if (attempt < MAX_RETRIES_PER_MODEL) {
          const delay = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
          console.warn(
            `Transient Gemini error (status: ${status || "unknown"}) on model ${modelName}. Retry ${
              attempt + 1
            }/${MAX_RETRIES_PER_MODEL} in ${delay}ms.`
          );
          await wait(delay);
          continue;
        }

        console.warn(`Transient Gemini error persisted on model ${modelName}. Trying next fallback model.`);
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
    history = req.body.history ? JSON.parse(req.body.history) : [];
  } catch {
    return res.status(400).json({ error: "Campo 'history' non è un JSON valido." });
  }

  message = req.body.message || "";
  const files = req.files || [];

  if ((!message || message.trim() === "") && files.length === 0) {
    return res.status(400).json({ error: "Il messaggio non può essere vuoto." });
  }

  try {
    const text = await generateResponse({ history, message, files });
    res.json({ response: text });
  } catch (err) {
    console.error("Gemini API error:", err.message || err);
    const status = err.status || 500;
    res.status(status).json({ error: "Errore nella comunicazione con Gemini. Riprova." });
  }
});

app.listen(PORT, () => {
  console.log(`GeminiP avviato su http://localhost:${PORT}`);
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
