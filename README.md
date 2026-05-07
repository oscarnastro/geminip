# GeminiP – Proxy accessibile per Google Gemini

Web app che funge da proxy a Google Gemini, progettata per essere **completamente accessibile con screen reader JAWS** e semplice da installare su un NAS tramite Docker.

---

## Funzionalità

- Interfaccia di chat accessibile con ARIA live regions, skip link, focus management
- Navigazione completa da tastiera (Tab, Invio per inviare, Shift+Invio per andare a capo)
- Bottone "Copia ultima risposta" per copiare il testo negli appunti
- Bottone "Nuova conversazione" per resettare la chat
- Memoria della conversazione nella sessione (contesto inviato a Gemini)
- Deploy semplice con Docker / Docker Compose

---

## Requisiti

- [Node.js](https://nodejs.org/) versione 18 o superiore
- [PM2](https://pm2.keymetrics.io/) (process manager — mantiene l'app attiva e la riavvia al boot)
- Una chiave API di Google Gemini (gratuita): https://aistudio.google.com/app/apikey

---

## Installazione sul NAS

### 1. Verifica Node.js

Connettiti al NAS via SSH e verifica che Node.js sia installato:

```bash
node -v   # deve essere >= 18
npm -v
```

Se non è installato, usa il gestore pacchetti del tuo NAS (es. Entware/opkg, Synology Package Center, ecc.) oppure installa [nvm](https://github.com/nvm-sh/nvm):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
```

### 2. Installa PM2 globalmente

```bash
npm install -g pm2
```

### 3. Copia i file sul NAS

Copia l'intera cartella del progetto sul NAS (via SSH, rsync, Samba, ecc.), poi entra nella directory:

```bash
cd /percorso/geminip
```

### 4. Configura la chiave API e il modello

```bash
cp .env.example .env
nano .env          # inserisci la tua GEMINI_API_KEY e, facoltativamente, GEMINI_MODEL
```

Nel file `.env` puoi scegliere il modello Gemini da usare tramite la variabile `GEMINI_MODEL`:

```
GEMINI_MODEL=gemini-2.5-flash
```

Se non la imposti, verrà usato `gemini-1.5-flash` come default.  
Modelli disponibili: `gemini-1.5-flash`, `gemini-1.5-pro`, `gemini-2.5-flash`, `gemini-2.5-pro` — lista completa su https://ai.google.dev/gemini-api/docs/models

### 5. Installa le dipendenze

```bash
npm install --omit=dev
```

### 6. Avvia con PM2

```bash
pm2 start ecosystem.config.cjs
```

L'app sarà disponibile su `http://<IP-del-NAS>:3000`

### 7. Avvio automatico al riavvio del NAS

```bash
pm2 save                  # salva la lista dei processi
pm2 startup               # mostra il comando da eseguire per abilitare l'autostart
# esegui il comando suggerito da pm2 startup (di solito inizia con sudo env ...)
```

### Comandi utili PM2

```bash
pm2 status                # stato dell'app
pm2 logs geminip          # log in tempo reale
pm2 restart geminip       # riavvia
pm2 stop geminip          # ferma
pm2 delete geminip        # rimuove dal processo manager
```

---

## Avvio rapido (senza PM2, solo per test)

```bash
cp .env.example .env
# Modifica .env con la tua chiave API
npm install
npm start
```

---

## Note sull'accessibilità

L'interfaccia è stata progettata per utenti che usano JAWS o altri screen reader:

- **Skip link** "Vai al campo di testo" all'inizio della pagina
- La lista dei messaggi ha `aria-live="polite"` — JAWS annuncia ogni nuova risposta automaticamente
- Il campo di stato sotto la chat (`role="status"`) annuncia l'avanzamento (invio, risposta ricevuta, errori)
- Tutti i controlli sono raggiungibili con **Tab** e attivabili con **Invio** o **Spazio**
- Per inviare un messaggio: scrivi nel campo di testo e premi **Invio** (Shift+Invio per andare a capo)
- Struttura heading chiara: `<h1>` nel header, sezioni con `aria-label`

---

## Struttura del progetto

```
geminip/
├── public/
│   └── index.html          # Frontend accessibile
├── server.js               # Backend Express (proxy Gemini)
├── ecosystem.config.cjs    # Configurazione PM2
├── package.json
├── .env.example
└── .gitignore
```

---

## Sicurezza

- La chiave API non è mai esposta al browser; tutte le chiamate a Gemini avvengono lato server
- L'app non memorizza messaggi su disco
