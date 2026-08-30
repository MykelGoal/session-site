import test from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backupsDir = path.join(__dirname, '..', 'backups')

test('file backend: save, load, missing, per-secret isolation', async () => {
  const m = await import('../lib/backup.js')
  assert.equal(m.backupBackend(), 'file')
  await m.saveBackup('VENOM~aaa', { economy: { x: 1 } })
  assert.deepEqual(await m.loadBackup('VENOM~aaa'), { economy: { x: 1 } })
  assert.equal(await m.loadBackup('VENOM~bbb'), null) // other instance sees nothing
  fs.rmSync(path.join(backupsDir, `${m.hashSecret('VENOM~aaa')}.json`), { force: true })
  assert.equal(await m.loadBackup('VENOM~aaa'), null)
})

test('postgres backend (pg-mem): roundtrip + upsert + missing', async () => {
  process.env.BACKUP_DATABASE_URL = 'postgres://mock/mock'
  const { newDb } = await import('pg-mem')
  globalThis.__VENOM_PG__ = newDb().adapters.createPg()

  // fresh module instance so backupBackend() sees the env var
  const m = await import('../lib/backup.js')
  assert.equal(m.backupBackend(), 'postgres')
  await m.saveBackup('VENOM~pg1', { economy: { wallet: 5000 } })
  await m.saveBackup('VENOM~pg1', { economy: { wallet: 7777 } }) // upsert path
  assert.deepEqual(await m.loadBackup('VENOM~pg1'), { economy: { wallet: 7777 } })
  assert.equal(await m.loadBackup('VENOM~pg2'), null)
  await m.saveBackup('VENOM~pg2', { notes: { n: 'hi' } })
  assert.deepEqual(await m.loadBackup('VENOM~pg2'), { notes: { n: 'hi' } })
  assert.deepEqual(await m.loadBackup('VENOM~pg1'), { economy: { wallet: 7777 } }) // still intact
})
