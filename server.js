import express from 'express'
import QRCode from 'qrcode'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { createSession, sessions, publicView, cleanup } from './lib/session.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

/* Render and most PaaS sit behind a proxy - trust it for rate limiting */
app.set('trust proxy', 1)

/* -------------------- very small rate limiter -------------------- */
const hits = new Map()
const LIMIT = 6          // new sessions
const WINDOW = 10 * 60 * 1000

function rateLimited(ip) {
  const now = Date.now()
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW)
  if (list.length >= LIMIT) {
    hits.set(ip, list)
    return true
  }
  list.push(now)
  hits.set(ip, list)
  return false
}

/* ---------------------------- API ---------------------------- */

app.post('/api/session', async (req, res) => {
  const ip = req.ip || 'unknown'
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' })
  }

  const method = req.body?.method === 'pair' ? 'pair' : 'qr'
  let number = String(req.body?.number || '').replace(/[^0-9]/g, '')

  if (method === 'pair') {
    if (number.length < 8 || number.length > 15) {
      return res.status(400).json({ error: 'Enter a valid number with its country code, digits only.' })
    }
    if (number.startsWith('0')) {
      return res.status(400).json({ error: 'Remove the leading 0 and start with your country code (e.g. 234...).' })
    }
  }

  try {
    const s = createSession({ method, number })
    res.json({ id: s.id, method })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/session/:id', async (req, res) => {
  const s = sessions.get(req.params.id)
  if (!s) return res.status(404).json({ error: 'Session not found or expired. Start again.' })

  const view = publicView(s)

  // render the QR string as a data-url so the browser can just show it
  if (view.qr) {
    try {
      view.qrImage = await QRCode.toDataURL(view.qr, {
        margin: 1,
        width: 320,
        color: { dark: '#0b0f1a', light: '#ffffff' }
      })
    } catch {}
  }
  res.json(view)
})

app.delete('/api/session/:id', (req, res) => {
  const s = sessions.get(req.params.id)
  if (s) {
    cleanup(s)
    sessions.delete(req.params.id)
  }
  res.json({ ok: true })
})

app.get('/api/health', (req, res) => {
  res.json({ ok: true, active: sessions.size, uptime: Math.floor(process.uptime()) })
})

/* Express 5 dropped the bare '*' wildcard - use a named splat */
app.get('/{*any}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))

/* clean the tmp folder on boot so restarts never leak old auth data */
const TMP = path.join(__dirname, 'tmp')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  VENOM MD session generator`)
  console.log(`  listening on http://0.0.0.0:${PORT}\n`)
})
