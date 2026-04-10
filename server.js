/**
 * VOID FRONTIER — Multiplayer Server
 * Node.js + Socket.io
 *
 * Install:  npm install socket.io express
 * Run:      node server.js
 * Default:  http://localhost:3000
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ── In-memory state ──────────────────────────────────────────────
const players   = new Map();   // socketId → playerData
const groups    = new Map();   // groupId  → groupData
const dungeons  = new Map();   // dungeonId → { groupId, lockedAt }
const arenas    = new Map();   // arenaId  → arenaData
const tradeOffers = new Map(); // tradeId  → tradeData
const arenaQueue  = [];        // players waiting for PvP match

// ── Helpers ──────────────────────────────────────────────────────
function uid() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function getPlayerGroup(socketId) {
  for (const [gid, g] of groups) {
    if (g.members.includes(socketId)) return { gid, group: g };
  }
  return null;
}

function broadcastToGroup(groupId, event, data, excludeSocketId = null) {
  const g = groups.get(groupId);
  if (!g) return;
  g.members.forEach(sid => {
    if (sid !== excludeSocketId) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.emit(event, data);
    }
  });
}

// ── Connection ───────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[+] Player connected:', socket.id);

  // ── Register player ─────────────────────────────────────────
  socket.on('player:register', ({ name, color }) => {
    players.set(socket.id, {
      id: socket.id,
      name: name || ('Pilot-' + socket.id.slice(0, 4)),
      color: color || '#00d4ff',
      x: 0, y: 0, angle: 0,
      hp: 100, credits: 2000,
      groupId: null,
    });
    socket.emit('player:registered', { id: socket.id });
    console.log('[R] Registered:', socket.id, name);
  });

  // ── Position update (only relayed to group members) ─────────
  socket.on('pos:update', ({ x, y, angle, hp }) => {
    const p = players.get(socket.id);
    if (!p) return;
    Object.assign(p, { x, y, angle, hp });

    const result = getPlayerGroup(socket.id);
    if (!result) return;
    broadcastToGroup(result.gid, 'pos:update', {
      id: socket.id,
      name: p.name,
      color: p.color,
      x, y, angle, hp,
    }, socket.id);
  });

  // ── GROUP: Create ────────────────────────────────────────────
  socket.on('group:create', () => {
    const p = players.get(socket.id);
    if (!p) return;

    // Leave existing group first
    leaveGroup(socket.id);

    const gid = 'G-' + uid();
    groups.set(gid, {
      id: gid,
      leader: socket.id,
      members: [socket.id],
      pendingInvites: [],
    });
    p.groupId = gid;
    socket.emit('group:created', { groupId: gid });
    console.log('[G] Group created:', gid, 'by', socket.id);
  });

  // ── GROUP: Invite ────────────────────────────────────────────
  socket.on('group:invite', ({ targetId }) => {
    const result = getPlayerGroup(socket.id);
    if (!result) { socket.emit('error', { msg: 'Debes estar en un grupo para invitar.' }); return; }
    const { gid, group } = result;
    if (group.leader !== socket.id) { socket.emit('error', { msg: 'Solo el líder puede invitar.' }); return; }

    const target = players.get(targetId);
    if (!target) { socket.emit('error', { msg: 'Jugador no encontrado.' }); return; }

    const inviterId = players.get(socket.id);
    const invName = inviterId ? inviterId.name : socket.id;

    group.pendingInvites.push(targetId);
    const targetSock = io.sockets.sockets.get(targetId);
    if (targetSock) {
      targetSock.emit('group:invite_received', {
        groupId: gid,
        inviterName: invName,
        inviterId: socket.id,
      });
    }
    socket.emit('group:invite_sent', { targetId, targetName: target.name });
  });

  // ── GROUP: Accept invite ─────────────────────────────────────
  socket.on('group:join', ({ groupId }) => {
    const group = groups.get(groupId);
    if (!group) { socket.emit('error', { msg: 'Grupo no encontrado.' }); return; }

    leaveGroup(socket.id);

    group.members.push(socket.id);
    group.pendingInvites = group.pendingInvites.filter(id => id !== socket.id);
    const p = players.get(socket.id);
    if (p) p.groupId = groupId;

    socket.emit('group:joined', { groupId, members: group.members.map(memberId => {
      const mp = players.get(memberId);
      return mp ? { id: memberId, name: mp.name, color: mp.color } : { id: memberId };
    })});

    broadcastToGroup(groupId, 'group:member_joined', {
      id: socket.id,
      name: p ? p.name : socket.id,
      color: p ? p.color : '#fff',
    }, socket.id);

    console.log('[G] Player joined group:', socket.id, '->', groupId);
  });

  // ── GROUP: Leave ─────────────────────────────────────────────
  socket.on('group:leave', () => {
    leaveGroup(socket.id);
    socket.emit('group:left');
  });

  // ── DUNGEON: Enter (with lock) ───────────────────────────────
  socket.on('dungeon:enter', ({ dungeonId }) => {
    const existing = dungeons.get(dungeonId);
    if (existing) {
      const occupyingGroup = groups.get(existing.groupId);
      const leaderP = occupyingGroup ? players.get(occupyingGroup.leader) : null;
      socket.emit('dungeon:occupied', {
        dungeonId,
        groupLeader: leaderP ? leaderP.name : 'otro grupo',
        lockedAt: existing.lockedAt,
      });
      return;
    }

    const result = getPlayerGroup(socket.id);
    const groupId = result ? result.gid : ('SOLO-' + socket.id);

    dungeons.set(dungeonId, { groupId, lockedAt: Date.now() });

    // Notify all group members
    if (result) {
      broadcastToGroup(result.gid, 'dungeon:entered', { dungeonId, groupId });
    }
    socket.emit('dungeon:entered', { dungeonId, groupId });
    console.log('[D] Dungeon locked:', dungeonId, 'by group', groupId);
  });

  // ── DUNGEON: Exit (unlock) ───────────────────────────────────
  socket.on('dungeon:exit', ({ dungeonId }) => {
    dungeons.delete(dungeonId);
    io.emit('dungeon:unlocked', { dungeonId });
    console.log('[D] Dungeon unlocked:', dungeonId);
  });

  // ── DUNGEON: Check status ────────────────────────────────────
  socket.on('dungeon:status', ({ dungeonId }) => {
    const lock = dungeons.get(dungeonId);
    if (lock) {
      const g = groups.get(lock.groupId);
      const leaderP = g ? players.get(g.leader) : null;
      socket.emit('dungeon:status_response', {
        dungeonId,
        occupied: true,
        groupLeader: leaderP ? leaderP.name : '?',
        lockedAt: lock.lockedAt,
      });
    } else {
      socket.emit('dungeon:status_response', { dungeonId, occupied: false });
    }
  });

  // ── DUNGEON CO-OP: Sync enemy hit ────────────────────────────
  socket.on('dungeon:enemy_hit', ({ dungeonId, enemyIdx, dmg, hp }) => {
    const result = getPlayerGroup(socket.id);
    if (!result) return;
    broadcastToGroup(result.gid, 'dungeon:enemy_hit', { dungeonId, enemyIdx, dmg, hp }, socket.id);
  });

  socket.on('dungeon:boss_hit', ({ dungeonId, dmg, hp }) => {
    const result = getPlayerGroup(socket.id);
    if (!result) return;
    broadcastToGroup(result.gid, 'dungeon:boss_hit', { dungeonId, dmg, hp }, socket.id);
  });

  socket.on('dungeon:player_pos', ({ dungeonId, x, y, dir }) => {
    const result = getPlayerGroup(socket.id);
    if (!result) return;
    const p = players.get(socket.id);
    broadcastToGroup(result.gid, 'dungeon:partner_pos', {
      id: socket.id,
      name: p ? p.name : '?',
      color: p ? p.color : '#fff',
      x, y, dir,
    }, socket.id);
  });

  // ── TRADE: Offer ─────────────────────────────────────────────
  socket.on('trade:offer', ({ targetId, items, credits }) => {
    const sender = players.get(socket.id);
    const target = players.get(targetId);
    if (!sender || !target) { socket.emit('error', { msg: 'Jugador no encontrado.' }); return; }
    if (credits < 0 || credits > sender.credits) { socket.emit('error', { msg: 'Créditos inválidos.' }); return; }

    const tradeId = 'T-' + uid();
    tradeOffers.set(tradeId, {
      id: tradeId,
      senderId: socket.id,
      targetId,
      items: items || [],
      credits: credits || 0,
      status: 'pending',
      createdAt: Date.now(),
    });

    const targetSock = io.sockets.sockets.get(targetId);
    if (targetSock) {
      targetSock.emit('trade:offer_received', {
        tradeId,
        senderName: sender.name,
        senderColor: sender.color,
        items,
        credits,
      });
    }
    socket.emit('trade:offer_sent', { tradeId, targetName: target.name });
    console.log('[T] Trade offer:', tradeId, socket.id, '->', targetId);

    // Auto-expire after 60s
    setTimeout(() => {
      const offer = tradeOffers.get(tradeId);
      if (offer && offer.status === 'pending') {
        tradeOffers.delete(tradeId);
        socket.emit('trade:expired', { tradeId });
        if (targetSock) targetSock.emit('trade:expired', { tradeId });
      }
    }, 60000);
  });

  // ── TRADE: Accept ────────────────────────────────────────────
  socket.on('trade:accept', ({ tradeId }) => {
    const offer = tradeOffers.get(tradeId);
    if (!offer || offer.status !== 'pending') { socket.emit('error', { msg: 'Oferta no válida.' }); return; }
    if (offer.targetId !== socket.id) { socket.emit('error', { msg: 'No es tu oferta.' }); return; }

    offer.status = 'accepted';
    tradeOffers.delete(tradeId);

    const senderSock = io.sockets.sockets.get(offer.senderId);
    if (senderSock) {
      senderSock.emit('trade:completed', {
        tradeId,
        role: 'sender',
        items: offer.items,
        credits: offer.credits,
      });
    }
    socket.emit('trade:completed', {
      tradeId,
      role: 'receiver',
      items: offer.items,
      credits: offer.credits,
    });

    console.log('[T] Trade accepted:', tradeId);
  });

  // ── TRADE: Reject ────────────────────────────────────────────
  socket.on('trade:reject', ({ tradeId }) => {
    const offer = tradeOffers.get(tradeId);
    if (!offer) return;
    offer.status = 'rejected';
    tradeOffers.delete(tradeId);

    const senderSock = io.sockets.sockets.get(offer.senderId);
    if (senderSock) senderSock.emit('trade:rejected', { tradeId });
    socket.emit('trade:reject_sent', { tradeId });
    console.log('[T] Trade rejected:', tradeId);
  });

  // ── ARENA: Join queue ────────────────────────────────────────
  socket.on('arena:queue', ({ bet }) => {
    const p = players.get(socket.id);
    if (!p) return;
    const betAmount = Math.max(0, Math.min(bet || 0, p.credits));

    // Remove if already in queue
    const existIdx = arenaQueue.findIndex(e => e.id === socket.id);
    if (existIdx >= 0) arenaQueue.splice(existIdx, 1);

    arenaQueue.push({ id: socket.id, bet: betAmount, joinedAt: Date.now() });
    socket.emit('arena:queued', { position: arenaQueue.length, bet: betAmount });
    console.log('[A] Queued:', socket.id, 'bet', betAmount, 'queue size', arenaQueue.length);

    // Try to match
    if (arenaQueue.length >= 2) {
      const p1Entry = arenaQueue.shift();
      const p2Entry = arenaQueue.shift();
      createArena(p1Entry, p2Entry);
    }
  });

  // ── ARENA: Leave queue ───────────────────────────────────────
  socket.on('arena:dequeue', () => {
    const idx = arenaQueue.findIndex(e => e.id === socket.id);
    if (idx >= 0) {
      arenaQueue.splice(idx, 1);
      socket.emit('arena:dequeued');
    }
  });

  // ── ARENA: Update (position + hit) ──────────────────────────
  socket.on('arena:update', ({ arenaId, x, y, angle, hp, bulletHit }) => {
    const arena = arenas.get(arenaId);
    if (!arena || !arena.active) return;

    const isP1 = arena.p1.id === socket.id;
    const isP2 = arena.p2.id === socket.id;
    if (!isP1 && !isP2) return;

    if (isP1) arena.p1.x = x, arena.p1.y = y, arena.p1.angle = angle, arena.p1.hp = hp;
    if (isP2) arena.p2.x = x, arena.p2.y = y, arena.p2.angle = angle, arena.p2.hp = hp;

    // Relay to opponent
    const opponentId = isP1 ? arena.p2.id : arena.p1.id;
    const opSock = io.sockets.sockets.get(opponentId);
    if (opSock) opSock.emit('arena:opponent_update', { x, y, angle, hp, bulletHit });

    // Check win condition
    if (hp <= 0) {
      const winnerId = isP1 ? arena.p2.id : arena.p1.id;
      const loserId = socket.id;
      resolveArena(arenaId, winnerId, loserId);
    }
  });

  // ── ARENA: Bet raise ─────────────────────────────────────────
  socket.on('arena:raise_bet', ({ arenaId, extraBet }) => {
    const arena = arenas.get(arenaId);
    if (!arena || arena.active || arena.started) return;
    const p = players.get(socket.id);
    if (!p) return;
    const extra = Math.min(extraBet, p.credits - (arena.p1.id === socket.id ? arena.p1.bet : arena.p2.bet));
    if (extra <= 0) return;
    if (arena.p1.id === socket.id) arena.p1.bet += extra;
    else arena.p2.bet += extra;

    // Notify both
    [arena.p1.id, arena.p2.id].forEach(sid => {
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit('arena:bet_updated', { p1bet: arena.p1.bet, p2bet: arena.p2.bet });
    });
  });

  // ── ARENA: Ready ─────────────────────────────────────────────
  socket.on('arena:ready', ({ arenaId }) => {
    const arena = arenas.get(arenaId);
    if (!arena) return;
    if (arena.p1.id === socket.id) arena.p1.ready = true;
    if (arena.p2.id === socket.id) arena.p2.ready = true;

    if (arena.p1.ready && arena.p2.ready && !arena.started) {
      arena.started = true;
      arena.active = true;
      arena.startedAt = Date.now();
      [arena.p1.id, arena.p2.id].forEach(sid => {
        const s = io.sockets.sockets.get(sid);
        if (s) s.emit('arena:start', { arenaId, p1: arena.p1, p2: arena.p2 });
      });
      console.log('[A] Arena started:', arenaId);
    }
  });

  // ── List online players (for invite UI) ─────────────────────
  socket.on('players:list', () => {
    const list = [];
    for (const [sid, p] of players) {
      if (sid === socket.id) continue;
      list.push({ id: sid, name: p.name, color: p.color, inGroup: !!p.groupId });
    }
    socket.emit('players:list', list);
  });

  // ── Disconnect ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('[-] Disconnected:', socket.id);
    leaveGroup(socket.id);

    // Remove from arena queue
    const qi = arenaQueue.findIndex(e => e.id === socket.id);
    if (qi >= 0) arenaQueue.splice(qi, 1);

    // Forfeit any active arena
    for (const [aid, arena] of arenas) {
      if (!arena.active) continue;
      if (arena.p1.id === socket.id || arena.p2.id === socket.id) {
        const winnerId = arena.p1.id === socket.id ? arena.p2.id : arena.p1.id;
        resolveArena(aid, winnerId, socket.id);
        break;
      }
    }

    // Unlock dungeons held by this player's solo session
    for (const [did, lock] of dungeons) {
      if (lock.groupId === ('SOLO-' + socket.id)) {
        dungeons.delete(did);
        io.emit('dungeon:unlocked', { dungeonId: did });
      }
    }

    players.delete(socket.id);
  });

  // ── Internal: leave group ────────────────────────────────────
  function leaveGroup(socketId) {
    const result = getPlayerGroup(socketId);
    if (!result) return;
    const { gid, group } = result;

    group.members = group.members.filter(id => id !== socketId);
    broadcastToGroup(gid, 'group:member_left', { id: socketId });

    const p = players.get(socketId);
    if (p) p.groupId = null;

    if (group.members.length === 0) {
      // Unlock dungeons held by this group
      for (const [did, lock] of dungeons) {
        if (lock.groupId === gid) {
          dungeons.delete(did);
          io.emit('dungeon:unlocked', { dungeonId: did });
        }
      }
      groups.delete(gid);
      console.log('[G] Group disbanded:', gid);
    } else if (group.leader === socketId) {
      // Pass leadership
      group.leader = group.members[0];
      broadcastToGroup(gid, 'group:new_leader', { id: group.leader });
    }
  }

  // ── Internal: create arena ───────────────────────────────────
  function createArena(p1Entry, p2Entry) {
    const arenaId = 'A-' + uid();
    const p1 = players.get(p1Entry.id);
    const p2 = players.get(p2Entry.id);
    if (!p1 || !p2) return;

    const arena = {
      id: arenaId,
      p1: { id: p1Entry.id, name: p1.name, color: p1.color, bet: p1Entry.bet, hp: 100, x: -300, y: 0, angle: 0, ready: false },
      p2: { id: p2Entry.id, name: p2.name, color: p2.color, bet: p2Entry.bet, hp: 100, x: 300, y: 0, angle: Math.PI, ready: false },
      active: false,
      started: false,
      createdAt: Date.now(),
    };
    arenas.set(arenaId, arena);

    const p1Sock = io.sockets.sockets.get(p1Entry.id);
    const p2Sock = io.sockets.sockets.get(p2Entry.id);
    const matchData = {
      arenaId,
      opponent: null,
      p1: { id: arena.p1.id, name: arena.p1.name, color: arena.p1.color, bet: arena.p1.bet },
      p2: { id: arena.p2.id, name: arena.p2.name, color: arena.p2.color, bet: arena.p2.bet },
    };
    if (p1Sock) p1Sock.emit('arena:matched', { ...matchData, opponent: arena.p2 });
    if (p2Sock) p2Sock.emit('arena:matched', { ...matchData, opponent: arena.p1 });
    console.log('[A] Arena created:', arenaId, p1.name, 'vs', p2.name);
  }

  // ── Internal: resolve arena ──────────────────────────────────
  function resolveArena(arenaId, winnerId, loserId) {
    const arena = arenas.get(arenaId);
    if (!arena) return;
    arena.active = false;
    const pot = arena.p1.bet + arena.p2.bet;
    const winnerP = players.get(winnerId);
    const loserP  = players.get(loserId);
    if (winnerP) winnerP.credits += pot;
    if (loserP  && loserP.credits >= arena[arena.p1.id === loserId ? 'p1' : 'p2'].bet)
      loserP.credits -= arena[arena.p1.id === loserId ? 'p1' : 'p2'].bet;

    const winSock = io.sockets.sockets.get(winnerId);
    const losSock = io.sockets.sockets.get(loserId);
    if (winSock) winSock.emit('arena:result', { arenaId, result: 'win', pot, creditsGained: pot });
    if (losSock) losSock.emit('arena:result', { arenaId, result: 'loss', pot, creditsLost: arena[arena.p1.id === loserId ? 'p1' : 'p2'].bet });

    arenas.delete(arenaId);
    console.log('[A] Arena resolved:', arenaId, 'winner:', winnerId);
  }
});

// ── Serve static files (HTML, JS) ───────────────────────────────
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/void_frontier_v19.html');
});

// ── Status endpoint ──────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({
    players:  players.size,
    groups:   groups.size,
    dungeons: dungeons.size,
    arenas:   arenas.size,
    queue:    arenaQueue.length,
  });
});

httpServer.listen(PORT, () => {
  console.log(`VOID FRONTIER Multiplayer Server running on port ${PORT}`);
  console.log(`Status: http://localhost:${PORT}/status`);
});
