# VENOM MD — Session Generator

A small web app that links a WhatsApp account and hands back a **session ID**,
so a bot can start already authenticated — no terminal, no QR scanning on the
server.

Supports both linking methods:

- **QR code** — scan with WhatsApp → Linked devices
- **Pairing code** — an 8-character code you type into WhatsApp

**Verified working:** produces real scannable QR codes and real pairing codes
from WhatsApp's servers (tested live).

---

## Deploy to Render (free)

1. Push this folder to its own GitHub repo.
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New → Web Service**.
3. Connect the repo. Render reads `render.yaml` automatically:
   - **Build:** `npm install`
   - **Start:** `npm start`
   - **Health check:** `/api/health`
4. Deploy. You get a URL like `https://venom-md-session.onrender.com`.

**Free tier note:** Render sleeps a free service after 15 minutes idle, and the
next request takes ~50 seconds to wake it. That is fine here — a slow first
load, then normal speed. WhatsApp's QR refreshes every 20 seconds, and the app
polls for a new one, so a cold start never breaks the flow.

### Other hosts

Works unchanged on Railway, Fly.io, Koyeb, Cyclic or any VPS:

```bash
npm install
npm start          # listens on $PORT, defaults to 3000
```

Node 20+ required (Baileys v7 is ESM-only).

---

## How a user links their bot

1. Open the site.
2. Pick **QR Code** or **Pairing Code**.
   - For pairing, enter the number with its country code, digits only
     (`2348012345678` — no `+`, no spaces, no leading zero).
3. Scan the QR, or type the code into WhatsApp → Linked devices → *Link with
   phone number instead*.
4. The site shows a long **session ID** (base64-encoded credentials).
5. Copy it into the bot's `.env`:

```env
SESSION_ID=eyJub2lzZUtleSI6...
```

That's it — the bot decodes it at startup and connects without any QR.

**Alternative:** click **Download** to get `creds.json` and drop it into the
bot's `session/` folder. Both routes are equivalent.

---

## Security

This app deliberately keeps nothing:

| | |
|---|---|
| **In-memory only** | Sessions live in a `Map`, never a database |
| **Auto-deleted** | The auth folder is wiped the moment the session is read |
| **5-minute TTL** | Abandoned attempts are reaped every 30 seconds |
| **Wiped on boot** | `tmp/` is cleared at startup, so restarts leak nothing |
| **Rate limited** | 6 new sessions per IP per 10 minutes |
| **User notified** | WhatsApp DMs the account when a session is issued |

**A session ID is equivalent to a password.** Anyone holding it can read and
send messages as that account. The UI says this plainly, and the confirmation
message tells users how to revoke (WhatsApp → Linked devices → remove).

If you host this publicly, be aware you are asking strangers to trust you with
account access. Running it on your own machine, or keeping the URL private, is
the safer choice.

---

## API

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/session` | Start a link attempt. Body: `{ method: "qr" \| "pair", number? }` |
| `GET` | `/api/session/:id` | Poll status. Returns `qrImage`, `code`, or `creds` when done |
| `DELETE` | `/api/session/:id` | Cancel and wipe immediately |
| `GET` | `/api/health` | Uptime and active session count |

Status values: `starting` → `qr`/`pairing` → `connected` → `done`, plus
`error` and `expired`.

---

## Local development

```bash
npm install
npm start
# http://localhost:3000
```

Test the API directly:

```bash
curl -X POST localhost:3000/api/session \
  -H 'Content-Type: application/json' \
  -d '{"method":"qr"}'
```
