/**
 * lib/sessions.js — PERMANENT cloud sessions behind short VENOM-XXXX-XXXX codes.
 *
 * SubZero-style: the short code is a permanent key. At pairing time we store
 * the creds under sha256(code) with a random update token. The bot fetches on
 * every boot (never burns) and pushes fresh creds on creds.update, so the
 * cloud copy never goes stale. Dies only when the user logs the device out of
 * WhatsApp (creds go dead) — then they re-pair, same as any bot.
 *
 * Storage: Postgres/Supabase (BACKUP_DATABASE_URL) when set, else local files.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(__dirname, '..', 'sessions')
fs.mkdirSync(DIR, { recursive: true })

const backendUrl = () => process.env.BACKUP_DATABASE_URL || ''
let pool = null

export function hashCode(code) {
  return crypto.createHash('sha256').update(String(code || '')).digest('hex')
}

async function db() {
  const u = backendUrl()
  if (!u) return null
  if (!pool) {
    const { Pool } = globalThis.__VENOM_PG__ || await import('pg')
    pool = new Pool({ connectionString: u, ssl: u.includes('localhost') ? false : { rejectUnauthorized: false } })
    await pool.query(
      `CREATE TABLE IF NOT EXISTS venom_sessions (id TEXT PRIMARY KEY, creds TEXT NOT NULL, token TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`
    )
  }
  return pool
}

/** Called once at pairing completion. Returns the update token. */
export async function createSession(code, creds) {
  const id = hashCode(code)
  const token = crypto.randomBytes(18).toString('hex')
  const p = await db()
  if (p) {
    await p.query(
      `INSERT INTO venom_sessions (id, creds, token) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET creds = EXCLUDED.creds, token = EXCLUDED.token, updated_at = now()`,
      [id, String(creds), token]
    )
    return token
  }
  fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify({ creds: String(creds), token, updatedAt: Date.now() }), 'utf8')
  return token
}

/** Permanent fetch (never burns). Returns { creds, token } or null. */
export async function readSession(code) {
  const id = hashCode(code)
  const p = await db()
  if (p) {
    const r = await p.query(`SELECT creds, token FROM venom_sessions WHERE id = $1`, [id])
    return r.rows.length ? { creds: r.rows[0].creds, token: r.rows[0].token } : null
  }
  const fp = path.join(DIR, `${id}.json`)
  if (!fs.existsSync(fp)) return null
  try {
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'))
    return { creds: d.creds, token: d.token }
  } catch { return null }
}

/** Bot keeps the cloud copy fresh. Token must match. */
export async function updateSession(code, token, creds) {
  const id = hashCode(code)
  if (!token || !creds) return false
  const p = await db()
  if (p) {
    const r = await p.query(
      `UPDATE venom_sessions SET creds = $2, updated_at = now() WHERE id = $1 AND token = $3`,
      [id, String(creds), String(token)]
    )
    return r.rowCount > 0
  }
  const fp = path.join(DIR, `${id}.json`)
  if (!fs.existsSync(fp)) return false
  try {
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'))
    if (d.token !== String(token)) return false
    d.creds = String(creds)
    d.updatedAt = Date.now()
    fs.writeFileSync(fp, JSON.stringify(d), 'utf8')
    return true
  } catch { return false }
}
