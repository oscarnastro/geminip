require("dotenv").config();
const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error("ERROR: GEMINI_API_KEY is not set. Please configure it in your .env file.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// POST /api/chat
// Body: { history: [{role, parts}], message: string }
// Returns: { response: string }
app.post("/api/chat", async (req, res) => {
  const { history = [], message } = req.body;

  if (!message || typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "Il messaggio non può essere vuoto." });
  }

  try {
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-1.5-flash" });

    const chat = model.startChat({
      history: history.map((turn) => ({
        role: turn.role,
        parts: [{ text: turn.parts }],
      })),
    });

    const result = await chat.sendMessage(message.trim());
    const text = result.response.text();
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
