const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const compression = require('compression');
const { Server } = require('socket.io');

const app = express();
app.use(compression()); // gzip text responses (JS/CSS/HTML/JSON) — big win on mobile connections
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HISTORY_FILE = path.join(__dirname, 'history.json');
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

const CHANNELS = ['general', 'random'];
const VOICE_CHANNEL = 'voice-lounge';

// message history per text channel, persisted to a JSON file (no DB needed)
let history = {};
try {
  history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
} catch {
  history = Object.fromEntries(CHANNELS.map((c) => [c, []]));
}
// Serialized + atomic persistence: only one write in flight at a time (concurrent
// fs.writeFile calls to the same path can complete out of order and silently drop
// messages), and writes land via tmp-file + rename so a crash mid-write can never
// leave a truncated/corrupt history.json on disk.
let historyWriteInFlight = false;
let historyWritePending = false;

function saveHistory() {
  if (historyWriteInFlight) { historyWritePending = true; return; }
  historyWriteInFlight = true;
  const data = JSON.stringify(history);
  const tmpFile = `${HISTORY_FILE}.tmp`;
  fs.writeFile(tmpFile, data, (err) => {
    if (err) {
      historyWriteInFlight = false;
      console.error('[history] write failed:', err);
      return;
    }
    fs.rename(tmpFile, HISTORY_FILE, (err) => {
      historyWriteInFlight = false;
      if (err) console.error('[history] rename failed:', err);
      if (historyWritePending) {
        historyWritePending = false;
        saveHistory();
      }
    });
  });
}

// socket.id -> { username, channel, inVoice }
const users = new Map();

// strip server-internal ownership tracking before a message ever reaches a client
function publicMsg(m) {
  const { ownerId, ...rest } = m;
  return rest;
}
// server keeps up to 200 messages per channel for backlog, but only the most
// recent 50 are sent on initial load — cuts join/switch-channel payload size
// substantially, which matters most on mobile connections
const HISTORY_PAGE_SIZE = 50;
function publicHistory(list) {
  return (list || []).slice(-HISTORY_PAGE_SIZE).map(publicMsg);
}

function broadcastPresence() {
  const list = [...users.values()].map((u) => ({ username: u.username, inVoice: u.inVoice }));
  io.emit('presence', list);
}

app.use(express.static(path.join(__dirname, 'public')));

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

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id} from ${socket.handshake.headers['x-forwarded-for'] || socket.handshake.address}`);

  socket.on('join', (username) => {
    username = String(username || '').trim().slice(0, 24) || `guest-${socket.id.slice(0, 4)}`;
    users.set(socket.id, { username, channel: 'general', inVoice: false });
    // join every text channel's room so unread messages in channels the user
    // isn't currently viewing still reach the client (for unread badges)
    CHANNELS.forEach((c) => socket.join(c));
    socket.emit('joined', { username, channels: CHANNELS, history: publicHistory(history['general']) });
    broadcastPresence();
    console.log(`[join] ${socket.id} -> "${username}"`);
  });

  socket.on('switch-channel', (channel) => {
    const u = users.get(socket.id);
    if (!u || !CHANNELS.includes(channel)) return;
    u.channel = channel; // sockets stay joined to every channel room; this just tracks where new messages/typing go
    socket.emit('channel-history', { channel, history: publicHistory(history[channel]) });
  });

  socket.on('chat-message', (payload) => {
    const u = users.get(socket.id);
    if (!u) return;
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
    history[u.channel] = history[u.channel] || [];
    history[u.channel].push(msg);
    if (history[u.channel].length > 200) history[u.channel].shift();
    saveHistory();
    io.to(u.channel).emit('chat-message', { channel: u.channel, msg: publicMsg(msg) });
  });

  socket.on('delete-message', ({ channel, id }) => {
    const u = users.get(socket.id);
    if (!u || !CHANNELS.includes(channel)) return;
    const list = history[channel] || [];
    const idx = list.findIndex((m) => m.id === id);
    if (idx === -1 || list[idx].ownerId !== socket.id) return;
    list.splice(idx, 1);
    saveHistory();
    io.to(channel).emit('message-deleted', { channel, id });
  });

  socket.on('typing', () => {
    const u = users.get(socket.id);
    if (!u) return;
    socket.to(u.channel).emit('typing', { channel: u.channel, username: u.username });
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
    if (u && u.inVoice) socket.to(VOICE_CHANNEL).emit('voice-peer-left', { id: socket.id });
    broadcastPresence();
    console.log(`[disconnect] ${socket.id}${u ? ` ("${u.username}")` : ''}`);
  });
});

server.listen(PORT, () => {
  console.log(`talk-app listening on http://localhost:${PORT}`);
});
