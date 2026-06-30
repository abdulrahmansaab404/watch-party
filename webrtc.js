// public/webrtc.js
//
// Peer-to-peer mesh for camera + mic between everyone in the room. Sized for
// a small family group (mesh scales fine up to ~6-8 participants; beyond
// that you'd want an SFU, out of scope here). Signaling rides over the same
// WebSocket connection as the playback sync (see sync.js / Sync.signal).
//
// Uses the "perfect negotiation" pattern so it doesn't matter whether
// someone enables their camera before or after everyone else has already
// connected — renegotiation Just Works in both directions without manual
// offer/answer bookkeeping per call site.

const WebRTC = (() => {
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // Optional: add a TURN server here if some of your relatives are behind
    // strict/symmetric NATs (common on mobile/corporate networks) and the
    // direct P2P connection won't establish. Free/low-cost TURN options
    // include Twilio NTS, Cloudflare Calls, or metered.ca's free tier.
    // { urls: 'turn:your-turn-host:3478', username: '...', credential: '...' },
  ];

  let localStream = null;
  const peers = new Map(); // id -> { pc, makingOffer, ignoreOffer }

  const hooks = { onLocalStream: null, onRemoteStream: null, onPeerClosed: null };

  function isPolite(peerId) {
    // Both sides compute this from the same two ids, so it's guaranteed to
    // disagree across the two ends (one polite, one not) — that's what
    // breaks the tie when both sides start negotiating at the same time.
    return Sync.id > peerId;
  }

  async function getLocalStream() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    hooks.onLocalStream?.(localStream);
    attachLocalStreamToAllPeers();
    return localStream;
  }

  function attachLocalStreamToAllPeers() {
    if (!localStream) return;
    for (const entry of peers.values()) {
      const existingTrackIds = new Set(entry.pc.getSenders().map((s) => s.track && s.track.id));
      localStream.getTracks().forEach((track) => {
        if (!existingTrackIds.has(track.id)) entry.pc.addTrack(track, localStream);
      });
    }
  }

  function setCamEnabled(on) {
    localStream?.getVideoTracks().forEach((t) => (t.enabled = on));
  }
  function setMicEnabled(on) {
    localStream?.getAudioTracks().forEach((t) => (t.enabled = on));
  }

  function newConnection(peerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry = { pc, makingOffer: false, ignoreOffer: false };
    peers.set(peerId, entry);

    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }

    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        Sync.signal(peerId, { sdp: pc.localDescription });
      } catch (err) {
        console.warn('negotiation failed', err);
      } finally {
        entry.makingOffer = false;
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) Sync.signal(peerId, { candidate: ev.candidate });
    };

    pc.ontrack = (ev) => {
      hooks.onRemoteStream?.(peerId, ev.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        closePeer(peerId);
      }
    };

    return entry;
  }

  function ensurePeer(peerId) {
    return peers.get(peerId) || newConnection(peerId);
  }

  async function handleSignal(fromId, data) {
    const entry = ensurePeer(fromId);
    const { pc } = entry;

    if (data.sdp) {
      const offerCollision = data.sdp.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable');
      entry.ignoreOffer = !isPolite(fromId) && offerCollision;
      if (entry.ignoreOffer) return;

      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription();
        Sync.signal(fromId, { sdp: pc.localDescription });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!entry.ignoreOffer) console.warn('ICE candidate error', err);
      }
    }
  }

  function closePeer(peerId) {
    const entry = peers.get(peerId);
    if (entry) { entry.pc.close(); peers.delete(peerId); }
    hooks.onPeerClosed?.(peerId);
  }

  return {
    hooks,
    getLocalStream,
    setCamEnabled,
    setMicEnabled,
    addPeer: (peerId) => ensurePeer(peerId), // kept name for app.js call sites
    handleSignal,
    closePeer,
  };
})();
