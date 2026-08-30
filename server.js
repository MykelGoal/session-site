import express from 'express'
import QRCode from 'qrcode'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { createSession, sessions, publicView, cleanup } from './lib/session.js'
import { grab, isShortVenomId } from './lib/vault.js'
import { saveBackup, loadBackup, bearerSecret, backupBackend } from './lib/backup.js'
import { readSession, updateSession } from './lib/sessions.js'

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

let dbCheck = { state: 'unchecked', at: 0 }
async function checkDb() {
  const u = process.env.BACKUP_DATABASE_URL
  if (!u) return 'file (no BACKUP_DATABASE_URL set)'
  if (Date.now() - dbCheck.at < 60_000) return dbCheck.state
  try {
    const { Pool } = await import('pg')
    const p = new Pool({ connectionString: u, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 })
    await p.query('select 1')
    await p.end()
    dbCheck = { state: 'ok', at: Date.now() }
  } catch (e) {
    const m = String(e.message || '')
    dbCheck = { state: m.includes('password') || m.includes('authentication')
      ? 'AUTH FAILED — wrong BACKUP_DATABASE_URL value (check password/URL)'
      : 'UNREACHABLE — ' + m.slice(0, 80), at: Date.now() }
  }
  return dbCheck.state
}

app.get('/api/health', async (req, res) => {
  res.json({ ok: true, active: sessions.size, backups: backupBackend(), db: await checkDb(), uptime: Math.floor(process.uptime()) })
})

/* Bot GRABS the real creds once with the short VENOM-XXXX-XXXX code. */
app.get('/api/grab/:code', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const code = req.params.code
  if (!isShortVenomId(code)) {
    return res.status(400).json({ error: 'Not a VENOM short ID. Expected VENOM-XXXX-XXXX.' })
  }
  const creds = grab(code)
  if (!creds) {
    return res.status(404).json({ error: 'Unknown, already used, or expired VENOM-ID. Generate a new one.' })
  }
  res.json({ ok: true, creds })
})

/* Permanent cloud sessions — the short code is a PERMANENT key (never burns). */
const sessRate = new Map()
app.get('/api/cloudsession/:code', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const code = req.params.code
  if (!isShortVenomId(code)) return res.status(400).json({ error: 'Not a VENOM short ID.' })
  const ip = req.ip || 'x'
  const now = Date.now()
  const e = sessRate.get(ip) || { n: 0, t: now }
  if (now - e.t > 60_000) { e.n = 0; e.t = now }
  e.n++
  sessRate.set(ip, e)
  if (e.n > 20) return res.status(429).json({ error: 'Too many attempts. Slow down.' })
  try {
    const s = await readSession(code)
    if (!s) return res.status(404).json({ error: 'No cloud session for this code. Re-pair on the site.' })
    res.json({ ok: true, creds: s.creds, token: s.token })
  } catch { res.status(500).json({ error: 'Session read failed.' }) }
})

/* Bot keeps its cloud copy fresh on every creds rotation (token-gated). */
app.put('/api/cloudsession/:code', async (req, res) => {
  const { token, creds } = req.body || {}
  try {
    const r = await updateSession(req.params.code, token, creds)
    if (!r.ok) return res.status(403).json({ error: 'Invalid token.' })
    res.json({ ok: true, created: !!r.created, token: r.token })
  } catch { res.status(500).json({ error: 'Session update failed.' }) }
})

/* ------------------- per-instance cloud backups ------------------- */
/* Auth = the instance's own long VENOM~ secret (already in their env). */

app.put('/api/backup', async (req, res) => {
  const secret = bearerSecret(req)
  if (!secret || !secret.startsWith('VENOM~')) {
    return res.status(401).json({ error: 'Bearer <long VENOM~ session> required.' })
  }
  const blob = req.body?.blob
  if (!blob || typeof blob !== 'object') return res.status(400).json({ error: 'blob object required.' })
  try {
    await saveBackup(secret, blob)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'Backup save failed.' })
  }
})

app.get('/api/backup', async (req, res) => {
  const secret = bearerSecret(req)
  if (!secret || !secret.startsWith('VENOM~')) {
    return res.status(401).json({ error: 'Bearer <long VENOM~ session> required.' })
  }
  try {
    const blob = await loadBackup(secret)
    if (!blob) return res.status(404).json({ error: 'No backup for this instance yet.' })
    res.json({ ok: true, blob })
  } catch (e) {
    res.status(500).json({ error: 'Backup read failed.' })
  }
})

/* Express 5 dropped the bare '*' wildcard - use a named splat */
app.get('/{*any}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))

/* wipe pairing tmp on boot — vault/ keeps unclaimed short IDs */
const TMP = path.join(__dirname, 'tmp')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
fs.mkdirSync(path.join(__dirname, 'vault'), { recursive: true })

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  VENOM MD session generator`)
  console.log(`  listening on http://0.0.0.0:${PORT}\n`)
})
