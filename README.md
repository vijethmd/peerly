# Peerly

Free, private, peer-to-peer video calling in the browser. No accounts, no installs, no time limits. Create a room, share the link, talk.

Built with Node.js, Express, Socket.IO (signaling) and WebRTC (media). Media streams flow directly between participants in a full mesh - the server only relays signaling messages and chat, never audio or video.

## Features

- Instant meeting rooms with shareable links (`/room/abc-defg-hij`)
- Pre-join lobby: camera preview, mic/camera toggles, device pickers, live occupancy
- Up to 8 participants per room (configurable via `MAX_ROOM_SIZE`)
- Mute / camera toggle, with state visible to everyone
- Screen sharing (via `replaceTrack`, no renegotiation needed)
- In-call text chat with URL linkification and unread badge
- Participants panel with mute / hand-raise / presenting indicators
- Raise hand with notification toasts
- Active-speaker highlight (WebAudio level analysis)
- Local meeting recording (screen picker + your mic, saved as `.webm`)
- Auto-fitting video grid (largest 16:9 tiles that fit, like Meet)
- Keyboard shortcuts: M mic, V camera, H hand, C chat, P people, ? help
- Call timer, copy-link button, join/leave toasts
- Graceful fallbacks: no camera, no mic, or no devices at all still lets you join
- Automatic reconnect and mesh rebuild if the socket drops
- Responsive layout for mobile

## Run locally

```bash
npm install
npm start          # http://localhost:4800
```

Note: browsers only allow camera/mic on `localhost` or HTTPS. To test a real call locally, open the room link in two browser windows (or one normal + one incognito).

## Deploy to Render

The repo includes `render.yaml`, so you can use either path:

**Blueprint (recommended)**
1. Push this repo to GitHub.
2. In the [Render dashboard](https://dashboard.render.com): New > Blueprint, pick the repo, click Apply.

**Manual**
1. New > Web Service, pick the repo.
2. Runtime: Node. Build command: `npm install`. Start command: `node server.js`. Plan: Free.

Render gives you HTTPS automatically, which WebRTC requires. WebSockets work out of the box.

Free-tier note: the service sleeps after ~15 minutes idle; the first visit after that takes ~30-60s to wake. Media is peer-to-peer, so the dyno does almost no work during calls.

## TURN server (recommended for production)

STUN (Google's free servers, configured by default) gets most peers connected. Peers behind strict/symmetric NATs or corporate firewalls additionally need a TURN relay. Without one, roughly 10-20% of peer pairs may fail to connect.

Free option: [metered.ca](https://www.metered.ca/tools/openrelay/) gives 50 GB/month of TURN relay. Create an account, then set these environment variables on Render (Dashboard > your service > Environment):

```
TURN_URL=turn:standard.relay.metered.ca:80,turn:standard.relay.metered.ca:443,turns:standard.relay.metered.ca:443?transport=tcp
TURN_USERNAME=<your username>
TURN_CREDENTIAL=<your credential>
```

The server exposes these to clients via `/api/ice-config`; no code changes needed.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `4800` | HTTP port (Render sets this automatically) |
| `MAX_ROOM_SIZE` | `8` | Max participants per room |
| `TURN_URL` | unset | Comma-separated TURN URLs |
| `TURN_USERNAME` | unset | TURN username |
| `TURN_CREDENTIAL` | unset | TURN credential |

## Architecture

```
Browser A ──┐                  ┌── Browser B
            │   Socket.IO      │
            ├── (signaling) ───┤      offers / answers / ICE,
            │   Node server    │      chat, presence, state
            └──────────────────┘
Browser A ═══ WebRTC media (DTLS-SRTP, peer-to-peer) ═══ Browser B
```

- Full-mesh topology: every participant has one `RTCPeerConnection` per other participant. Mesh cost grows O(n^2), which is why rooms cap at 8 - beyond that you want an SFU (mediasoup, LiveKit, Jitsi).
- The newcomer always initiates the offer to each existing peer, so there is exactly one negotiation per pair and no glare.
- Screen share and camera swaps use `RTCRtpSender.replaceTrack()`, avoiding renegotiation entirely.
- Server state is a single in-memory `Map` - no database. Rooms vanish when the last person leaves.

## Limitations

- Mesh scales to ~8 people; each participant uploads their video n-1 times.
- Recording captures whatever screen/tab you pick plus your mic (browser-local composition; there is no server-side recorder).
- No persistence: chat history and rooms are gone when everyone leaves.
