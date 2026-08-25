const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const compression = require('compression');
const { Server } = require('socket.io');

const app = express();
app.disable('x-powered-by');
app.use(compression()); // gzip text responses (JS/CSS/HTML/JSON) — big win on mobile connections
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_DIR = __dirname;
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
const DMS_FILE = path.join(DATA_DIR, 'dms.json');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain',
  'application/zip', 'application/msword',
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 10).replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.has(file.mimetype)),
});

const VOICE_CHANNEL = 'voice-lounge';
const DEFAULT_SERVER_ID = 'home';
const DEFAULT_CHANNELS = ['general', 'random'];

// --- generic serialized + atomic JSON store: one write in flight at a time
// (concurrent writes to the same path can finish out of order and silently
// drop data), landed via tmp-file + rename so a crash mid-write can never
// leave a truncated file on disk. Same pattern for every persisted store. ---
function makeStore(file, defaultValue) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    data = defaultValue;
  }
  let writeInFlight = false;
  let writePending = false;
  function save() {
    if (writeInFlight) { writePending = true; return; }
    writeInFlight = true;
    const json = JSON.stringify(data);
    const tmp = `${file}.tmp`;
    fs.writeFile(tmp, json, (err) => {
      if (err) { writeInFlight = false; console.error(`[store] write failed for ${file}:`, err); return; }
      fs.rename(tmp, file, (err) => {
        writeInFlight = false;
        if (err) console.error(`[store] rename failed for ${file}:`, err);
        if (writePending) { writePending = false; save(); }
      });
    });
  }
  return { get data() { return data; }, save };
}

const historyStore = makeStore(HISTORY_FILE, { [`${DEFAULT_SERVER_ID}::general`]: [], [`${DEFAULT_SERVER_ID}::random`]: [] });
const usersStore = makeStore(USERS_FILE, {}); // username -> { avatarUrl, friends: [], incoming: [], outgoing: [], servers: [] }
const serversStore = makeStore(SERVERS_FILE, {
  [DEFAULT_SERVER_ID]: { id: DEFAULT_SERVER_ID, name: 'Home', ownerUsername: null, channels: DEFAULT_CHANNELS, members: [] },
});
const dmsStore = makeStore(DMS_FILE, {}); // dmKey ("a::b" sorted) -> [msg]

function history() { return historyStore.data; }
function usersDb() { return usersStore.data; }
function serversDb() { return serversStore.data; }
function dmsDb() { return dmsStore.data; }

function ensureUserProfile(username) {
  const db = usersDb();
  if (!db[username]) {
    db[username] = { avatarUrl: null, friends: [], incoming: [], outgoing: [], servers: [DEFAULT_SERVER_ID] };
    if (!serversDb()[DEFAULT_SERVER_ID].members.includes(username)) {
      serversDb()[DEFAULT_SERVER_ID].members.push(username);
    }
    usersStore.save();
    serversStore.save();
  }
  return db[username];
}

function publicProfile(username) {
  const p = ensureUserProfile(username);
  return { username, avatarUrl: p.avatarUrl };
}

function dmKey(a, b) { return [a, b].sort().join('::'); }

// strip server-internal ownership tracking before a message ever reaches a client
function publicMsg(m) {
  const { ownerId, ...rest } = m;
  return rest;
}
// only the most recent 50 messages are sent on initial load — cuts payload
// size substantially (up to 200 are still kept server-side for backlog)
const HISTORY_PAGE_SIZE = 50;
function publicHistory(list) {
  return (list || []).slice(-HISTORY_PAGE_SIZE).map(publicMsg);
}

// socket.id -> { username, serverId, channel, inVoice }
const users = new Map();
// username -> Set<socket.id>, for routing DMs/friend notifications to every
// tab/device a user currently has open
const onlineSockets = new Map();

function addOnlineSocket(username, socketId) {
  if (!onlineSockets.has(username)) onlineSockets.set(username, new Set());
  onlineSockets.get(username).add(socketId);
}
function removeOnlineSocket(username, socketId) {
  const set = onlineSockets.get(username);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) onlineSockets.delete(username);
}
function emitToUser(username, event, payload) {
  const set = onlineSockets.get(username);
  if (!set) return;
  set.forEach((sid) => io.to(sid).emit(event, payload));
}

function broadcastPresence() {
  // one row per account, not per socket — a user with multiple tabs/devices
  // open would otherwise show up once per connection
  const byUsername = new Map();
  for (const u of users.values()) {
    const existing = byUsername.get(u.username);
    byUsername.set(u.username, { username: u.username, inVoice: (existing?.inVoice || false) || u.inVoice });
  }
  const list = [...byUsername.values()].map((u) => ({ ...publicProfile(u.username), inVoice: u.inVoice }));
  io.emit('presence', list);
}

function publicServerList() {
  return Object.values(serversDb()).map((s) => ({
    id: s.id,
    name: s.name,
    ownerUsername: s.ownerUsername,
    memberCount: s.members.length,
  }));
}

function myServerList(username) {
  const profile = ensureUserProfile(username);
  return profile.servers.map((id) => serversDb()[id]).filter(Boolean).map((s) => ({
    id: s.id, name: s.name, channels: s.channels,
  }));
}

const PUBLIC_DIR = path.join(__dirname, 'public');

// Serves index.html with app.js/style.css URLs cache-busted by each file's
// actual mtime. The Android app's WebView has a track record of
// over-aggressively caching JS/CSS across app restarts — a Cache-Control
// header only asks nicely; a URL that's byte-different whenever the file
// actually changes is the one thing no caching bug can misinterpret.
function serveIndex(req, res) {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const v = (file) => { try { return fs.statSync(path.join(PUBLIC_DIR, file)).mtimeMs; } catch { return Date.now(); } };
  html = html
    .replace('/style.css"', `/style.css?v=${v('style.css')}"`)
    .replace('/app.js"', `/app.js?v=${v('app.js')}"`);
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(html);
}
app.get('/', serveIndex);
app.get('/index.html', serveIndex);

app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// diagnostic beacon: the client posts here when getUserMedia() fails after
// every fallback, so the exact browser-reported error is visible in server
// logs without depending on a user accurately relaying technical text
app.post('/api/client-log', express.json({ limit: '2kb' }), (req, res) => {
  const { context, name, message, attempts, ua } = req.body || {};
  console.log(`[client-error] context=${context} name=${name} message=${message} attempts=${JSON.stringify(attempts)} ua=${ua}`);
  res.status(204).end();
});

app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large (15MB max)' });
    }
    if (err) return res.status(500).json({ error: 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'Unsupported file type' });
    res.json({
      url: `/uploads/${req.file.filename}`,
      name: req.file.originalname.slice(0, 200),
      mime: req.file.mimetype,
      size: req.file.size,
    });
  });
});

// simple fixed-window per-socket rate limit — cheap flood protection for
// events a client could otherwise fire as fast as the wire allows
const rateLimitState = new Map(); // socket.id -> { key -> { count, windowStart } }
function rateLimited(socket, key, max, windowMs) {
  let state = rateLimitState.get(socket.id);
  if (!state) { state = {}; rateLimitState.set(socket.id, state); }
  const now = Date.now();
  const bucket = state[key];
  if (!bucket || now - bucket.windowStart > windowMs) {
    state[key] = { count: 1, windowStart: now };
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id} from ${socket.handshake.headers['x-forwarded-for'] || socket.handshake.address}`);

  socket.on('join', (username) => {
    username = String(username || '').trim().slice(0, 24) || `guest-${socket.id.slice(0, 4)}`;
    const profile = ensureUserProfile(username);
    users.set(socket.id, { username, serverId: DEFAULT_SERVER_ID, channel: 'general', inVoice: false });
    addOnlineSocket(username, socket.id);

    // join every channel room in every server this user is a member of, so
    // messages/typing reach the client even for servers/channels not
    // currently being viewed (needed for unread badges)
    profile.servers.forEach((sid) => {
      const s = serversDb()[sid];
      if (s) s.channels.forEach((c) => socket.join(`${sid}::${c}`));
    });

    const server0 = serversDb()[DEFAULT_SERVER_ID];
    socket.emit('joined', {
      username,
      profile: { avatarUrl: profile.avatarUrl },
      servers: myServerList(username),
      serverList: publicServerList(),
      currentServerId: DEFAULT_SERVER_ID,
      channels: server0.channels,
      history: publicHistory(history()[`${DEFAULT_SERVER_ID}::general`]),
      friends: profile.friends.map(publicProfile),
      incomingRequests: profile.incoming.slice(),
      outgoingRequests: profile.outgoing.slice(),
    });
    broadcastPresence();
    console.log(`[join] ${socket.id} -> "${username}"`);
  });

  socket.on('switch-channel', ({ serverId, channel }) => {
    const u = users.get(socket.id);
    if (!u) return;
    const s = serversDb()[serverId];
    if (!s || !s.channels.includes(channel)) return;
    u.serverId = serverId;
    u.channel = channel; // sockets stay joined to every member channel room; this just tracks where new sends/typing go
    socket.emit('channel-history', { serverId, channel, history: publicHistory(history()[`${serverId}::${channel}`]) });
  });

  socket.on('chat-message', (payload) => {
    const u = users.get(socket.id);
    if (!u) return;
    if (rateLimited(socket, 'chat-message', 10, 5000)) return; // 10 msgs / 5s
    const { text, attachment } = typeof payload === 'string' ? { text: payload } : (payload || {});
    if (!text && !attachment) return;
    let safeAttachment = null;
    if (attachment && typeof attachment.url === 'string' && attachment.url.startsWith('/uploads/')) {
      safeAttachment = {
        url: attachment.url,
        name: String(attachment.name || 'file').slice(0, 200),
        mime: String(attachment.mime || '').slice(0, 100),
        size: Number(attachment.size) || 0,
      };
    }
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      username: u.username,
      text: String(text || '').slice(0, 2000),
      attachment: safeAttachment,
      ts: Date.now(),
      ownerId: socket.id, // stripped before broadcast; server-side ownership check for delete
    };
    const key = `${u.serverId}::${u.channel}`;
    history()[key] = history()[key] || [];
    history()[key].push(msg);
    if (history()[key].length > 200) history()[key].shift();
    historyStore.save();
    io.to(key).emit('chat-message', { serverId: u.serverId, channel: u.channel, msg: publicMsg(msg) });
  });

  socket.on('delete-message', ({ serverId, channel, id }) => {
    const u = users.get(socket.id);
    if (!u) return;
    const key = `${serverId}::${channel}`;
    const list = history()[key] || [];
    const idx = list.findIndex((m) => m.id === id);
    if (idx === -1 || list[idx].ownerId !== socket.id) return;
    list.splice(idx, 1);
    historyStore.save();
    io.to(key).emit('message-deleted', { serverId, channel, id });
  });

  socket.on('edit-message', ({ serverId, channel, id, text }) => {
    const u = users.get(socket.id);
    if (!u) return;
    if (rateLimited(socket, 'chat-message', 10, 5000)) return;
    const key = `${serverId}::${channel}`;
    const list = history()[key] || [];
    const msg = list.find((m) => m.id === id);
    if (!msg || msg.ownerId !== socket.id) return;
    const newText = String(text || '').slice(0, 2000).trim();
    if (!newText) return; // editing to empty isn't supported — that's what delete is for
    msg.text = newText;
    msg.edited = true;
    historyStore.save();
    io.to(key).emit('message-edited', { serverId, channel, id, text: newText });
  });

  socket.on('typing', () => {
    const u = users.get(socket.id);
    if (!u) return;
    if (rateLimited(socket, 'typing', 20, 3000)) return;
    socket.to(`${u.serverId}::${u.channel}`).emit('typing', { serverId: u.serverId, channel: u.channel, username: u.username });
  });

  // --- servers (Discord-style: create your own, browse/join others) ---
  socket.on('create-server', (name) => {
    const u = users.get(socket.id);
    if (!u) return;
    name = String(name || '').trim().slice(0, 40);
    if (!name) return;
    const id = crypto.randomBytes(6).toString('hex');
    serversDb()[id] = { id, name, ownerUsername: u.username, channels: DEFAULT_CHANNELS.slice(), members: [u.username] };
    serversStore.save();
    const profile = ensureUserProfile(u.username);
    profile.servers.push(id);
    usersStore.save();
    DEFAULT_CHANNELS.forEach((c) => {
      const key = `${id}::${c}`;
      history()[key] = history()[key] || [];
    });
    historyStore.save();
    socket.join(`${id}::general`);
    socket.join(`${id}::random`);
    socket.emit('server-created', { id, name, channels: DEFAULT_CHANNELS });
    io.emit('server-list', publicServerList());
    console.log(`[create-server] "${u.username}" created "${name}" (${id})`);
  });

  socket.on('list-servers', () => {
    socket.emit('server-list', publicServerList());
  });

  socket.on('join-server', (serverId) => {
    const u = users.get(socket.id);
    if (!u) return;
    const s = serversDb()[serverId];
    if (!s) return;
    const profile = ensureUserProfile(u.username);
    if (!profile.servers.includes(serverId)) {
      profile.servers.push(serverId);
      usersStore.save();
    }
    if (!s.members.includes(u.username)) {
      s.members.push(u.username);
      serversStore.save();
    }
    s.channels.forEach((c) => socket.join(`${serverId}::${c}`));
    socket.emit('server-joined', { id: s.id, name: s.name, channels: s.channels });
    io.emit('server-list', publicServerList());
  });

  // --- friends ---
  socket.on('friend-request', (toUsername) => {
    const u = users.get(socket.id);
    if (!u) return;
    if (rateLimited(socket, 'friend-request', 10, 10000)) return;
    toUsername = String(toUsername || '').trim().slice(0, 24);
    if (!toUsername || toUsername === u.username) return;
    const target = usersDb()[toUsername];
    if (!target) return; // only known (previously-joined) usernames can be friended
    const me = ensureUserProfile(u.username);
    if (me.friends.includes(toUsername) || me.outgoing.includes(toUsername)) return;
    me.outgoing.push(toUsername);
    if (!target.incoming.includes(u.username)) target.incoming.push(u.username);
    usersStore.save();
    socket.emit('friend-outgoing-added', toUsername);
    emitToUser(toUsername, 'friend-request-received', publicProfile(u.username));
  });

  socket.on('friend-accept', (fromUsername) => {
    const u = users.get(socket.id);
    if (!u) return;
    const me = ensureUserProfile(u.username);
    const other = usersDb()[fromUsername];
    if (!other || !me.incoming.includes(fromUsername)) return;
    me.incoming = me.incoming.filter((n) => n !== fromUsername);
    other.outgoing = other.outgoing.filter((n) => n !== u.username);
    if (!me.friends.includes(fromUsername)) me.friends.push(fromUsername);
    if (!other.friends.includes(u.username)) other.friends.push(u.username);
    usersStore.save();
    socket.emit('friend-added', publicProfile(fromUsername));
    emitToUser(fromUsername, 'friend-added', publicProfile(u.username));
  });

  socket.on('friend-decline', (fromUsername) => {
    const u = users.get(socket.id);
    if (!u) return;
    const me = ensureUserProfile(u.username);
    const other = usersDb()[fromUsername];
    me.incoming = me.incoming.filter((n) => n !== fromUsername);
    if (other) other.outgoing = other.outgoing.filter((n) => n !== u.username);
    usersStore.save();
    socket.emit('friend-incoming-removed', fromUsername);
  });

  socket.on('friend-remove', (otherUsername) => {
    const u = users.get(socket.id);
    if (!u) return;
    const me = ensureUserProfile(u.username);
    const other = usersDb()[otherUsername];
    me.friends = me.friends.filter((n) => n !== otherUsername);
    if (other) other.friends = other.friends.filter((n) => n !== u.username);
    usersStore.save();
    socket.emit('friend-removed', otherUsername);
    emitToUser(otherUsername, 'friend-removed', u.username);
  });

  // --- direct messages ---
  socket.on('dm-history', (withUser) => {
    const u = users.get(socket.id);
    if (!u) return;
    const key = dmKey(u.username, withUser);
    socket.emit('dm-history', { withUser, history: (dmsDb()[key] || []).slice(-HISTORY_PAGE_SIZE) });
  });

  socket.on('dm-message', ({ to, text }) => {
    const u = users.get(socket.id);
    if (!u || !to || !text) return;
    if (rateLimited(socket, 'dm-message', 10, 5000)) return;
    const key = dmKey(u.username, to);
    const msg = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, from: u.username, text: String(text).slice(0, 2000), ts: Date.now() };
    dmsDb()[key] = dmsDb()[key] || [];
    dmsDb()[key].push(msg);
    if (dmsDb()[key].length > 200) dmsDb()[key].shift();
    dmsStore.save();
    socket.emit('dm-message', { withUser: to, msg });
    emitToUser(to, 'dm-message', { withUser: u.username, msg });
  });

  // --- profile: avatar + rename ---
  socket.on('set-avatar', (url) => {
    const u = users.get(socket.id);
    if (!u || typeof url !== 'string' || !url.startsWith('/uploads/')) return;
    const profile = ensureUserProfile(u.username);
    profile.avatarUrl = url;
    usersStore.save();
    io.emit('profile-updated', publicProfile(u.username));
  });

  socket.on('rename', (newUsername) => {
    const u = users.get(socket.id);
    if (!u) return;
    newUsername = String(newUsername || '').trim().slice(0, 24);
    if (!newUsername || newUsername === u.username) return;
    const db = usersDb();
    if (db[newUsername]) { socket.emit('rename-failed', 'That name is taken.'); return; }
    const oldUsername = u.username;
    const profile = db[oldUsername];
    delete db[oldUsername];
    db[newUsername] = profile;
    // fix up references in every other profile's friends/incoming/outgoing lists
    Object.values(db).forEach((p) => {
      ['friends', 'incoming', 'outgoing'].forEach((k) => {
        const i = p[k].indexOf(oldUsername);
        if (i !== -1) p[k][i] = newUsername;
      });
    });
    Object.values(serversDb()).forEach((s) => {
      const i = s.members.indexOf(oldUsername);
      if (i !== -1) s.members[i] = newUsername;
      if (s.ownerUsername === oldUsername) s.ownerUsername = newUsername;
    });
    usersStore.save();
    serversStore.save();
    u.username = newUsername;
    removeOnlineSocket(oldUsername, socket.id);
    addOnlineSocket(newUsername, socket.id);
    socket.emit('renamed', newUsername);
    broadcastPresence();
    console.log(`[rename] "${oldUsername}" -> "${newUsername}"`);
  });

  // --- WebRTC signaling relay for peer-to-peer voice (mesh) ---
  socket.on('voice-join', () => {
    const u = users.get(socket.id);
    if (!u) return;
    const peers = [...users.entries()].filter(([id, other]) => other.inVoice && id !== socket.id);
    u.inVoice = true;
    socket.join(VOICE_CHANNEL);
    socket.emit('voice-peers', peers.map(([id, other]) => ({ id, username: other.username })));
    socket.to(VOICE_CHANNEL).emit('voice-peer-joined', { id: socket.id, username: u.username });
    broadcastPresence();
    console.log(`[voice-join] "${u.username}" joined voice, existing peers: [${peers.map(([, o]) => o.username).join(', ')}]`);
  });

  socket.on('voice-leave', () => {
    const u = users.get(socket.id);
    if (!u) return;
    u.inVoice = false;
    socket.leave(VOICE_CHANNEL);
    socket.to(VOICE_CHANNEL).emit('voice-peer-left', { id: socket.id });
    broadcastPresence();
    console.log(`[voice-leave] "${u.username}" left voice`);
  });

  socket.on('voice-signal', ({ to, signal }) => {
    io.to(to).emit('voice-signal', { from: socket.id, signal });
    const u = users.get(socket.id);
    const target = users.get(to);
    console.log(`[voice-signal] ${signal.type} from "${u ? u.username : socket.id}" -> "${target ? target.username : to}"`);
  });

  socket.on('disconnect', () => {
    const u = users.get(socket.id);
    users.delete(socket.id);
    rateLimitState.delete(socket.id);
    if (u) {
      removeOnlineSocket(u.username, socket.id);
      if (u.inVoice) socket.to(VOICE_CHANNEL).emit('voice-peer-left', { id: socket.id });
    }
    broadcastPresence();
    console.log(`[disconnect] ${socket.id}${u ? ` ("${u.username}")` : ''}`);
  });
});

server.listen(PORT, () => {
  console.log(`talk-app listening on http://localhost:${PORT}`);
});
