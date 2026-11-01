import {
  BackupCodecPolicy,
  Room,
  RoomEvent,
  Track,
  createLocalScreenTracks,
} from 'livekit-client'

export type ScreenQuality = 'auto' | '480p' | '720p' | '1080p'
export type ScreenFrameRate = 30 | 60
export type ScreenContentProfile = 'auto' | 'detail' | 'motion'
export type ScreenTracksPromise = ReturnType<typeof createLocalScreenTracks>

export interface ScreenShareSettings {
  quality: ScreenQuality
  frameRate: ScreenFrameRate
  contentProfile: ScreenContentProfile
  shareAudio: boolean
}

export const SCREEN_SETTINGS_KEY = 'lumaloop.screenShareSettings'
export const DEFAULT_SCREEN_SETTINGS: ScreenShareSettings = {
  quality: 'auto',
  frameRate: 30,
  contentProfile: 'auto',
  shareAudio: true,
}

const SCREEN_QUALITY_PRESETS = {
  auto: { width: 1920, height: 1080, maxBitrate: 4_500_000 },
  '480p': { width: 854, height: 480, maxBitrate: 1_000_000 },
  '720p': { width: 1280, height: 720, maxBitrate: 2_500_000 },
  '1080p': { width: 1920, height: 1080, maxBitrate: 4_500_000 },
} as const

export function readScreenShareSettings(): ScreenShareSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SCREEN_SETTINGS_KEY) ?? 'null') as Partial<ScreenShareSettings> | null
    return {
      quality: saved?.quality === '480p' || saved?.quality === '720p' || saved?.quality === '1080p' ? saved.quality : 'auto',
      frameRate: saved?.frameRate === 60 ? 60 : 30,
      contentProfile: saved?.contentProfile === 'detail' || saved?.contentProfile === 'motion' ? saved.contentProfile : 'auto',
      shareAudio: typeof saved?.shareAudio === 'boolean' ? saved.shareAudio : DEFAULT_SCREEN_SETTINGS.shareAudio,
    }
  } catch {
    return DEFAULT_SCREEN_SETTINGS
  }
}

export function createScreenShareRoom() {
  return new Room({
    adaptiveStream: true,
    dynacast: true,
    // Keep the media transport independent of React component lifecycle.
    disconnectOnPageLeave: true,
  })
}

export function requestScreenCapture(settings: ScreenShareSettings): ScreenTracksPromise {
  const preset = SCREEN_QUALITY_PRESETS[settings.quality]
  const contentHint = settings.contentProfile === 'detail' ? 'detail' : 'motion'

  // This function must be called directly from the user's click handler. Do not
  // await token fetches or dynamic imports before opening the browser picker.
  return createLocalScreenTracks({
    audio: settings.shareAudio,
    video: { displaySurface: 'browser' },
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    resolution: {
      width: preset.width,
      height: preset.height,
      frameRate: settings.frameRate,
    },
    contentHint,
    systemAudio: settings.shareAudio ? 'include' : 'exclude',
  })
}

export async function publishScreenCapture(
  room: Room,
  pendingTracks: ScreenTracksPromise,
  settings: ScreenShareSettings,
) {
  const tracks = await pendingTracks
  const videoTrack = tracks.find((track) => track.kind === Track.Kind.Video)
  const audioTrack = tracks.find((track) => track.kind === Track.Kind.Audio)

  if (!videoTrack) {
    tracks.forEach((track) => track.stop())
    throw new Error('Your browser did not provide a screen video track.')
  }

  const preset = SCREEN_QUALITY_PRESETS[settings.quality]
  const publishedTracks: typeof tracks = []
  videoTrack.mediaStreamTrack.contentHint = settings.contentProfile === 'detail' ? 'detail' : 'motion'

  // Prefer H.264 for this controlled performance experiment. Chromium on many
  // Windows devices can use hardware H.264 encoding/decoding; VP8 remains the
  // compatibility fallback for clients that cannot receive H.264.
  const frameRateFactor = settings.frameRate === 60 ? 1.35 : 1
  try {
    await room.localParticipant.publishTrack(videoTrack, {
      source: Track.Source.ScreenShare,
      videoCodec: 'h264',
      backupCodec: { codec: 'vp8' },
      backupCodecPolicy: BackupCodecPolicy.PREFER_REGRESSION,
      simulcast: false,
      screenShareEncoding: {
        maxBitrate: Math.round(preset.maxBitrate * frameRateFactor),
        maxFramerate: settings.frameRate,
      },
      // Balanced degradation avoids forcing either extreme: preserve readable
      // detail while reducing frame rate/resolution gradually under congestion.
      degradationPreference: 'balanced',
    })
    publishedTracks.push(videoTrack)

    if (audioTrack) {
      await room.localParticipant.publishTrack(audioTrack, {
        source: Track.Source.ScreenShareAudio,
      })
      publishedTracks.push(audioTrack)
    }
  } catch (error) {
    for (const track of publishedTracks) {
      await room.localParticipant.unpublishTrack(track, true).catch(() => track.stop())
    }
    for (const track of tracks) {
      if (!publishedTracks.includes(track)) track.stop()
    }
    throw error
  }

  return { videoTrack, audioTrack: audioTrack ?? null }
}

export function stopPublishedScreenShare(room: Room) {
  for (const publication of room.localParticipant.trackPublications.values()) {
    if (
      (publication.source === Track.Source.ScreenShare || publication.source === Track.Source.ScreenShareAudio)
      && publication.track
    ) {
      void room.localParticipant.unpublishTrack(publication.track, true)
    }
  }
}

export { RoomEvent, Track }
export type ScreenShareRoom = Room
