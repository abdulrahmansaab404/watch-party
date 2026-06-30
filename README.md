# Sync Watch Party

A small, dependency-light website for watching a show with people in other
countries at the exact same timestamp, with a built-in camera/mic chat
panel. Built to be fast: no framework, no build step, no rounded corners,
no blur, no animation — just the controls you need.

What it does:

- Anyone who opens the link lands on a player with a season/episode picker.
- Play, pause, and seek are broadcast to everyone in the room and applied
  at the corrected timestamp, accounting for each person's network latency
  and clock offset — not just "send the command and hope."
- Video **quality is local only** — your quality dropdown never affects
  anyone else's stream.
- A **RESYNC** button forces your player back to the group's exact current
  position if anything ever drifts (a buffering hiccup, a flaky connection).
- A camera/mic grid sits in the sidebar so everyone can see and hear each
  other while watching, like a watch party in person. Peer-to-peer, so
  there's no video relay server to pay for or maintain.

## What you provide

This project does **not** ship with, link to, or know about any specific
video source. You point it at video you have the rights to stream to your
group — files you own, a Plex/Jellyfin/Emby server you run, a private S3
bucket, whatever. Open `public/video-sources.js` and fill in a URL per
episode. That file has full instructions and examples inline. Until you
fill it in, episodes show "no source configured" instead of erroring.

Two formats are supported per episode, and you can mix them across
episodes:

```js
{ quality: '1080p', type: 'mp4', url: 'https://your-host/s1e1-1080p.mp4' }
{ quality: 'auto',  type: 'hls', url: 'https://your-host/s1e1/master.m3u8' }
```

`mp4` is simplest if you just have video files — list one URL per
resolution you have and the quality dropdown is built from that list.
`hls` is better if you already have an adaptive stream (a Plex/Jellyfin
transcode, a CDN you control) — the quality dropdown is built automatically
from the levels inside the playlist via hls.js.

## Running it

```
npm install
npm start
```

Open `http://localhost:8080`. To test as two "different" people, open it
in two browser windows (or one in an incognito window).

Set `ROOM_PASSWORD` in your environment before starting if you want a
shared passphrase gate (see `.env.example`). Everyone who opens the site
without `?room=` lands in the same default room — that's all a small
family group needs. If you ever want separate simultaneous watch parties,
add `?room=anything` to the URL; different room values never see or affect
each other.

## Putting it online

This needs a real (small) server process for the WebSocket connection —
GitHub Pages alone won't run it, since Pages only serves static files. The
code itself still lives in your GitHub repo; you point a free Node host at
that repo to actually run it. Camera/mic also require HTTPS, which any of
these give you automatically.

**Render** (easiest — a `render.yaml` is already in this repo): push the
repo to GitHub, go to render.com, "New > Blueprint", point it at the repo,
and it deploys itself on the free tier from `render.yaml`. Add
`ROOM_PASSWORD` in the dashboard's environment tab if you want it.

**Railway / Fly.io**: both auto-detect a Node app from `package.json` —
connect the GitHub repo and deploy, no extra config needed beyond setting
`ROOM_PASSWORD` if desired.

**Your own VPS**: `npm install && npm start` behind a reverse proxy
(Caddy is the least fuss — it gets you HTTPS automatically) or behind
nginx + certbot.

## How the sync actually works

The server is the single source of truth for `{ mediaId, isPlaying,
baseTime, lastUpdate }` per room — not any one person's "host" status.
Whoever presses play/pause/seek updates that state and it's broadcast to
everyone, including back to themselves for confirmation.

Each client separately measures its clock offset against the server with a
small ping/pong exchange (sent every 4s, keeping the best/lowest-latency
sample), so "what time should my video be at right now" can be computed
precisely even though everyone's network latency differs:

```
expected playback time = baseTime + (estimatedServerNow - lastUpdate)
```

On every state broadcast, and again every 3 seconds during playback as a
safety net, each client compares its actual `video.currentTime` against
that expected time. A drift past ~350ms triggers a hard correction; the
RESYNC button forces that correction immediately and unconditionally.

Episode changes are also synced — picking a different episode moves
everyone to it, starting paused, so nobody is dropped into a half-buffered
stream mid-playback.

## Camera & mic

WebRTC mesh, signaled over the same WebSocket connection as playback sync
(see `public/webrtc.js`). It uses the standard "perfect negotiation"
pattern, so it doesn't matter who turns their camera on first or whether
someone joins late — connections (re)negotiate correctly either way.
Camera and mic default to **off**; each person opts in with the CAM/MIC
buttons, and permission is requested at that point, not on page load.

This is peer-to-peer, which is what keeps it free and simple — every
participant connects directly to every other participant. That scales
comfortably for a family-sized group; if you ever wanted dozens of
simultaneous people, you'd want a media relay server (SFU) instead, which
is out of scope here.

If someone's connection sits behind a strict/symmetric NAT (common on some
mobile carriers or corporate networks), the direct peer-to-peer link can
fail to establish even though playback sync still works fine (that part
only needs a normal WebSocket, not P2P). If that happens, add a TURN
server's credentials to the `ICE_SERVERS` list at the top of
`public/webrtc.js` — the file has a comment showing exactly where.

## Project layout

```
server.js              sync + WebRTC signaling server (Node, no DB)
public/index.html       page shell
public/style.css        all styling — flat, no radius, no blur, no motion
public/video-sources.js the file you edit to point at your own video
public/sync.js          WebSocket client + clock-offset math
public/webrtc.js        camera/mic mesh
public/app.js           wires the <video> element, picker, sync, and webrtc together
render.yaml              one-click Render deployment blueprint
```

## A note on the first click

Browsers require a user gesture before they'll allow audio playback or
camera/mic prompts — there's no way around this for any web video player,
including big-name streaming sites. That's the one click on the join
screen; after that, sync keeps everyone aligned without further input.
