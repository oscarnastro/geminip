require("dotenv").config();
const express = require("express");
const multer = require("multer");
const mammoth = require("mammoth");
const { PDFParse } = require("pdf-parse");
const path = require("path");

const app = express();
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
