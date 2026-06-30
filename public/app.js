// public/app.js
// Wires the <video> element, the episode picker, the sync engine, and the
// camera/mic mesh together. No frameworks, no build step.

(() => {
  'use strict';

  // ---------- elements ----------
  const video = document.getElementById('video');
  const overlay = document.getElementById('video-overlay');
  const overlayText = document.getElementById('overlay-text');
  const playPauseBtn = document.getElementById('playpause-btn');
  const seekBar = document.getElementById('seek-bar');
  const timeLabel = document.getElementById('time-label');
  const qualitySelect = document.getElementById('quality-select');
  const camToggle = document.getElementById('cam-toggle');
  const micToggle = document.getElementById('mic-toggle');
  const resyncBtn = document.getElementById('resync-btn');
  const episodeLabelEl = document.getElementById('episode-label');
  const seasonSelect = document.getElementById('season-select');
  const episodeListEl = document.getElementById('episode-list');
  const videoGrid = document.getElementById('video-grid');
  const peopleCount = document.getElementById('people-count');
  const nameInput = document.getElementById('name-input');
  const connDot = document.getElementById('conn-dot');
  const connText = document.getElementById('conn-text');
  const latencyEl = document.getElementById('latency');

  const joinScreen = document.getElementById('join-screen');
  const joinRoomLabel = document.getElementById('join-room-label');
  const joinNameInput = document.getElementById('join-name');
  const joinPasswordInput = document.getElementById('join-password');
  const joinBtn = document.getElementById('join-btn');
  const joinError = document.getElementById('join-error');

  // ---------- state ----------
  const params = new URLSearchParams(location.search);
  const room = (params.get('room') || 'default').slice(0, 64);
  joinRoomLabel.textContent = `room: ${room}`;

  let currentMediaId = null;
  let hlsInstance = null;
  let applyingRemote = false;
  let pendingApply = null;
  let isDraggingSeek = false;
  const peerNames = new Map(); // id -> name
  let camOn = false;
  let micOn = false;

  // ---------- name persistence (this is a standalone site the user hosts
  // themselves, not a Claude artifact, so plain localStorage is fine here) ----------
  const savedName = localStorage.getItem('swp_name') || '';
  joinNameInput.value = savedName;
  nameInput.value = savedName;
  joinPasswordInput.value = localStorage.getItem('swp_password') || '';

  // ====================================================================
  // Episode picker (static, built from video-sources.js)
  // ====================================================================

  function mediaIdOf(season, episode) { return `${season}-${episode}`; }

  function findEpisode(mediaId) {
    if (!mediaId) return null;
    const [s, e] = mediaId.split('-').map(Number);
    const season = VIDEO_LIBRARY.seasons.find((x) => x.season === s);
    const ep = season?.episodes.find((x) => x.episode === e);
    return ep ? { season: s, episode: e, title: ep.title, sources: ep.sources } : null;
  }

  function buildPicker() {
    seasonSelect.innerHTML = '';
    VIDEO_LIBRARY.seasons.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.season;
      opt.textContent = `Season ${s.season}`;
      seasonSelect.appendChild(opt);
    });
    seasonSelect.onchange = () => renderEpisodeList(Number(seasonSelect.value));
    if (VIDEO_LIBRARY.seasons.length) renderEpisodeList(VIDEO_LIBRARY.seasons[0].season);
  }

  function renderEpisodeList(seasonNum) {
    const season = VIDEO_LIBRARY.seasons.find((s) => s.season === seasonNum);
    episodeListEl.innerHTML = '';
    if (!season) return;
    season.episodes.forEach((ep) => {
      const mediaId = mediaIdOf(seasonNum, ep.episode);
      const row = document.createElement('div');
      row.className = 'ep-row' + (mediaId === currentMediaId ? ' current' : '');
      row.dataset.mediaId = mediaId;
      const hasSource = ep.sources && ep.sources.length > 0;
      row.innerHTML = `<span><span class="ep-num">E${ep.episode}</span> ${ep.title}</span>${hasSource ? '' : '<span class="ep-flag">no source</span>'}`;
      row.onclick = () => Sync.changeMedia(mediaId);
      episodeListEl.appendChild(row);
    });
  }

  function highlightCurrentEpisodeRow() {
    [...episodeListEl.children].forEach((row) => {
      row.classList.toggle('current', row.dataset.mediaId === currentMediaId);
    });
  }

  // ====================================================================
  // Video source loading (mp4 multi-file or hls adaptive, per-user quality)
  // ====================================================================

  function clearQualityOptions() {
    qualitySelect.innerHTML = '<option value="">quality</option>';
  }

  function showOverlay(msg) {
    overlayText.textContent = msg;
    overlay.classList.remove('hidden');
  }
  function hideOverlay() { overlay.classList.add('hidden'); }

  function teardownHls() {
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  }

  function loadMedia(mediaId) {
    currentMediaId = mediaId;
    const ep = findEpisode(mediaId);
    episodeLabelEl.textContent = ep ? `S${ep.season}E${ep.episode} — ${ep.title}` : mediaId || '—';
    highlightCurrentEpisodeRow();
    teardownHls();
    clearQualityOptions();

    if (!ep || !ep.sources || ep.sources.length === 0) {
      showOverlay('No video source configured for this episode yet.\nAdd a URL in public/video-sources.js.');
      video.removeAttribute('src');
      video.load();
      return;
    }
    hideOverlay();

    if (ep.sources[0].type === 'hls') {
      setupHls(ep.sources[0].url);
    } else {
      setupMp4(ep.sources);
    }
  }

  function setupMp4(sources) {
    sources.forEach((s, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = s.quality;
      qualitySelect.appendChild(opt);
    });
    qualitySelect.value = '0';
    video.src = sources[0].url;
    video.load();

    qualitySelect.onchange = () => {
      const idx = Number(qualitySelect.value);
      const target = sources[idx];
      if (!target) return;
      const resumeTime = video.currentTime;
      const wasPlaying = !video.paused;
      applyingRemote = true; // suppress sync echo while we reload locally
      video.src = target.url;
      video.load();
      video.addEventListener('loadedmetadata', function onMeta() {
        video.removeEventListener('loadedmetadata', onMeta);
        video.currentTime = resumeTime;
        if (wasPlaying) video.play().catch(() => {});
        setTimeout(() => { applyingRemote = false; }, 150);
      }, { once: true });
    };
  }

  function setupHls(url) {
    const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');
    if (nativeHls) {
      // Safari/iPadOS: native HLS already does adaptive quality; expose "auto" only.
      const opt = document.createElement('option');
      opt.value = 'auto'; opt.textContent = 'auto';
      qualitySelect.appendChild(opt);
      video.src = url;
      video.load();
      return;
    }
    if (typeof Hls === 'undefined' || !Hls.isSupported()) {
      showOverlay('This browser cannot play HLS. Try a Chromium or Safari based browser.');
      return;
    }
    hlsInstance = new Hls({ capLevelToPlayerSize: false });
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(video);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
      const autoOpt = document.createElement('option');
      autoOpt.value = 'auto'; autoOpt.textContent = 'auto';
      qualitySelect.appendChild(autoOpt);
      data.levels.forEach((lvl, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = `${lvl.height}p`;
        qualitySelect.appendChild(opt);
      });
      qualitySelect.value = 'auto';
    });
    qualitySelect.onchange = () => {
      const v = qualitySelect.value;
      hlsInstance.currentLevel = v === 'auto' ? -1 : Number(v);
    };
  }

  video.addEventListener('loadedmetadata', () => {
    seekBar.max = '1000';
    if (pendingApply) { applyState(pendingApply, true); pendingApply = null; }
  });

  // ====================================================================
  // Sync engine wiring
  // ====================================================================

  function applyState(state, force) {
    if (!state || isDraggingSeek) return; // don't fight the user's own drag in progress
    const target = Sync.expectedTime(state);
    const drift = Math.abs((video.currentTime || 0) - target);
    applyingRemote = true;

    if (force || drift > 0.35) {
      video.currentTime = Math.max(0, target);
    }
    if (state.isPlaying && video.paused) {
      video.play().catch(() => { /* will retry on next tick / user gesture */ });
    } else if (!state.isPlaying && !video.paused) {
      video.pause();
    }
    setTimeout(() => { applyingRemote = false; }, 200);
  }

  Sync.on('state', (msg) => {
    if (!msg.mediaId) {
      showOverlay('Pick an episode from the list on the right to begin.');
      return;
    }
    if (msg.mediaId !== currentMediaId) {
      pendingApply = msg;
      loadMedia(msg.mediaId);
      return; // applied once loadedmetadata fires
    }
    applyState(msg);
  });

  Sync.on('open', () => { connDot.className = 'dot dot-on'; connText.textContent = 'connected'; });
  Sync.on('close', () => { connDot.className = 'dot dot-off'; connText.textContent = 'reconnecting'; });

  Sync.on('roster', (roster) => {
    roster.forEach((p) => { if (p.id !== Sync.id) peerNames.set(p.id, p.name); });
    updatePeopleCount();
    roster.forEach((p) => {
      if (p.id === Sync.id) return;
      WebRTC.addPeer(p.id);
    });
  });

  Sync.on('peer-joined', (msg) => {
    peerNames.set(msg.id, msg.name);
    updatePeopleCount();
    WebRTC.addPeer(msg.id);
  });

  Sync.on('peer-left', (msg) => {
    peerNames.delete(msg.id);
    removeTile(msg.id);
    WebRTC.closePeer(msg.id);
    updatePeopleCount();
  });

  // Periodic drift re-check, independent of incoming messages — catches
  // gradual local clock / decode drift during long stretches of playback.
  setInterval(() => {
    if (applyingRemote || !Sync.lastState) return;
    if (Sync.lastState.mediaId !== currentMediaId) return;
    if (!Sync.lastState.isPlaying || video.paused) return;
    applyState(Sync.lastState);
  }, 3000);

  // periodic latency display
  setInterval(() => {
    latencyEl.textContent = Number.isFinite(Sync.rtt) ? `${Math.round(Sync.rtt)}ms` : '';
  }, 2000);

  // ====================================================================
  // Local controls -> outgoing sync events
  // ====================================================================

  playPauseBtn.onclick = () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };

  video.addEventListener('play', () => {
    playPauseBtn.textContent = 'PAUSE';
    if (applyingRemote) return;
    Sync.play(video.currentTime, currentMediaId);
  });
  video.addEventListener('pause', () => {
    playPauseBtn.textContent = 'PLAY';
    if (applyingRemote) return;
    Sync.pause(video.currentTime, currentMediaId);
  });
  video.addEventListener('seeked', () => {
    if (applyingRemote) return;
    Sync.seek(video.currentTime, currentMediaId);
  });

  video.addEventListener('timeupdate', () => {
    if (isDraggingSeek || !video.duration) return;
    seekBar.value = String(Math.round((video.currentTime / video.duration) * 1000));
    timeLabel.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  });

  seekBar.addEventListener('input', () => {
    isDraggingSeek = true;
    if (video.duration) {
      timeLabel.textContent = `${fmt((seekBar.value / 1000) * video.duration)} / ${fmt(video.duration)}`;
    }
  });
  seekBar.addEventListener('change', () => {
    isDraggingSeek = false;
    if (video.duration) video.currentTime = (seekBar.value / 1000) * video.duration;
  });

  function fmt(sec) {
    if (!Number.isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  resyncBtn.onclick = () => {
    forceNextStateApply = true;
    Sync.requestState();
    flashOverlay('Resyncing…');
  };
  function flashOverlay(msg) {
    if (!overlay.classList.contains('hidden')) return; // don't clobber a real error overlay
    showOverlay(msg);
    setTimeout(hideOverlay, 700);
  }

  // Wrap applyState so a manual resync always forces a hard correction,
  // even if the drift happens to be under the normal auto-correct threshold.
  let forceNextStateApply = false;
  const _applyState = applyState;
  applyState = function (state, force) {
    _applyState(state, force || forceNextStateApply);
    forceNextStateApply = false;
  };

  // ====================================================================
  // Camera / mic
  // ====================================================================

  function tileFor(id) {
    let tile = document.getElementById(`tile-${id}`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'peer-tile';
      tile.id = `tile-${id}`;
      const v = document.createElement('video');
      v.autoplay = true; v.playsInline = true;
      if (id === 'local') v.muted = true;
      const label = document.createElement('div');
      label.className = 'peer-name';
      tile.appendChild(v);
      tile.appendChild(label);
      videoGrid.appendChild(tile);
    }
    return tile;
  }
  function removeTile(id) {
    const tile = document.getElementById(`tile-${id}`);
    if (tile) tile.remove();
  }
  function updatePeopleCount() {
    peopleCount.textContent = ` (${peerNames.size + 1})`;
  }

  WebRTC.hooks.onLocalStream = (stream) => {
    const tile = tileFor('local');
    tile.querySelector('video').srcObject = stream;
    tile.querySelector('.peer-name').textContent = 'You';
  };
  WebRTC.hooks.onRemoteStream = (peerId, stream) => {
    const tile = tileFor(peerId);
    tile.querySelector('video').srcObject = stream;
    tile.querySelector('.peer-name').textContent = peerNames.get(peerId) || 'Guest';
  };
  WebRTC.hooks.onPeerClosed = (peerId) => removeTile(peerId);

  Sync.on('signal', (msg) => WebRTC.handleSignal(msg.from, msg.data));

  camToggle.onclick = async () => {
    if (!camOn) {
      const ok = await ensureLocalStream();
      if (!ok) return;
    }
    camOn = !camOn;
    WebRTC.setCamEnabled(camOn);
    camToggle.classList.toggle('active', camOn);
  };
  micToggle.onclick = async () => {
    if (!micOn) {
      const ok = await ensureLocalStream();
      if (!ok) return;
    }
    micOn = !micOn;
    WebRTC.setMicEnabled(micOn);
    micToggle.classList.toggle('active', micOn);
  };

  let streamRequested = false;
  async function ensureLocalStream() {
    if (streamRequested) return true;
    streamRequested = true;
    try {
      const stream = await WebRTC.getLocalStream();
      // Start muted/off until the user explicitly enables — getUserMedia
      // returns tracks enabled by default, so flip them off immediately.
      stream.getVideoTracks().forEach((t) => (t.enabled = false));
      stream.getAudioTracks().forEach((t) => (t.enabled = false));
      return true;
    } catch (err) {
      console.warn('camera/mic unavailable:', err);
      streamRequested = false; // allow retry on next click
      return false;
    }
  }

  // ====================================================================
  // Join flow
  // ====================================================================

  nameInput.addEventListener('change', () => localStorage.setItem('swp_name', nameInput.value));

  Sync.on('join-rejected', () => {
    joinScreen.style.display = 'flex';
    joinError.textContent = 'Wrong password.';
    joinError.classList.remove('hidden');
  });

  joinBtn.onclick = async () => {
    const name = (joinNameInput.value || 'Guest').trim().slice(0, 40);
    const password = joinPasswordInput.value || '';
    localStorage.setItem('swp_name', name);
    localStorage.setItem('swp_password', password);
    nameInput.value = name;
    joinScreen.style.display = 'none';

    buildPicker();
    Sync.connect({ room, name, password });

    // A click just happened, so this is a valid user gesture for the
    // browser's autoplay-with-sound policy on most engines.
    video.muted = false;
  };

  joinPasswordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
  joinNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
})();
