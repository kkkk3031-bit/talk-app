const socket = io();

const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app-screen');
const usernameInput = document.getElementById('username-input');
const joinBtn = document.getElementById('join-btn');
const channelList = document.getElementById('channel-list');
const presenceList = document.getElementById('presence-list');
const currentChannelEl = document.getElementById('current-channel');
const messagesEl = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const voiceToggleBtn = document.getElementById('voice-toggle-btn');
const voiceParticipantsEl = document.getElementById('voice-participants');
const userBarAvatar = document.getElementById('user-bar-avatar');
const userBarName = document.getElementById('user-bar-name');
const muteMicBtn = document.getElementById('mute-mic-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const micSelect = document.getElementById('mic-select');
const volumeSlider = document.getElementById('volume-slider');
const volumeValueEl = document.getElementById('volume-value');

let myUsername = null;
let currentChannel = 'general';
let inVoice = false;
let micMuted = false;
let localStream = null;
const peerConnections = new Map(); // peerId -> RTCPeerConnection

// --- persisted voice/audio settings (mic device, output volume) ---
const settings = Object.assign(
  { micId: '', volume: 100 },
  JSON.parse(localStorage.getItem('talkapp-settings') || '{}')
);
function saveSettings() {
  localStorage.setItem('talkapp-settings', JSON.stringify(settings));
}
function applyVolumeToAudioEls() {
  const v = settings.volume / 100;
  document.querySelectorAll('audio[id^="audio-"]').forEach((el) => { el.volume = v; });
}
volumeSlider.value = settings.volume;
volumeValueEl.textContent = settings.volume;
volumeSlider.addEventListener('input', () => {
  settings.volume = Number(volumeSlider.value);
  volumeValueEl.textContent = settings.volume;
  applyVolumeToAudioEls();
  saveSettings();
});

async function populateMicList() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter((d) => d.kind === 'audioinput');
  micSelect.innerHTML = '';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Default microphone';
  micSelect.appendChild(defaultOpt);
  mics.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${i + 1}`;
    micSelect.appendChild(opt);
  });
  micSelect.value = settings.micId || '';
}
micSelect.addEventListener('change', () => { settings.micId = micSelect.value; saveSettings(); });

settingsBtn.addEventListener('click', async () => {
  settingsModal.classList.remove('hidden');
  try { await populateMicList(); } catch {}
});
settingsCloseBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); });

muteMicBtn.addEventListener('click', () => {
  if (!localStream) return;
  micMuted = !micMuted;
  localStream.getAudioTracks().forEach((t) => { t.enabled = !micMuted; });
  muteMicBtn.classList.toggle('muted', micMuted);
  muteMicBtn.textContent = micMuted ? '🔇' : '🎤';
});
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

// --- voice-activity detection: drives the red "speaking" state on the voice button ---
let vadAudioCtx = null;
let vadRAF = null;

function startVAD(stream) {
  vadAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = vadAudioCtx.createMediaStreamSource(stream);
  const analyser = vadAudioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.5;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const THRESHOLD = 14;
  let speaking = false;
  (function loop() {
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const nowSpeaking = sum / data.length > THRESHOLD;
    if (nowSpeaking !== speaking) {
      speaking = nowSpeaking;
      voiceToggleBtn.classList.toggle('speaking', speaking);
    }
    vadRAF = requestAnimationFrame(loop);
  })();
}

function stopVAD() {
  if (vadRAF) cancelAnimationFrame(vadRAF);
  vadRAF = null;
  if (vadAudioCtx) { vadAudioCtx.close(); vadAudioCtx = null; }
  voiceToggleBtn.classList.remove('speaking');
}

function go(fn) { document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn) : fn(); }

function renderMessage({ id, username, text, ts }, system = false) {
  const div = document.createElement('div');
  div.className = 'message' + (system ? ' system' : '');
  if (id) div.dataset.id = id;
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const mine = !system && username === myUsername;
  div.innerHTML = system
    ? `<span class="text">${escapeHtml(text)}</span>`
    : `<span class="author">${escapeHtml(username)}</span><span class="time">${time}</span>${mine ? '<button class="delete-btn" title="Delete">🗑</button>' : ''}<br/><span class="text">${escapeHtml(text)}</span>`;
  if (mine) {
    div.querySelector('.delete-btn').addEventListener('click', () => {
      socket.emit('delete-message', { channel: currentChannel, id });
    });
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

const AVATAR_COLORS = ['#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#f0a020', '#23a55a', '#00a8fc'];
function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderChannelList(channels) {
  channelList.innerHTML = '';
  channels.forEach((c) => {
    const li = document.createElement('li');
    li.textContent = `# ${c}`;
    li.dataset.channel = c;
    if (c === currentChannel) li.classList.add('active');
    li.addEventListener('click', () => {
      if (c === currentChannel) return;
      currentChannel = c;
      currentChannelEl.textContent = c;
      messageInput.placeholder = `Message #${c}`;
      [...channelList.children].forEach((el) => el.classList.toggle('active', el.dataset.channel === c));
      unreadCounts[c] = 0;
      renderChannelBadge(li, c);
      typingUsers.clear();
      renderTyping();
      socket.emit('switch-channel', c);
    });
    channelList.appendChild(li);
  });
}

function renderPresence(list) {
  presenceList.innerHTML = '';
  list.forEach((u) => {
    const li = document.createElement('li');
    li.className = 'presence';
    li.innerHTML = `<span class="dot"></span>${escapeHtml(u.username)}${u.inVoice ? ' 🔊' : ''}`;
    presenceList.appendChild(li);
  });
}

joinBtn.addEventListener('click', doJoin);
usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  const name = usernameInput.value.trim();
  if (!name) return;
  socket.emit('join', name);
}

socket.on('joined', ({ username, channels, history }) => {
  myUsername = username;
  loginScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');
  userBarName.textContent = username;
  userBarAvatar.textContent = username.slice(0, 1).toUpperCase();
  userBarAvatar.style.background = avatarColor(username);
  renderChannelList(channels);
  messagesEl.innerHTML = '';
  history.forEach((m) => renderMessage(m));
});

socket.on('channel-history', ({ channel, history }) => {
  if (channel !== currentChannel) return;
  messagesEl.innerHTML = '';
  history.forEach((m) => renderMessage(m));
});

socket.on('chat-message', ({ channel, msg }) => {
  if (channel !== currentChannel) {
    bumpUnread(channel);
    return;
  }
  renderMessage(msg);
});

socket.on('message-deleted', ({ channel, id }) => {
  if (channel !== currentChannel) return;
  const el = messagesEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (el) el.remove();
});

socket.on('presence', renderPresence);

messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', text);
  messageInput.value = '';
});

// --- typing indicator ---
let typingEmitThrottle = 0;
messageInput.addEventListener('input', () => {
  const now = Date.now();
  if (now - typingEmitThrottle < 2000) return;
  typingEmitThrottle = now;
  socket.emit('typing');
});

const typingIndicatorEl = document.getElementById('typing-indicator');
const typingUsers = new Map(); // username -> timeout id
socket.on('typing', ({ channel, username }) => {
  if (channel !== currentChannel) return;
  if (typingUsers.has(username)) clearTimeout(typingUsers.get(username));
  typingUsers.set(username, setTimeout(() => {
    typingUsers.delete(username);
    renderTyping();
  }, 3000));
  renderTyping();
});
function renderTyping() {
  const names = [...typingUsers.keys()];
  if (names.length === 0) typingIndicatorEl.textContent = '';
  else if (names.length === 1) typingIndicatorEl.textContent = `${names[0]} is typing…`;
  else typingIndicatorEl.textContent = `${names.join(', ')} are typing…`;
}

// --- unread badges on other channels ---
const unreadCounts = {};
function bumpUnread(channel) {
  unreadCounts[channel] = (unreadCounts[channel] || 0) + 1;
  const li = channelList.querySelector(`[data-channel="${CSS.escape(channel)}"]`);
  if (li) renderChannelBadge(li, channel);
}
function renderChannelBadge(li, channel) {
  let badge = li.querySelector('.unread-badge');
  const count = unreadCounts[channel] || 0;
  if (count === 0) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'unread-badge';
    li.appendChild(badge);
  }
  badge.textContent = count > 99 ? '99+' : String(count);
}

// --- WebRTC voice (P2P mesh) ---

function addAudioEl(peerId, stream) {
  let el = document.getElementById('audio-' + peerId);
  if (!el) {
    el = document.createElement('audio');
    el.id = 'audio-' + peerId;
    el.autoplay = true;
    document.body.appendChild(el);
  }
  el.volume = settings.volume / 100;
  el.srcObject = stream;
}

function removeAudioEl(peerId) {
  const el = document.getElementById('audio-' + peerId);
  if (el) el.remove();
}

const VOICE_MAX_BITRATE = 64000; // bump above Opus's default ~32kbps mono for clearer voice

async function boostBitrate(sender) {
  const params = sender.getParameters();
  if (!params.encodings) params.encodings = [{}];
  params.encodings[0].maxBitrate = VOICE_MAX_BITRATE;
  try { await sender.setParameters(params); } catch {}
}

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(rtcConfig);
  if (localStream) {
    localStream.getTracks().forEach((t) => {
      const sender = pc.addTrack(t, localStream);
      boostBitrate(sender);
    });
  }
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('voice-signal', { to: peerId, signal: { type: 'ice', candidate: e.candidate } });
  };
  pc.ontrack = (e) => addAudioEl(peerId, e.streams[0]);
  peerConnections.set(peerId, pc);
  return pc;
}

async function callPeer(peerId) {
  const pc = createPeerConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('voice-signal', { to: peerId, signal: { type: 'offer', sdp: offer } });
}

socket.on('voice-peers', async (peers) => {
  for (const p of peers) await callPeer(p.id);
});

socket.on('voice-peer-joined', (peer) => {
  renderVoiceParticipant(peer.id, peer.username);
});

socket.on('voice-peer-left', ({ id }) => {
  const pc = peerConnections.get(id);
  if (pc) { pc.close(); peerConnections.delete(id); }
  removeAudioEl(id);
  const li = document.getElementById('voice-p-' + id);
  if (li) li.remove();
});

socket.on('voice-signal', async ({ from, signal }) => {
  let pc = peerConnections.get(from);
  if (signal.type === 'offer') {
    if (!pc) pc = createPeerConnection(from);
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('voice-signal', { to: from, signal: { type: 'answer', sdp: answer } });
  } else if (signal.type === 'answer') {
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
  } else if (signal.type === 'ice') {
    if (pc) { try { await pc.addIceCandidate(signal.candidate); } catch {} }
  }
});

function renderVoiceParticipant(id, username) {
  if (document.getElementById('voice-p-' + id)) return;
  const li = document.createElement('li');
  li.id = 'voice-p-' + id;
  li.textContent = username;
  voiceParticipantsEl.appendChild(li);
}

voiceToggleBtn.addEventListener('click', async () => {
  if (!inVoice) {
    try {
      const audioConstraint = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      };
      if (settings.micId) audioConstraint.deviceId = { exact: settings.micId };
      localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
    } catch (err) {
      alert('Microphone access denied or unavailable: ' + err.message);
      return;
    }
    inVoice = true;
    micMuted = false;
    voiceToggleBtn.textContent = 'Leave Voice';
    muteMicBtn.disabled = false;
    muteMicBtn.textContent = '🎤';
    muteMicBtn.classList.remove('muted');
    renderVoiceParticipant('me', myUsername + ' (you)');
    socket.emit('voice-join');
    startVAD(localStream);
  } else {
    inVoice = false;
    voiceToggleBtn.textContent = 'Join Voice';
    muteMicBtn.disabled = true;
    peerConnections.forEach((pc) => pc.close());
    peerConnections.clear();
    voiceParticipantsEl.innerHTML = '';
    stopVAD();
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    socket.emit('voice-leave');
  }
});
