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

- [Docker](https://docs.docker.com/get-docker/) e [Docker Compose](https://docs.docker.com/compose/)
- Una chiave API di Google Gemini (gratuita): https://aistudio.google.com/app/apikey

---

## Installazione sul NAS

### 1. Copia i file

Copia l'intera cartella del progetto sul tuo NAS (via SSH, Samba, ecc.).

### 2. Configura la chiave API

```bash
cp .env.example .env
# Modifica .env e inserisci la tua GEMINI_API_KEY
nano .env
```

### 3. Avvia con Docker Compose

```bash
docker compose up -d
```

L'app sarà disponibile su `http://<IP-del-NAS>:3000`

### Fermare il servizio

```bash
docker compose down
```

---

## Avvio locale (senza Docker)

```bash
# Requisiti: Node.js 18+
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
│   └── index.html        # Frontend accessibile
├── server.js             # Backend Express (proxy Gemini)
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── .gitignore
```

---

## Sicurezza

- La chiave API non è mai esposta al browser; tutte le chiamate a Gemini avvengono lato server
- L'app non memorizza messaggi su disco
