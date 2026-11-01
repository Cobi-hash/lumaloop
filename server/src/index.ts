import 'dotenv/config'
import { createServer } from 'node:http'
import cors from 'cors'
import express from 'express'
import { AccessToken } from 'livekit-server-sdk'
import { Server } from 'socket.io'
import { RoomRegistry, type PlaybackAction } from './rooms.js'

const port = Number(process.env.PORT ?? 3001)
const frontendOrigins = (process.env.FRONTEND_ORIGINS ?? 'http://localhost:5173,http://localhost:4173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

function originAllowed(origin: string | undefined) {
  return !origin || frontendOrigins.includes(origin)
}

export function createWatchPartyServer() {
  const app = express()
  app.use(cors({ origin: (origin, callback) => callback(null, originAllowed(origin)), methods: ['GET', 'POST'] }))
  app.use(express.json({ limit: '10kb' }))

  const httpServer = createServer(app)
  const io = new Server(httpServer, {
    cors: { origin: frontendOrigins, methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
    allowRequest: (request, callback) => callback(null, originAllowed(request.headers.origin)),
  })
  let registry: RoomRegistry
  const activeScreenSharers = new Map<string, string>()
  registry = new RoomRegistry(30_000, (code) => {
    if (io.sockets.adapter.rooms.has(code)) io.to(code).emit('room:state', registry.snapshot(code))
  })
  const socketOwnsParticipant = (code: string, participantId: string, socketId: string) =>
    registry.participant(code, participantId)?.socketId === socketId

  app.get('/health', (_request, response) => response.json({ status: 'ok' }))
  app.post('/api/livekit/token', async (request, response) => {
    const { roomCode, participantId, authToken } = request.body as { roomCode?: unknown; participantId?: unknown; authToken?: unknown }
    if (typeof roomCode !== 'string' || typeof participantId !== 'string' || typeof authToken !== 'string') {
      response.status(400).json({ error: 'Room code, participant ID, and session credential are required.' })
      return
    }
    if (!registry.canJoinScreen(roomCode, participantId, authToken)) {
      response.status(403).json({ error: 'Only participants currently in this room can connect to screen sharing.' })
      return
    }
    const livekitUrl = process.env.LIVEKIT_URL
    const apiKey = process.env.LIVEKIT_API_KEY
    const apiSecret = process.env.LIVEKIT_API_SECRET
    if (!livekitUrl || !apiKey || !apiSecret) {
      response.status(503).json({ error: 'Screen sharing is not configured on this server. Add the LiveKit connection variables.' })
      return
    }
    const participant = registry.participant(roomCode, participantId)
    if (!participant) {
      response.status(404).json({ error: 'This participant is no longer in the room.' })
      return
    }
    try {
      const token = new AccessToken(apiKey, apiSecret, {
        identity: participant.id,
        name: participant.displayName,
        ttl: '10m',
      })
      token.addGrant({
        roomJoin: true,
        room: `cinetogether-${roomCode.toUpperCase()}`,
        canPublish: registry.canPublishScreen(roomCode, participantId),
        canSubscribe: true,
        canPublishData: false,
      })
      response.json({ url: livekitUrl, token: await token.toJwt() })
    } catch (error) {
      console.error('Unable to create LiveKit token', error)
      response.status(500).json({ error: 'Could not start screen sharing. Please try again.' })
    }
  })

  io.on('connection', (socket) => {
    socket.on('room:create', (payload: unknown, acknowledge?: (result: unknown) => void) => {
      try {
        const input = (payload ?? {}) as { displayName?: unknown; participantId?: unknown; authToken?: unknown }
        const result = registry.create(input.displayName, input.participantId, input.authToken, socket.id)
        socket.join(result.room.code)
        acknowledge?.({ ok: true, ...result })
      } catch (error) {
        acknowledge?.({ ok: false, error: errorMessage(error) })
      }
    })

    socket.on('room:join', (payload: unknown, acknowledge?: (result: unknown) => void) => {
      try {
        const input = (payload ?? {}) as { code?: unknown; displayName?: unknown; participantId?: unknown; authToken?: unknown }
        const result = registry.join(input.code, input.displayName, input.participantId, input.authToken, socket.id)
        socket.join(result.room.code)
        io.to(result.room.code).emit('room:state', result.room)
        socket.emit('room:screen-state', {
          active: activeScreenSharers.has(result.room.code),
          participantId: activeScreenSharers.get(result.room.code),
        })
        acknowledge?.({ ok: true, ...result })
      } catch (error) {
        acknowledge?.({ ok: false, error: errorMessage(error) })
      }
    })

    // Experimental direct WebRTC signaling. Only signaling data is relayed; media is peer-to-peer.
    socket.on('p2p:signal', (payload: unknown) => {
      const input = (payload ?? {}) as { code?: unknown; participantId?: unknown; targetId?: unknown; signal?: unknown }
      if (typeof input.code !== 'string' || typeof input.participantId !== 'string' || typeof input.targetId !== 'string' || !input.signal) return
      if (!socketOwnsParticipant(input.code, input.participantId, socket.id)) return
      const sender = registry.participant(input.code, input.participantId)
      const target = registry.participant(input.code, input.targetId)
      if (!sender?.connected || !target?.connected || !target.socketId) return
      const signal = input.signal as { type?: unknown }
      if (signal.type === 'offer' && !registry.canPublishScreen(input.code, input.participantId)) return
      io.to(target.socketId).emit('p2p:signal', { from: input.participantId, signal: input.signal })
    })

    socket.on('p2p:mode', (payload: unknown) => {
      const input = (payload ?? {}) as { code?: unknown; participantId?: unknown; transport?: unknown }
      if (typeof input.code !== 'string' || typeof input.participantId !== 'string') return
      if (input.transport !== 'livekit' && input.transport !== 'p2p') return
      if (!socketOwnsParticipant(input.code, input.participantId, socket.id) || !registry.canPublishScreen(input.code, input.participantId)) return
      io.to(input.code.toUpperCase()).emit('p2p:mode', { transport: input.transport })
    })

    socket.on('p2p:request', (payload: unknown) => {
      const input = (payload ?? {}) as { code?: unknown; participantId?: unknown }
      if (typeof input.code !== 'string' || typeof input.participantId !== 'string') return
      if (!socketOwnsParticipant(input.code, input.participantId, socket.id)) return
      const guest = registry.participant(input.code, input.participantId)
      if (!guest?.connected) return
      const host = registry.snapshot(input.code).participants.find((participant) => participant.role === 'host' || participant.role === 'cohost')
      const hostParticipant = host ? registry.participant(input.code, host.id) : undefined
      if (hostParticipant?.socketId) io.to(hostParticipant.socketId).emit('p2p:request', { participantId: input.participantId })
    })

    socket.on('room:playback', (payload: unknown, acknowledge?: (result: unknown) => void) => {
      try {
        const input = (payload ?? {}) as {
          code?: unknown
          participantId?: unknown
          action?: unknown
          currentTime?: unknown
          sourceUrl?: unknown
        }
        if (typeof input.code !== 'string' || typeof input.participantId !== 'string') throw new Error('Room details are missing.')
        if (!socketOwnsParticipant(input.code, input.participantId, socket.id)) throw new Error('This connection does not own that participant session.')
        if (!['load', 'play', 'pause', 'seek'].includes(String(input.action))) throw new Error('That playback action is not supported.')
        const room = registry.controlPlayback(
          input.code,
          input.participantId,
          input.action as PlaybackAction,
          Number(input.currentTime ?? 0),
          input.sourceUrl,
        )
        io.to(room.code).emit('room:state', room)
        acknowledge?.({ ok: true, room })
      } catch (error) {
        acknowledge?.({ ok: false, error: errorMessage(error) })
      }
    })

    socket.on('room:role', (payload: unknown, acknowledge?: (result: unknown) => void) => {
      try {
        const input = (payload ?? {}) as { code?: string; participantId?: string; targetId?: string; role?: unknown }
        if (!input.code || !input.participantId || !input.targetId) throw new Error('Participant details are missing.')
        if (!socketOwnsParticipant(input.code, input.participantId, socket.id)) throw new Error('This connection does not own that participant session.')
        const room = registry.setRole(input.code, input.participantId, input.targetId, input.role)
        io.to(room.code).emit('room:state', room)
        acknowledge?.({ ok: true, room })
      } catch (error) {
        acknowledge?.({ ok: false, error: errorMessage(error) })
      }
    })

    socket.on('screen:active', (payload: unknown) => {
      const input = (payload ?? {}) as { code?: string; participantId?: string; active?: boolean }
      if (!input.code || !input.participantId || !socketOwnsParticipant(input.code, input.participantId, socket.id) || !registry.canPublishScreen(input.code, input.participantId)) return
      if (input.active) activeScreenSharers.set(input.code.toUpperCase(), input.participantId)
      else if (activeScreenSharers.get(input.code.toUpperCase()) === input.participantId) activeScreenSharers.delete(input.code.toUpperCase())
      io.to(input.code.toUpperCase()).emit('room:screen-state', {
        active: activeScreenSharers.has(input.code.toUpperCase()),
        participantId: activeScreenSharers.get(input.code.toUpperCase()),
      })
    })

    socket.on('room:remove', (payload: unknown, acknowledge?: (result: unknown) => void) => {
      try {
        const input = (payload ?? {}) as { code?: string; participantId?: string; targetId?: string }
        if (!input.code || !input.participantId || !input.targetId) throw new Error('Participant details are missing.')
        if (!socketOwnsParticipant(input.code, input.participantId, socket.id)) throw new Error('This connection does not own that participant session.')
        const result = registry.removeParticipant(input.code, input.participantId, input.targetId)
        if (result.socketId) {
          const removedSocket = io.sockets.sockets.get(result.socketId)
          removedSocket?.leave(input.code)
          removedSocket?.emit('room:removed')
        }
        if (result.room) io.to(input.code).emit('room:state', result.room)
        acknowledge?.({ ok: true })
      } catch (error) {
        acknowledge?.({ ok: false, error: errorMessage(error) })
      }
    })

    socket.on('room:leave', (payload: unknown, acknowledge?: (result: unknown) => void) => {
      const input = (payload ?? {}) as { code?: string; participantId?: string }
      if (!input.code || !input.participantId) {
        acknowledge?.({ ok: true })
        return
      }
      if (!socketOwnsParticipant(input.code, input.participantId, socket.id)) {
        acknowledge?.({ ok: false, error: 'This connection does not own that participant session.' })
        return
      }
      if (activeScreenSharers.get(input.code.toUpperCase()) === input.participantId) {
        activeScreenSharers.delete(input.code.toUpperCase())
        io.to(input.code.toUpperCase()).emit('room:screen-state', { active: false })
      }
      const roomCode = registry.leave(input.code, input.participantId)
      if (!roomCode) return
      socket.leave(roomCode)
      if (io.sockets.adapter.rooms.has(roomCode)) io.to(roomCode).emit('room:state', registry.snapshot(roomCode))
      acknowledge?.({ ok: true })
    })

    socket.on('disconnect', () => {
      const roomCode = registry.roomCodeForSocket(socket.id)
      const participantId = roomCode
        ? registry.snapshot(roomCode).participants.find((participant) => registry.participant(roomCode, participant.id)?.socketId === socket.id)?.id
        : undefined
      if (roomCode && participantId && activeScreenSharers.get(roomCode) === participantId) {
        activeScreenSharers.delete(roomCode)
        io.to(roomCode).emit('room:screen-state', { active: false })
      }
      registry.disconnect(socket.id)
    })
  })

  return { app, httpServer, io, registry }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

if (process.env.NODE_ENV !== 'test') {
  const service = createWatchPartyServer()
  service.httpServer.listen(port, '0.0.0.0', () => console.log(`CineTogether API listening on ${port}`))
}
