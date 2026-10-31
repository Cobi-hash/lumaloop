import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto'

export type ParticipantRole = 'host' | 'cohost' | 'guest'
export type PlaybackAction = 'load' | 'play' | 'pause' | 'seek'

export interface Participant {
  id: string
  displayName: string
  role: ParticipantRole
  joinedAt: number
  connected: boolean
  socketId: string
  authToken: string
}

interface PlaybackState {
  sourceUrl: string
  currentTime: number
  isPlaying: boolean
  updatedAt: number
}

interface Room {
  code: string
  createdAt: number
  participants: Map<string, Participant>
  playback: PlaybackState
}

export interface PublicParticipant extends Omit<Participant, 'socketId' | 'authToken'> {}

export interface RoomSnapshot {
  code: string
  createdAt: number
  participants: PublicParticipant[]
  playback: {
    sourceUrl: string
    currentTime: number
    isPlaying: boolean
    updatedAt: number
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_PARTICIPANTS = 16
const MAX_NAME_LENGTH = 32
const MAX_URL_LENGTH = 2048

function makeRoomCode(): string {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
}

export function cleanDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a display name to continue.')
  const name = value.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH)
  if (!name) throw new Error('Enter a display name to continue.')
  return name
}

function cleanParticipantId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 80 || !value.trim()) return randomUUID()
  return value.trim()
}

function cleanAuthToken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 128) {
    throw new Error('This participant session is not valid. Start again from the room link.')
  }
  return value
}

function secretsMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function toPublicParticipant(participant: Participant): PublicParticipant {
  const { socketId: _socketId, ...publicParticipant } = participant
  return publicParticipant
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>()
  private readonly disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly reconnectGraceMs = 30_000,
    private readonly onChange: (code: string) => void = () => {},
  ) {}

  create(displayName: unknown, participantId: unknown, authTokenValue: unknown, socketId: string) {
    const name = cleanDisplayName(displayName)
    let code = makeRoomCode()
    while (this.rooms.has(code)) code = makeRoomCode()
    const participant: Participant = {
      id: cleanParticipantId(participantId),
      displayName: name,
      role: 'host',
      joinedAt: Date.now(),
      connected: true,
      socketId,
      authToken: cleanAuthToken(authTokenValue),
    }
    const room: Room = {
      code,
      createdAt: Date.now(),
      participants: new Map([[participant.id, participant]]),
      playback: { sourceUrl: '', currentTime: 0, isPlaying: false, updatedAt: Date.now() },
    }
    this.rooms.set(code, room)
    return { room: this.snapshot(code), participant: toPublicParticipant(participant), authToken: participant.authToken }
  }

  join(codeValue: unknown, displayName: unknown, participantIdValue: unknown, authTokenValue: unknown, socketId: string) {
    const code = typeof codeValue === 'string' ? codeValue.trim().toUpperCase() : ''
    const room = this.rooms.get(code)
    if (!room) throw new Error('That room was not found. Check the code or ask for a new invite.')
    const name = cleanDisplayName(displayName)
    const id = cleanParticipantId(participantIdValue)
    const authToken = cleanAuthToken(authTokenValue)
    let participant = room.participants.get(id)
    const reconnected = Boolean(participant)
    if (participant) {
      if (!secretsMatch(participant.authToken, authToken)) {
        throw new Error('This participant is already in the room. Use the same browser session to reconnect.')
      }
      this.clearDisconnectTimer(code, id)
      participant.displayName = name
      participant.socketId = socketId
      participant.connected = true
    } else {
      if (room.participants.size >= MAX_PARTICIPANTS) throw new Error('This room is full (16 people maximum).')
      participant = { id, displayName: name, role: 'guest', joinedAt: Date.now(), connected: true, socketId, authToken }
      room.participants.set(id, participant)
    }
    this.onChange(code)
    return { room: this.snapshot(code), participant: toPublicParticipant(participant), reconnected, authToken: participant.authToken }
  }

  snapshot(codeValue: string): RoomSnapshot {
    const room = this.requireRoom(codeValue)
    const now = Date.now()
    const elapsed = room.playback.isPlaying ? Math.max(0, now - room.playback.updatedAt) / 1000 : 0
    return {
      code: room.code,
      createdAt: room.createdAt,
      participants: [...room.participants.values()].map(toPublicParticipant),
      playback: {
        ...room.playback,
        currentTime: room.playback.currentTime + elapsed,
        updatedAt: now,
      },
    }
  }

  participant(roomCode: string, participantId: string): Participant | undefined {
    return this.rooms.get(roomCode.toUpperCase())?.participants.get(participantId)
  }

  roomCodeForSocket(socketId: string): string | undefined {
    for (const room of this.rooms.values()) {
      if ([...room.participants.values()].some((participant) => participant.socketId === socketId)) return room.code
    }
    return undefined
  }

  controlPlayback(codeValue: string, participantId: string, action: PlaybackAction, currentTime = 0, sourceUrl?: unknown) {
    const room = this.requireRoom(codeValue)
    this.requireController(room, participantId)
    const time = Number(currentTime)
    if (!Number.isFinite(time) || time < 0) throw new Error('Playback position must be a non-negative number.')
    if (action === 'load') {
      if (typeof sourceUrl !== 'string' || sourceUrl.length > MAX_URL_LENGTH) throw new Error('Enter a valid direct video URL.')
      let parsed: URL
      try {
        parsed = new URL(sourceUrl)
      } catch {
        throw new Error('Enter a valid direct video URL.')
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS video links are supported.')
      room.playback.sourceUrl = parsed.toString()
      room.playback.currentTime = 0
      room.playback.isPlaying = false
    } else {
      room.playback.currentTime = time
      if (action === 'play') room.playback.isPlaying = true
      if (action === 'pause') room.playback.isPlaying = false
    }
    room.playback.updatedAt = Date.now()
    this.onChange(room.code)
    return this.snapshot(room.code)
  }

  setRole(codeValue: string, actorId: string, targetId: string, role: unknown) {
    const room = this.requireRoom(codeValue)
    const actor = room.participants.get(actorId)
    const target = room.participants.get(targetId)
    if (actor?.role !== 'host') throw new Error('Only the host can change participant roles.')
    if (!target || target.role === 'host') throw new Error('That participant cannot be changed.')
    if (role !== 'cohost' && role !== 'guest') throw new Error('Choose Guest or Co-host.')
    target.role = role
    this.onChange(room.code)
    return this.snapshot(room.code)
  }

  removeParticipant(codeValue: string, actorId: string, targetId: string) {
    const room = this.requireRoom(codeValue)
    const actor = room.participants.get(actorId)
    const target = room.participants.get(targetId)
    if (!actor || !target || actorId === targetId) throw new Error('That participant cannot be removed.')
    if (actor.role !== 'host' && !(actor.role === 'cohost' && target.role === 'guest')) {
      throw new Error('You do not have permission to remove this participant.')
    }
    const socketId = target.socketId
    this.deleteParticipant(room, targetId)
    this.onChange(room.code)
    return { room: this.rooms.has(room.code) ? this.snapshot(room.code) : undefined, socketId }
  }

  leave(codeValue: string, participantId: string) {
    const room = this.rooms.get(codeValue.toUpperCase())
    if (!room || !room.participants.has(participantId)) return undefined
    this.deleteParticipant(room, participantId)
    if (this.rooms.has(room.code)) this.onChange(room.code)
    return room.code
  }

  disconnect(socketId: string) {
    for (const room of this.rooms.values()) {
      const participant = [...room.participants.values()].find((item) => item.socketId === socketId)
      if (!participant) continue
      participant.connected = false
      participant.socketId = ''
      const key = this.timerKey(room.code, participant.id)
      this.clearDisconnectTimer(room.code, participant.id)
      const timer = setTimeout(() => {
        this.disconnectTimers.delete(key)
        const currentRoom = this.rooms.get(room.code)
        if (!currentRoom || currentRoom.participants.get(participant.id)?.connected) return
        this.deleteParticipant(currentRoom, participant.id)
        if (this.rooms.has(room.code)) this.onChange(room.code)
      }, this.reconnectGraceMs)
      this.disconnectTimers.set(key, timer)
      this.onChange(room.code)
      return room.code
    }
    return undefined
  }

  canJoinScreen(codeValue: string, participantId: string, authToken: string): boolean {
    const participant = this.participant(codeValue, participantId)
    return Boolean(participant?.connected && secretsMatch(participant.authToken, authToken))
  }

  canPublishScreen(codeValue: string, participantId: string): boolean {
    const participant = this.participant(codeValue, participantId)
    return Boolean(participant?.connected && (participant.role === 'host' || participant.role === 'cohost'))
  }

  private requireController(room: Room, participantId: string) {
    const participant = room.participants.get(participantId)
    if (!participant || !participant.connected || (participant.role !== 'host' && participant.role !== 'cohost')) {
      throw new Error('Only the host or a co-host can control playback.')
    }
  }

  private requireRoom(codeValue: string): Room {
    const room = this.rooms.get(codeValue.toUpperCase())
    if (!room) throw new Error('That room is no longer available.')
    return room
  }

  private deleteParticipant(room: Room, participantId: string) {
    this.clearDisconnectTimer(room.code, participantId)
    room.participants.delete(participantId)
    if (room.participants.size === 0) {
      this.rooms.delete(room.code)
      return
    }
    const hasHost = [...room.participants.values()].some((participant) => participant.role === 'host')
    if (!hasHost) {
      const nextHost = [...room.participants.values()]
        .filter((participant) => participant.connected)
        .sort((left, right) => left.joinedAt - right.joinedAt)[0]
      if (nextHost) nextHost.role = 'host'
    }
  }

  private clearDisconnectTimer(code: string, participantId: string) {
    const key = this.timerKey(code, participantId)
    const timer = this.disconnectTimers.get(key)
    if (timer) clearTimeout(timer)
    this.disconnectTimers.delete(key)
  }

  private timerKey(code: string, participantId: string) {
    return `${code}:${participantId}`
  }
}
