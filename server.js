require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const mammoth = require("mammoth");
const { PDFParse } = require("pdf-parse");
const path = require("path");

const app = express();

// Trust the first reverse-proxy hop so req.ip and X-Forwarded-For are correct.
// Must be set before any middleware so every subsequent handler sees the right IP.
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3004;
const API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB per file
const MAX_FILES = 5;
const SUPPORTED_TEXT_FILE_EXTENSIONS = new Set([".docx", ".pdf", ".txt", ".csv"]);

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

// Basic Auth credentials — required at startup
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER;
const BASIC_AUTH_PASSWORD = process.env.BASIC_AUTH_PASSWORD;

// Rate limit configuration
const RATE_LIMIT_WINDOW_MS = parseNonNegativeInteger(process.env.RATE_LIMIT_WINDOW_MS, 60_000);
const RATE_LIMIT_MAX = parseNonNegativeInteger(process.env.RATE_LIMIT_MAX, 200);
const CHAT_RATE_LIMIT_MAX = parseNonNegativeInteger(process.env.CHAT_RATE_LIMIT_MAX, 10);

if (!API_KEY) {
  console.error("ERROR: DEEPSEEK_API_KEY is not set. Please configure it in your .env file.");
  process.exit(1);
}

if (!BASIC_AUTH_USER || !BASIC_AUTH_PASSWORD) {
  console.error(
    "ERROR: BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must both be set. " +
      "The app will not start unprotected. Please configure them in your .env file."
  );
  process.exit(1);
}

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ip: req.ip,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        responseTime: `${Date.now() - start}ms`,
        userAgent: req.headers["user-agent"] || "",
        forwardedFor: req.headers["x-forwarded-for"] || "",
        origin: req.headers["origin"] || "",
        referer: req.headers["referer"] || "",
      })
    );
  });
  next();
});

// Basic Auth middleware — protects the whole app.
// Timing-safe comparison: both inputs are converted to fixed-length HMAC-SHA256
// digests with a per-process random key, so timingSafeEqual always receives
// same-length buffers and no timing information leaks based on input length.
const HMAC_KEY = crypto.randomBytes(32);

function credentialDigest(value) {
  return crypto.createHmac("sha256", HMAC_KEY).update(value, "utf8").digest();
}

// Pre-compute expected digests once at startup (avoids recomputing on every request)
const EXPECTED_USER_DIGEST = credentialDigest(BASIC_AUTH_USER);
const EXPECTED_PASS_DIGEST = credentialDigest(BASIC_AUTH_PASSWORD);

function basicAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="GeminiP - Accessible Proxy"');
    return res.status(401).json({ error: "Authentication required." });
  }

  let submittedUser = "";
  let submittedPass = "";
  try {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const colonIdx = decoded.indexOf(":");
    if (colonIdx < 0) {
      // Malformed credentials: colon separator is required by RFC 7617
      res.setHeader("WWW-Authenticate", 'Basic realm="GeminiP - Accessible Proxy"');
      return res.status(401).json({ error: "Invalid credentials." });
    }
    submittedUser = decoded.slice(0, colonIdx);
    submittedPass = decoded.slice(colonIdx + 1);
  } catch {
    res.setHeader("WWW-Authenticate", 'Basic realm="GeminiP - Accessible Proxy"');
    return res.status(401).json({ error: "Invalid credentials." });
  }

  const userOk = crypto.timingSafeEqual(credentialDigest(submittedUser), EXPECTED_USER_DIGEST);
  const passOk = crypto.timingSafeEqual(credentialDigest(submittedPass), EXPECTED_PASS_DIGEST);
  if (!userOk || !passOk) {
    res.setHeader("WWW-Authenticate", 'Basic realm="GeminiP - Accessible Proxy"');
    return res.status(401).json({ error: "Invalid credentials." });
  }

  next();
}

app.use(basicAuth);

// General rate limiter (all routes)
const generalLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: "Too many requests. Please try again later." });
  },
});
app.use(generalLimiter);

// Stricter rate limiter applied only to POST /api/chat
const chatLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: CHAT_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: "Too many chat requests. Please slow down and try again later." });
  },
});

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
  function getTurnContent(turn) {
    // Support existing frontend history shape ("parts") and DeepSeek-native shape ("content").
    if (typeof turn?.parts === "string") {
      return turn.parts;
    }
    if (typeof turn?.content === "string") {
      return turn.content;
    }
    return "";
  }

  const messages = history
    .map((turn) => {
      const content = getTurnContent(turn);
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

function buildSupportedFileTypesMessage() {
  return "Formati supportati: .docx, .pdf, .txt, .csv.";
}

function getAttachmentLabel(file) {
  return file?.originalname || "file-sconosciuto";
}

function getFileExtension(file) {
  const fileName = file?.originalname || "";
  return path.extname(fileName).toLowerCase();
}

function createAttachmentError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  err.userMessage = message;
  return err;
}

async function extractTextFromFile(file) {
  const extension = getFileExtension(file);
  const attachmentLabel = getAttachmentLabel(file);

  if (!SUPPORTED_TEXT_FILE_EXTENSIONS.has(extension)) {
    throw createAttachmentError(
      `Il file "${attachmentLabel}" non è supportato per l'estrazione testo. ${buildSupportedFileTypesMessage()}`
    );
  }

  try {
    let extractedText = "";

    if (extension === ".docx") {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      extractedText = result?.value || "";
    } else if (extension === ".pdf") {
      const parser = new PDFParse({ data: file.buffer });
      try {
        const result = await parser.getText();
        extractedText = result?.text || "";
      } finally {
        await parser.destroy();
      }
    } else {
      extractedText = file.buffer.toString("utf8");
    }

    if (!extractedText.trim()) {
      throw createAttachmentError(`Il file "${attachmentLabel}" non contiene testo leggibile.`);
    }

    return {
      fileName: attachmentLabel,
      text: extractedText.trim(),
    };
  } catch (err) {
    if (err?.userMessage) {
      throw err;
    }

    throw createAttachmentError(`Impossibile leggere il file "${attachmentLabel}". Verifica che sia un file valido.`);
  }
}

function buildUserMessageWithAttachments(message, extractedAttachments) {
  const sections = [];
  const trimmedMessage = typeof message === "string" ? message.trim() : "";

  if (trimmedMessage) {
    sections.push(`Messaggio utente:\n${trimmedMessage}`);
  }

  for (const attachment of extractedAttachments) {
    sections.push(`Documento allegato: ${attachment.fileName}\nContenuto estratto:\n${attachment.text}`);
  }

  return sections.join("\n\n");
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

  const rawBody = await response.text();
  let data = {};
  if (rawBody) {
    try {
      data = JSON.parse(rawBody);
    } catch (parseErr) {
      console.error("DeepSeek API parse error:", parseErr.message || parseErr);
      const err = new Error("Risposta dal server DeepSeek non valida.");
      err.status = 502;
      throw err;
    }
  }

  if (!response.ok) {
    const err = new Error(data?.error?.message || `DeepSeek API request failed with status ${response.status}.`);
    err.status = response.status;
    throw err;
  }

  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    const apiMessage = data?.error?.message;
    const err = new Error(
      apiMessage ? `Errore DeepSeek: ${apiMessage}` : "Risposta DeepSeek non valida: contenuto mancante o vuoto."
    );
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
app.post("/api/chat", chatLimiter, upload.array("files", MAX_FILES), async (req, res) => {
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

  try {
    let requestMessage = message;

    if (files.length > 0) {
      const extractedAttachments = await Promise.all(files.map((file) => extractTextFromFile(file)));
      requestMessage = buildUserMessageWithAttachments(message, extractedAttachments);
    }

    const text = await generateResponse({ history, message: requestMessage });
    res.json({ response: text });
  } catch (err) {
    console.error("DeepSeek API error:", err.message || err);
    const status = err.status || 500;
    const clientErrorMessage = err.userMessage || "Errore nella comunicazione con DeepSeek. Riprova.";
    res.status(status).json({ error: clientErrorMessage });
  }
});

app.listen(PORT, () => {
  console.log(`DeepSeek proxy avviato su http://localhost:${PORT}`);
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
