import assert from 'node:assert/strict'
import test from 'node:test'
import { RoomRegistry } from './rooms.js'

const createRoom = (registry: RoomRegistry) => registry.create('Host', 'host-id', 'host-secret-for-test', 'host-socket')

test('creates rooms, enforces playback roles, and synchronizes late joiners', async () => {
  const registry = new RoomRegistry()
  const created = createRoom(registry)
  const joined = registry.join(created.room.code, 'Guest', 'guest-id', 'guest-secret-for-test', 'guest-socket')

  assert.equal(created.participant.role, 'host')
  assert.equal(joined.participant.role, 'guest')
  assert.throws(() => registry.controlPlayback(created.room.code, 'guest-id', 'play', 0), /Only the host or a co-host/)

  registry.controlPlayback(created.room.code, 'host-id', 'load', 0, 'https://media.example/video.mp4')
  registry.controlPlayback(created.room.code, 'host-id', 'play', 18)
  const seek = registry.controlPlayback(created.room.code, 'host-id', 'seek', 25)
  assert.equal(seek.playback.currentTime, 25)
  assert.equal(seek.playback.isPlaying, true)
  registry.controlPlayback(created.room.code, 'host-id', 'pause', 25)
  assert.equal(registry.snapshot(created.room.code).playback.isPlaying, false)
  registry.controlPlayback(created.room.code, 'host-id', 'play', 18)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const lateJoiner = registry.join(created.room.code, 'Late guest', 'late-id', 'late-secret-for-test', 'late-socket')
  assert.ok(lateJoiner.room.playback.currentTime >= 18)
  assert.equal(lateJoiner.room.playback.isPlaying, true)
})

test('allows reconnect during grace and removes abandoned participants after expiry', async () => {
  const registry = new RoomRegistry(15)
  const created = createRoom(registry)
  registry.join(created.room.code, 'Guest', 'guest-id', 'guest-secret-for-test', 'guest-socket')

  registry.disconnect('host-socket')
  const reconnected = registry.join(created.room.code, 'Host again', 'host-id', 'host-secret-for-test', 'new-host-socket')
  assert.equal(reconnected.reconnected, true)
  assert.equal(reconnected.participant.role, 'host')

  registry.disconnect('new-host-socket')
  registry.disconnect('guest-socket')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.throws(() => registry.snapshot(created.room.code), /no longer available/)
})

test('host can change roles and co-host can remove guests only', () => {
  const registry = new RoomRegistry()
  const created = createRoom(registry)
  registry.join(created.room.code, 'Guest', 'guest-id', 'guest-secret-for-test', 'guest-socket')
  registry.join(created.room.code, 'Other guest', 'other-id', 'other-secret-for-test', 'other-socket')

  registry.setRole(created.room.code, 'host-id', 'guest-id', 'cohost')
  assert.throws(() => registry.setRole(created.room.code, 'guest-id', 'other-id', 'cohost'), /Only the host/)
  registry.removeParticipant(created.room.code, 'guest-id', 'other-id')
  assert.equal(registry.snapshot(created.room.code).participants.length, 2)
})

test('screen-share membership and publisher rights follow participant roles', () => {
  const registry = new RoomRegistry()
  const created = createRoom(registry)
  registry.join(created.room.code, 'Guest', 'guest-id', 'guest-secret-for-test', 'guest-socket')

  assert.equal(registry.canJoinScreen(created.room.code, 'guest-id', 'guest-secret-for-test'), true)
  assert.equal(registry.canPublishScreen(created.room.code, 'guest-id'), false)
  assert.equal(registry.canPublishScreen(created.room.code, 'host-id'), true)
  assert.equal(registry.canJoinScreen(created.room.code, 'outsider', 'outsider-secret-for-test'), false)
})

test('requires a private session credential to reconnect as an existing participant', () => {
  const registry = new RoomRegistry()
  const created = createRoom(registry)
  assert.throws(() => registry.join(created.room.code, 'Impostor', 'host-id', 'wrong-secret-for-test', 'impostor-socket'), /already in the room/)
  assert.equal(registry.snapshot(created.room.code).participants[0].displayName, 'Host')
})
