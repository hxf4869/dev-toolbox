// Narrow loopback-only unit tests for waitForNginx exported by stack.mjs.
// Certificates are generated with the same openssl parameters as the nginx group
// in verify.mjs, inside a private 0700 mkdtemp directory that is removed afterwards.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import https from 'node:https'
import net from 'node:net'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitForNginx } from './stack.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let directory
let trusted // certificate A: the one real servers under test present
let other // certificate B PEM: an unrelated self-signed CA that must never verify A

function issue(name) {
  const key = join(directory, `${name}.key`)
  const pem = join(directory, `${name}.pem`)
  const result = spawnSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',pem,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'], { encoding: 'utf8' })
  assert.equal(result.status, 0, `openssl failed for ${name}: ${(result.stderr ?? '').trim().slice(-300)}`)
  return { key, pem }
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dev-toolbox-nginx-wait-'))
  await chmod(directory, 0o700)
  const a = issue('localhost-a')
  const b = issue('localhost-b')
  await Promise.all([a.key, a.pem, b.key, b.pem].map(path => chmod(path, 0o600)))
  trusted = { key: await readFile(a.key, 'utf8'), pem: await readFile(a.pem, 'utf8') }
  other = await readFile(b.pem, 'utf8')
})

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function tlsServer() {
  const server = https.createServer({ key: trusted.key, cert: trusted.pem }, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('ok')
  })
  server.on('tlsClientError', () => {})
  return server
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
}

function close(server) {
  return new Promise(resolve => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

test('retries ECONNREFUSED during startup and resolves once TLS answers 200', async () => {
  const port = await freePort()
  const server = tlsServer()
  const delayed = sleep(400).then(() => listen(server, port))
  try {
    await waitForNginx(`https://localhost:${port}`, trusted.pem, 5000)
  } finally {
    await delayed.catch(() => {})
    await close(server)
  }
})

test('rejects at the deadline with ECONNREFUSED when nothing ever listens', async () => {
  const port = await freePort()
  const started = Date.now()
  await assert.rejects(
    waitForNginx(`https://localhost:${port}`, trusted.pem, 800),
    error => {
      assert.match(error.message, /Timed out: Nginx TLS/)
      assert.match(error.message, /ECONNREFUSED/)
      assert.doesNotMatch(error.message, /set-cookie|<|HTTP \d/)
      return true
    }
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed < 800 + 800, `rejection took ${elapsed}ms`)
  assert.ok(elapsed >= 500, `gave up after only ${elapsed}ms`)
  await sleep(50)
  const networkHandles = process.getActiveResourcesInfo().filter(name => /TCP|TLS|UDP/.test(name))
  assert.deepEqual(networkHandles, [])
})

test('bounds the total deadline when a slow peer trickles a response forever', async () => {
  const port = await freePort()
  const server = https.createServer({ key: trusted.key, cert: trusted.pem })
  const trickles = new Set()
  server.on('secureConnection', socket => {
    // Handshake completes, then a status line that never terminates: the client
    // parser keeps waiting for CRLF while bytes keep arriving, so a socket-idle
    // timeout would never fire; only the wall-clock deadline can end this.
    socket.write('HTTP/1.1 200 OK')
    const trickle = setInterval(() => socket.write('x'.repeat(16)), 100)
    trickles.add(trickle)
    const stop = () => { clearInterval(trickle); trickles.delete(trickle) }
    socket.on('close', stop)
    socket.on('error', stop)
  })
  await listen(server, port)
  try {
    const started = Date.now()
    // Race guard so a regression back to idle-timeout semantics fails bounded instead of hanging.
    const guard = sleep(900 + 800).then(() => { throw new Error('waitForNginx did not settle within the wall-clock bound') })
    guard.catch(() => {})
    await assert.rejects(
      Promise.race([waitForNginx(`https://localhost:${port}`, trusted.pem, 900), guard]),
      error => {
        assert.match(error.message, /Timed out: Nginx TLS/)
        assert.match(error.message, /ETIMEDOUT/)
        return true
      }
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 800, `gave up after only ${elapsed}ms`)
    assert.ok(elapsed < 900 + 800, `rejection took ${elapsed}ms`)
  } finally {
    for (const trickle of trickles) clearInterval(trickle)
    await close(server)
  }
})

test('rejects immediately with a certificate error when the CA does not match', async () => {
  const port = await freePort()
  const server = tlsServer()
  await listen(server, port)
  try {
    const started = Date.now()
    await assert.rejects(
      waitForNginx(`https://localhost:${port}`, other, 5000),
      error => {
        assert.match(error.message, /Nginx TLS check failed/)
        assert.match(error.message, /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT/)
        return true
      }
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 1500, `rejection took ${elapsed}ms`)
  } finally {
    await close(server)
  }
})

test('rejects with ERR_TLS_CERT_ALTNAME_INVALID for an IP endpoint against a localhost SAN', async () => {
  const port = await freePort()
  const server = tlsServer()
  await listen(server, port)
  try {
    await assert.rejects(
      waitForNginx(`https://127.0.0.1:${port}`, trusted.pem, 5000),
      error => {
        assert.match(error.message, /Nginx TLS check failed/)
        assert.match(error.message, /ERR_TLS_CERT_ALTNAME_INVALID/)
        return true
      }
    )
  } finally {
    await close(server)
  }
})
