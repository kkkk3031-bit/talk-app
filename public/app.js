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

let myUsername = null;
let currentChannel = 'general';
let inVoice = false;
let localStream = null;
const peerConnections = new Map(); // peerId -> RTCPeerConnection
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function go(fn) { document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn) : fn(); }

function renderMessage({ username, text, ts }, system = false) {
  const div = document.createElement('div');
  div.className = 'message' + (system ? ' system' : '');
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = system
    ? `<span class="text">${escapeHtml(text)}</span>`
    : `<span class="author">${escapeHtml(username)}</span><span class="time">${time}</span><br/><span class="text">${escapeHtml(text)}</span>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
  if (channel !== currentChannel) return;
  renderMessage(msg);
});

socket.on('presence', renderPresence);

messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', text);
  messageInput.value = '';
});

// --- WebRTC voice (P2P mesh) ---

function addAudioEl(peerId, stream) {
  let el = document.getElementById('audio-' + peerId);
  if (!el) {
    el = document.createElement('audio');
    el.id = 'audio-' + peerId;
    el.autoplay = true;
    document.body.appendChild(el);
  }
  el.srcObject = stream;
}

function removeAudioEl(peerId) {
  const el = document.getElementById('audio-' + peerId);
  if (el) el.remove();
}

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(rtcConfig);
  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
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
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      alert('Microphone access denied or unavailable: ' + err.message);
      return;
    }
    inVoice = true;
    voiceToggleBtn.textContent = 'Leave Voice';
    renderVoiceParticipant('me', myUsername + ' (you)');
    socket.emit('voice-join');
  } else {
    inVoice = false;
    voiceToggleBtn.textContent = 'Join Voice';
    peerConnections.forEach((pc) => pc.close());
    peerConnections.clear();
    voiceParticipantsEl.innerHTML = '';
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    socket.emit('voice-leave');
  }
});
