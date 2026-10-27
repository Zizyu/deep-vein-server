'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 25000, pingTimeout: 20000 });
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 5;
const GAME_FILE = path.join(__dirname, 'deep_vein_multiplayer.html');
const lobbies = new Map();
const playerLobby = new Map();

app.disable('x-powered-by');
app.get('/', (_req, res) => res.sendFile(GAME_FILE));
app.get('/health', (_req, res) => res.json({ ok: true, game: 'DEEP VEIN', lobbies: lobbies.size }));

function cleanName(value) {
  const name = String(value || 'MINER').replace(/[^\w\- ]/g, '').trim().replace(/\s+/g, ' ').slice(0, 18);
  return name || 'MINER';
}
function makeCode() {
  let code;
  do { code = Math.random().toString(36).slice(2, 8).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  while (code.length < 4 || lobbies.has(code));
  return code.slice(0, 6);
}
function publicPlayer(p) {
  return {
    id: p.id, name: p.name, alive: p.alive,
    x: Number.isFinite(p.x) ? p.x : null,
    y: Number.isFinite(p.y) ? p.y : null,
    aim: Number.isFinite(p.aim) ? p.aim : 0,
    mv: Number.isFinite(p.mv) ? p.mv : 0,
    foot: Number.isFinite(p.foot) ? p.foot : 0,
    moving: !!p.moving,
    flashlightOn: p.flashlightOn !== false,
    noise: Number.isFinite(p.noise) ? p.noise : 0,
    possessed: !!p.possessed,
  };
}
function lobbyView(lobby) {
  return {
    code: lobby.code,
    hostId: lobby.hostId,
    status: lobby.status,
    maxPlayers: MAX_PLAYERS,
    botSlots: Math.max(0, MAX_PLAYERS - lobby.players.size),
    players: [...lobby.players.values()].map(publicPlayer),
  };
}
function worldView(lobby) {
  return {
    goldTaken: [...lobby.goldTaken].sort((a, b) => a - b),
    tagsDone: [...lobby.tagsDone].sort((a, b) => a - b),
    goldCount: lobby.goldTaken.size,
    tagCount: lobby.tagsDone.size,
  };
}
function emitLobby(lobby) {
  io.to(lobby.code).emit('lobby-update', lobbyView(lobby));
  emitPlayers(lobby);
}
function emitPlayers(lobby) {
  io.to(lobby.code).emit('players-update', {
    players: [...lobby.players.values()].map(publicPlayer),
    hostId: lobby.hostId,
  });
}
function newLobby() {
  const lobby = {
    code: makeCode(), hostId: null, status: 'lobby', players: new Map(),
    seed: 0, startedAt: 0, goldTaken: new Set(), tagsDone: new Set(),
    lastMonsterState: null,
  };
  lobbies.set(lobby.code, lobby);
  return lobby;
}
function leaveCurrent(socket) {
  const code = playerLobby.get(socket.id);
  if (!code) return;
  const lobby = lobbies.get(code);
  playerLobby.delete(socket.id);
  socket.leave(code);
  if (!lobby) return;
  lobby.players.delete(socket.id);
  if (lobby.players.size === 0) {
    lobbies.delete(code);
    io.to(code).emit('lobby-closed');
    return;
  }
  if (!lobby.players.has(lobby.hostId)) {
    const next = [...lobby.players.values()].find(p => p.alive) || [...lobby.players.values()][0];
    lobby.hostId = next.id;
  }
  emitLobby(lobby);
}
function addPlayer(socket, lobby, name) {
  if (lobby.status !== 'lobby') {
    socket.emit('lobby-error', { message: 'That shift has already started. Join an open lobby or host a new one.' });
    return false;
  }
  if (lobby.players.size >= MAX_PLAYERS) {
    socket.emit('lobby-error', { message: 'That lobby already has five players.' });
    return false;
  }
  leaveCurrent(socket);
  const player = {
    id: socket.id, name: cleanName(name), alive: true,
    x: null, y: null, aim: 0, mv: 0, foot: 0, moving: false,
    flashlightOn: true, noise: 0, possessed: false,
  };
  lobby.players.set(socket.id, player);
  playerLobby.set(socket.id, lobby.code);
  if (!lobby.hostId) lobby.hostId = socket.id;
  socket.join(lobby.code);
  socket.emit('lobby-update', lobbyView(lobby));
  emitLobby(lobby);
  return true;
}
function findLobbyFor(socket) {
  const code = playerLobby.get(socket.id);
  return code ? lobbies.get(code) : null;
}
function clampNum(n, min, max, fallback = 0) {
  n = Number(n);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function markDead(lobby, p, data = {}) {
  if (!p || !p.alive) return false;
  p.alive = false;
  if (Number.isFinite(Number(data.x))) p.x = clampNum(data.x, 0, 1680, p.x || 120);
  if (Number.isFinite(Number(data.y))) p.y = clampNum(data.y, 0, 1296, p.y || 120);
  if (Number.isFinite(Number(data.aim))) p.aim = clampNum(data.aim, -Math.PI * 8, Math.PI * 8, p.aim);
  io.to(lobby.code).emit('player-died', publicPlayer(p));
  if (lobby.hostId === p.id) {
    const successor = [...lobby.players.values()].find(q => q.alive);
    if (successor) lobby.hostId = successor.id;
  }
  emitLobby(lobby);
  if (![...lobby.players.values()].some(q => q.alive)) {
    io.to(lobby.code).emit('game-ended', { message: 'Every human miner has died. The mine has claimed the whole crew.' });
  }
  return true;
}

io.on('connection', socket => {
  socket.on('create-lobby', data => {
    leaveCurrent(socket);
    const lobby = newLobby();
    addPlayer(socket, lobby, data && data.name);
  });

  socket.on('quick-join', data => {
    leaveCurrent(socket);
    let lobby = [...lobbies.values()]
      .filter(l => l.status === 'lobby' && l.players.size < MAX_PLAYERS)
      .sort((a, b) => b.players.size - a.players.size || a.code.localeCompare(b.code))[0];
    if (!lobby) lobby = newLobby();
    addPlayer(socket, lobby, data && data.name);
  });

  socket.on('join-lobby', data => {
    const code = String(data && data.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const lobby = lobbies.get(code);
    if (!lobby) return socket.emit('lobby-error', { message: 'Room not found. Check the code and try again.' });
    if (playerLobby.get(socket.id) === code) { socket.emit('lobby-update', lobbyView(lobby)); return; }
    addPlayer(socket, lobby, data && data.name);
  });

  socket.on('leave-lobby', () => leaveCurrent(socket));

  socket.on('start-game', () => {
    const lobby = findLobbyFor(socket);
    if (!lobby) return socket.emit('lobby-error', { message: 'Join a lobby first.' });
    if (lobby.hostId !== socket.id) return socket.emit('lobby-error', { message: 'Only the lobby host can start the shift.' });
    if (lobby.status !== 'lobby') return;
    lobby.status = 'playing';
    lobby.seed = (Math.random() * 0x7ffffffe + 1) >>> 0;
    lobby.startedAt = Date.now();
    lobby.goldTaken.clear(); lobby.tagsDone.clear(); lobby.lastMonsterState = null;
    const payload = {
      code: lobby.code, hostId: lobby.hostId, seed: lobby.seed,
      botSlots: Math.max(0, MAX_PLAYERS - lobby.players.size),
      players: [...lobby.players.values()].map(publicPlayer),
      world: worldView(lobby),
    };
    io.to(lobby.code).emit('lobby-update', lobbyView(lobby));
    io.to(lobby.code).emit('game-start', payload);
  });

  socket.on('player-state', data => {
    const lobby = findLobbyFor(socket);
    if (!lobby || lobby.status !== 'playing') return;
    const p = lobby.players.get(socket.id);
    if (!p || !p.alive || !data || typeof data !== 'object') return;
    p.x = clampNum(data.x, 0, 1680, p.x || 120);
    p.y = clampNum(data.y, 0, 1296, p.y || 120);
    p.aim = clampNum(data.aim, -Math.PI * 8, Math.PI * 8, p.aim);
    p.mv = clampNum(data.mv, 0, 4, 0);
    p.foot = clampNum(data.foot, 0, 1e7, 0);
    p.moving = !!data.moving;
    p.flashlightOn = data.flashlightOn !== false;
    p.noise = clampNum(data.noise, 0, 100, 0);
    p.name = cleanName(data.name || p.name);
    emitPlayers(lobby);
  });

  socket.on('player-death', data => {
    const lobby = findLobbyFor(socket);
    if (!lobby || lobby.status !== 'playing') return;
    markDead(lobby, lobby.players.get(socket.id), data || {});
  });

  socket.on('kill-player', data => {
    const lobby = findLobbyFor(socket);
    if (!lobby || lobby.status !== 'playing' || lobby.hostId !== socket.id) return;
    const target = lobby.players.get(String(data && data.id || ''));
    if (!target || target.id === socket.id) {
      // The monster may still catch its host; allow that case only when it is the sole living human.
      if (!target || [...lobby.players.values()].filter(p => p.alive).length > 1) return;
    }
    markDead(lobby, target, data || {});
  });

  socket.on('world-action', data => {
    const lobby = findLobbyFor(socket);
    if (!lobby || lobby.status !== 'playing' || !data) return;
    const index = Math.floor(Number(data.index));
    if (!Number.isInteger(index) || index < 0 || index > 100) return;
    if (data.type === 'gold') lobby.goldTaken.add(index);
    else if (data.type === 'tag') lobby.tagsDone.add(index);
    else return;
    io.to(lobby.code).emit('world-state', worldView(lobby));
  });

  socket.on('monster-state', data => {
    const lobby = findLobbyFor(socket);
    if (!lobby || lobby.status !== 'playing' || lobby.hostId !== socket.id || !data || typeof data !== 'object') return;
    // Host-only state authority ensures every client sees the same monster possession and bot state.
    lobby.lastMonsterState = data;
    io.to(lobby.code).emit('monster-state', { ...data, world: worldView(lobby) });
  });

  socket.on('disconnect', () => leaveCurrent(socket));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`DEEP VEIN multiplayer server listening on port ${PORT}`);
});
