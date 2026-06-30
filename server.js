// server.js
// Authoritative sync server + WebRTC signaling relay.
// Single Node process, no database, no build step. Designed to run on any
// free Node host (Render/Railway/Fly/a VPS) or locally behind a tunnel.

'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
// Optional shared passphrase so the link can't be used by randoms if it leaks.
// Leave ROOM_PASSWORD unset to disable the gate entirely.
const ROOM_PASSWORD = process.env.ROOM_PASSWORD || '';

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: '1h' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/**
 * In-memory room state. One room == one "watch party". Everyone who opens
 * the site without a ?room= param lands in "default", which is all this
 * project needs for a small family group.
 *
 * state shape:
 *   mediaId    - opaque string identifying what's loaded (e.g. "1-4" for S1E4)
 *   isPlaying  - bool
 *   baseTime   - media currentTime (seconds) as of lastUpdate
 *   lastUpdate - server wall-clock ms when baseTime was recorded
 */
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Map(), // clientId -> ws
      state: { mediaId: null, isPlaying: false, baseTime: 0, lastUpdate: Date.now() },
    });
  }
  return rooms.get(roomId);
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId) {
  const payload = JSON.stringify(msg);
  for (const [id, client] of room.clients) {
    if (id === exceptId) continue;
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

function rosterOf(room) {
  return [...room.clients.entries()].map(([id, ws]) => ({ id, name: ws._name || 'Guest' }));
}

let nextId = 1;

wss.on('connection', (ws) => {
  ws.id = String(nextId++);
  ws.roomId = null;
  ws._name = 'Guest';

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }

    switch (msg.type) {
      case 'join': {
        if (ROOM_PASSWORD && msg.password !== ROOM_PASSWORD) {
          send(ws, { type: 'join-rejected', reason: 'bad-password' });
          ws.close();
          return;
        }
        const roomId = (msg.room || 'default').slice(0, 64);
        const room = getRoom(roomId);
        ws.roomId = roomId;
        ws._name = (msg.name || 'Guest').slice(0, 40);
        room.clients.set(ws.id, ws);

        send(ws, { type: 'joined', id: ws.id, roster: rosterOf(room) });
        send(ws, { type: 'state', ...room.state, serverNow: Date.now() });
        broadcast(room, { type: 'peer-joined', id: ws.id, name: ws._name }, ws.id);
        break;
      }

      case 'ping': {
        // Clock-offset handshake. Client sends its own clock reading; we
        // stamp the moment we received it so the client can compute
        // round-trip time and the offset between our clocks.
        send(ws, { type: 'pong', t0: msg.t0, serverTime: Date.now() });
        break;
      }

      case 'play':
      case 'pause':
      case 'seek': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        // 'seek' must NOT change play/pause state — only play/pause actions do.
        // (Previously this incorrectly forced isPlaying=true on every seek,
        // which meant scrubbing while paused would start playback for everyone.)
        if (msg.type === 'play') room.state.isPlaying = true;
        else if (msg.type === 'pause') room.state.isPlaying = false;
        room.state.baseTime = Number(msg.time) || 0;
        room.state.lastUpdate = Date.now();
        if (msg.mediaId) room.state.mediaId = msg.mediaId;
        broadcast(room, { type: 'state', ...room.state, serverNow: Date.now(), origin: ws.id, action: msg.type });
        break;
      }

      case 'change-media': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        room.state.mediaId = msg.mediaId;
        room.state.baseTime = 0;
        room.state.isPlaying = false;
        room.state.lastUpdate = Date.now();
        broadcast(room, { type: 'state', ...room.state, serverNow: Date.now(), origin: ws.id, action: 'change-media' });
        break;
      }

      case 'request-state': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        send(ws, { type: 'state', ...room.state, serverNow: Date.now() });
        break;
      }

      case 'webrtc-signal': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const target = room.clients.get(msg.to);
        if (target) send(target, { type: 'webrtc-signal', from: ws.id, data: msg.data });
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;
    room.clients.delete(ws.id);
    broadcast(room, { type: 'peer-left', id: ws.id });
    if (room.clients.size === 0) rooms.delete(ws.roomId);
  });
});

server.listen(PORT, () => {
  console.log(`sync-watch-party listening on :${PORT}`);
  if (!ROOM_PASSWORD) {
    console.log('ROOM_PASSWORD not set — anyone with the link can join. Set it in your environment to gate access.');
  }
});
