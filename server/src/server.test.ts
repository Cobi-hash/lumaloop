import assert from 'node:assert/strict'
import test from 'node:test'
import { io as createClient, type Socket } from 'socket.io-client'

process.env.NODE_ENV = 'test'
const { createWatchPartyServer } = await import('./index.js')

function connect(url: string) {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createClient(url, { transports: ['websocket'], reconnection: false, timeout: 2_000 })
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', reject)
  })
}

function emitAck<T>(socket: Socket, event: string, payload: unknown) {
  return new Promise<T>((resolve, reject) => {
    socket.timeout(2_000).emit(event, payload, (error: Error | null, result: T) => {
      if (error) reject(error)
      else resolve(result)
    })
  })
}

test('Socket.IO supports room creation, joining, playback sync, and late join snapshots', async (context) => {
  const service = createWatchPartyServer()
  await new Promise<void>((resolve) => service.httpServer.listen(0, '127.0.0.1', resolve))
  const address = service.httpServer.address()
  assert.ok(address && typeof address !== 'string')
  context.after(async () => {
    service.io.close()
  })

  const url = `http://127.0.0.1:${address.port}`
  const rejectedOrigin = createClient(url, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { Origin: 'https://not-allowed.example' },
  })
  const originWasRejected = await new Promise<boolean>((resolve) => {
    rejectedOrigin.once('connect', () => resolve(false))
    rejectedOrigin.once('connect_error', () => resolve(true))
  })
  rejectedOrigin.close()
  assert.equal(originWasRejected, true)

  const hostSocket = await connect(url)
  const guestSocket = await connect(url)
  const host = await emitAck<{ ok: boolean; room: { code: string } }>(hostSocket, 'room:create', {
    displayName: 'Host', participantId: 'host-id', authToken: 'host-secret-for-test',
  })
  const guest = await emitAck<{ ok: boolean; participant: { role: string } }>(guestSocket, 'room:join', {
    code: host.room.code, displayName: 'Guest', participantId: 'guest-id', authToken: 'guest-secret-for-test',
  })

  assert.equal(host.ok, true)
  assert.equal(guest.participant.role, 'guest')
  const denied = await emitAck<{ ok: boolean; error: string }>(guestSocket, 'room:playback', {
    code: host.room.code, participantId: 'guest-id', action: 'play', currentTime: 0,
  })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /Only the host or a co-host/)
  const impersonation = await emitAck<{ ok: boolean; error: string }>(guestSocket, 'room:playback', {
    code: host.room.code, participantId: 'host-id', action: 'play', currentTime: 0,
  })
  assert.equal(impersonation.ok, false)
  assert.match(impersonation.error, /does not own/)

  await emitAck(hostSocket, 'room:playback', {
    code: host.room.code, participantId: 'host-id', action: 'load', sourceUrl: 'https://media.example/film.m3u8',
  })
  await emitAck(hostSocket, 'room:playback', {
    code: host.room.code, participantId: 'host-id', action: 'play', currentTime: 42,
  })
  const lateSocket = await connect(url)
  const late = await emitAck<{ room: { playback: { sourceUrl: string; currentTime: number; isPlaying: boolean } } }>(lateSocket, 'room:join', {
    code: host.room.code, displayName: 'Late viewer', participantId: 'late-id', authToken: 'late-secret-for-test',
  })
  assert.equal(late.room.playback.sourceUrl, 'https://media.example/film.m3u8')
  assert.ok(late.room.playback.currentTime >= 42)
  assert.equal(late.room.playback.isPlaying, true)

  const screenStateEvent = new Promise<{ active: boolean; participantId: string }>((resolve) => guestSocket.once('room:screen-state', resolve))
  hostSocket.emit('screen:active', { code: host.room.code, participantId: 'host-id', active: true })
  const screenState = await screenStateEvent
  assert.equal(screenState.active, true)
  assert.equal(screenState.participantId, 'host-id')

  hostSocket.disconnect()
  const reconnectedSocket = await connect(url)
  const reconnected = await emitAck<{ reconnected: boolean; participant: { role: string } }>(reconnectedSocket, 'room:join', {
    code: host.room.code, displayName: 'Host back', participantId: 'host-id', authToken: 'host-secret-for-test',
  })
  assert.equal(reconnected.reconnected, true)
  assert.equal(reconnected.participant.role, 'host')

  service.registry.leave(host.room.code, 'host-id')
  service.registry.leave(host.room.code, 'guest-id')
  service.registry.leave(host.room.code, 'late-id')
  reconnectedSocket.disconnect()
  guestSocket.disconnect()
  lateSocket.disconnect()
})

test('LiveKit token API lets guests subscribe but only hosts publish', async (context) => {
  process.env.LIVEKIT_URL = 'wss://live.example.test'
  process.env.LIVEKIT_API_KEY = 'test-key'
  process.env.LIVEKIT_API_SECRET = 'test-secret-that-is-long-enough-for-hmac'
  const service = createWatchPartyServer()
  await new Promise<void>((resolve) => service.httpServer.listen(0, '127.0.0.1', resolve))
  const address = service.httpServer.address()
  assert.ok(address && typeof address !== 'string')
  const hostSocket = await connect(`http://127.0.0.1:${address.port}`)
  const guestSocket = await connect(`http://127.0.0.1:${address.port}`)
  const hostSecret = 'publisher-private-secret-for-test'
  const guestSecret = 'viewer-private-secret-for-test'
  const created = await emitAck<{ room: { code: string }; authToken: string }>(hostSocket, 'room:create', {
    displayName: 'Host', participantId: 'publisher-id', authToken: hostSecret,
  })
  await emitAck(guestSocket, 'room:join', {
    code: created.room.code, displayName: 'Guest', participantId: 'viewer-id', authToken: guestSecret,
  })
  context.after(() => {
    service.registry.leave(created.room.code, 'publisher-id')
    service.registry.leave(created.room.code, 'viewer-id')
    hostSocket.disconnect()
    guestSocket.disconnect()
    return new Promise<void>((resolve) => service.io.close(resolve))
  })

  const requestToken = (participantId: string, authToken: string) => fetch(`http://127.0.0.1:${address.port}/api/livekit/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomCode: created.room.code, participantId, authToken }),
  })
  const hostResponse = await requestToken('publisher-id', hostSecret)
  const guestResponse = await requestToken('viewer-id', guestSecret)
  const hostResult = await hostResponse.json() as { token: string }
  const guestResult = await guestResponse.json() as { token: string }
  const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { video: { canPublish: boolean } }
  assert.equal(claims(hostResult.token).video.canPublish, true)
  assert.equal(claims(guestResult.token).video.canPublish, false)
  assert.equal((await requestToken('outside-id', 'unrelated-secret-for-test')).status, 403)
})
