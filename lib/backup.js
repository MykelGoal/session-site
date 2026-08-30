/**
 * lib/backup.js — private per-instance cloud backups for VENOM MD forks.
 *
 * The bot authenticates with its own long VENOM~ session secret (the same
 * string the user already has in SESSION_ID). We hash it and store one opaque
 * JSON blob per instance. No public DB creds, no collisions, no listing.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(__dirname, '..', 'backups')
fs.mkdirSync(DIR, { recursive: true })

export function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex')
}

export function bearerSecret(req) {
  const h = String(req.headers.authorization || '')
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

export function saveBackup(secret, blob) {
  const fp = path.join(DIR, `${hashSecret(secret)}.json`)
  fs.writeFileSync(fp, JSON.stringify({ updatedAt: Date.now(), blob }), 'utf8')
  return true
}

export function loadBackup(secret) {
  const fp = path.join(DIR, `${hashSecret(secret)}.json`)
  if (!fs.existsSync(fp)) return null
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')).blob ?? null } catch { return null }
}
