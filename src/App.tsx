import { useEffect, useRef, useState } from 'react'
import type { Room as LiveKitRoomType, Track as LiveKitTrackType } from 'livekit-client'
import {
  createScreenShareRoom,
  publishScreenCapture as publishScreenTracks,
  readScreenShareSettings,
  requestScreenCapture,
  RoomEvent,
  stopPublishedScreenShare,
  Track,
  type ScreenContentProfile,
  type ScreenFrameRate,
  type ScreenQuality,
  type ScreenShareSettings,
  type ScreenTracksPromise,
} from './lib/screenShare'
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Clapperboard,
  Copy,
  Crown,
  Film,
  Link2,
  LoaderCircle,
  LogOut,
  Maximize2,
  Minimize2,
  Mic2,
  MonitorPlay,
  Play,
  Plus,
  ScreenShare,
  ShieldCheck,
  Users,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { io, type Socket } from 'socket.io-client'
import './App.css'

type Role = 'host' | 'cohost' | 'guest'
type Mode = 'video' | 'screen'
interface Participant {
  id: string
  displayName: string
  role: Role
  joinedAt: number
  connected: boolean
}

interface RoomState {
  code: string
  createdAt: number
  participants: Participant[]
  playback: {
    sourceUrl: string
    currentTime: number
    isPlaying: boolean
    updatedAt: number
  }
}

interface AckResponse<T = unknown> {
  ok: boolean
  error?: string
  room?: T
  participant?: Participant
  reconnected?: boolean
  authToken?: string
}

interface Session {
  code: string
  participantId: string
  displayName: string
  authToken: string
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const NAME_KEY = 'lumaloop.displayName'
const PARTICIPANT_KEY = 'lumaloop.participantId'
const AUTH_TOKEN_KEY = 'lumaloop.participantCredential'

function participantId() {
  const saved = localStorage.getItem(PARTICIPANT_KEY)
  if (saved) return saved
  const created = crypto.randomUUID()
  localStorage.setItem(PARTICIPANT_KEY, created)
  return created
}

function participantCredential() {
  const saved = localStorage.getItem(AUTH_TOKEN_KEY)
  if (saved) return saved
  const created = crypto.randomUUID()
  localStorage.setItem(AUTH_TOKEN_KEY, created)
  return created
}

function emitAck<T>(socket: Socket, event: string, payload: unknown) {
  return new Promise<T>((resolve, reject) => {
    socket.timeout(7_000).emit(event, payload, (error: Error | null, response: T) => {
      if (error) reject(new Error('The server did not respond. Check your connection and try again.'))
      else resolve(response)
    })
  })
}

function readableTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '00:00'
  const value = Math.max(0, Math.floor(seconds))
  return `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`
}

type BandwidthEstimate = { low: number; high: number; uploadNeeded: number }

function estimateScreenShareBandwidth(settings: ScreenShareSettings): BandwidthEstimate {
  const ranges = {
    auto: { low: 2.4, high: 4.5 },
    '480p': { low: 0.55, high: 1.0 },
    '720p': { low: 1.2, high: 2.5 },
    '1080p': { low: 2.4, high: 4.5 },
  } as const
  const range = ranges[settings.quality]
  const fpsFactor = settings.frameRate === 60 ? 1.35 : 1
  const contentFactor = settings.contentProfile === 'detail' ? 0.9 : settings.contentProfile === 'motion' ? 1.08 : 1
  const audioMbps = settings.shareAudio ? 0.12 : 0
  const overheadFactor = 1.1
  const low = (range.low * fpsFactor * contentFactor + audioMbps) * overheadFactor
  const high = (range.high * fpsFactor * contentFactor + audioMbps) * overheadFactor
  return { low, high, uploadNeeded: high / 0.7 }
}

function recommendScreenSettings(uploadMbps: number): { quality: ScreenQuality; frameRate: ScreenFrameRate; contentProfile: ScreenContentProfile; label: string } {
  if (uploadMbps < 2) return { quality: '480p', frameRate: 30, contentProfile: 'motion', label: 'Low bandwidth · prioritize reliability' }
  if (uploadMbps < 4) return { quality: '720p', frameRate: 30, contentProfile: 'motion', label: 'Moderate upload · good everyday balance' }
  if (uploadMbps < 7) return { quality: '1080p', frameRate: 30, contentProfile: 'motion', label: 'Strong upload · Full HD at 30 FPS' }
  return { quality: '1080p', frameRate: 60, contentProfile: 'motion', label: 'Very strong upload · Full HD at 60 FPS' }
}

function formatMbps(value: number) {
  return value < 1 ? value.toFixed(2) : value.toFixed(1)
}

function App() {
  const [displayName, setDisplayName] = useState(() => localStorage.getItem(NAME_KEY) ?? '')
  const [roomCode, setRoomCode] = useState(() => new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '')
  const [room, setRoom] = useState<RoomState | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [socketConnected, setSocketConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [mode, setMode] = useState<Mode>('video')
  const [muted, setMuted] = useState(() => localStorage.getItem('lumaloop.muted') !== 'false')
  const [screenAudioMuted, setScreenAudioMuted] = useState(true)
  const [mediaUrl, setMediaUrl] = useState('')
  const [mediaError, setMediaError] = useState('')
  const [screenError, setScreenError] = useState('')
  const [screenConnected, setScreenConnected] = useState(false)
  const [screenSharing, setScreenSharing] = useState(false)
  const [screenActive, setScreenActive] = useState(false)
  const [screenShareSettings, setScreenShareSettings] = useState(readScreenShareSettings)
  const [uploadSpeedMbps, setUploadSpeedMbps] = useState('10')
  const [mediaControlsVisible, setMediaControlsVisible] = useState(true)
  const [screenTrack, setScreenTrack] = useState<LiveKitTrackType | null>(null)
  const [screenAudioTrack, setScreenAudioTrack] = useState<LiveKitTrackType | null>(null)
  const [copied, setCopied] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const socketRef = useRef<Socket | null>(null)
  const sessionRef = useRef<Session | null>(null)
  const roomRef = useRef<RoomState | null>(null)
  const syncingSeekRef = useRef(false)
  const mediaControlsTimerRef = useRef<number | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const mediaFrameRef = useRef<HTMLDivElement>(null)
  const screenStageRef = useRef<HTMLDivElement>(null)
  const screenVideoRef = useRef<HTMLVideoElement>(null)
  const screenAudioRef = useRef<HTMLAudioElement>(null)
  const liveKitRef = useRef<LiveKitRoomType | null>(null)
  
  const self = room?.participants.find((participant) => participant.id === session?.participantId)
  const canControl = self?.role === 'host' || self?.role === 'cohost'
  const isHost = self?.role === 'host'
  const playbackSource = room?.playback.sourceUrl
  const playbackTime = room?.playback.currentTime
  const playbackIsPlaying = room?.playback.isPlaying
  const playbackUpdatedAt = room?.playback.updatedAt

  useEffect(() => {
    roomRef.current = room
  }, [room])

  useEffect(() => {
    if (self) setScreenAudioMuted(canControl)
  }, [self?.role])

  useEffect(() => {
    const updateFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', updateFullscreen)
    return () => document.removeEventListener('fullscreenchange', updateFullscreen)
  }, [])

  useEffect(() => {
    if (!playbackSource || playbackTime === undefined || playbackIsPlaying === undefined || playbackUpdatedAt === undefined) return
    const video = videoRef.current
    if (!video) return
    const sync = () => {
      if (!video.readyState) return
      const target = playbackTime + (playbackIsPlaying ? Math.max(0, Date.now() - playbackUpdatedAt) / 1000 : 0)
      const drift = target - video.currentTime
      if (Math.abs(drift) > 1.25) {
        // Large drift needs a hard correction; small drift is corrected with
        // temporary playback-rate nudging to avoid visible seek jumps.
        syncingSeekRef.current = true
        try {
          video.currentTime = target
          video.playbackRate = 1
          window.setTimeout(() => { syncingSeekRef.current = false }, 800)
        } catch {
          syncingSeekRef.current = false
        }
      } else if (playbackIsPlaying && Math.abs(drift) > 0.12) {
        video.playbackRate = Math.max(0.96, Math.min(1.04, 1 + drift * 0.035))
      } else {
        video.playbackRate = 1
      }
      if (playbackIsPlaying && video.paused) void video.play().catch(() => setMediaError('Playback was blocked by the browser. Press play on your device to continue.'))
      if (!playbackIsPlaying && !video.paused) {
        video.playbackRate = 1
        video.pause()
      }
    }
    sync()
    const timer = window.setInterval(sync, 1_500)
    return () => window.clearInterval(timer)
  }, [playbackSource, playbackTime, playbackIsPlaying, playbackUpdatedAt])

  useEffect(() => {
    const video = videoRef.current
    const source = playbackSource
    if (!video || !source) return
    const pathname = new URL(source).pathname.toLowerCase()
    const isHls = pathname.endsWith('.m3u8')
    const isVideo = /\.(mp4|webm)$/.test(pathname)
    if (!isHls && !isVideo) {
      video.removeAttribute('src')
      video.load()
      return
    }
    if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      let disposed = false
      let hls: import('hls.js').default | undefined
      void import('hls.js').then(({ default: Hls }) => {
        if (disposed) return
        if (!Hls.isSupported()) {
          setMediaError('This browser does not support HLS playback.')
          return
        }
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          capLevelToPlayerSize: true,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          backBufferLength: 30,
          abrBandWidthFactor: 0.8,
          abrBandWidthUpFactor: 0.7,
        })
        hls.loadSource(source)
        hls.attachMedia(video)
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) setMediaError('This HLS stream could not be loaded. Check that it is public, uses HTTPS, and allows playback from this site.')
        })
      })
      return () => { disposed = true; hls?.destroy() }
    }
    video.src = source
    video.load()
    return () => video.removeAttribute('src')
  }, [playbackSource])

  useEffect(() => {
    const video = screenVideoRef.current
    if (!video || !screenTrack) return
    screenTrack.attach(video)
    return () => { screenTrack.detach(video) }
  }, [screenTrack])

  useEffect(() => {
    const audio = screenAudioRef.current
    if (!audio || !screenAudioTrack) return
    // Apply the local mute before and after attaching the remote track.
    // Keep the host's local playback muted independently of the shared source.
    audio.muted = screenAudioMuted
    screenAudioTrack.attach(audio)
    audio.muted = screenAudioMuted
    return () => { screenAudioTrack.detach(audio) }
  }, [screenAudioTrack, screenAudioMuted])

  useEffect(() => () => {
    if (mediaControlsTimerRef.current !== null) window.clearTimeout(mediaControlsTimerRef.current)
    liveKitRef.current?.disconnect()
    socketRef.current?.disconnect()
  }, [])

  async function connectToRoom(action: 'room:create' | 'room:join') {
    setError('')
    setNotice('')
    const name = displayName.trim()
    if (!name) {
      setError('Add a display name to start your movie night.')
      return
    }
    if (action === 'room:join' && !roomCode.trim()) {
      setError('Enter the room code from your invitation.')
      return
    }
    setBusy(true)
    localStorage.setItem(NAME_KEY, name)
    const id = participantId()
    const authToken = participantCredential()
    let activeSocket = socketRef.current
    if (!activeSocket) {
      activeSocket = io(API_URL, { autoConnect: false, transports: ['websocket', 'polling'] })
      socketRef.current = activeSocket
      activeSocket.on('connect', () => {
        setSocketConnected(true)
        const currentSession = sessionRef.current
        if (currentSession) {
          void emitAck<AckResponse<RoomState>>(activeSocket!, 'room:join', {
            code: currentSession.code,
            displayName: currentSession.displayName,
            participantId: currentSession.participantId,
            authToken: currentSession.authToken,
          }).then((result) => {
            if (result.ok && result.room) {
              setRoom(result.room)
              revealMediaControls()
              setNotice('You are back in the room.')
            }
          }).catch(() => setError('Connection restored, but the room could not be rejoined.'))
        }
      })
      activeSocket.on('disconnect', () => setSocketConnected(false))
      activeSocket.on('connect_error', () => setError('Could not reach the watch-party server. Try again in a moment.'))
      activeSocket.on('room:state', (nextRoom: RoomState) => {
        if (roomRef.current?.playback.sourceUrl !== nextRoom.playback.sourceUrl) {
          setMediaUrl(nextRoom.playback.sourceUrl)
          setMediaError('')
        }
        setRoom(nextRoom)
      })
      activeSocket.on('room:screen-state', (state: { active: boolean }) => setScreenActive(state.active))
      activeSocket.on('room:removed', () => {
        setRoom(null)
        setSession(null)
        sessionRef.current = null
        setError('The host removed you from this room.')
      })
      activeSocket.connect()
    }
    try {
      if (!activeSocket.connected) {
        await new Promise<void>((resolve, reject) => {
          activeSocket!.once('connect', () => resolve())
          activeSocket!.once('connect_error', () => reject(new Error('Could not connect to the watch-party server.')))
        })
      }
      const payload = { displayName: name, participantId: id, authToken, ...(action === 'room:join' ? { code: roomCode.trim().toUpperCase() } : {}) }
      const result = await emitAck<AckResponse<RoomState>>(activeSocket, action, payload)
      if (!result.ok || !result.room || !result.participant) throw new Error(result.error ?? 'Could not enter that room.')
      const nextSession = { code: result.room.code, participantId: result.participant.id, displayName: name, authToken: result.authToken ?? authToken }
      sessionRef.current = nextSession
      setSession(nextSession)
      setRoom(result.room)
      revealMediaControls()
      setMediaUrl(result.room.playback.sourceUrl)
      setMediaError('')
      setRoomCode(result.room.code)
      setError('')
      history.replaceState(null, '', `?room=${result.room.code}`)
      setSocketConnected(true)
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Could not enter the room.')
    } finally {
      setBusy(false)
    }
  }

  function playback(action: 'load' | 'play' | 'pause' | 'seek', currentTime = videoRef.current?.currentTime ?? 0, sourceUrl?: string) {
    if (!room || !session || !socketRef.current) return
    setError('')
    void emitAck<AckResponse<RoomState>>(socketRef.current, 'room:playback', {
      code: room.code, participantId: session.participantId, action, currentTime, sourceUrl,
    }).then((result) => {
      if (!result.ok) setError(result.error ?? 'Playback could not be synchronized.')
    }).catch((issue) => setError(issue instanceof Error ? issue.message : 'Playback could not be synchronized.'))
  }

  function exitScreenFullscreen() {
    const stage = screenStageRef.current
    const fullscreenElement = document.fullscreenElement
    if (stage && fullscreenElement && (fullscreenElement === stage || stage.contains(fullscreenElement))) {
      void document.exitFullscreen().catch(() => {
        setError('Could not exit fullscreen. Press Escape to return to the room.')
      })
    }
  }

  async function toggleFullscreen(target: HTMLElement | null) {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else if (target?.isConnected && target.requestFullscreen) {
        await target.requestFullscreen()
      } else {
        setError('Fullscreen is not available for this player right now.')
      }
    } catch {
      setError('The browser could not change fullscreen mode. Press Escape to exit fullscreen.')
    }
  }

  function revealMediaControls() {
    setMediaControlsVisible(true)
    if (mediaControlsTimerRef.current !== null) window.clearTimeout(mediaControlsTimerRef.current)
    mediaControlsTimerRef.current = window.setTimeout(() => {
      setMediaControlsVisible(false)
      mediaControlsTimerRef.current = null
    }, 2_400)
  }

  function scheduleMediaControlsHide() {
    if (mediaControlsTimerRef.current !== null) window.clearTimeout(mediaControlsTimerRef.current)
    mediaControlsTimerRef.current = window.setTimeout(() => {
      setMediaControlsVisible(false)
      mediaControlsTimerRef.current = null
    }, 2_000)
  }

  async function copyInvite() {
    if (!room) return
    try {
      await navigator.clipboard.writeText(`${location.origin}?room=${room.code}`)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_800)
    } catch {
      setError(`Copy was blocked by the browser. Share room code ${room.code} instead.`)
    }
  }

  function manageParticipant(event: 'room:role' | 'room:remove', targetId: string, role?: Role) {
    if (!room || !session || !socketRef.current) return
    const payload = { code: room.code, participantId: session.participantId, targetId, ...(role ? { role } : {}) }
    void emitAck<AckResponse>(socketRef.current, event, payload).then((result) => {
      if (!result.ok) setError(result.error ?? 'That participant action failed.')
    }).catch((issue) => setError(issue instanceof Error ? issue.message : 'That participant action failed.'))
  }

  async function leaveRoom() {
    if (session && socketRef.current?.connected) {
      try {
        await emitAck(socketRef.current, 'room:leave', { code: session.code, participantId: session.participantId })
      } catch {
        setNotice('The room connection closed before cleanup was confirmed.')
      }
    }
    socketRef.current?.disconnect()
    socketRef.current = null
    sessionRef.current = null
    liveKitRef.current?.disconnect()
    liveKitRef.current = null
    setSocketConnected(false)
    setScreenConnected(false)
    setScreenSharing(false)
    setScreenActive(false)
    setScreenTrack(null)
    setRoom(null)
    setSession(null)
    setMode('video')
    setError('')
    setNotice('')
    history.replaceState(null, '', location.pathname)
  }

  async function connectScreenShare(
    publish: boolean,
    pendingScreenTracks?: ScreenTracksPromise,
    settings: ScreenShareSettings = screenShareSettings,
  ) {
    if (!room || !session) return
    setScreenError('')
    try {
      if (liveKitRef.current) {
        if (publish && pendingScreenTracks) await publishScreenCapture(liveKitRef.current, pendingScreenTracks, settings)
        return
      }
      const response = await fetch(`${API_URL}/api/livekit/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomCode: room.code, participantId: session.participantId, authToken: session.authToken }),
      })
      const credentials = await response.json() as { url?: string; token?: string; error?: string }
      if (!response.ok || !credentials.url || !credentials.token) throw new Error(credentials.error ?? 'Screen sharing is not available.')
      const liveKitRoom = createScreenShareRoom()
      liveKitRoom.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Video) {
          setScreenTrack(track)
          setMode('screen')
        }
        if (track.kind === Track.Kind.Audio) setScreenAudioTrack(track)
      })
      liveKitRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind === Track.Kind.Video) {
          exitScreenFullscreen()
          setScreenTrack(null)
        }
        if (track.kind === Track.Kind.Audio) setScreenAudioTrack(null)
      })
      liveKitRoom.on(RoomEvent.Disconnected, () => {
        if (liveKitRef.current === liveKitRoom) liveKitRef.current = null
        exitScreenFullscreen()
        setScreenConnected(false)
        setScreenSharing(false)
        setScreenActive(false)
        setScreenTrack(null)
        setScreenAudioTrack(null)
        socketRef.current?.emit('screen:active', {
          code: room.code,
          participantId: session.participantId,
          active: false,
        })
      })
      liveKitRef.current = liveKitRoom
      await liveKitRoom.connect(credentials.url, credentials.token)
      setScreenConnected(true)
      for (const remote of liveKitRoom.remoteParticipants.values()) {
        for (const publication of remote.trackPublications.values()) {
          if (publication.track?.kind === Track.Kind.Video) setScreenTrack(publication.track)
          if (publication.track?.kind === Track.Kind.Audio) setScreenAudioTrack(publication.track)
        }
      }
      if (publish && pendingScreenTracks) await publishScreenCapture(liveKitRoom, pendingScreenTracks, settings)
    } catch (issue) {
      setScreenError(issue instanceof Error ? issue.message : 'Could not connect to screen sharing.')
      liveKitRef.current?.disconnect()
      liveKitRef.current = null
      setScreenConnected(false)
    }
  }

  function startScreenShare() {
    if (!room || !session) return
    setScreenError('')
    const settings = { ...screenShareSettings }
    try {
      // Start native capture immediately in the click gesture; network setup runs after.
      const pendingScreenTracks = requestScreenCapture(settings)
      const liveKitRoom = liveKitRef.current
      if (liveKitRoom) void publishScreenCapture(liveKitRoom, pendingScreenTracks, settings)
      else void connectScreenShare(true, pendingScreenTracks, settings)
    } catch (issue) {
      setScreenError(screenCaptureError(issue))
    }
  }

  async function publishScreenCapture(
    liveKitRoom: LiveKitRoomType,
    pendingScreenTracks: ScreenTracksPromise,
    settings: ScreenShareSettings,
  ) {
    try {
      const { videoTrack, audioTrack } = await publishScreenTracks(liveKitRoom, pendingScreenTracks, settings)
      setScreenTrack(videoTrack)
      setScreenAudioTrack(audioTrack)
      setScreenSharing(true)
      setMode('screen')
      videoTrack.mediaStreamTrack.addEventListener('ended', stopScreenShare, { once: true })
      socketRef.current?.emit('screen:active', { code: room?.code, participantId: session?.participantId, active: true })
    } catch (issue) {
      setScreenError(screenCaptureError(issue))
    }
  }

  function screenCaptureError(issue: unknown) {
    if (issue instanceof Error && ['NotAllowedError', 'PermissionDeniedError'].includes(issue.name)) {
      return 'Screen capture was denied. Click Share my screen and approve the browser sharing prompt.'
    }
    return issue instanceof Error ? issue.message : 'Screen sharing was cancelled or unavailable.'
  }

  function updateScreenShareSettings(update: Partial<ScreenShareSettings>) {
    const next = { ...screenShareSettings, ...update }
    setScreenShareSettings(next)
    localStorage.setItem('lumaloop.screenShareSettings', JSON.stringify(next))
  }

  function stopScreenShare() {
    exitScreenFullscreen()
    const liveKitRoom = liveKitRef.current
    if (liveKitRoom) stopPublishedScreenShare(liveKitRoom)
    socketRef.current?.emit('screen:active', { code: room?.code, participantId: session?.participantId, active: false })
    setScreenSharing(false)
    setScreenTrack(null)
    setScreenAudioTrack(null)
  }

  if (!room || !session) {
    return (
      <main className="entry-shell">
        <div className="entry-backdrop" aria-hidden="true" />
        <header className="topbar entry-topbar">
          <a className="brand" href="/" aria-label="LumaLoop home"><span className="brand-mark"><Film size={19} strokeWidth={2.2} /></span><span>LumaLoop</span></a>
          <div className="topbar-note"><span className="status-dot" /> A little closer, even from far away</div>
        </header>
        <section className="entry-content">
          <div className="entry-copy">
            <p className="eyebrow"><Clapperboard size={14} /> YOUR PRIVATE SCREENING ROOM</p>
            <h1>Good stories<br /><em>are better shared.</em></h1>
            <p className="entry-description">Press play together, wherever everyone happens to be.</p>
            <div className="film-strip" aria-label="A quiet night at the movies">
              <img src="https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=960&q=85" alt="Rows of red cinema seats facing a movie screen" />
              <div className="film-caption"><span>TONIGHT'S FEATURE</span><strong>Your people. Your pick.</strong></div>
              <div className="film-index">01 <span>/</span> 03</div>
            </div>
          </div>
          <div className="entry-panel">
            <div className="panel-heading"><span className="panel-icon"><Users size={19} /></span><div><h2>Start your watch party</h2><p>No accounts. Just a name and a link.</p></div></div>
            <label className="field-label" htmlFor="display-name">Your name</label>
            <input id="display-name" className="text-input" value={displayName} maxLength={32} placeholder="What should we call you?" onChange={(event) => setDisplayName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void connectToRoom('room:create') }} />
            <button className="primary-button create-button" type="button" disabled={busy} onClick={() => void connectToRoom('room:create')}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={18} />} Create a room <ArrowUpRight size={17} />
            </button>
            <div className="form-divider"><span /> OR JOIN YOUR FRIENDS <span /></div>
            <label className="field-label" htmlFor="room-code">Room code</label>
            <div className="join-row">
              <div className="code-field"><Link2 size={17} /><input id="room-code" value={roomCode} maxLength={6} placeholder="e.g. H7K9Q2" onChange={(event) => setRoomCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} onKeyDown={(event) => { if (event.key === 'Enter') void connectToRoom('room:join') }} /></div>
              <button className="secondary-button join-button" type="button" disabled={busy} onClick={() => void connectToRoom('room:join')}>{busy ? <LoaderCircle className="spin" size={17} /> : <>Join room <ArrowUpRight size={16} /></>}</button>
            </div>
            {error && <p className="inline-error" role="alert">{error}</p>}
            <div className="privacy-note"><ShieldCheck size={16} /><span>Your room is private to anyone with its invite link. No account needed.</span><CircleHelp size={15} aria-label="No user tracking or passwords" /></div>
          </div>
        </section>
        <footer className="entry-footer"><span>© 2026 LumaLoop</span><span>Made for movie nights, long distance and otherwise</span></footer>
      </main>
    )
  }

  const playbackState = room.playback
  const elapsed = playbackState.currentTime + (playbackState.isPlaying ? Math.max(0, Date.now() - playbackState.updatedAt) / 1000 : 0)
  const mediaFormatError = playbackSource && !/\.(mp4|webm|m3u8)$/i.test(new URL(playbackSource).pathname)
    ? 'Use a direct MP4, WebM, or M3U8 link. Protected or provider-hosted streams may not be playable here.'
    : ''
  const visibleMediaError = mediaError || mediaFormatError

  return (
    <main className="room-shell">
      <header className="topbar room-topbar">
        <a className="brand" href="/" onClick={(event) => { event.preventDefault(); leaveRoom() }} aria-label="Leave room and go home"><span className="brand-mark"><Film size={19} strokeWidth={2.2} /></span><span>LumaLoop</span></a>
        <div className="room-context"><span className="room-live-dot" /><span className="room-context-label">PRIVATE ROOM</span><span className="context-divider">/</span><strong>{room.code}</strong></div>
        <div className="topbar-actions"><button className="invite-button" type="button" onClick={() => void copyInvite()}>{copied ? <Check size={16} /> : <Copy size={16} />}<span>{copied ? 'Copied' : 'Invite'}</span></button><button className="icon-button leave-button" type="button" title="Leave room" aria-label="Leave room" onClick={leaveRoom}><LogOut size={17} /></button></div>
      </header>
      <div className="room-workspace">
        <section className="watch-column">
          <div className="watch-heading"><div><p className="eyebrow">NOW PLAYING TOGETHER</p><h1>{mode === 'video' ? 'The screening room' : 'On the big screen'}</h1></div><div className={`connection-pill ${socketConnected ? 'is-online' : 'is-offline'}`}><span />{socketConnected ? 'Connected' : 'Reconnecting'}</div></div>
          <nav className="mode-tabs" aria-label="Room mode">
            <button className={mode === 'video' ? 'active' : ''} type="button" onClick={() => { setMode('video'); revealMediaControls() }}><Film size={16} /> Watch video</button>
            <button className={mode === 'screen' ? 'active' : ''} type="button" onClick={() => { setMode('screen'); revealMediaControls(); if (!screenConnected) void connectScreenShare(false) }}><MonitorPlay size={16} /> Screen share{screenActive && <span className="tab-live-dot" />}</button>
          </nav>
          {mode === 'video' ? (
            <>
              <div className="media-frame" ref={mediaFrameRef} onPointerEnter={revealMediaControls} onPointerMove={revealMediaControls} onPointerDown={revealMediaControls} onPointerLeave={scheduleMediaControlsHide} onFocusCapture={revealMediaControls}>
                {playbackState.sourceUrl ? <video ref={videoRef} className="video-player" playsInline muted={muted} controls={canControl} onPlay={() => { if (canControl && !playbackState.isPlaying) playback('play') }} onPause={() => { if (canControl && playbackState.isPlaying) playback('pause') }} onSeeked={() => { if (syncingSeekRef.current) { syncingSeekRef.current = false; return } if (canControl) playback('seek') }} onLoadedMetadata={() => { const current = roomRef.current?.playback; if (current && videoRef.current) videoRef.current.currentTime = current.currentTime }} onError={() => setMediaError('This video could not be loaded. The link may be private, blocked by CORS, or require provider access.')} /> : <div className="empty-player"><div className="reel-icon"><Film size={31} /></div><p className="eyebrow">THE SCREEN IS YOURS</p><h2>Pick the first feature.</h2><p>Paste a direct MP4, WebM, or M3U8 link to begin.</p></div>}
                {visibleMediaError && playbackState.sourceUrl && <div className="player-error" role="alert"><CircleHelp size={20} /><span>{visibleMediaError}</span></div>}
                <div className={`player-corner-mark ${mediaControlsVisible ? 'is-obscured' : ''}`}><span className="brand-mark"><Film size={14} /></span> LUMALOOP</div>
                {playbackState.sourceUrl && <div className={`playback-meta media-controls-overlay ${mediaControlsVisible ? 'controls-visible' : 'controls-hidden'}`} aria-hidden={!mediaControlsVisible}>
                  <div className="playback-status"><span className={playbackState.isPlaying ? 'playing-pulse' : 'paused-mark'} />{playbackState.isPlaying ? 'Playing in sync' : 'Paused'}<span className="timecode">{readableTime(elapsed)}</span></div>
                  <div className="media-local-actions">
                    <button className="local-audio" type="button" title={muted ? 'Unmute this device' : 'Mute this device'} aria-label={muted ? 'Unmute this device' : 'Mute this device'} onClick={() => { const next = !muted; setMuted(next); localStorage.setItem('lumaloop.muted', String(next)) }}>{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}<span>{muted ? 'Unmute me' : 'Mute me'}</span></button>
                    <button className="icon-button media-fullscreen-button" type="button" title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} onClick={() => void toggleFullscreen(mediaFrameRef.current)}>{isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
                  </div>
                </div>}
              </div>
              {canControl && <form className="source-form" onSubmit={(event) => { event.preventDefault(); playback('load', 0, mediaUrl.trim()) }}><div className="source-label"><span className="mini-label">VIDEO SOURCE</span><span>Direct links only</span></div><div className="source-row"><input aria-label="Video URL" value={mediaUrl} onChange={(event) => setMediaUrl(event.target.value)} placeholder="Paste an MP4, WebM or HLS link"/><button type="submit" disabled={!mediaUrl.trim()}><Play size={15} /> Load video</button></div></form>}
              {!canControl && playbackState.sourceUrl && <div className="guest-status"><ShieldCheck size={15} /> Playback is directed by {room.participants.find((participant) => participant.role === 'host')?.displayName ?? 'the host'}.</div>}
            </>
          ) : (
            <div className="screen-experience" onPointerEnter={revealMediaControls} onPointerMove={revealMediaControls} onPointerDown={revealMediaControls} onPointerLeave={scheduleMediaControlsHide} onFocusCapture={revealMediaControls}>
            <div className="screen-stage" ref={screenStageRef}>
              {screenTrack ? <><video ref={screenVideoRef} className="screen-video" autoPlay playsInline /><audio ref={screenAudioRef} autoPlay muted={screenAudioMuted} /></> : <div className="screen-empty"><div className="screen-empty-icon"><ScreenShare size={28} /></div><p className="eyebrow">LIVE SCREEN SHARE</p><h2>{screenConnected ? 'Waiting for a screen' : 'Bring everyone to the same screen.'}</h2><p>{screenConnected ? canControl ? 'Open your video source in another tab, then choose it in the share picker. Enable Share tab audio if available.' : 'The host or co-host can start sharing at any time.' : 'Connect to the room screen, then choose a browser tab, window, or display to share.'}</p>{!screenConnected && <button className="secondary-button" type="button" onClick={() => void connectScreenShare(false)}><MonitorPlay size={16} /> Connect to screen</button>}</div>}
              <div className={`screen-stage-footer media-controls-overlay ${mediaControlsVisible ? 'controls-visible' : 'controls-hidden'}`} aria-hidden={!mediaControlsVisible}>
                <span><span className={screenActive ? 'playing-pulse' : 'paused-mark'} />{screenActive ? 'Screen is live' : screenConnected ? 'Connected to screen room' : 'Not connected'}</span>
                <div className="screen-footer-actions">
                  <button className="local-audio" type="button" title={screenAudioMuted ? 'Unmute this device' : 'Mute this device'} aria-label={screenAudioMuted ? 'Unmute this device' : 'Mute this device'} onClick={() => setScreenAudioMuted((current) => !current)}>{screenAudioMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}<span>{screenAudioMuted ? 'Unmute me' : 'Mute me'}</span></button>
                  <button className="icon-button media-fullscreen-button" type="button" title={isFullscreen ? 'Exit fullscreen' : screenTrack ? 'Enter fullscreen' : 'Fullscreen unavailable'} aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} onClick={() => { if (document.fullscreenElement || screenTrack) void toggleFullscreen(screenStageRef.current) }}>{isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
                  {screenSharing ? <button className="stop-share" type="button" onClick={stopScreenShare}><X size={15} /> Stop sharing</button> : canControl && !screenActive && <button className="share-button" type="button" onClick={startScreenShare}><ScreenShare size={16} /> Choose what to share</button>}
                </div>
              </div>
              {screenError && <p className="inline-error screen-error" role="alert">{screenError}</p>}
              {!canControl && !screenTrack && <p className="screen-limit-note"><Mic2 size={14} /> Screen audio is shared when supported by your browser.</p>}
            </div>
            {canControl && mediaControlsVisible && <div className="screen-settings-strip" aria-label="Screen-share settings">
              <label className="screen-setting">
                <span>QUALITY</span>
                <select value={screenShareSettings.quality} disabled={screenSharing} onChange={(event) => updateScreenShareSettings({ quality: event.target.value as ScreenQuality })}>
                  <option value="auto">Auto · up to 1080p</option>
                  <option value="480p">480p · low bandwidth</option>
                  <option value="720p">720p · balanced</option>
                  <option value="1080p">1080p · Full HD</option>
                </select>
              </label>
              <label className="screen-setting">
                <span>CONTENT</span>
                <select value={screenShareSettings.contentProfile} disabled={screenSharing} onChange={(event) => updateScreenShareSettings({ contentProfile: event.target.value as ScreenContentProfile })}>
                  <option value="auto">Auto · balanced</option>
                  <option value="detail">Detail · text and websites</option>
                  <option value="motion">Motion · video and games</option>
                </select>
              </label>
              <label className="screen-setting screen-fps-setting">
                <span>FRAME RATE</span>
                <select value={screenShareSettings.frameRate} disabled={screenSharing} onChange={(event) => updateScreenShareSettings({ frameRate: Number(event.target.value) as ScreenFrameRate })}>
                  <option value="30">30 FPS · recommended</option>
                  <option value="60">60 FPS · smoother motion</option>
                </select>
              </label>
              <label className="screen-audio-toggle">
                <input type="checkbox" checked={screenShareSettings.shareAudio} disabled={screenSharing} onChange={(event) => updateScreenShareSettings({ shareAudio: event.target.checked })} />
                <span>Share available audio</span>
              </label>
              <section className="bandwidth-guide" aria-label="Upload bandwidth guide">
                <div className="bandwidth-guide-heading">
                  <div><span className="bandwidth-kicker">NETWORK PLANNER</span><h3>Choose settings for your upload</h3></div>
                  <span className="bandwidth-live">ESTIMATES</span>
                </div>
                <label className="bandwidth-speed-input">
                  <span>Your upload speed</span>
                  <div><input type="number" min="0.1" max="10000" step="0.1" inputMode="decimal" value={uploadSpeedMbps} onChange={(event) => setUploadSpeedMbps(event.target.value)} aria-label="Upload speed in megabits per second" /><strong>Mbps</strong></div>
                </label>
                {(() => {
                  const speed = Number(uploadSpeedMbps)
                  const validSpeed = Number.isFinite(speed) && speed > 0
                  const estimate = estimateScreenShareBandwidth(screenShareSettings)
                  const recommendation = recommendScreenSettings(validSpeed ? speed : 0)
                  const enough = validSpeed && speed >= estimate.uploadNeeded
                  return <>
                    <div className="bandwidth-current">
                      <div><span>CURRENT SETTINGS · ESTIMATED USE</span><strong>{formatMbps(estimate.low)}–{formatMbps(estimate.high)} Mbps</strong><small>about {(estimate.low * 0.45).toFixed(1)}–{(estimate.high * 0.45).toFixed(1)} GB per hour</small></div>
                      <div className={validSpeed ? enough ? 'bandwidth-status is-good' : 'bandwidth-status is-tight' : 'bandwidth-status'}>{validSpeed ? enough ? 'Good headroom' : 'May struggle' : 'Enter a valid speed'}</div>
                    </div>
                    <p className="bandwidth-explanation">{validSpeed ? <>For these settings, aim for at least <strong>{formatMbps(estimate.uploadNeeded)} Mbps upload</strong>. This includes roughly 30% headroom for network variation. {enough ? 'Your entered speed should have reasonable headroom.' : 'Your entered speed is below the recommended target; consider the settings below.'}</> : 'Enter your measured upload speed to see a recommendation.'}</p>
                    <div className="bandwidth-recommendation">
                      <div><span>RECOMMENDED FOR YOUR UPLOAD</span><strong>{recommendation.quality} · {recommendation.frameRate} FPS · Motion</strong><small>{recommendation.label}</small></div>
                      <button type="button" disabled={!validSpeed || screenSharing} onClick={() => updateScreenShareSettings({ quality: recommendation.quality, frameRate: recommendation.frameRate, contentProfile: recommendation.contentProfile })}>Apply settings</button>
                    </div>
                    <p className="bandwidth-footnote">These are planning estimates, not fixed consumption. Actual bitrate changes with motion, browser encoder, codec, resolution and network conditions. Upload is sent once to the LiveKit server, not once per viewer. Measure upload with other uploads paused; use a wired connection when possible.</p>
                  </>
                })()}
              </section>
              <p className="screen-settings-note">{screenSharing ? 'Stop sharing to change these settings; they apply the next time you share.' : '1080p is the maximum. The stream prioritizes keeping text sharp under congestion; on weak connections it may reduce frame rate rather than blur the image. 30 FPS is recommended; use 60 FPS for fast games if your upload can sustain it.'}</p>
            </div>}
            </div>
          )}
          {error && <p className="inline-error room-error" role="alert">{error}</p>}
          {notice && <p className="inline-notice" role="status">{notice}</p>}
          <div className="room-bottomline"><span><ShieldCheck size={15} /> No accounts or passwords</span><span>Share only media you have permission to watch.</span></div>
        </section>
        <aside className="people-panel">
          <div className="people-heading"><div><p className="eyebrow">THE COMPANY</p><h2>In the room <span>{room.participants.filter((participant) => participant.connected).length}</span></h2></div><Users size={18} /></div>
          <div className="people-list">
            {room.participants.map((participant, index) => {
              const isSelf = participant.id === session.participantId
              return <div className={`person-row ${!participant.connected ? 'is-away' : ''}`} key={participant.id} style={{ animationDelay: `${index * 45}ms` }}>
                <div className={`avatar avatar-${index % 5}`}>{participant.displayName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</div>
                <div className="person-copy"><strong>{participant.displayName}{isSelf && <span className="you-tag">YOU</span>}</strong><span>{participant.connected ? participant.role === 'cohost' ? 'Co-host' : participant.role === 'host' ? 'Room host' : 'Guest' : 'Reconnecting...'}</span></div>
                {participant.role === 'host' ? <Crown className="role-icon host-icon" size={15} aria-label="Host" /> : isHost && !isSelf ? <div className="person-actions"><select aria-label={`Set ${participant.displayName} role`} value={participant.role} onChange={(event) => manageParticipant('room:role', participant.id, event.target.value as Role)}><option value="guest">Guest</option><option value="cohost">Co-host</option></select><button type="button" title={`Remove ${participant.displayName}`} aria-label={`Remove ${participant.displayName}`} onClick={() => manageParticipant('room:remove', participant.id)}><X size={14} /></button></div> : participant.role === 'cohost' ? <span className="cohost-tag">CO-HOST</span> : <span className="guest-dot" />}
              </div>
            })}
          </div>
          <div className="invite-block"><div className="invite-block-head"><span className="invite-icon"><Link2 size={16} /></span><div><strong>Bring someone in</strong><span>They can join with this room code.</span></div></div><button className="room-code-button" type="button" onClick={() => void copyInvite()}><span>{room.code}</span>{copied ? <Check size={16} /> : <Copy size={16} />}</button><p className="invite-footnote">Anyone with the invite link can enter. Share it privately.</p></div>
          <div className="role-note"><Crown size={15} /><span>{isHost ? 'You are the host. You can promote a co-host and manage the room.' : canControl ? 'You can manage playback as a co-host.' : 'The host and co-host manage playback.'}</span><ChevronDown size={14} /></div>
          <div className="connection-note"><span className={socketConnected ? 'connected-indicator' : 'disconnected-indicator'} />{socketConnected ? 'Everyone is up to date' : 'Reconnecting to the room'}<span className="connection-lock"><ShieldCheck size={14} /></span></div>
        </aside>
      </div>
    </main>
  )
}

export default App
