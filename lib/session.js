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
import zlib from 'zlib'
import { fileURLToPath } from 'url'
import { stash } from './vault.js'

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
    shortId: null,       // VENOM-XXXX-XXXX — what the user pastes
    credsJson: null,     // kept only until we stash + DM, then dropped
    jid: null,
    createdAt: Date.now(),
    restarts: 0,
    registered: false,
    closing: false,
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

  sock.ev.on('creds.update', async () => {
    await saveCreds()
    if (sock.authState?.creds?.registered) session.registered = true
  })

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
        session.shortId = stash(raw)
        session.credsJson = raw
        session.longId = 'VENOM~' + zlib.gzipSync(Buffer.from(raw)).toString('base64url')
        session.status = 'done'

        const shortId = session.shortId

        await sock
          .sendMessage(session.jid, {
            text:
              '✅ *VENOM MD — SESSION READY*\n\n' +
              'Your short session ID is in the next message. Paste it as\n' +
              '`SESSION_ID` in the bot `.env`.\n\n' +
              'The bot will *grab* the real credentials from the VENOM session site once, then this code dies.\n\n' +
              '⚠️ *Keep it secret.* If it leaks: WhatsApp → Linked devices → remove this device.'
          })
          .catch(() => {})

        await sock.sendMessage(session.jid, { text: shortId }).catch(() => {})
      } catch (e) {
        session.status = 'error'
        session.error = `Could not read the credentials: ${e.message}`
      }

      // close and wipe - the server keeps nothing.
      // wait long enough for the two messages above to leave the socket.
      setTimeout(() => cleanup(session, false), 6000)
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      if (session.status === 'done') return           // expected close after success
      if (session.closing) return                     // we asked for this

      /*
       * WhatsApp *always* drops the socket right after a successful link and
       * expects the client to reconnect with the credentials it just issued
       * (515 restartRequired, sometimes 428). That is not a failure - it is
       * the normal handshake. Reconnect instead of giving up, otherwise the
       * user sees "connection closed" the instant they scan.
       */
      const RECOVERABLE = new Set([
        DisconnectReason.restartRequired, // 515
        DisconnectReason.connectionClosed, // 428
        DisconnectReason.connectionLost, // 408
        DisconnectReason.timedOut // 408
      ])

      if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
        session.status = 'error'
        session.error = 'WhatsApp rejected the link. Please start again.'
        return
      }

      if (RECOVERABLE.has(code) || code === undefined) {
        session.restarts = (session.restarts || 0) + 1
        if (session.restarts > 3) {
          session.status = 'error'
          session.error = 'WhatsApp kept dropping the connection. Please try again.'
          return
        }
        // if creds were already issued, the link succeeded and we are just
        // completing the handshake - tell the user that, not "connecting"
        if (session.registered) session.status = 'connected'
        // keep the same folder: the creds written so far are what we resume with
        try { session.sock?.ev?.removeAllListeners?.() } catch {}
        setTimeout(() => {
          start(session).catch((e) => {
            session.status = 'error'
            session.error = e.message
          })
        }, 1200)
        return
      }

      if (session.status !== 'connected') {
        session.status = 'error'
        session.error = `Connection closed (${code || 'unknown'}). Please try again.`
      }
    }
  })
}

/** Close the socket and remove the on-disk auth folder. */
export function cleanup(session, markExpired = true) {
  session.closing = true
  try { session.sock?.ev?.removeAllListeners?.() } catch {}
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
    // the client calls this the session ID; keep both names so either works
    sessionId: s.status === 'done' ? s.shortId : null,
    longId: s.status === 'done' ? s.longId : null,
    creds: s.status === 'done' ? s.shortId : null,
    credsJson: s.status === 'done' ? s.credsJson : null,
    // seconds, so the name matches the unit a client would assume
    expiresIn: Math.max(0, Math.ceil((TTL - (Date.now() - s.createdAt)) / 1000))
  }
}
