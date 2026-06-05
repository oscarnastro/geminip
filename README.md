# GeminiP – Accessible Proxy for DeepSeek

A web app that acts as a proxy for DeepSeek, designed to be **fully accessible with the JAWS screen reader** and easy to install on a NAS via Docker.

---

## Features

- Accessible chat interface with ARIA live regions, skip link, and focus management
- Full keyboard navigation (Tab, Enter to send, Shift+Enter for a new line)
- "Copy last response" button to copy text to the clipboard
- "New conversation" button to reset the chat
- Conversation memory within the session (context sent to DeepSeek)
- Server-side document text extraction for `.docx`, `.pdf`, `.txt`, and `.csv` attachments
- Simple deployment with Docker / Docker Compose

---

## Requirements

- [Node.js](https://nodejs.org/) version 18 or higher
- [PM2](https://pm2.keymetrics.io/) (process manager — keeps the app alive and restarts it on boot)
- A DeepSeek API key: https://platform.deepseek.com/

---

## NAS Installation

### 1. Check Node.js

Connect to the NAS via SSH and verify that Node.js is installed:

```bash
node -v   # must be >= 18
npm -v
```

If it is not installed, use your NAS package manager (e.g. Entware/opkg, Synology Package Center, etc.) or install [nvm](https://github.com/nvm-sh/nvm):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
```

### 2. Install PM2 globally

```bash
npm install -g pm2
```

### 3. Copy the files to the NAS

Copy the entire project folder to the NAS (via SSH, rsync, Samba, etc.), then enter the directory:

```bash
cd /path/to/geminip
```

### 4. Configure the API key and model

```bash
cp .env.example .env
nano .env          # enter your DEEPSEEK_API_KEY and, optionally, DEEPSEEK_MODEL
```

In the `.env` file you can choose the DeepSeek model to use via the `DEEPSEEK_MODEL` variable:

```
DEEPSEEK_MODEL=deepseek-chat
```

If not set, `deepseek-chat` will be used as the default with automatic fallback to `deepseek-reasoner` in case of temporary service unavailability or model not available.

Optional retry tuning:

```
DEEPSEEK_MAX_RETRIES_PER_MODEL=2
DEEPSEEK_INITIAL_RETRY_DELAY_MS=1000
```

> Note: attachments with extension `.docx`, `.pdf`, `.txt`, and `.csv` are parsed server-side and sent to DeepSeek as extracted text in the user message. Other file types return a clear Italian error message.

### 5. Install dependencies

```bash
npm install --omit=dev
```

### 6. Start with PM2

```bash
pm2 start ecosystem.config.cjs
```

The app will be available at `http://<NAS-IP>:3000`

### 7. Auto-start on NAS reboot

```bash
pm2 save                  # saves the process list
pm2 startup               # shows the command to run to enable autostart
# run the command suggested by pm2 startup (usually starts with sudo env ...)
```

### Useful PM2 commands

```bash
pm2 status                # app status
pm2 logs geminip          # real-time logs
pm2 restart geminip       # restart
pm2 stop geminip          # stop
pm2 delete geminip        # remove from process manager
```

---

## Quick start (without PM2, for testing only)

```bash
cp .env.example .env
# Edit .env with your API key
npm install
npm start
```

---

## Accessibility notes

The interface has been designed for users who use JAWS or other screen readers:

- **Skip link** "Go to text field" at the top of the page
- The message list has `aria-live="polite"` — JAWS automatically announces each new response
- The status field below the chat (`role="status"`) announces progress (sending, response received, errors)
- All controls are reachable with **Tab** and activatable with **Enter** or **Space**
- To send a message: type in the text field and press **Enter** (Shift+Enter for a new line)
- Clear heading structure: `<h1>` in the header, sections with `aria-label`

---

## Project structure

```
geminip/
├── public/
│   └── index.html          # Accessible frontend
├── server.js               # Express backend (DeepSeek proxy)
├── ecosystem.config.cjs    # PM2 configuration
├── package.json
├── .env.example
└── .gitignore
```

---

## Security

- The API key is never exposed to the browser; all calls to DeepSeek happen server-side
- The app does not store messages on disk
