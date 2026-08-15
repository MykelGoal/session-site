import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  jidNormalizedUser
} from 'baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(__dirname, '..', 'tmp')
const logger = pino({ level: 'silent' })

/**
 * One short-lived WhatsApp link attempt per visitor.
 *
 * Flow: create a socket -> emit QR (or a pairing code) -> once WhatsApp
 * confirms the link, read the creds the library wrote to disk, hand them to
 * the user as a session string, then close the socket and delete everything.
 *
 * Nothing is persisted server-side: sessions live in memory, expire after
 * SESSION_TTL, and the auth folder is removed as soon as it has been read.
 */

export const sessions = new Map()
const TTL = 5 * 60 * 1000        // a link attempt may stay open 5 minutes
const REAP_EVERY = 30 * 1000

export function createSession({ method = 'qr', number = '' } = {}) {
  const id = crypto.randomBytes(12).toString('hex')
  const dir = path.join(TMP, id)
  fs.mkdirSync(dir, { recursive: true })

  const session = {
    id,
    method,
    number,
    dir,
    status: 'starting',   // starting | qr | pairing | connected | done | error | expired
    qr: null,
    code: null,
    error: null,
    credsB64: null,
    jid: null,
    createdAt: Date.now(),
    sock: null
  }
  sessions.set(id, session)
  start(session).catch((e) => {
    session.status = 'error'
    session.error = e.message
  })
  return session
}

async function start(session) {
  const { state, saveCreds } = await useMultiFileAuthState(session.dir)
  const { version } = await fetchLatestBaileysVersion()
  const usePairing = session.method === 'pair'

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    // pairing code requires a "desktop-like" browser signature
    browser: usePairing ? Browsers.ubuntu('Chrome') : Browsers.macOS('Safari'),
    markOnlineOnConnect: false,
    syncFullHistory: false
  })
  session.sock = sock

  sock.ev.on('creds.update', saveCreds)

  if (usePairing) {
    session.status = 'pairing'
    // WhatsApp rejects the request if it arrives too early
    setTimeout(async () => {
      try {
        if (sock.authState.creds.registered) return
        const code = await sock.requestPairingCode(session.number)
        session.code = code?.match(/.{1,4}/g)?.join('-') || code
      } catch (e) {
        session.status = 'error'
        session.error = `Could not get a pairing code: ${e.message}`
      }
    }, 3000)
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr && !usePairing) {
      session.status = 'qr'
      session.qr = qr
    }

    if (connection === 'open') {
      session.status = 'connected'
      session.jid = jidNormalizedUser(sock.user?.id || '')

      // give Baileys a moment to flush the final creds to disk
      await new Promise((r) => setTimeout(r, 2500))

      try {
        const credsPath = path.join(session.dir, 'creds.json')
        const raw = fs.readFileSync(credsPath, 'utf-8')
        session.credsB64 = Buffer.from(raw).toString('base64')
        session.status = 'done'

        // tell the user, in their own chat, that a session was issued
        await sock
          .sendMessage(session.jid, {
            text:
              '✅ *Session created successfully*\n\n' +
              'Your session ID has been shown on the website.\n\n' +
              '⚠️ *Keep it secret.* Anyone holding it can control this WhatsApp account. ' +
              'If you ever share it by accident, open WhatsApp → Linked devices and remove this device.'
          })
          .catch(() => {})
      } catch (e) {
        session.status = 'error'
        session.error = `Could not read the credentials: ${e.message}`
      }

      // close and wipe - the server keeps nothing
      setTimeout(() => cleanup(session, false), 1500)
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      if (session.status === 'done') return           // expected close after success
      if (code === DisconnectReason.loggedOut) {
        session.status = 'error'
        session.error = 'WhatsApp rejected the link. Please try again.'
      } else if (session.status !== 'connected') {
        session.status = 'error'
        session.error = 'Connection closed before linking completed. Please try again.'
      }
    }
  })
}

/** Close the socket and remove the on-disk auth folder. */
export function cleanup(session, markExpired = true) {
  try { session.sock?.ws?.close?.() } catch {}
  try { session.sock?.end?.(undefined) } catch {}
  try { fs.rmSync(session.dir, { recursive: true, force: true }) } catch {}
  session.sock = null
  if (markExpired && session.status !== 'done') session.status = 'expired'
}

/** Drop stale sessions so nothing lingers in memory or on disk. */
setInterval(() => {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.createdAt > TTL) {
      cleanup(s)
      sessions.delete(id)
    }
  }
}, REAP_EVERY)

export function publicView(s) {
  return {
    id: s.id,
    status: s.status,
    qr: s.qr,
    code: s.code,
    error: s.error,
    jid: s.jid ? s.jid.split('@')[0] : null,
    creds: s.status === 'done' ? s.credsB64 : null,
    // seconds, so the name matches the unit a client would assume
    expiresIn: Math.max(0, Math.ceil((TTL - (Date.now() - s.createdAt)) / 1000))
  }
}
