const socket = io();

const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app-screen');
const usernameInput = document.getElementById('username-input');
const joinBtn = document.getElementById('join-btn');
const channelList = document.getElementById('channel-list');
const presenceList = document.getElementById('presence-list');
const messagesEl = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const attachmentPreviewEl = document.getElementById('attachment-preview');
const voiceToggleBtn = document.getElementById('voice-toggle-btn');
const voiceMediaControlsEl = document.getElementById('voice-media-controls');
const cameraToggleBtn = document.getElementById('camera-toggle-btn');
const videoGridEl = document.getElementById('video-grid');
const voiceRoomNavEl = document.getElementById('voice-room-nav');
const mainHeaderTextEl = document.getElementById('main-header-text');
const voiceViewEl = document.getElementById('voice-view');
const textViewEl = document.getElementById('text-view');
const voiceEmptyStateEl = document.getElementById('voice-empty-state');
const voiceEmptyJoinBtn = document.getElementById('voice-empty-join-btn');
const userBarAvatar = document.getElementById('user-bar-avatar');
const userBarName = document.getElementById('user-bar-name');
const muteMicBtn = document.getElementById('mute-mic-btn');
const settingsBtn = document.getElementById('settings-btn');
const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
const sidebarOverlayEl = document.getElementById('sidebar-overlay');
const sidebarEl = document.querySelector('.sidebar');
const sidebarResizeHandle = document.getElementById('sidebar-resize-handle');
const settingsModal = document.getElementById('settings-modal');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const micSelect = document.getElementById('mic-select');
const volumeSlider = document.getElementById('volume-slider');
const volumeValueEl = document.getElementById('volume-value');
const displayNameInput = document.getElementById('display-name-input');
const saveNameBtn = document.getElementById('save-name-btn');
const renameErrorEl = document.getElementById('rename-error');
const avatarPreviewEl = document.getElementById('avatar-preview');
const avatarUploadBtn = document.getElementById('avatar-upload-btn');
const avatarFileInput = document.getElementById('avatar-file-input');

const serverRailListEl = document.getElementById('server-rail-list');
const serverAddBtn = document.getElementById('server-add-btn');
const serverModal = document.getElementById('server-modal');
const serverModalCloseBtn = document.getElementById('server-modal-close-btn');
const createServerInput = document.getElementById('create-server-input');
const createServerBtn = document.getElementById('create-server-btn');
const browseServerListEl = document.getElementById('browse-server-list');

const friendsNavEl = document.getElementById('friends-nav');
const friendsViewEl = document.getElementById('friends-view');
const addFriendForm = document.getElementById('add-friend-form');
const addFriendInput = document.getElementById('add-friend-input');
const incomingRequestsListEl = document.getElementById('incoming-requests-list');
const friendsListEl = document.getElementById('friends-list');

const dmViewEl = document.getElementById('dm-view');
const dmMessagesEl = document.getElementById('dm-messages');
const dmForm = document.getElementById('dm-form');
const dmInput = document.getElementById('dm-input');

let myUsername = null;
let currentServerId = 'home';
let currentChannel = 'general';
let currentDmUser = null;
const knownProfiles = new Map(); // username -> { username, avatarUrl }
const myServers = new Map(); // serverId -> { id, name, channels }
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

// re-scan input devices live (e.g. a USB/wired mic plugged into the phone
// while Settings is open) instead of only enumerating once on modal open
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (!settingsModal.classList.contains('hidden')) populateMicList().catch(() => {});
  });
}

settingsBtn.addEventListener('click', async () => {
  settingsModal.classList.remove('hidden');
  displayNameInput.value = myUsername;
  renameErrorEl.classList.add('hidden');
  applyAvatar(avatarPreviewEl, myUsername);
  try { await populateMicList(); } catch {}
});
settingsCloseBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); });

// --- profile: rename ---
saveNameBtn.addEventListener('click', () => {
  const name = displayNameInput.value.trim();
  if (!name || name === myUsername) return;
  socket.emit('rename', name);
});
socket.on('renamed', (newUsername) => {
  myUsername = newUsername;
  userBarName.textContent = newUsername;
  applyAvatar(userBarAvatar, newUsername);
  renameErrorEl.classList.add('hidden');
});
socket.on('rename-failed', (message) => {
  renameErrorEl.textContent = message;
  renameErrorEl.classList.remove('hidden');
});

// --- profile: avatar upload ---
avatarUploadBtn.addEventListener('click', () => avatarFileInput.click());
avatarFileInput.addEventListener('change', async () => {
  const file = avatarFileInput.files[0];
  avatarFileInput.value = '';
  if (!file) return;
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    socket.emit('set-avatar', data.url);
    rememberProfile({ username: myUsername, avatarUrl: data.url });
    applyAvatar(avatarPreviewEl, myUsername);
    applyAvatar(userBarAvatar, myUsername);
  } catch (err) {
    alert('Avatar upload failed: ' + err.message);
  }
});

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
      setTileSpeaking('me', speaking);
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

function isImageMime(mime) { return /^image\//.test(mime || ''); }
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function renderAttachment(att) {
  if (!att) return '';
  if (isImageMime(att.mime)) {
    return `<img class="attachment-img" src="${att.url}" alt="${escapeHtml(att.name)}" data-lightbox="${att.url}" />`;
  }
  return `<a class="attachment-file" href="${att.url}" target="_blank" rel="noopener" download="${escapeHtml(att.name)}">📄 ${escapeHtml(att.name)} <span class="attachment-size">(${formatSize(att.size)})</span></a>`;
}

// consecutive messages from the same author within this window are grouped
// under one avatar/header, like real Discord. Shared by the channel message
// list and the DM message list, each with its own independent grouping state.
const GROUP_WINDOW_MS = 7 * 60 * 1000;

function createMessageList(container, { onDelete, onEdit, onReact } = {}) {
  let lastGroupAuthor = null;
  let lastGroupTs = 0;

  function clear() {
    container.innerHTML = '';
    lastGroupAuthor = null;
    lastGroupTs = 0;
  }

  function textSpanHtml(text, edited) {
    if (!text) return '';
    // the (edited) tag lives INSIDE .text (not as a sibling) so it flows
    // right after the last word on the wrapped line, matching Discord —
    // .text is display:block, so a sibling span would start on its own line
    return `<span class="text">${escapeHtml(text)}${edited ? ' <span class="edited-tag">(edited)</span>' : ''}</span>`;
  }

  function reactionsHtml(reactions) {
    if (!reactions) return '<div class="reactions"></div>';
    const pills = Object.keys(reactions).map((emoji) => {
      const users = reactions[emoji];
      if (!users || !users.length) return '';
      const mine = users.indexOf(myUsername) !== -1;
      return `<button class="reaction-pill${mine ? ' mine' : ''}" data-emoji="${escapeHtml(emoji)}">${emoji} ${users.length}</button>`;
    }).join('');
    return `<div class="reactions">${pills}</div>`;
  }

  function render({ id, username, text, attachment, ts, edited, reactions }, system = false) {
    const div = document.createElement('div');
    const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const mine = !system && !!onDelete && username === myUsername;
    const textHtml = textSpanHtml(text, edited);
    const attHtml = attachment ? renderAttachment(attachment) : '';
    const reactHtml = reactionsHtml(reactions);
    const reactBtnHtml = onReact ? '<button class="react-btn" title="Add reaction">😀</button>' : '';
    const editBtnHtml = mine && text && onEdit ? '<button class="edit-btn" title="Edit">✏️</button>' : '';
    const deleteBtnHtml = mine ? '<button class="delete-btn" title="Delete">🗑</button>' : '';

    if (system) {
      div.className = 'message system';
      if (id) div.dataset.id = id;
      div.innerHTML = `<span class="text">${escapeHtml(text)}</span>`;
      lastGroupAuthor = null;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
      return;
    }

    const grouped = username === lastGroupAuthor && (ts - lastGroupTs) < GROUP_WINDOW_MS;
    div.className = 'message' + (grouped ? ' grouped' : '');
    if (id) div.dataset.id = id;
    const gutterHtml = grouped
      ? `<span class="hover-time">${time}</span>`
      : `<div class="avatar message-avatar"></div>`;
    const headerHtml = grouped
      ? ''
      : `<div class="message-header"><span class="author">${escapeHtml(username)}</span><span class="time">${time}</span></div>`;
    div.innerHTML = `<div class="message-gutter">${gutterHtml}</div><div class="message-body">${headerHtml}${textHtml}${attHtml}${reactHtml}</div><div class="message-actions">${reactBtnHtml}${editBtnHtml}${deleteBtnHtml}</div>`;
    if (!grouped) applyAvatar(div.querySelector('.message-avatar'), username);
    if (mine) {
      div.querySelector('.delete-btn').addEventListener('click', () => onDelete(id));
      const editBtn = div.querySelector('.edit-btn');
      if (editBtn) editBtn.addEventListener('click', () => beginEdit(div, id));
    }
    const reactBtn = div.querySelector('.react-btn');
    if (reactBtn) reactBtn.addEventListener('click', (e) => openReactionPicker(e.currentTarget, id, onReact));
    lastGroupAuthor = username;
    lastGroupTs = ts;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function beginEdit(div, id) {
    const textEl = div.querySelector('.text');
    if (!textEl || div.querySelector('.edit-input')) return; // no text to edit, or already editing
    const original = textEl.textContent;
    const input = document.createElement('input');
    input.className = 'edit-input';
    input.value = original;
    textEl.replaceWith(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    // finish() removes `input` from the DOM, which itself fires a blur event —
    // without this guard, an Enter/Escape keypress and the blur it triggers
    // would both call finish() and the second call's replaceWith() would
    // throw (input is no longer a child of anything by then)
    let finished = false;
    const finish = (commit) => {
      if (finished) return;
      finished = true;
      const newVal = input.value.trim();
      if (commit && newVal && newVal !== original) onEdit(id, newVal);
      const restored = document.createElement('span');
      restored.className = 'text';
      restored.textContent = commit && newVal ? newVal : original;
      input.replaceWith(restored);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  // applies a server-confirmed edit to an already-rendered message (own or
  // someone else's — every tab of the editor gets this same echo too)
  function applyEdit(id, text) {
    const div = container.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!div) return;
    const textEl = div.querySelector('.text');
    if (!textEl) return;
    textEl.innerHTML = `${escapeHtml(text)} <span class="edited-tag">(edited)</span>`;
  }

  // applies a server-confirmed reaction change (add/remove, by anyone) to an
  // already-rendered message
  function applyReactions(id, reactions) {
    const div = container.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!div) return;
    const el = div.querySelector('.reactions');
    if (el) el.outerHTML = reactionsHtml(reactions);
  }

  if (onReact) {
    container.addEventListener('click', (e) => {
      const pill = e.target.closest('.reaction-pill');
      if (!pill) return;
      const messageEl = pill.closest('.message');
      if (!messageEl || !messageEl.dataset.id) return;
      onReact(messageEl.dataset.id, pill.dataset.emoji);
    });
  }

  return { clear, render, applyEdit, applyReactions };
}

const channelMessageList = createMessageList(messagesEl, {
  onDelete: (id) => socket.emit('delete-message', { serverId: currentServerId, channel: currentChannel, id }),
  onEdit: (id, text) => socket.emit('edit-message', { serverId: currentServerId, channel: currentChannel, id, text }),
  onReact: (id, emoji) => socket.emit('toggle-reaction', { serverId: currentServerId, channel: currentChannel, id, emoji }),
});
function clearMessages() { channelMessageList.clear(); }
function renderMessage(msg, system = false) { channelMessageList.render(msg, system); }

const AVATAR_COLORS = ['#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#f0a020', '#23a55a', '#00a8fc'];
function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function rememberProfile(p) {
  if (p && p.username) knownProfiles.set(p.username, p);
}

// applies either an uploaded photo or the letter-avatar fallback to any .avatar element
function applyAvatar(el, username) {
  const p = knownProfiles.get(username);
  el.style.background = ''; // clear the shorthand first — setting it after the image longhands resets them back out
  if (p && p.avatarUrl) {
    el.style.backgroundImage = `url('${p.avatarUrl}')`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.style.background = avatarColor(username);
    el.textContent = username.slice(0, 1).toUpperCase();
  }
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
    li.addEventListener('click', () => {
      currentChannel = c;
      messageInput.placeholder = `Message #${c}`;
      [...channelList.children].forEach((el) => el.classList.toggle('active', el.dataset.channel === c));
      unreadCounts[c] = 0;
      renderChannelBadge(li, c);
      typingUsers.clear();
      renderTyping();
      socket.emit('switch-channel', { serverId: currentServerId, channel: c });
      setMainView('text');
      closeSidebar();
    });
    channelList.appendChild(li);
  });
}

// --- main view: land on the Voice room after login; everything else is opt-in ---
let mainView = 'voice';
function setMainView(view) {
  mainView = view;
  const isText = view === 'text';
  const isVoice = view === 'voice';
  const isFriends = view === 'friends';
  const isDm = view === 'dm';
  textViewEl.classList.toggle('hidden', !isText);
  voiceViewEl.classList.toggle('hidden', !isVoice);
  friendsViewEl.classList.toggle('hidden', !isFriends);
  dmViewEl.classList.toggle('hidden', !isDm);
  voiceRoomNavEl.classList.toggle('active', isVoice);
  friendsNavEl.classList.toggle('active', isFriends);
  [...channelList.children].forEach((el) => el.classList.toggle('active', isText && el.dataset.channel === currentChannel));
  if (isText) mainHeaderTextEl.textContent = `# ${currentChannel}`;
  else if (isVoice) mainHeaderTextEl.textContent = '🔊 Voice Room';
  else if (isFriends) mainHeaderTextEl.textContent = '👥 Friends';
  else if (isDm) mainHeaderTextEl.textContent = `@${currentDmUser}`;
}
voiceRoomNavEl.addEventListener('click', () => { setMainView('voice'); closeSidebar(); });
voiceEmptyJoinBtn.addEventListener('click', () => voiceToggleBtn.click());
friendsNavEl.addEventListener('click', () => { setMainView('friends'); closeSidebar(); });

// --- servers (Discord-style: your own server rail on the left) ---
let latestServerDirectory = [];

function renderServerRail() {
  serverRailListEl.innerHTML = '';
  myServers.forEach((s) => {
    const el = document.createElement('div');
    el.className = 'server-icon' + (s.id === currentServerId ? ' active' : '');
    el.textContent = s.name.slice(0, 1).toUpperCase();
    el.title = s.name;
    el.dataset.serverId = s.id;
    el.addEventListener('click', () => switchServer(s.id));
    serverRailListEl.appendChild(el);
  });
}

function switchServer(serverId) {
  const s = myServers.get(serverId);
  if (!s) return;
  currentServerId = serverId;
  currentChannel = s.channels[0];
  renderServerRail();
  renderChannelList(s.channels);
  socket.emit('switch-channel', { serverId, channel: currentChannel });
  setMainView('text');
  closeSidebar();
}

socket.on('server-created', (s) => {
  myServers.set(s.id, s);
  renderServerRail();
  switchServer(s.id);
  serverModal.classList.add('hidden');
});

socket.on('server-joined', (s) => {
  myServers.set(s.id, s);
  renderServerRail();
  switchServer(s.id);
  serverModal.classList.add('hidden');
});

socket.on('server-member-kicked', ({ serverId, username }) => {
  const s = myServers.get(serverId);
  if (s && s.members) s.members = s.members.filter((m) => m !== username);
  if (serverId === currentServerId && !serverModal.classList.contains('hidden')) renderServerMembers();
});

socket.on('server-member-joined', ({ serverId, members }) => {
  const s = myServers.get(serverId);
  if (s) s.members = members;
  if (serverId === currentServerId && !serverModal.classList.contains('hidden')) renderServerMembers();
});

socket.on('kicked-from-server', ({ serverId, name }) => {
  myServers.delete(serverId);
  renderServerRail();
  alert(`You were removed from ${name}.`);
  if (serverId === currentServerId) switchServer('home');
});

socket.on('server-list', (list) => {
  latestServerDirectory = list;
  renderBrowseServerList();
});

function renderBrowseServerList() {
  browseServerListEl.innerHTML = '';
  latestServerDirectory.filter((s) => !myServers.has(s.id)).forEach((s) => {
    const li = document.createElement('li');
    li.className = 'friend-row';
    li.innerHTML = `<span>${escapeHtml(s.name)} <span class="member-count">(${s.memberCount} member${s.memberCount === 1 ? '' : 's'})</span></span>`;
    const joinBtn = document.createElement('button');
    joinBtn.textContent = 'Join';
    joinBtn.addEventListener('click', () => socket.emit('join-server', s.id));
    li.appendChild(joinBtn);
    browseServerListEl.appendChild(li);
  });
  if (!browseServerListEl.children.length) {
    browseServerListEl.innerHTML = '<li class="friends-empty">No other servers yet — create one!</li>';
  }
}

const inviteLinkInput = document.getElementById('invite-link-input');
const copyInviteBtn = document.getElementById('copy-invite-btn');
const serverMembersListEl = document.getElementById('server-members-list');

function renderServerMembers() {
  const s = myServers.get(currentServerId);
  serverMembersListEl.innerHTML = '';
  if (!s || !s.members) return;
  const iAmOwner = s.ownerUsername === myUsername;
  s.members.forEach((username) => {
    const li = document.createElement('li');
    li.className = 'friend-row';
    const avatar = document.createElement('div');
    avatar.className = 'avatar friend-avatar';
    applyAvatar(avatar, username);
    const label = document.createElement('span');
    label.textContent = username + (username === s.ownerUsername ? ' (owner)' : '');
    li.append(avatar, label);
    if (iAmOwner && username !== s.ownerUsername) {
      const kickBtn = document.createElement('button');
      kickBtn.textContent = 'Kick';
      kickBtn.className = 'friend-decline-btn';
      kickBtn.addEventListener('click', () => {
        if (confirm(`Remove ${username} from ${s.name}?`)) socket.emit('kick-member', { serverId: currentServerId, username });
      });
      li.appendChild(kickBtn);
    }
    serverMembersListEl.appendChild(li);
  });
}

serverAddBtn.addEventListener('click', () => {
  serverModal.classList.remove('hidden');
  socket.emit('list-servers');
  inviteLinkInput.value = `${location.origin}${location.pathname}?invite=${encodeURIComponent(currentServerId)}`;
  renderServerMembers();
});
copyInviteBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(inviteLinkInput.value);
    copyInviteBtn.textContent = 'Copied!';
  } catch (e) {
    inviteLinkInput.select(); // clipboard API unavailable (e.g. old WebView) — fall back to select-to-copy
    copyInviteBtn.textContent = 'Select & copy';
  }
  setTimeout(() => { copyInviteBtn.textContent = 'Copy'; }, 1500);
});
serverModalCloseBtn.addEventListener('click', () => serverModal.classList.add('hidden'));
serverModal.addEventListener('click', (e) => { if (e.target === serverModal) serverModal.classList.add('hidden'); });
createServerBtn.addEventListener('click', () => {
  const name = createServerInput.value.trim();
  if (!name) return;
  socket.emit('create-server', name);
  createServerInput.value = '';
});

// --- friends ---
let myFriends = [];
let myIncoming = [];
let myOutgoing = [];

function refreshFriendsView() {
  incomingRequestsListEl.innerHTML = '';
  myIncoming.forEach((username) => {
    const li = document.createElement('li');
    li.className = 'friend-row';
    const avatar = document.createElement('div');
    avatar.className = 'avatar friend-avatar';
    applyAvatar(avatar, username);
    const label = document.createElement('span');
    label.textContent = username;
    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = 'Accept';
    acceptBtn.addEventListener('click', () => socket.emit('friend-accept', username));
    const declineBtn = document.createElement('button');
    declineBtn.textContent = 'Decline';
    declineBtn.className = 'friend-decline-btn';
    declineBtn.addEventListener('click', () => socket.emit('friend-decline', username));
    li.append(avatar, label, acceptBtn, declineBtn);
    incomingRequestsListEl.appendChild(li);
  });
  if (!myIncoming.length) incomingRequestsListEl.innerHTML = '<li class="friends-empty">No pending requests.</li>';

  friendsListEl.innerHTML = '';
  myFriends.forEach((f) => {
    const username = f.username || f;
    const li = document.createElement('li');
    li.className = 'friend-row';
    const avatar = document.createElement('div');
    avatar.className = 'avatar friend-avatar';
    applyAvatar(avatar, username);
    const label = document.createElement('span');
    label.textContent = username;
    label.className = 'friend-name-clickable';
    label.addEventListener('click', () => openDm(username));
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.className = 'friend-decline-btn';
    removeBtn.addEventListener('click', () => socket.emit('friend-remove', username));
    li.append(avatar, label, removeBtn);
    friendsListEl.appendChild(li);
    renderDmUnreadBadge(li, username);
  });
  if (!myFriends.length) friendsListEl.innerHTML = '<li class="friends-empty">No friends yet — add one above.</li>';
}

// --- DM unread badges: per-friend-row, plus a summary dot on the Friends nav item ---
const dmUnreadCounts = {};
// NOTE: no optional chaining (?.) or other ES2020+ syntax in this file — the
// Android app's WebView is a very old Chromium (66, from ~2018) and a single
// unsupported token anywhere is a hard parse-time SyntaxError that silently
// kills the *entire* script, disabling every feature, not just the one using it.
function findFriendRow(username) {
  const rows = friendsListEl.querySelectorAll('.friend-row');
  for (let i = 0; i < rows.length; i++) {
    const label = rows[i].querySelector('.friend-name-clickable');
    if (label && label.textContent === username) return rows[i];
  }
  return null;
}
function bumpDmUnread(fromUsername) {
  dmUnreadCounts[fromUsername] = (dmUnreadCounts[fromUsername] || 0) + 1;
  const li = findFriendRow(fromUsername);
  if (li) renderDmUnreadBadge(li, fromUsername);
  renderFriendsNavBadge();
}
function clearDmUnread(username) {
  if (!dmUnreadCounts[username]) return;
  delete dmUnreadCounts[username];
  const li = findFriendRow(username);
  if (li) renderDmUnreadBadge(li, username);
  renderFriendsNavBadge();
}
function renderDmUnreadBadge(li, username) {
  let badge = li.querySelector('.unread-badge');
  const count = dmUnreadCounts[username] || 0;
  if (count === 0) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'unread-badge';
    // sits inline right after the name, not absolutely positioned like the
    // sidebar channel badge — a friend-row already has a Remove button
    // occupying the row's right edge
    const label = li.querySelector('.friend-name-clickable');
    if (label) label.insertAdjacentElement('afterend', badge);
    else li.appendChild(badge);
  }
  badge.textContent = count > 99 ? '99+' : String(count);
}
function renderFriendsNavBadge() {
  const total = Object.values(dmUnreadCounts).reduce((a, b) => a + b, 0);
  let dot = friendsNavEl.querySelector('.unread-badge');
  if (total === 0) {
    if (dot) dot.remove();
    return;
  }
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'unread-badge';
    friendsNavEl.appendChild(dot);
  }
  dot.textContent = total > 99 ? '99+' : String(total);
}

addFriendForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = addFriendInput.value.trim();
  if (!name) return;
  socket.emit('friend-request', name);
  addFriendInput.value = '';
});

socket.on('friend-request-received', (profile) => {
  rememberProfile(profile);
  if (!myIncoming.includes(profile.username)) myIncoming.push(profile.username);
  refreshFriendsView();
});

socket.on('friend-added', (profile) => {
  rememberProfile(profile);
  myIncoming = myIncoming.filter((n) => n !== profile.username);
  myOutgoing = myOutgoing.filter((n) => n !== profile.username);
  if (!myFriends.some((f) => (f.username || f) === profile.username)) myFriends.push(profile);
  refreshFriendsView();
});

socket.on('friend-incoming-removed', (username) => {
  myIncoming = myIncoming.filter((n) => n !== username);
  refreshFriendsView();
});

socket.on('friend-outgoing-added', (username) => {
  myOutgoing.push(username);
});

socket.on('friend-removed', (username) => {
  myFriends = myFriends.filter((f) => (f.username || f) !== username);
  refreshFriendsView();
});

// --- direct messages ---
const dmMessageList = createMessageList(dmMessagesEl); // no onDelete — DMs aren't deletable (server has no dm-delete event)

function openDm(username) {
  currentDmUser = username;
  dmMessageList.clear();
  socket.emit('dm-history', username);
  setMainView('dm');
  clearDmUnread(username);
  clearTimeout(dmTypingTimeout);
  dmTypingIndicatorEl.textContent = '';
}

socket.on('dm-history', ({ withUser, history }) => {
  if (withUser !== currentDmUser) return;
  dmMessageList.clear();
  history.forEach((m) => renderDmMessage(m));
});

socket.on('dm-message', ({ withUser, msg }) => {
  if (withUser !== currentDmUser || mainView !== 'dm') {
    if (msg.from !== myUsername) bumpDmUnread(withUser);
    return;
  }
  renderDmMessage(msg);
});

function renderDmMessage({ from, text, ts }) {
  dmMessageList.render({ username: from, text, ts });
}

dmForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = dmInput.value.trim();
  if (!text || !currentDmUser) return;
  socket.emit('dm-message', { to: currentDmUser, text });
  dmInput.value = '';
});

let dmTypingEmitThrottle = 0;
dmInput.addEventListener('input', () => {
  if (!currentDmUser) return;
  const now = Date.now();
  if (now - dmTypingEmitThrottle < 2000) return;
  dmTypingEmitThrottle = now;
  socket.emit('dm-typing', currentDmUser);
});

const dmTypingIndicatorEl = document.getElementById('dm-typing-indicator');
let dmTypingTimeout = null;
socket.on('dm-typing', ({ from }) => {
  if (from !== currentDmUser) return;
  clearTimeout(dmTypingTimeout);
  dmTypingIndicatorEl.textContent = `${from} is typing…`;
  dmTypingTimeout = setTimeout(() => { dmTypingIndicatorEl.textContent = ''; }, 3000);
});

function openSidebar() {
  sidebarEl.classList.add('open');
  sidebarOverlayEl.classList.remove('hidden');
  sidebarToggleBtn.textContent = '✕';
}
function closeSidebar() {
  sidebarEl.classList.remove('open');
  sidebarOverlayEl.classList.add('hidden');
  sidebarToggleBtn.textContent = '☰';
}
sidebarToggleBtn.addEventListener('click', () => {
  sidebarEl.classList.contains('open') ? closeSidebar() : openSidebar();
});
sidebarOverlayEl.addEventListener('click', closeSidebar);

function renderPresence(list) {
  list.forEach(rememberProfile);
  presenceList.innerHTML = '';
  list.forEach((u) => {
    const li = document.createElement('li');
    li.className = 'presence';
    li.innerHTML = `<span class="dot"></span>${escapeHtml(u.username)}${u.inVoice ? ' 🔊' : ''}`;
    presenceList.appendChild(li);
  });
}

socket.on('profile-updated', (p) => {
  rememberProfile(p);
  if (p.username === myUsername) applyAvatar(userBarAvatar, myUsername);
  refreshFriendsView();
});

joinBtn.addEventListener('click', doJoin);
usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  const name = usernameInput.value.trim();
  if (!name) return;
  socket.emit('join', name);
}

socket.on('joined', (data) => {
  const { username, profile, servers, serverList, currentServerId: sid, channels, history, friends, incomingRequests, outgoingRequests } = data;
  myUsername = username;
  currentServerId = sid;
  rememberProfile({ username, avatarUrl: profile.avatarUrl });
  loginScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');
  userBarName.textContent = username;
  applyAvatar(userBarAvatar, username);
  displayNameInput.value = username;

  servers.forEach((s) => myServers.set(s.id, s));
  renderServerRail();
  renderChannelList(channels);
  clearMessages();
  history.forEach((m) => renderMessage(m));
  setMainView('voice');

  myFriends = friends || [];
  myIncoming = incomingRequests || [];
  myOutgoing = outgoingRequests || [];
  friends.forEach(rememberProfile);
  refreshFriendsView();

  latestServerDirectory = serverList || [];

  const invite = new URLSearchParams(location.search).get('invite');
  if (invite) {
    socket.emit('join-server', invite);
    // `history` above shadows window.history in this scope — must qualify it
    window.history.replaceState(null, '', location.pathname); // strip ?invite= so refreshing doesn't re-trigger it
  }
});

socket.on('channel-history', ({ serverId, channel, history }) => {
  if (serverId !== currentServerId || channel !== currentChannel) return;
  clearMessages();
  history.forEach((m) => renderMessage(m));
});

socket.on('chat-message', ({ serverId, channel, msg }) => {
  if (serverId !== currentServerId || channel !== currentChannel || mainView !== 'text') {
    bumpUnread(serverId, channel);
    return;
  }
  renderMessage(msg);
});

socket.on('message-deleted', ({ serverId, channel, id }) => {
  if (serverId !== currentServerId || channel !== currentChannel) return;
  const el = messagesEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (el) el.remove();
});

socket.on('message-edited', ({ serverId, channel, id, text }) => {
  if (serverId !== currentServerId || channel !== currentChannel) return;
  channelMessageList.applyEdit(id, text);
});

socket.on('message-reaction', ({ serverId, channel, id, reactions }) => {
  if (serverId !== currentServerId || channel !== currentChannel) return;
  channelMessageList.applyReactions(id, reactions);
});

socket.on('presence', renderPresence);

let pendingAttachment = null;

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  attachmentPreviewEl.textContent = `Uploading ${file.name}…`;
  attachmentPreviewEl.classList.remove('hidden');
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    pendingAttachment = data;
    attachmentPreviewEl.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = `📎 ${data.name} (${formatSize(data.size)})`;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '✕';
    removeBtn.className = 'attachment-remove';
    removeBtn.addEventListener('click', () => {
      pendingAttachment = null;
      attachmentPreviewEl.classList.add('hidden');
      attachmentPreviewEl.innerHTML = '';
    });
    attachmentPreviewEl.appendChild(label);
    attachmentPreviewEl.appendChild(removeBtn);
  } catch (err) {
    attachmentPreviewEl.textContent = `Upload failed: ${err.message}`;
    setTimeout(() => attachmentPreviewEl.classList.add('hidden'), 3000);
  }
});

messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text && !pendingAttachment) return;
  socket.emit('chat-message', { text, attachment: pendingAttachment });
  messageInput.value = '';
  pendingAttachment = null;
  attachmentPreviewEl.classList.add('hidden');
  attachmentPreviewEl.innerHTML = '';
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
function bumpUnread(serverId, channel) {
  if (serverId !== currentServerId) return; // only the visible server's sidebar has these channels rendered
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
  watchRemoteSpeaking(peerId, stream);
}

function removeAudioEl(peerId) {
  const el = document.getElementById('audio-' + peerId);
  if (el) el.remove();
}

// --- voice room: one big tile per participant (Discord-style), avatar circle
// by default, swapped for their live video when camera/screen is on ---
function showVideoGrid() {
  videoGridEl.classList.remove('hidden');
  voiceEmptyStateEl.classList.add('hidden');
}
function hideVideoGridIfEmpty() {
  if (!videoGridEl.children.length) {
    videoGridEl.classList.add('hidden');
    voiceEmptyStateEl.classList.remove('hidden');
  }
}

function ensureRoomTile(peerId, label) {
  let tile = document.getElementById('room-tile-' + peerId);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = 'room-tile-' + peerId;
    const avatar = document.createElement('div');
    avatar.className = 'avatar room-avatar';
    applyAvatar(avatar, label);
    const labelEl = document.createElement('div');
    labelEl.className = 'video-tile-label';
    labelEl.textContent = label;
    tile.appendChild(avatar);
    tile.appendChild(labelEl);
    videoGridEl.appendChild(tile);
    showVideoGrid();
  }
  return tile;
}

function removeRoomTile(peerId) {
  const tile = document.getElementById('room-tile-' + peerId);
  if (tile) tile.remove();
  hideVideoGridIfEmpty();
  stopWatchingRemoteSpeaking(peerId);
}

function setTileVideo(peerId, label, stream, { muted = false, mirror = false } = {}) {
  const tile = ensureRoomTile(peerId, label);
  const existingAvatar = tile.querySelector('.room-avatar');
  if (existingAvatar) existingAvatar.remove();
  let video = tile.querySelector('video');
  if (!video) {
    video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = muted;
    if (mirror) video.classList.add('mirrored');
    tile.insertBefore(video, tile.firstChild);
  }
  video.srcObject = stream;
}

function setTileAvatarOnly(peerId, label) {
  const tile = document.getElementById('room-tile-' + peerId);
  if (!tile) return;
  const video = tile.querySelector('video');
  if (video) video.remove();
  if (!tile.querySelector('.room-avatar')) {
    const avatar = document.createElement('div');
    avatar.className = 'avatar room-avatar';
    applyAvatar(avatar, label);
    tile.insertBefore(avatar, tile.firstChild);
  }
}

function setTileSpeaking(peerId, speaking) {
  const tile = document.getElementById('room-tile-' + peerId);
  if (tile) tile.classList.toggle('speaking', speaking);
}

// remote-peer speaking detection mirrors the local VAD, so every tile in the
// room gets the same "who's talking" ring, not just the local user's button
const remoteVadHandles = new Map(); // peerId -> { ctx, raf }
function watchRemoteSpeaking(peerId, stream) {
  stopWatchingRemoteSpeaking(peerId);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.5;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const THRESHOLD = 14;
  let speaking = false;
  let raf;
  (function loop() {
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const nowSpeaking = sum / data.length > THRESHOLD;
    if (nowSpeaking !== speaking) {
      speaking = nowSpeaking;
      setTileSpeaking(peerId, speaking);
    }
    raf = requestAnimationFrame(loop);
  })();
  remoteVadHandles.set(peerId, { ctx, get raf() { return raf; } });
}
function stopWatchingRemoteSpeaking(peerId) {
  const handle = remoteVadHandles.get(peerId);
  if (!handle) return;
  cancelAnimationFrame(handle.raf);
  handle.ctx.close();
  remoteVadHandles.delete(peerId);
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
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => pc.addTrack(t, cameraStream));
  }
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('voice-signal', { to: peerId, signal: { type: 'ice', candidate: e.candidate } });
  };
  pc.ontrack = (e) => {
    if (e.track.kind === 'video') {
      const username = peerUsernames.get(peerId) || peerId;
      setTileVideo(peerId, username, e.streams[0]);
    } else {
      addAudioEl(peerId, e.streams[0]);
    }
  };
  peerConnections.set(peerId, pc);
  return pc;
}

async function renegotiate(peerId) {
  const pc = peerConnections.get(peerId);
  if (!pc) return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('voice-signal', { to: peerId, signal: { type: 'offer', sdp: offer } });
}

async function callPeer(peerId) {
  const pc = createPeerConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('voice-signal', { to: peerId, signal: { type: 'offer', sdp: offer } });
}

const peerUsernames = new Map(); // peerId -> username, for labeling remote video tiles

socket.on('voice-peers', async (peers) => {
  for (const p of peers) {
    peerUsernames.set(p.id, p.username);
    ensureRoomTile(p.id, p.username);
    await callPeer(p.id);
  }
});

socket.on('voice-peer-joined', (peer) => {
  peerUsernames.set(peer.id, peer.username);
  ensureRoomTile(peer.id, peer.username);
});

socket.on('voice-peer-left', ({ id }) => {
  const pc = peerConnections.get(id);
  if (pc) { pc.close(); peerConnections.delete(id); }
  removeAudioEl(id);
  removeRoomTile(id);
  peerUsernames.delete(id);
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
  } else if (signal.type === 'video-off') {
    setTileAvatarOnly(from, peerUsernames.get(from) || from);
  }
});

voiceToggleBtn.addEventListener('click', async () => {
  if (!inVoice) {
    localStream = await acquireMicStream();
    if (!localStream) return;
    inVoice = true;
    micMuted = false;
    voiceToggleBtn.textContent = 'Leave Voice';
    muteMicBtn.disabled = false;
    muteMicBtn.textContent = '🎤';
    muteMicBtn.classList.remove('muted');
    ensureRoomTile('me', myUsername);
    voiceMediaControlsEl.classList.remove('hidden');
    socket.emit('voice-join');
    startVAD(localStream);
  } else {
    inVoice = false;
    voiceToggleBtn.textContent = 'Join Voice';
    muteMicBtn.disabled = true;
    voiceMediaControlsEl.classList.add('hidden');
    if (cameraOn) stopCamera();
    peerConnections.forEach((pc) => pc.close());
    peerConnections.clear();
    peerUsernames.clear();
    remoteVadHandles.forEach((_, peerId) => stopWatchingRemoteSpeaking(peerId));
    videoGridEl.innerHTML = '';
    videoGridEl.classList.add('hidden');
    stopVAD();
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    socket.emit('voice-leave');
  }
});

// the Android app's WebView tags its user-agent so the two "how to fix this"
// paths (browser address-bar vs. Android app Settings) can be told apart —
// see MainActivity's settings.setUserAgentString()
const IS_ANDROID_APP = /TalkAppAndroid/.test(navigator.userAgent);

// Requests a mic stream with the preferred constraints, but falls back to
// progressively simpler ones instead of failing outright. Real Android
// WebViews (and some real devices) routinely throw NotReadableError /
// OverconstrainedError on the first getUserMedia() call even when nothing
// else is actually holding the mic — a stale saved deviceId that no longer
// exists (e.g. a Bluetooth headset that's since disconnected) or a transient
// AudioRecord-not-ready state right after the permission grant are both
// common, and a bare retry a moment later routinely succeeds. Only surfaces
// an error to the user after every fallback has actually failed.
async function acquireMicStream() {
  const withDevice = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  };
  // `ideal`, not `exact` — a saved device that's no longer present must not
  // hard-fail the whole request, it should just fall back to the default
  if (settings.micId) withDevice.deviceId = { ideal: settings.micId };

  const attempts = [
    () => navigator.mediaDevices.getUserMedia({ audio: withDevice }),
    // Chromium picks a VOICE_COMMUNICATION AudioSource when echoCancellation
    // (default true, including for plain `{audio: true}`) is requested,
    // which needs the app to have set up AudioManager communication mode.
    // The standalone Chrome app does that internally; a bare WebView does
    // not — confirmed on a real device (Samsung, Android 16, Chrome 152
    // WebView) via the /api/client-log beacon: every previous fallback here
    // still requested echo cancellation, so none of them actually exercised
    // a different AudioSource and all failed identically. Explicitly
    // disabling all processing forces a plain MIC source instead.
    () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }),
    () => navigator.mediaDevices.getUserMedia({ audio: true }),
  ];

  const attemptErrors = [];
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    try {
      return await attempts[i]();
    } catch (err) {
      lastErr = err;
      attemptErrors.push(i + ':' + err.name);
      if (i < attempts.length - 1) await new Promise((r) => setTimeout(r, 350));
    }
  }
  reportMediaError('microphone', lastErr, attemptErrors);
  alert(mediaErrorMessage(lastErr, 'microphone'));
  return null;
}

// fire-and-forget: lets the exact browser-reported error show up in server
// logs instead of relying on someone accurately relaying technical text
function reportMediaError(context, err, attemptErrors) {
  try {
    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, name: err.name, message: err.message, attempts: attemptErrors || null, ua: navigator.userAgent }),
    }).catch(() => {});
  } catch (e) { /* ignore — this is best-effort diagnostics, never block the user-facing error */ }
}

// maps getUserMedia() DOMException names to what the user should actually do,
// instead of surfacing the raw browser error string
function mediaErrorMessage(err, device) {
  switch (err.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return IS_ANDROID_APP
        ? `${device === 'camera' ? 'Camera' : 'Microphone'} access is blocked for talk-app. Open your phone's Settings > Apps > talk-app > Permissions, and allow ${device === 'camera' ? 'Camera' : 'Microphone'}.`
        : `${device === 'camera' ? 'Camera' : 'Microphone'} access was blocked. Click the padlock/site-info icon in your address bar, allow ${device}, then reload the page.`;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return `No ${device} was found on this device.`;
    case 'NotReadableError':
    case 'TrackStartError':
      return `Couldn't access the ${device} — it may already be in use by another app.`;
    case 'SecurityError':
      return `${device === 'camera' ? 'Camera' : 'Microphone'} access requires a secure (HTTPS) connection.`;
    default:
      return `${device === 'camera' ? 'Camera' : 'Microphone'} access failed: ${err.message}`;
  }
}

// --- camera ---
let cameraStream = null;
let cameraOn = false;

async function startCamera() {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
  } catch (err) {
    reportMediaError('camera', err);
    alert(mediaErrorMessage(err, 'camera'));
    return;
  }
  cameraOn = true;
  cameraToggleBtn.classList.add('active');
  cameraToggleBtn.title = 'Turn off camera';
  setTileVideo('me', myUsername, cameraStream, { muted: true, mirror: true });
  for (const [peerId, pc] of peerConnections) {
    cameraStream.getTracks().forEach((t) => pc.addTrack(t, cameraStream));
    await renegotiate(peerId);
  }
}

function stopCamera() {
  if (!cameraStream) return;
  cameraStream.getTracks().forEach((t) => t.stop());
  for (const [peerId, pc] of peerConnections) {
    pc.getSenders().filter((s) => s.track && s.track.kind === 'video').forEach((s) => pc.removeTrack(s));
    renegotiate(peerId);
    socket.emit('voice-signal', { to: peerId, signal: { type: 'video-off', kind: 'cam' } });
  }
  cameraStream = null;
  cameraOn = false;
  cameraToggleBtn.classList.remove('active');
  cameraToggleBtn.title = 'Turn on camera';
  setTileAvatarOnly('me', myUsername);
}

cameraToggleBtn.addEventListener('click', () => {
  if (cameraOn) stopCamera();
  else startCamera();
});

// --- sidebar drag-to-resize ---
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 420;
(() => {
  const saved = parseInt(localStorage.getItem('sidebarWidth'), 10);
  if (saved && saved >= SIDEBAR_MIN_WIDTH && saved <= SIDEBAR_MAX_WIDTH) {
    sidebarEl.style.width = `${saved}px`;
  }
})();

let sidebarDragStartX = 0;
let sidebarDragStartWidth = 0;

function onSidebarDragMove(e) {
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const delta = clientX - sidebarDragStartX;
  const width = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, sidebarDragStartWidth + delta));
  sidebarEl.style.width = `${width}px`;
}
function onSidebarDragEnd() {
  sidebarResizeHandle.classList.remove('dragging');
  document.removeEventListener('mousemove', onSidebarDragMove);
  document.removeEventListener('mouseup', onSidebarDragEnd);
  document.removeEventListener('touchmove', onSidebarDragMove);
  document.removeEventListener('touchend', onSidebarDragEnd);
  localStorage.setItem('sidebarWidth', parseInt(sidebarEl.style.width, 10));
}
function onSidebarDragStart(e) {
  sidebarDragStartX = e.touches ? e.touches[0].clientX : e.clientX;
  sidebarDragStartWidth = sidebarEl.getBoundingClientRect().width;
  sidebarResizeHandle.classList.add('dragging');
  document.addEventListener('mousemove', onSidebarDragMove);
  document.addEventListener('mouseup', onSidebarDragEnd);
  document.addEventListener('touchmove', onSidebarDragMove, { passive: true });
  document.addEventListener('touchend', onSidebarDragEnd);
  e.preventDefault();
}
sidebarResizeHandle.addEventListener('mousedown', onSidebarDragStart);
sidebarResizeHandle.addEventListener('touchstart', onSidebarDragStart, { passive: false });

// --- image lightbox: click any attachment image (chat or DM) to view full-size ---
const imageLightbox = document.getElementById('image-lightbox');
const lightboxImg = document.getElementById('lightbox-img');
document.addEventListener('click', (e) => {
  const img = e.target.closest('.attachment-img');
  if (!img) return;
  lightboxImg.src = img.dataset.lightbox || img.src;
  lightboxImg.alt = img.alt;
  imageLightbox.classList.remove('hidden');
});
imageLightbox.addEventListener('click', () => imageLightbox.classList.add('hidden'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !imageLightbox.classList.contains('hidden')) imageLightbox.classList.add('hidden');
});

// --- reactions: a small fixed emoji set, click the react button to pick one,
// click an existing pill to toggle your own reaction on/off ---
const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const reactionPicker = document.createElement('div');
reactionPicker.className = 'reaction-picker hidden';
reactionPicker.innerHTML = REACTION_EMOJI.map((e) => `<button data-emoji="${e}">${e}</button>`).join('');
document.body.appendChild(reactionPicker);

let reactionPickerTarget = null; // { messageId, onReact }
function openReactionPicker(btn, messageId, onReact) {
  reactionPickerTarget = { messageId, onReact };
  const rect = btn.getBoundingClientRect();
  reactionPicker.style.top = `${rect.bottom + 4}px`;
  reactionPicker.style.left = `${Math.max(4, rect.right - 200)}px`;
  reactionPicker.classList.remove('hidden');
}
function closeReactionPicker() {
  reactionPicker.classList.add('hidden');
  reactionPickerTarget = null;
}
reactionPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-emoji]');
  if (!btn || !reactionPickerTarget) return;
  reactionPickerTarget.onReact(reactionPickerTarget.messageId, btn.dataset.emoji);
  closeReactionPicker();
});
document.addEventListener('click', (e) => {
  if (!reactionPickerTarget) return;
  if (!reactionPicker.contains(e.target) && !e.target.closest('.react-btn')) closeReactionPicker();
});
