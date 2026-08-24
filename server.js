const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HISTORY_FILE = path.join(__dirname, 'history.json');

const CHANNELS = ['general', 'random'];
const VOICE_CHANNEL = 'voice-lounge';

// message history per text channel, persisted to a JSON file (no DB needed)
let history = {};
try {
  history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
} catch {
  history = Object.fromEntries(CHANNELS.map((c) => [c, []]));
}
function saveHistory() {
  fs.writeFile(HISTORY_FILE, JSON.stringify(history), () => {});
}

// socket.id -> { username, channel, inVoice }
const users = new Map();

function broadcastPresence() {
  const list = [...users.values()].map((u) => ({ username: u.username, inVoice: u.inVoice }));
  io.emit('presence', list);
}

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  socket.on('join', (username) => {
    username = String(username || '').trim().slice(0, 24) || `guest-${socket.id.slice(0, 4)}`;
    users.set(socket.id, { username, channel: 'general', inVoice: false });
    socket.join('general');
    socket.emit('joined', { username, channels: CHANNELS, history: history['general'] || [] });
    broadcastPresence();
  });

  socket.on('switch-channel', (channel) => {
    const u = users.get(socket.id);
    if (!u || !CHANNELS.includes(channel)) return;
    socket.leave(u.channel);
    u.channel = channel;
    socket.join(channel);
    socket.emit('channel-history', { channel, history: history[channel] || [] });
  });

  socket.on('chat-message', (text) => {
    const u = users.get(socket.id);
    if (!u || !text) return;
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      username: u.username,
      text: String(text).slice(0, 2000),
      ts: Date.now(),
    };
    history[u.channel] = history[u.channel] || [];
    history[u.channel].push(msg);
    if (history[u.channel].length > 200) history[u.channel].shift();
    saveHistory();
    io.to(u.channel).emit('chat-message', { channel: u.channel, msg });
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
  });

  socket.on('voice-leave', () => {
    const u = users.get(socket.id);
    if (!u) return;
    u.inVoice = false;
    socket.leave(VOICE_CHANNEL);
    socket.to(VOICE_CHANNEL).emit('voice-peer-left', { id: socket.id });
    broadcastPresence();
  });

  socket.on('voice-signal', ({ to, signal }) => {
    io.to(to).emit('voice-signal', { from: socket.id, signal });
  });

  socket.on('disconnect', () => {
    const u = users.get(socket.id);
    users.delete(socket.id);
    if (u && u.inVoice) socket.to(VOICE_CHANNEL).emit('voice-peer-left', { id: socket.id });
    broadcastPresence();
  });
});

server.listen(PORT, () => {
  console.log(`talk-app listening on http://localhost:${PORT}`);
});
