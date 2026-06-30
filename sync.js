// public/sync.js
//
// Owns the WebSocket connection to the sync server and the clock-offset math
// needed to apply remote play/pause/seek at the exact right local moment.
// Exposes a small Sync object that app.js drives; knows nothing about the
// <video> element itself.

const Sync = (() => {
  let ws = null;
  let myId = null;
  let clockOffset = 0;      // estimated serverTime - clientTime, ms
  let bestRtt = Infinity;
  let lastState = null;     // last authoritative {mediaId,isPlaying,baseTime,lastUpdate}
  let pingTimer = null;
  let reconnectDelay = 500;

  const listeners = {
    state: [], roster: [], 'peer-joined': [], 'peer-left': [],
    signal: [], open: [], close: [], 'join-rejected': [],
  };

  function on(event, fn) { (listeners[event] ||= []).push(fn); }
  function emit(event, payload) { (listeners[event] || []).forEach((fn) => fn(payload)); }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function connect({ room, name, password }) {
    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      reconnectDelay = 500;
      send({ type: 'join', room, name, password });
      startPing();
      emit('open');
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };

    ws.onclose = () => {
      stopPing();
      emit('close');
      setTimeout(() => connect({ room, name, password }), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);
    };

    ws.onerror = () => ws.close();
  }

  function handle(msg) {
    switch (msg.type) {
      case 'joined':
        myId = msg.id;
        emit('roster', msg.roster);
        break;
      case 'join-rejected':
        emit('join-rejected', msg);
        break;
      case 'pong': {
        const rtt = Date.now() - msg.t0;
        if (rtt < bestRtt) {
          bestRtt = rtt;
          clockOffset = msg.serverTime - (msg.t0 + rtt / 2);
        }
        break;
      }
      case 'state':
        lastState = msg;
        emit('state', msg);
        break;
      case 'peer-joined':
        emit('peer-joined', msg);
        break;
      case 'peer-left':
        emit('peer-left', msg);
        break;
      case 'webrtc-signal':
        emit('signal', msg);
        break;
      default:
        break;
    }
  }

  function startPing() {
    stopPing();
    ping();
    pingTimer = setInterval(ping, 4000);
  }
  function stopPing() { if (pingTimer) clearInterval(pingTimer); pingTimer = null; }
  function ping() { send({ type: 'ping', t0: Date.now() }); }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // Estimated current server time, given our best clock-offset sample.
  function serverNow() { return Date.now() + clockOffset; }

  // Where playback SHOULD be right now, given the last authoritative state.
  function expectedTime(state = lastState) {
    if (!state) return 0;
    if (!state.isPlaying) return state.baseTime;
    const elapsed = (serverNow() - state.lastUpdate) / 1000;
    return state.baseTime + Math.max(0, elapsed);
  }

  return {
    on,
    connect,
    send,
    get id() { return myId; },
    get offset() { return clockOffset; },
    get rtt() { return bestRtt; },
    get lastState() { return lastState; },
    expectedTime,
    play(time, mediaId) { send({ type: 'play', time, mediaId }); },
    pause(time, mediaId) { send({ type: 'pause', time, mediaId }); },
    seek(time, mediaId) { send({ type: 'seek', time, mediaId }); },
    changeMedia(mediaId) { send({ type: 'change-media', mediaId }); },
    requestState() { send({ type: 'request-state' }); },
    signal(to, data) { send({ type: 'webrtc-signal', to, data }); },
  };
})();
