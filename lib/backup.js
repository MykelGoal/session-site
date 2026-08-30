/**
 * lib/backup.js — private per-instance cloud backups for VENOM MD forks.
 *
 * The bot authenticates with its own long VENOM~ session secret (the same
 * string the user already has in SESSION_ID). We hash it and store one opaque
 * JSON blob per instance. No public DB creds, no collisions, no listing.
 *
 * Storage: Postgres/Supabase when BACKUP_DATABASE_URL is set (durable across
 * Render redeploys), otherwise local files under backups/.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(__dirname, '..', 'backups')
fs.mkdirSync(DIR, { recursive: true })

const backendUrl = () => process.env.BACKUP_DATABASE_URL || ''
let pool = null

export function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex')
}

export function bearerSecret(req) {
  const h = String(req.headers.authorization || '')
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

export const backupBackend = () => (backendUrl() ? 'postgres' : 'file')

async function db() {
  const u = backendUrl()
  if (!u) return null
  if (!pool) {
    const { Pool } = globalThis.__VENOM_PG__ || await import('pg')
    pool = new Pool({
      connectionString: u,
      ssl: u.includes('localhost') ? false : { rejectUnauthorized: false },
    })
    await pool.query(
      `CREATE TABLE IF NOT EXISTS venom_backups (id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`
    )
  }
  return pool
}

export async function saveBackup(secret, blob) {
  const id = hashSecret(secret)
  const payload = JSON.stringify({ updatedAt: Date.now(), blob })
  const p = await db()
  if (p) {
    await p.query(
      `INSERT INTO venom_backups (id, value) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [id, payload]
    )
    return true
  }
  fs.writeFileSync(path.join(DIR, `${id}.json`), payload, 'utf8')
  return true
}

export async function loadBackup(secret) {
  const id = hashSecret(secret)
  const p = await db()
  if (p) {
    const r = await p.query(`SELECT value FROM venom_backups WHERE id = $1`, [id])
    if (!r.rows.length) return null
    try { return JSON.parse(r.rows[0].value).blob ?? null } catch { return null }
  }
  const fp = path.join(DIR, `${id}.json`)
  if (!fs.existsSync(fp)) return null
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')).blob ?? null } catch { return null }
}
