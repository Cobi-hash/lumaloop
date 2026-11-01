import type { Socket } from 'socket.io-client'

type Signal = RTCSessionDescriptionInit | RTCIceCandidateInit
type SignalEnvelope = { from: string; signal: Signal }

export class DirectScreenShare {
  private peers = new Map<string, RTCPeerConnection>()
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>()
  private stream: MediaStream | null = null
  private disposed = false
  private readonly socket: Socket
  private readonly code: string
  private readonly participantId: string
  private readonly onRemoteStream: (stream: MediaStream | null) => void
  private readonly onError: (message: string) => void
  private readonly onStopped: () => void

  constructor(
    socket: Socket,
    code: string,
    participantId: string,
    onRemoteStream: (stream: MediaStream | null) => void,
    onError: (message: string) => void,
    onStopped: () => void,
  ) {
    this.socket = socket
    this.code = code
    this.participantId = participantId
    this.onRemoteStream = onRemoteStream
    this.onError = onError
    this.onStopped = onStopped
    socket.on('p2p:request', this.handleRequest)
    socket.on('p2p:signal', this.handleSignal)
  }

  async startCapture() {
    // Call from a click handler so the browser's screen picker opens immediately.
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true,
    })
    const video = this.stream.getVideoTracks()[0]
    if (!video) throw new Error('The browser did not provide a screen video track.')
    video.contentHint = 'motion'
    video.addEventListener('ended', () => { this.stop(); this.onStopped() }, { once: true })
  }

  requestStream() {
    this.socket.emit('p2p:request', { code: this.code, participantId: this.participantId })
  }

  private createPeer(targetId: string) {
    const existing = this.peers.get(targetId)
    if (existing) existing.close()
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })
    this.peers.set(targetId, peer)
    peer.onicecandidate = ({ candidate }) => {
      if (candidate) this.send(targetId, candidate.toJSON())
    }
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed') this.onError('Direct connection failed. This network may require a TURN relay; try the standard LiveKit mode.')
      if (peer.connectionState === 'closed' || peer.connectionState === 'disconnected') {
        if (this.peers.get(targetId) === peer) this.peers.delete(targetId)
      }
    }
    peer.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track])
      event.track.addEventListener('ended', () => this.onRemoteStream(null), { once: true })
      this.onRemoteStream(stream)
    }
    return peer
  }

  private handleRequest = async ({ participantId: targetId }: { participantId: string }) => {
    if (this.disposed || !this.stream) return
    try {
      const peer = this.createPeer(targetId)
      this.stream.getTracks().forEach((track) => peer.addTrack(track, this.stream!))
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      this.send(targetId, peer.localDescription!)
    } catch (error) {
      this.onError(error instanceof Error ? error.message : 'Could not create a direct connection.')
    }
  }

  private handleSignal = async ({ from, signal }: SignalEnvelope) => {
    if (this.disposed) return
    try {
      let peer = this.peers.get(from)
      if ('type' in signal && signal.type === 'offer') {
        peer = this.createPeer(from)
        await peer.setRemoteDescription(signal as RTCSessionDescriptionInit)
        for (const candidate of this.pendingCandidates.get(from) ?? []) await peer.addIceCandidate(candidate)
        this.pendingCandidates.delete(from)
        const answer = await peer.createAnswer()
        await peer.setLocalDescription(answer)
        this.send(from, peer.localDescription!)
      } else if ('type' in signal && signal.type === 'answer') {
        if (!peer) return
        await peer.setRemoteDescription(signal as RTCSessionDescriptionInit)
        for (const candidate of this.pendingCandidates.get(from) ?? []) await peer.addIceCandidate(candidate)
        this.pendingCandidates.delete(from)
      } else {
        const candidate = signal as RTCIceCandidateInit
        if (!peer?.remoteDescription) {
          const pending = this.pendingCandidates.get(from) ?? []
          pending.push(candidate)
          this.pendingCandidates.set(from, pending)
        } else {
          await peer.addIceCandidate(candidate)
        }
      }
    } catch (error) {
      this.onError(error instanceof Error ? error.message : 'Direct connection negotiation failed.')
    }
  }

  private send(targetId: string, signal: Signal) {
    this.socket.emit('p2p:signal', { code: this.code, participantId: this.participantId, targetId, signal })
  }

  stop() {
    this.disposed = true
    this.socket.off('p2p:request', this.handleRequest)
    this.socket.off('p2p:signal', this.handleSignal)
    for (const peer of this.peers.values()) peer.close()
    this.peers.clear()
    this.pendingCandidates.clear()
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    this.onRemoteStream(null)
  }
}
