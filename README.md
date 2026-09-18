# Peerly

Free, private, peer-to-peer video meetings in the browser. No accounts, no installs, no time limits. Create a room, share the link, talk.

Media goes directly between participants over WebRTC (end-to-end encrypted by DTLS-SRTP). The Node.js server only coordinates: it relays connection setup, chat and meeting state, and never sees audio or video.

## Features

**In the call**
- Meeting rooms with shareable links (`/room/abc-defg-hij`) and a pre-join lobby: camera preview, mic level meter, device and speaker pickers
- Up to 8 people per meeting (`MAX_ROOM_SIZE`), in an auto-fitting grid or a spotlight view (pin anyone; presentations spotlight themselves)
- Screen sharing with the presenter’s camera still visible, including tab audio where the browser supports it
- **Background blur and virtual backgrounds**: two blur strengths, six built-in backgrounds, or upload your own. Segmentation runs on your device (MediaPipe), and the background stays blurred while the model loads so it’s never briefly exposed
- **Reactions** with floating animations, a flash on the sender’s tile, and a celebration burst when several people react together
- **Private messages**: message everyone or one person; incoming private messages notify you with a Reply shortcut
- Raise hand (with queue order), active-speaker highlight, “you’re muted” reminder, connection quality indicators, and a “video paused” hint when a stream stalls
- Local recording (saved to your downloads; everyone sees a REC badge)
- Keyboard shortcuts (`?` lists them), data saver mode, screen wake lock, and a layout that works on phones

**Captions, transcript and AI notes**
- The host turns on the transcript, and everyone gets **live captions** with speaker names. Each person’s browser transcribes their own microphone (Chrome and Edge use their built-in speech service), so attribution is exact and Peerly’s server only receives text
- **Catch me up**: an AI recap of the meeting so far, for late joiners or anyone who stepped away
- **Meeting notes page** when the meeting ends: an AI summary, key points, decisions, action items with owners and due dates, open questions, a topic timeline, who spoke and for how long, the timeline, the full searchable transcript and the public chat. Download it as Markdown or print it. Private messages are never included
- AI features use Claude (`claude-opus-5` with structured output). Without an API key everything else, including the transcript and notes page, still works

**Host controls**
- Ask-to-join waiting room (admit or deny, or open the meeting to let everyone in)
- Mute someone or everyone, turn off someone’s camera, lower hands, remove people (they can’t rejoin from that browser)
- Approve who can present, turn private messages off, hand over the host role, end the meeting for everyone
- If the host drops, the longest-present participant takes over

**Reliability**
- **Brief network drops don’t end the call.** Peer connections stay up while the signaling connection reconnects; everyone else just sees “Reconnecting…” on your tile
- **Reloading the page puts you straight back** in the same seat
- **Server restarts and deploys don’t drop calls.** Media keeps flowing peer-to-peer while the server is down; clients reconnect, prove who they are with signed tokens, and the meeting is rebuilt, with the real host getting the role back (needs `SESSION_SECRET`)
- ICE restarts with backoff, automatic connection rebuilds, a frozen-video watchdog, and per-viewer adaptive bitrate (thumbnails get a fraction of the bandwidth of a spotlighted tile)
- Falls back to the default device when a microphone or camera is unplugged

## Run locally

```bash
npm install
npm start          # http://localhost:4800
```

To try AI notes locally, start it with a key: `ANTHROPIC_API_KEY=sk-ant-... npm start`.

Browsers only allow camera and mic on `localhost` or HTTPS. To test a call on one computer, open the room link in a normal window and a private window.

```bash
npm test           # unit + integration tests (node:test)
npm run lint       # ESLint
npm run dev        # restart on file changes
```

## Deploy

### Render

`render.yaml` describes the service. Create it with **New > Blueprint** and pick this repository, or create a **Web Service** manually with build command `npm ci --omit=dev` and start command `node server.js`. Pushes to `main` deploy automatically.

Then set these in the service’s **Environment** tab:

| Variable | Why |
|---|---|
| `ANTHROPIC_API_KEY` | Turns on AI meeting notes and “catch me up” |
| `SESSION_SECRET` | Any random string of 32+ characters (for example `openssl rand -hex 32`). Lets calls survive deploys. The blueprint generates it for you |

The free plan sleeps after about 15 minutes idle, so the first visit afterwards takes 30 to 60 seconds. Meeting state and notes live in memory, so they are lost if the instance restarts; calls reconnect on their own, but unfinished transcripts don’t survive.

### Docker

```bash
docker build -t peerly .
docker run -p 4800:4800 -e SESSION_SECRET=$(openssl rand -hex 32) -e ANTHROPIC_API_KEY=... peerly
```

Put it behind HTTPS (browsers require it for camera and mic), and set `TRUST_PROXY` to the number of proxies in front of it.

## TURN server

Google’s public STUN servers connect most people. Participants behind strict firewalls or symmetric NATs also need a TURN relay; without one, roughly 10 to 20% of pairs may fail to connect.

- **coturn** (recommended): run it with `use-auth-secret` and set `TURN_URL` and `TURN_SECRET`. Peerly then hands each participant short-lived credentials, so no long-lived TURN password ever reaches a browser
- **A hosted relay** such as [metered.ca](https://www.metered.ca/tools/openrelay/): set `TURN_URL`, `TURN_USERNAME` and `TURN_CREDENTIAL`

`TURN_URL` takes a comma-separated list, for example `turn:turn.example.com:3478,turns:turn.example.com:5349?transport=tcp`.

## Configuration

All settings are environment variables; `.env.example` lists them. Invalid values stop the server at startup with a clear message.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4800` | HTTP port (Render sets it) |
| `SESSION_SECRET` | random per process | Signs resume tokens so calls survive restarts |
| `ANTHROPIC_API_KEY` | unset | Enables AI notes and recaps |
| `AI_MODEL` | `claude-opus-5` | Claude model |
| `AI_EFFORT` | `medium` | `low`, `medium`, `high`, `xhigh` or `max` |
| `AI_MAX_REQUESTS_PER_HOUR` | `60` | Server-wide AI spend cap |
| `MAX_ROOM_SIZE` | `8` | People per meeting (2 to 16) |
| `RECONNECT_GRACE_MS` | `30000` | How long a dropped participant keeps their seat |
| `REPORT_TTL_HOURS` | `24` | How long meeting notes stay available |
| `TURN_URL`, `TURN_SECRET`, `TURN_USERNAME`, `TURN_CREDENTIAL` | unset | TURN relay (see above) |
| `FORCE_RELAY` | `false` | Send all media through TURN (hides participants’ IP addresses from each other) |
| `METRICS_TOKEN` | unset | Enables Prometheus metrics at `/metrics` behind `Authorization: Bearer <token>` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`; logs are JSON lines in production |
| `TRUST_PROXY` | `1` (`true` on Render) | Proxy hops to trust for client IPs |
| `ALLOWED_ORIGINS` | same origin | Extra origins allowed to open WebSocket connections |

## Architecture

```
Browser A ──┐                           ┌── Browser B
            │  Socket.IO (signaling)    │     offers/answers/ICE, chat,
            ├─── Node.js server ────────┤     state, captions (text)
            └──────────┬────────────────┘
                       │ transcript + public chat, when the meeting ends
                       ▼
                  Claude API ──▶ meeting notes page

Browser A ═══ WebRTC audio/video (DTLS-SRTP, peer-to-peer) ═══ Browser B
```

- **Mesh topology.** Every participant has one `RTCPeerConnection` per other participant, with a fixed transceiver plan (mic, camera, screen video, screen audio), so turning video off, switching cameras, applying effects or presenting is `replaceTrack()` with no renegotiation. Mesh cost grows O(n²), which is why meetings cap at 8; beyond that you want an SFU (mediasoup, LiveKit)
- **Negotiation** follows the W3C “perfect negotiation” pattern. Each connection has a session id, so a reloaded page or a rebuilt connection cleanly replaces the old one, and simultaneous rebuilds converge on one
- **Identity.** The server issues each participant an id and an HMAC-signed resume token (plus a signed host proof for the host). Tokens are stateless, which is what lets a freshly restarted server recognise people
- **Server state** is in memory: rooms, the waiting room, chat history, transcripts and reports. Rooms disappear when the last person leaves
- **Security.** Strict Content Security Policy (no inline scripts, WASM only for the segmentation model), HSTS, Permissions-Policy, WebSocket origin checks, per-IP and per-event rate limits, input sanitisation (including bidi-spoofing characters), bounded memory everywhere, and meeting-note links that are unguessable and kept out of logs. Transcript text is treated as untrusted when sent to the AI
- **Operations.** `/healthz` (liveness), `/readyz` (fails during shutdown), `/metrics` (Prometheus, opt-in), structured logs with request ids, client error reporting, and graceful shutdown that tells clients to reconnect

### Code layout

```
server.js            entry point
src/
  server.js          wiring, graceful shutdown
  app.js             HTTP: security headers, API, pages, vendor assets
  signaling.js       Socket.IO events: join/resume, waiting room, chat, host controls
  rooms.js           in-memory meeting state
  reports.js         meeting notes lifecycle
  ai.js              Claude integration (prompts, schemas, error handling)
  config.js  logger.js  rateLimit.js  tokens.js  validate.js  ice.js  metrics.js
public/
  room.html  report.html  index.html
  js/room/           the meeting client (ES modules)
    call.js          session lifecycle and state reconciliation
    peers.js         WebRTC mesh
    media.js         camera, mic, screen, devices
    effects.js       background blur and virtual backgrounds
    stage.js         video tiles and layout
    chat.js  people.js  reactions.js  notes.js  speech.js  ...
  js/report.js       meeting notes page
test/                node:test suites for the server, AI layer and HTTP API
```

## Limitations

- Mesh scales to about 8 people; each person uploads their video once per other participant
- Live captions need a browser with speech recognition (Chrome, Edge, Safari). People on other browsers still see everyone else’s captions
- Recording captures a screen or tab you pick plus your microphone, in your own browser; there’s no server-side recording
- Meeting state is per server process, so this runs as a single instance. Running several would need a shared store (for example Redis) and sticky sessions
