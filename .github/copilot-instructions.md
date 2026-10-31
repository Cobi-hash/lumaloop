# LumaLoop Workspace Guidance

- This is a no-account watch-party app. Never add registration, passwords, DRM circumvention, or provider/CORS bypasses.
- The Vite/React client deploys to Vercel. The Express/Socket.IO service deploys as a persistent Node web service on Render, never as a Vercel function.
- Keep LiveKit API credentials on the server. Room broadcasts must not include participant session credentials. Guests may subscribe; only hosts and co-hosts may publish screens or control playback.
- Keep participant mute preferences local to each browser. Shared playback state must not mutate local audio settings.
- Use `npm run dev` for both local services, `npm run build` for production builds, and `npm test` for backend tests.
- Room state is in memory. Keep the Render service to one instance unless shared storage and a Socket.IO adapter are added.

## Setup Checklist

- [x] Clarify project requirements: React/TypeScript client, Node/TypeScript service, Vercel and Render deployment.
- [x] Scaffold the project workspace.
- [x] Implement the branded client, room state, playback sync, participant roles, and LiveKit screen-share flow.
- [x] No additional VS Code extensions are required.
- [x] Compile and test the client and backend.
- [x] No custom VS Code task is required; npm scripts cover local development and verification.
- [x] Launch the local application after user confirmation.
- [x] Document environment variables, deployment steps, external services, and limitations in README.md.
