import test from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(__dirname, '..', 'sessions')

test('file backend: create, read, update, wrong token, isolation', async () => {
  const m = await import('../lib/sessions.js')
  const token = await m.createSession('VENOM-AAAA-BBBB', '{"creds":{"me":"234@s.whatsapp.net"}}')
  assert.ok(token && token.length > 20)
  const s = await m.readSession('VENOM-AAAA-BBBB')
  assert.equal(s.creds, '{"creds":{"me":"234@s.whatsapp.net"}}')
  assert.equal(await m.readSession('VENOM-ZZZZ-ZZZZ'), null) // other code sees nothing
  assert.equal(await m.updateSession('VENOM-AAAA-BBBB', 'wrong-token', '{"x":1}'), false)
  assert.equal(await m.updateSession('VENOM-AAAA-BBBB', token, '{"creds":{"rotated":true}}'), true)
  assert.equal((await m.readSession('VENOM-AAAA-BBBB')).creds, '{"creds":{"rotated":true}}')
  fs.rmSync(path.join(dir, `${m.hashCode('VENOM-AAAA-BBBB')}.json`), { force: true })
})

test('postgres backend (pg-mem): create, read, update, wrong token', async () => {
  process.env.BACKUP_DATABASE_URL = 'postgres://mock/mock'
  const { newDb } = await import('pg-mem')
  globalThis.__VENOM_PG__ = newDb().adapters.createPg()
  const m = await import('../lib/sessions.js')
  const token = await m.createSession('VENOM-PG00-PG01', '{"creds":{"pg":true}}')
  assert.equal((await m.readSession('VENOM-PG00-PG01')).creds, '{"creds":{"pg":true}}')
  assert.equal(await m.updateSession('VENOM-PG00-PG01', 'nope', '{"x":1}'), false)
  assert.equal(await m.updateSession('VENOM-PG00-PG01', token, '{"creds":{"pg":2}}'), true)
  assert.equal((await m.readSession('VENOM-PG00-PG01')).creds, '{"creds":{"pg":2}}')
  assert.equal(await m.readSession('VENOM-NOPE-NOPE'), null)
})
