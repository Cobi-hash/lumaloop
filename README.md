# LumaLoop

LumaLoop is an anonymous watch-party app: enter a display name, create or join a private room, and watch a direct video link together. Rooms also have a separate LiveKit screen-sharing mode. No account or password is collected.

## Stack and Architecture

- **Frontend:** React 19, TypeScript, Vite, Socket.IO client, HLS.js, and LiveKit client. Deploy the static bundle to Vercel.
- **Realtime backend:** TypeScript, Express, Socket.IO, and the LiveKit server SDK. Deploy as a persistent Node web service on Render. Do not deploy this service as a Vercel function.
- **Room state:** held in backend memory. Socket.IO broadcasts room membership and playback state. A private browser credential protects participant reconnects and LiveKit token requests; it is not broadcast.
- **Screen sharing:** LiveKit SFU carries screen video and optional captured audio. The backend issues short-lived tokens; guests can subscribe, while hosts and co-hosts can publish.

## Local Development

Prerequisites: Node.js 22.12 or newer and npm (Vite's supported runtime floor).

```powershell
Copy-Item .env.example .env
Copy-Item server/.env.example server/.env
npm install
npm ci --prefix server
npm run dev
```

Open `http://localhost:5173`. The root `dev` script starts Vite and the Socket.IO server together. Direct video rooms and participant presence work without LiveKit credentials; screen-share controls return a clear configuration message until credentials are set.

Set `VITE_API_URL` in the root `.env` only when the backend is not at `http://localhost:3001`. Set `FRONTEND_ORIGINS` in `server/.env` to the exact comma-separated browser origins, with no trailing slash.

## Media Support and Restrictions

Paste a direct `.mp4`, `.webm`, or `.m3u8` URL. The URL must be reachable by every participant's browser. HLS uses native browser playback where available and HLS.js otherwise. Synchronization broadcasts load, play, pause, and seek state; new arrivals receive the current position. Small playback drift is corrected locally without changing another participant's mute preference.

A stream can still fail because its server blocks cross-origin requests, requires cookies or authorization, has expired, or uses a format the browser cannot decode. The app does not proxy media, bypass CORS, defeat provider restrictions, or circumvent DRM. Use only media you are allowed to access and share.

## Deploy Backend to Render

The included `render.yaml` is a Render Blueprint for the persistent API service.

1. Push this repository to a Git provider and create a Render Blueprint from it, or create a Web Service manually.
2. For a manual service, set **Root Directory** to `server`, **Build Command** to `npm ci --include=dev && npm run build`, and **Start Command** to `npm start`.
3. Keep the service as a persistent Node web service. Render supplies `PORT`; the server binds to `0.0.0.0` and exposes `GET /health`.
4. Configure these environment variables in Render:

| Variable | Required | Value |
| --- | --- | --- |
| `FRONTEND_ORIGINS` | Yes | Exact Vercel production origin, plus any preview/custom origins that should be allowed, comma-separated |
| `LIVEKIT_URL` | For screen sharing | LiveKit Cloud or self-hosted server URL, normally `wss://...` |
| `LIVEKIT_API_KEY` | For screen sharing | LiveKit API key |
| `LIVEKIT_API_SECRET` | For screen sharing | LiveKit API secret; keep it only in Render |
| `PORT` | No | Assigned by Render; do not hardcode it in production |

Use a single Render instance for this in-memory version. If Render assigns a public service URL such as `https://lumaloop-api.onrender.com`, keep that HTTPS origin for the frontend; Socket.IO negotiates secure WebSocket connections automatically. Render free web services may spin down after inactivity, so use an always-on instance where uninterrupted availability is required.

## Deploy Frontend to Vercel

1. Import the repository as a Vercel project with the repository root as the project root.
2. Set the build command to `npm run build:client` and the output directory to `dist` (also defined in `vercel.json`). Install with `npm install` or Vercel's normal npm install step.
3. Set `VITE_API_URL` to the Render service origin, for example `https://lumaloop-api.onrender.com`, with no trailing slash.
4. Add the exact Vercel origin to Render's `FRONTEND_ORIGINS`, redeploy the backend, then redeploy the frontend.
5. For preview deployments, add each permitted preview origin to `FRONTEND_ORIGINS`. The server intentionally does not allow every origin by default.

Vercel hosts only the static website. Socket.IO and LiveKit token issuance remain on Render.

## Configure LiveKit

Create a LiveKit Cloud project or operate a compatible LiveKit server/SFU. Copy its WebSocket URL, API key, and API secret into Render's `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`. Never put the secret in a `VITE_*` variable. Screen sharing requires a secure browser context (localhost is allowed for development), user permission, and a browser that supports `getDisplayMedia`. Choosing tab/window/display and capturing its audio depend on the browser and operating system. LiveKit is an external service and may have usage charges; it is not required for direct video playback.

## Commands and Tests

```powershell
npm run dev
npm run build
npm test
npm run lint
```

`npm run build` compiles the frontend and backend. `npm test` runs the backend's room-state and Socket.IO integration tests, including role restrictions, seek and late-join synchronization, reconnect grace, room cleanup, screen-share status, and LiveKit token grants.

## Operational Limitations

- Room state is in memory and is lost when the Render process restarts or redeploys. The current setup supports one backend instance; horizontal scaling needs shared room storage and a Socket.IO adapter such as Redis.
- Rooms hold at most 16 participants. A participant who disconnects has 30 seconds to reconnect; empty rooms are deleted. When a host leaves, the earliest connected participant becomes host.
- Invitation links are room codes, not authentication. Anyone with a link can enter. Share links privately.
- Playback synchronization coordinates independently loaded browser media; it cannot guarantee identical buffering or frame timing across networks.
- LiveKit credentials are required for multi-person screen sharing. If that external service is unavailable, video rooms continue to work.
- Screen share is real-time browser capture, not a recording. Audio capture and available share targets vary by browser/device.
