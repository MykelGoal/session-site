import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

/**
 * Short VENOM-ID vault.
 *
 * Pairing produces a fat creds.json. We never show that. We mint
 *   VENOM-K7M2-9XPQ
 * stash the creds here, and the bot GRABS them once via /api/grab/:code.
 * After a successful grab (or 24h) the blob is gone.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VAULT_DIR = path.join(__dirname, '..', 'vault')
const TTL = 24 * 60 * 60 * 1000
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O/1/I/L

fs.mkdirSync(VAULT_DIR, { recursive: true })

export function normalizeCode(raw) {
  const compact = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  if (compact.startsWith('VENOM')) {
    const body = compact.slice(5)
    if (body.length === 8) return `VENOM-${body.slice(0, 4)}-${body.slice(4)}`
  }
  return String(raw || '').trim().toUpperCase()
}

export function isShortVenomId(raw) {
  const n = normalizeCode(raw)
  return /^VENOM-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(n)
}

function mint() {
  const bytes = crypto.randomBytes(8)
  let body = ''
  for (const b of bytes) body += ALPHABET[b % ALPHABET.length]
  return `VENOM-${body.slice(0, 4)}-${body.slice(4)}`
}

function fileFor(code) {
  return path.join(VAULT_DIR, `${normalizeCode(code)}.json`)
}

export function stash(credsJson) {
  let code = mint()
  let guard = 0
  while (fs.existsSync(fileFor(code)) && guard++ < 8) code = mint()
  const rec = {
    code,
    creds: typeof credsJson === 'string' ? credsJson : JSON.stringify(credsJson),
    createdAt: Date.now(),
  }
  fs.writeFileSync(fileFor(code), JSON.stringify(rec), 'utf8')
  return code
}

/** One-time grab. Returns creds JSON string or null. */
export function grab(raw) {
  const code = normalizeCode(raw)
  if (!isShortVenomId(code)) return null
  const fp = fileFor(code)
  if (!fs.existsSync(fp)) return null
  let rec
  try {
    rec = JSON.parse(fs.readFileSync(fp, 'utf8'))
  } catch {
    try { fs.unlinkSync(fp) } catch {}
    return null
  }
  try { fs.unlinkSync(fp) } catch {}
  if (Date.now() - rec.createdAt > TTL) return null
  return rec.creds || null
}

export function reapVault() {
  const now = Date.now()
  for (const name of fs.readdirSync(VAULT_DIR)) {
    if (!name.endsWith('.json')) continue
    const fp = path.join(VAULT_DIR, name)
    try {
      const rec = JSON.parse(fs.readFileSync(fp, 'utf8'))
      if (now - rec.createdAt > TTL) fs.unlinkSync(fp)
    } catch {
      try { fs.unlinkSync(fp) } catch {}
    }
  }
}

setInterval(reapVault, 10 * 60 * 1000).unref?.()
