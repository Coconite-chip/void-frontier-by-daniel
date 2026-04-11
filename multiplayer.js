/**
 * VOID FRONTIER — Multiplayer Client Patch
 *
 * HOW TO USE:
 * 1. Start the server:  cd void-frontier-server && npm install && node server.js
 * 2. Add this line just before </body> in void_frontier_v19.html:
 *    <script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
 *    <script src="multiplayer.js"></script>
 *
 * 3. Change SERVER_URL below to your server address.
 */

const SERVER_URL = 'https://void-frontier-by-daniel.onrender.com'; // ← cambia esto por tu URL de Render

// ── State ────────────────────────────────────────────────────────
const mp = {
  socket: null,
  connected: false,
  myId: null,
  playerName: localStorage.getItem('vf_playerName') || '',
  groupId: null,
  groupMembers: [],       // [{id, name, color, x, y, angle, hp}]
  isLeader: false,
  pendingInvites: [],     // [{groupId, inviterName, inviterId}]
  activeTrade: null,      // current trade offer (as target)
  arenaState: null,       // active arena data
  arenaQueued: false,
  arenaQueueTimeout: null,
  dungeonPartners: {},    // socketId → {x, y, dir, name, color}
  activeDungeonId: null,  // dungeonId activo en este momento
  onlinePlayers: [],      // all online (for invite UI)
  dungeonLocks: {},       // dungeonId → {occupied, groupLeader}
};

// ── Connect ──────────────────────────────────────────────────────
function mpConnect() {
  if (!window.io) { console.warn('[MP] Socket.io not loaded'); return; }
  mp.socket = window.io(SERVER_URL, { transports: ['websocket'], reconnection: true });

  mp.socket.on('connect', () => {
    mp.connected = true;
    mp.myId = mp.socket.id;
    // Register with current player state
    const pName = mp.playerName || ('Pilot-' + mp.socket.id.slice(0, 4));
    mp.socket.emit('player:register', {
      name: pName,
      color: player.shipColor || '#00d4ff',
    });
    addLog('🌐 Conectado como: ' + pName + ' | ID: ' + mp.socket.id.slice(0, 6), 'good');
    // Sync star states from server
    if (typeof mpSyncStars === 'function') setTimeout(mpSyncStars, 400);
    mpRenderHUD();
  });

  mp.socket.on('disconnect', () => {
    mp.connected = false;
    addLog('🌐 Desconectado del servidor multijugador.', 'warn');
    mpRenderHUD();
  });

  mp.socket.on('player:registered', ({ id }) => {
    mp.myId = id;
    mpRenderHUD();
  });

  // ── Group events ──────────────────────────────────────────────
  mp.socket.on('group:created', ({ groupId }) => {
    mp.groupId = groupId;
    mp.isLeader = true;
    mp.groupMembers = [];
    addLog('✅ Grupo creado: ' + groupId, 'good');
    mpRenderHUD();
  });

  mp.socket.on('group:joined', ({ groupId, members }) => {
    mp.groupId = groupId;
    mp.isLeader = false;
    mp.groupMembers = members.filter(m => m.id !== mp.myId).map(m => ({ ...m, x: 0, y: 0, hp: 100 }));
    addLog('✅ Unido al grupo: ' + groupId, 'good');
    mpRenderHUD();
  });

  mp.socket.on('group:left', () => {
    mp.groupId = null;
    mp.isLeader = false;
    mp.groupMembers = [];
    addLog('Saliste del grupo.', 'warn');
    mpRenderHUD();
  });

  mp.socket.on('group:member_joined', ({ id, name, color }) => {
    mp.groupMembers.push({ id, name, color, x: 0, y: 0, hp: 100 });
    addLog('👥 ' + name + ' se unió al grupo.', 'good');
    mpRenderHUD();
  });

  mp.socket.on('group:member_left', ({ id }) => {
    const m = mp.groupMembers.find(m => m.id === id);
    mp.groupMembers = mp.groupMembers.filter(m => m.id !== id);
    if (m) addLog('👥 ' + m.name + ' abandonó el grupo.', 'warn');
    mpRenderHUD();
  });

  mp.socket.on('group:new_leader', ({ id }) => {
    if (id === mp.myId) {
      mp.isLeader = true;
      addLog('👑 Ahora eres el líder del grupo.', 'good');
      mpRenderHUD();
    }
  });

  mp.socket.on('group:invite_received', (data) => {
    mp.pendingInvites.push(data);
    addLog('📨 Invitación de ' + data.inviterName + ' [GRUPO ' + data.groupId + ']', 'new');
    mpShowInviteToast(data);
    mpRenderHUD();
  });

  mp.socket.on('group:invite_sent', ({ targetName }) => {
    addLog('📨 Invitación enviada a ' + targetName, 'new');
  });

  // ── Position sync ─────────────────────────────────────────────
  mp.socket.on('pos:update', ({ id, name, color, x, y, angle, hp }) => {
    const existing = mp.groupMembers.find(m => m.id === id);
    if (existing) { Object.assign(existing, { x, y, angle, hp, name, color }); }
    else { mp.groupMembers.push({ id, name, color, x, y, angle, hp }); }
  });

  // ── Dungeon events ────────────────────────────────────────────
  mp.socket.on('dungeon:occupied', ({ dungeonId, groupLeader }) => {
    mp.dungeonLocks[dungeonId] = { occupied: true, groupLeader };
    addLog('⚠ DUNGEON OCUPADA por el grupo de ' + groupLeader + '. Espera.', 'warn');
    mpRenderHUD();
  });

  mp.socket.on('dungeon:entered', ({ dungeonId }) => {
    addLog('☠ Entrando al dungeon en modo co-op...', 'warn');
    mp.dungeonLocks[dungeonId] = { occupied: true, groupLeader: 'mi grupo' };
    mp.activeDungeonId = dungeonId;
  });

  mp.socket.on('dungeon:unlocked', ({ dungeonId }) => {
    if (mp.dungeonLocks[dungeonId]) {
      delete mp.dungeonLocks[dungeonId];
      addLog('🔓 Dungeon libre: ' + dungeonId, 'new');
      mpRenderHUD();
    }
  });

  mp.socket.on('dungeon:enemy_hit', ({ enemyIdx, dmg, hp }) => {
    if (!inDungeon) return;
    const room = dungeonState.rooms[dungeonState.currentRoom];
    if (!room) return;
    const e = room.enemies[enemyIdx];
    if (e && e.alive) { e.hp = hp; if (e.hp <= 0) e.alive = false; }
  });

  mp.socket.on('dungeon:boss_hit', ({ hp }) => {
    if (!inDungeon) return;
    const room = dungeonState.rooms[dungeonState.currentRoom];
    if (room && room.boss && room.boss.alive) {
      room.boss.hp = hp;
      if (room.boss.hp <= 0) { room.boss.alive = false; handleBossDefeat(room.boss); }
    }
  });

  mp.socket.on('dungeon:partner_pos', ({ id, name, color, x, y, dir }) => {
    mp.dungeonPartners[id] = { x, y, dir, name: name || '?', color: color || '#00ffcc' };
  });

  // ── Trade events ──────────────────────────────────────────────
  mp.socket.on('trade:offer_received', (offer) => {
    mp.activeTrade = offer;
    addLog('💱 Oferta de ' + offer.senderName + ': ₢' + offer.credits + ' + ' + offer.items.length + ' items', 'good');
    mpShowTradeModal(offer);
  });

  mp.socket.on('trade:offer_sent', ({ tradeId, targetName }) => {
    addLog('📤 Oferta enviada a ' + targetName + ' [' + tradeId + ']', 'new');
  });

  mp.socket.on('trade:completed', ({ role, items, credits }) => {
    if (role === 'sender') {
      player.credits -= credits;
      items.forEach(item => {
        const idx = player.cargo.findIndex(c => c.name === item.name);
        if (idx >= 0) {
          player.cargo[idx].qty -= item.qty;
          if (player.cargo[idx].qty <= 0) player.cargo.splice(idx, 1);
        }
      });
      addLog('✅ Intercambio completado — enviaste ₢' + credits, 'good');
    } else {
      player.credits += credits;
      items.forEach(item => {
        const ex = player.cargo.find(c => c.name === item.name);
        if (ex) ex.qty += item.qty;
        else player.cargo.push({ name: item.name, qty: item.qty, boughtAt: 0 });
      });
      addLog('✅ Intercambio completado — recibiste ₢' + credits + ' + ' + items.length + ' items', 'good');
    }
  });

  mp.socket.on('trade:rejected', () => {
    addLog('❌ Oferta de intercambio rechazada.', 'warn');
  });

  mp.socket.on('trade:expired', ({ tradeId }) => {
    addLog('⏰ Oferta de intercambio expirada: ' + tradeId, 'warn');
    mp.activeTrade = null;
    const modal = document.getElementById('mpTradeModal');
    if (modal) modal.style.display = 'none';
  });

  // ── Arena events ──────────────────────────────────────────────
  mp.socket.on('arena:queued', ({ position, bet }) => {
    mp.arenaQueued = true;
    addLog('⚔ En cola PvP — posición ' + position + ' | Apuesta: ₢' + bet, 'new');
    // Auto-reset si no hay rival en 90s
    if (mp.arenaQueueTimeout) clearTimeout(mp.arenaQueueTimeout);
    mp.arenaQueueTimeout = setTimeout(() => {
      if (mp.arenaQueued) {
        mp.arenaQueued = false;
        if (mp.socket) mp.socket.emit('arena:dequeue');
        addLog('⚔ Cola PvP expirada — no se encontró rival. Inténtalo de nuevo.', 'warn');
        mpRenderHUD();
        const panel = document.getElementById('mpPanel');
        if (panel && panel._activeTab === 'ARENA') mpRenderTab('ARENA');
      }
    }, 90000);
    mpRenderHUD();
  });

  mp.socket.on('arena:dequeued', () => {
    mp.arenaQueued = false;
    if (mp.arenaQueueTimeout) { clearTimeout(mp.arenaQueueTimeout); mp.arenaQueueTimeout = null; }
    addLog('Saliste de la cola PvP.', 'warn');
    mpRenderHUD();
  });

  mp.socket.on('arena:matched', (data) => {
    mp.arenaState = data;
    mp.arenaQueued = false;
    if (mp.arenaQueueTimeout) { clearTimeout(mp.arenaQueueTimeout); mp.arenaQueueTimeout = null; }
    addLog('⚔ COMBATE ENCONTRADO vs ' + data.opponent.name + ' | Bote: ₢' + (data.p1.bet + data.p2.bet), 'danger');
    mpShowArenaLobby(data);
    mpRenderHUD();
    // Send ready immediately — server auto-starts after 8s anyway
    mp.socket.emit('arena:ready', { arenaId: data.arenaId });
  });

  mp.socket.on('arena:bet_updated', ({ p1bet, p2bet }) => {
    if (mp.arenaState) {
      mp.arenaState.p1.bet = p1bet;
      mp.arenaState.p2.bet = p2bet;
      mpUpdateArenaLobby();
    }
  });

  mp.socket.on('arena:start', (data) => {
    mp.arenaState = data;
    mp.arenaState.active = true;
    if (mp._arenaCountdownInterval) { clearInterval(mp._arenaCountdownInterval); mp._arenaCountdownInterval = null; }
    addLog('⚔ ARENA INICIADA — ¡Combate!', 'danger');
    mpCloseArenaLobby();
    mpRenderHUD();
  });

  mp.socket.on('arena:opponent_update', ({ x, y, angle, hp, bulletHit }) => {
    if (!mp.arenaState) return;
    mp.arenaState.opponentX = x;
    mp.arenaState.opponentY = y;
    mp.arenaState.opponentAngle = angle;
    mp.arenaState.opponentHp = hp;
    // If opponent bullet hits us
    if (bulletHit) hitPlayer(bulletHit.dmg || 10);
  });

  mp.socket.on('arena:result', ({ result, pot, creditsGained, creditsLost }) => {
    mp.arenaState = null;
    if (result === 'win') {
      player.credits += creditsGained;
      addLog('🏆 VICTORIA en arena! +₢' + creditsGained + ' (bote total: ₢' + pot + ')', 'good');
    } else {
      addLog('💀 DERROTA en arena. -₢' + (creditsLost || 0), 'danger');
    }
    mpRenderHUD();
  });

  mp.socket.on('players:list', (list) => {
    mp.onlinePlayers = list;
    mpRenderPlayerList();
  });

  mp.socket.on('error', ({ msg }) => {
    addLog('⚠ ' + msg, 'warn');
  });
}

// ── Position broadcast loop (20fps) ──────────────────────────────
setInterval(() => {
  if (!mp.connected || !mp.socket) return;
  if (!mp.groupId) return;
  if (inCity || inStar || inFarm || inVoidHollow || inDungeon) return;
  mp.socket.emit('pos:update', {
    x: Math.round(player.x),
    y: Math.round(player.y),
    angle: player.angle,
    hp: Math.round(player.hull),
  });
}, 50);

// ── Dungeon position broadcast ────────────────────────────────────
setInterval(() => {
  if (!mp.connected || !mp.groupId || !inDungeon) return;
  // Usar activeDungeonId directamente - más fiable que buscar en locks
  const dungeonId = mp.activeDungeonId || Object.keys(mp.dungeonLocks).find(did => mp.dungeonLocks[did]?.occupied);
  if (!dungeonId) return;
  const p = players && players.get ? null : null; // avoid collision
  mp.socket.emit('dungeon:player_pos', {
    dungeonId,
    x: Math.round(dPlayer.x),
    y: Math.round(dPlayer.y),
    dir: dPlayer.dir,
    name: mp.playerName || ('Pilot-' + (mp.myId || '????').slice(0, 4)),
    color: (typeof player !== 'undefined' && player.shipColor) ? player.shipColor : '#00d4ff',
  });
}, 80);

// ── Arena position broadcast ──────────────────────────────────────
setInterval(() => {
  if (!mp.connected || !mp.arenaState?.active) return;
  mp.socket.emit('arena:update', {
    arenaId: mp.arenaState.id,
    x: Math.round(player.x),
    y: Math.round(player.y),
    angle: player.angle,
    hp: Math.round(player.hull),
  });
}, 50);

// ── Dungeon: hook into enterDungeon ──────────────────────────────
const _origEnterDungeon = typeof enterDungeon === 'function' ? enterDungeon : null;
window.enterDungeon = function(planet) {
  if (!mp.connected || !mp.socket) {
    if (_origEnterDungeon) _origEnterDungeon(planet);
    return;
  }
  const dungeonId = planet.name;
  const lock = mp.dungeonLocks[dungeonId];
  // Permitir entrar si el lock es de nuestro grupo o no hay lock
  if (lock && lock.occupied && lock.groupLeader !== 'tu grupo' && lock.groupLeader !== 'mi grupo') {
    addLog('⚠ DUNGEON OCUPADA — Grupo de ' + lock.groupLeader + ' está dentro. Espera.', 'warn');
    return;
  }
  mp.activeDungeonId = dungeonId;
  mp.socket.emit('dungeon:enter', { dungeonId });
  if (_origEnterDungeon) _origEnterDungeon(planet);
};

const _origExitDungeon = typeof exitDungeon === 'function' ? exitDungeon : null;
window.exitDungeon = function(victory) {
  if (mp.connected && mp.socket && inDungeon) {
    const did = mp.activeDungeonId || (dungeonPlanet && dungeonPlanet.name);
    if (did) mp.socket.emit('dungeon:exit', { dungeonId: did });
    mp.dungeonPartners = {};
    mp.activeDungeonId = null;
  }
  if (_origExitDungeon) _origExitDungeon(victory);
};

// ── Draw group members on space map ──────────────────────────────
const _origDraw = typeof draw === 'function' ? draw : null;
window.draw = function() {
  if (_origDraw) _origDraw();
  drawGroupMembers();
};

function drawGroupMembers() {
  if (!mp.groupId || mp.groupMembers.length === 0) return;
  if (inCity || inFarm || inStar || inDungeon || inVoidHollow) return;
  if (typeof camera === 'undefined' || typeof ctx === 'undefined') return;
  if (typeof mapState !== 'undefined' && mapState.open) return;

  mp.groupMembers.forEach(m => {
    const sx = (m.x - camera.x) * camera.zoom + W / 2;
    const sy = (m.y - camera.y) * camera.zoom + H / 2;
    const margin = 30;
    const onScreen = sx > margin && sx < W - margin && sy > margin && sy < H - margin;
    const col = m.color || '#00ffcc';

    if (onScreen) {
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(m.angle || 0);
      ctx.shadowBlur = 14;
      ctx.shadowColor = col;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(14, 0); ctx.lineTo(-8, -7); ctx.lineTo(-5, 0); ctx.lineTo(-8, 7);
      ctx.closePath();
      ctx.stroke();
      ctx.rotate(-(m.angle || 0));
      ctx.shadowBlur = 0;
      ctx.fillStyle = col;
      ctx.font = 'bold 9px Share Tech Mono';
      ctx.textAlign = 'center';
      ctx.fillText('👥 ' + (m.name || '?'), 0, -20);
      const hpPct = (m.hp || 100) / 100;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(-14, 10, 28, 3);
      ctx.fillStyle = hpPct > 0.5 ? '#00ff88' : hpPct > 0.25 ? '#ffd700' : '#ff2244';
      ctx.fillRect(-14, 10, 28 * hpPct, 3);
      ctx.restore();
    } else {
      // Off-screen arrow
      const ang = Math.atan2(m.y - player.y, m.x - player.x);
      const cos = Math.cos(ang), sin = Math.sin(ang);
      const txA = cos > 0 ? (W - 50 - W / 2) / cos : (50 - W / 2) / cos;
      const tyA = sin > 0 ? (H - 50 - H / 2) / sin : (50 - H / 2) / sin;
      const tMin = Math.min(Math.abs(txA), Math.abs(tyA));
      const arx = W / 2 + cos * tMin, ary = H / 2 + sin * tMin;
      ctx.save();
      ctx.translate(arx, ary);
      ctx.rotate(ang);
      ctx.fillStyle = col + 'cc';
      ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(-6, -6); ctx.lineTo(-6, 6); ctx.closePath(); ctx.fill();
      ctx.rotate(-ang);
      ctx.fillStyle = col;
      ctx.font = 'bold 8px Share Tech Mono';
      ctx.textAlign = 'center';
      ctx.fillText('👥 ' + (m.name || '?'), 0, -14);
      ctx.restore();
    }
  });

  // Draw dungeon partners
  if (inDungeon && typeof dungeonCtx !== 'undefined') {
    const camX = W / 2 - dPlayer.x;
    const camY = H / 2 - dPlayer.y;
    Object.values(mp.dungeonPartners).forEach(p2 => {
      const sx = p2.x + camX, sy = p2.y + camY;
      dungeonCtx.save();
      dungeonCtx.translate(sx, sy);
      dungeonCtx.fillStyle = (p2.color || '#00ffcc') + 'cc';
      dungeonCtx.beginPath(); dungeonCtx.arc(0, -2, 11, 0, Math.PI * 2); dungeonCtx.fill();
      dungeonCtx.strokeStyle = p2.color || '#00ffcc'; dungeonCtx.lineWidth = 2;
      dungeonCtx.beginPath(); dungeonCtx.arc(0, -2, 11, 0, Math.PI * 2); dungeonCtx.stroke();
      dungeonCtx.fillStyle = p2.color || '#00ffcc';
      dungeonCtx.font = 'bold 8px Share Tech Mono'; dungeonCtx.textAlign = 'center';
      dungeonCtx.fillText('👥 ' + (p2.name || '?'), 0, -20);
      dungeonCtx.restore();
    });
  }
}

// ── HUD ──────────────────────────────────────────────────────────
function mpCreateHUD() {
  const el = document.createElement('div');
  el.id = 'mpHUD';
  el.style.cssText = `
    position:fixed;top:60px;left:50%;transform:translateX(-50%);
    background:rgba(2,8,18,0.93);border:1px solid rgba(0,200,255,0.25);
    border-radius:4px;padding:8px 14px;font-family:'Share Tech Mono',monospace;
    font-size:9px;color:#4a7a9b;z-index:1000;pointer-events:all;
    display:flex;align-items:center;gap:12px;white-space:nowrap;
  `;
  document.body.appendChild(el);
  mpRenderHUD();
}

function mpRenderHUD() {
  const el = document.getElementById('mpHUD');
  if (!el) return;

  const statusColor = mp.connected ? '#00ff88' : '#ff4444';
  const statusText = mp.connected ? 'ONLINE' : 'OFFLINE';

  let groupInfo = '';
  if (mp.groupId) {
    const count = mp.groupMembers.length + 1;
    const leaderBadge = mp.isLeader ? ' 👑' : '';
    groupInfo = `<span style="color:#00d4ff">GRUPO ${mp.groupId.slice(-4)}${leaderBadge} [${count}]</span>`;
  }

  let arenaInfo = '';
  if (mp.arenaQueued) arenaInfo = '<span style="color:#ffd700;animation:blink 1s infinite">⚔ EN COLA PvP</span>';
  if (mp.arenaState?.active) arenaInfo = '<span style="color:#ff2244">⚔ ARENA ACTIVA</span>';

  const invBadge = mp.pendingInvites.length > 0
    ? `<span style="color:#ffd700;cursor:pointer" onclick="mpOpenPanel()">📨 ${mp.pendingInvites.length} inv.</span>`
    : '';

  el.innerHTML = `
    <span style="color:${statusColor}">● ${statusText}</span>
    ${groupInfo ? `<span style="color:#4a7a9b">|</span> ${groupInfo}` : ''}
    ${arenaInfo}
    ${invBadge}
    <button onclick="mpOpenPanel()" style="
      background:none;border:1px solid rgba(0,212,255,0.4);color:#00d4ff;
      font-family:inherit;font-size:8px;padding:2px 7px;cursor:pointer;border-radius:2px;
    ">⚙ MULTI</button>
  `;
}

// ── Main panel ───────────────────────────────────────────────────
function mpOpenPanel() {
  let panel = document.getElementById('mpPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'mpPanel';
    panel.style.cssText = `
      position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
      width:480px;max-height:80vh;overflow-y:auto;
      background:rgba(1,6,16,0.98);border:1px solid rgba(0,200,255,0.3);
      border-radius:8px;padding:20px;z-index:2000;font-family:'Share Tech Mono',monospace;
      backdrop-filter:blur(20px);
    `;
    document.body.appendChild(panel);
  }
  panel.style.display = 'block';
  mpRenderPanel();
}

function mpClosePanel() {
  const el = document.getElementById('mpPanel');
  if (el) el.style.display = 'none';
}

function mpRenderPanel() {
  const panel = document.getElementById('mpPanel');
  if (!panel) return;

  const tabs = ['GRUPO', 'JUGADORES', 'COMERCIO', 'ARENA'];
  const activeTab = panel._activeTab || 'GRUPO';

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div style="font-family:Orbitron,sans-serif;font-size:13px;color:#00d4ff;letter-spacing:2px">🌐 MULTIJUGADOR</div>
      <button onclick="mpClosePanel()" style="background:none;border:none;color:#ff2244;font-size:16px;cursor:pointer">✕</button>
    </div>
    <div style="display:flex;gap:4px;margin-bottom:14px;border-bottom:1px solid rgba(0,212,255,0.2);padding-bottom:8px">
      ${tabs.map(t => `
        <button onclick="mpSwitchTab('${t}')" style="
          background:${t === activeTab ? 'rgba(0,212,255,0.12)' : 'none'};
          border:1px solid ${t === activeTab ? '#00d4ff' : 'rgba(255,255,255,0.1)'};
          color:${t === activeTab ? '#00d4ff' : '#4a7a9b'};
          font-family:Share Tech Mono,monospace;font-size:9px;padding:5px 10px;
          cursor:pointer;border-radius:3px;letter-spacing:1px;
        ">${t}</button>
      `).join('')}
    </div>
    <div id="mpPanelContent"></div>
  `;

  panel._activeTab = activeTab;
  mpRenderTab(activeTab);
}

function mpSwitchTab(tab) {
  const panel = document.getElementById('mpPanel');
  if (panel) { panel._activeTab = tab; mpRenderPanel(); }
  if (tab === 'JUGADORES') mp.socket && mp.socket.emit('players:list');
}

function mpRenderTab(tab) {
  const el = document.getElementById('mpPanelContent');
  if (!el) return;

  if (tab === 'GRUPO') {
    el.innerHTML = `
      <div style="font-size:9px;color:#4a7a9b;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
        <span>Piloto: <b style="color:#00ffcc">${mp.playerName || 'sin nombre'}</b>
        ${mp.connected ? '' : '<span style="color:#ff4444"> (desconectado)</span>'}</span>
        <button onclick="mpChangeName()" style="background:none;border:1px solid rgba(0,212,255,0.3);color:#4a7a9b;font-family:inherit;font-size:8px;padding:2px 8px;cursor:pointer;border-radius:2px">✏ cambiar nombre</button>
      </div>
      ${mp.groupId ? `
        <div style="background:rgba(0,212,255,0.06);border:1px solid rgba(0,212,255,0.2);border-radius:6px;padding:12px;margin-bottom:10px">
          <div style="font-size:9px;color:#00d4ff;letter-spacing:1px;margin-bottom:8px">
            GRUPO ${mp.groupId} ${mp.isLeader ? '👑 (líder)' : ''}
          </div>
          <div style="font-size:9px;color:#c8e8ff;margin-bottom:4px">
            👤 Tú (${mp.myId ? mp.myId.slice(0,4) : '?'})
          </div>
          ${mp.groupMembers.map(m => `
            <div style="font-size:9px;color:${m.color || '#c8e8ff'};margin-bottom:4px;display:flex;align-items:center;gap:6px">
              <span>👥 ${m.name}</span>
              <span style="color:#4a7a9b">${m.id.slice(0,6)}</span>
              <div style="width:40px;height:3px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden">
                <div style="height:100%;width:${m.hp || 100}%;background:${(m.hp||100)>50?'#00ff88':'#ff2244'}"></div>
              </div>
            </div>
          `).join('')}
        </div>
        ${mp.isLeader ? `
          <div style="margin-bottom:8px">
            <input id="mpInviteId" placeholder="ID del jugador a invitar" style="
              width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);
              color:#c8e8ff;font-family:Share Tech Mono,monospace;font-size:9px;
              padding:6px 10px;border-radius:3px;box-sizing:border-box;margin-bottom:6px
            ">
            <button onclick="mpInviteById()" style="
              background:none;border:1px solid #00d4ff;color:#00d4ff;
              font-family:Share Tech Mono,monospace;font-size:9px;
              padding:5px 12px;cursor:pointer;border-radius:3px;letter-spacing:1px
            ">📨 INVITAR</button>
          </div>
        ` : ''}
        <button onclick="mpLeaveGroup()" style="
          background:none;border:1px solid #ff6b35;color:#ff6b35;
          font-family:Share Tech Mono,monospace;font-size:9px;
          padding:5px 12px;cursor:pointer;border-radius:3px;letter-spacing:1px
        ">← SALIR DEL GRUPO</button>
      ` : `
        <button onclick="mpCreateGroup()" style="
          background:rgba(0,212,255,0.08);border:1px solid #00d4ff;color:#00d4ff;
          font-family:Share Tech Mono,monospace;font-size:9px;
          padding:7px 16px;cursor:pointer;border-radius:3px;letter-spacing:1px;width:100%;margin-bottom:8px
        ">✚ CREAR GRUPO</button>
        <div style="font-size:8px;color:#4a7a9b;text-align:center">
          Crea un grupo y comparte tu ID para que otros se unan. Solo los miembros del grupo se ven en el mapa.
        </div>
      `}
      ${mp.pendingInvites.length > 0 ? `
        <div style="margin-top:12px;border-top:1px solid rgba(255,215,0,0.2);padding-top:10px">
          <div style="font-size:9px;color:#ffd700;margin-bottom:6px">📨 INVITACIONES PENDIENTES</div>
          ${mp.pendingInvites.map((inv, i) => `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;padding:6px;background:rgba(255,215,0,0.06);border-radius:4px;border:1px solid rgba(255,215,0,0.2)">
              <span style="font-size:9px;color:#c8e8ff">${inv.inviterName}</span>
              <div style="display:flex;gap:4px">
                <button onclick="mpAcceptInvite(${i})" style="background:none;border:1px solid #00ff88;color:#00ff88;font-family:Share Tech Mono,monospace;font-size:8px;padding:3px 8px;cursor:pointer;border-radius:2px">✓ ACEPTAR</button>
                <button onclick="mpDeclineInvite(${i})" style="background:none;border:1px solid #ff4444;color:#ff4444;font-family:Share Tech Mono,monospace;font-size:8px;padding:3px 8px;cursor:pointer;border-radius:2px">✕</button>
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;
  } else if (tab === 'JUGADORES') {
    const list = mp.onlinePlayers;
    el.innerHTML = `
      <div style="font-size:9px;color:#4a7a9b;margin-bottom:10px">
        ${list.length} jugadores online (excluyendo tú)
        <button onclick="mp.socket && mp.socket.emit('players:list')" style="background:none;border:1px solid rgba(0,212,255,0.3);color:#4a7a9b;font-family:inherit;font-size:8px;padding:2px 8px;cursor:pointer;border-radius:2px;margin-left:8px">↻ Actualizar</button>
      </div>
      ${list.length === 0
        ? '<div style="font-size:9px;color:#4a7a9b;text-align:center;padding:20px">Sin jugadores online ahora mismo</div>'
        : list.map(p2 => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:7px;background:rgba(255,255,255,0.03);border-radius:4px;border:1px solid rgba(255,255,255,0.07);margin-bottom:6px">
            <div style="display:flex;align-items:center;gap:8px">
              <div style="width:10px;height:10px;border-radius:50%;background:${p2.color}"></div>
              <div>
                <div style="font-size:10px;color:#c8e8ff">${p2.name}</div>
                <div style="font-size:8px;color:#4a7a9b">${p2.id.slice(0,8)} ${p2.inGroup ? '(en grupo)' : ''}</div>
              </div>
            </div>
            <div style="display:flex;gap:4px">
              ${mp.isLeader && !p2.inGroup ? `
                <button onclick="mpInvitePlayer('${p2.id}')" style="background:none;border:1px solid #00d4ff;color:#00d4ff;font-family:Share Tech Mono,monospace;font-size:8px;padding:3px 8px;cursor:pointer;border-radius:2px">📨 INVITAR</button>
              ` : ''}
              <button onclick="mpOpenTradeOffer('${p2.id}','${p2.name}')" style="background:none;border:1px solid #ffd700;color:#ffd700;font-family:Share Tech Mono,monospace;font-size:8px;padding:3px 8px;cursor:pointer;border-radius:2px">💱 COMERCIO</button>
            </div>
          </div>
        `).join('')
      }
    `;
  } else if (tab === 'COMERCIO') {
    const cargoTotal = player.cargo.reduce((s, c) => s + c.qty, 0);
    el.innerHTML = `
      <div style="font-size:9px;color:#4a7a9b;margin-bottom:10px">
        Selecciona un jugador en la pestaña JUGADORES y pulsa "COMERCIO", o introduce su ID aquí.
      </div>
      <div style="margin-bottom:10px">
        <input id="mpTradeTargetId" placeholder="ID del jugador destino" style="
          width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);
          color:#c8e8ff;font-family:Share Tech Mono,monospace;font-size:9px;
          padding:6px 10px;border-radius:3px;box-sizing:border-box
        ">
      </div>
      <div style="font-size:9px;color:#4a7a9b;margin-bottom:6px">Créditos a enviar: <b style="color:#ffd700">₢${player.credits}</b> disponibles</div>
      <input type="range" min="0" max="${player.credits}" value="0" id="mpTradeCredits" style="width:100%;margin-bottom:4px"
        oninput="document.getElementById('mpTradeCreditVal').textContent=this.value">
      <div style="font-size:10px;color:#ffd700;margin-bottom:10px">₢ <span id="mpTradeCreditVal">0</span></div>
      <div style="font-size:9px;color:#4a7a9b;margin-bottom:6px">Cargo (${cargoTotal}/${player.maxCargo}):</div>
      <div id="mpTradeCargoList" style="margin-bottom:10px">
        ${player.cargo.length === 0
          ? '<div style="font-size:9px;color:#4a7a9b">Sin cargo</div>'
          : player.cargo.map((c, i) => `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;font-size:9px">
              <span style="color:#c8e8ff">${c.name} x${c.qty}</span>
              <select id="mpTradeCargoQty_${i}" style="background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.2);color:#c8e8ff;font-size:9px;padding:2px 4px;border-radius:2px">
                ${Array.from({length:c.qty+1},(_,n)=>`<option value="${n}">${n}</option>`).join('')}
              </select>
            </div>
          `).join('')
        }
      </div>
      <button onclick="mpSendTradeOffer()" style="
        background:rgba(255,215,0,0.1);border:1px solid #ffd700;color:#ffd700;
        font-family:Share Tech Mono,monospace;font-size:9px;
        padding:7px 16px;cursor:pointer;border-radius:3px;letter-spacing:1px;width:100%
      ">💱 ENVIAR OFERTA DE INTERCAMBIO</button>
    `;
  } else if (tab === 'ARENA') {
    el.innerHTML = `
      <div style="font-size:9px;color:#4a7a9b;margin-bottom:12px">
        Combate 1v1 en arena espacial. El servidor actúa como árbitro. La apuesta va a escrow hasta que termine el combate.
      </div>
      ${mp.arenaState?.active ? `
        <div style="background:rgba(255,34,68,0.1);border:1px solid #ff2244;border-radius:6px;padding:12px;margin-bottom:10px">
          <div style="font-family:Orbitron,sans-serif;font-size:11px;color:#ff2244;letter-spacing:2px;margin-bottom:8px">⚔ ARENA ACTIVA</div>
          <div style="font-size:9px;color:#c8e8ff">
            Rival HP: <b style="color:#ff2244">${Math.ceil(mp.arenaState.opponentHp || 100)}</b>
          </div>
          <div style="font-size:9px;color:#4a7a9b;margin-top:4px">Combate en curso — posición y disparos se sincronizan automáticamente.</div>
        </div>
      ` : mp.arenaQueued ? `
        <div style="background:rgba(255,215,0,0.08);border:1px solid #ffd700;border-radius:6px;padding:12px;margin-bottom:10px;text-align:center">
          <div style="font-size:11px;color:#ffd700;letter-spacing:1px">⚔ EN COLA PvP...</div>
          <div style="font-size:9px;color:#4a7a9b;margin-top:6px">Buscando rival</div>
        </div>
        <button onclick="mp.socket && mp.socket.emit('arena:dequeue')" style="
          width:100%;background:none;border:1px solid #ff6b35;color:#ff6b35;
          font-family:Share Tech Mono,monospace;font-size:9px;padding:7px;cursor:pointer;border-radius:3px
        ">SALIR DE LA COLA</button>
      ` : `
        <div style="margin-bottom:10px">
          <div style="font-size:9px;color:#4a7a9b;margin-bottom:4px">Apuesta inicial (₢${player.credits} disponibles):</div>
          <input type="range" min="0" max="${Math.min(player.credits, 1000000)}" step="1000" value="0" id="mpArenaBet" style="width:100%;margin-bottom:4px"
            oninput="document.getElementById('mpArenaBetVal').textContent=parseInt(this.value).toLocaleString()">
          <div style="font-size:10px;color:#ffd700">₢ <span id="mpArenaBetVal">0</span></div>
        </div>
        <button onclick="mpJoinArenaQueue()" style="
          background:rgba(255,34,68,0.1);border:1px solid #ff2244;color:#ff2244;
          font-family:Share Tech Mono,monospace;font-size:9px;
          padding:8px 16px;cursor:pointer;border-radius:3px;letter-spacing:1px;width:100%
        ">⚔ ENTRAR EN COLA PvP</button>
        <div style="font-size:8px;color:#4a7a9b;margin-top:8px;text-align:center">
          El combate ocurre en el espacio. Tu posición y disparos se envían al servidor en tiempo real.
        </div>
      `}
    `;
  }
}

// ── Actions ───────────────────────────────────────────────────────
function mpCreateGroup() {
  if (!mp.connected) { addLog('No conectado al servidor multijugador.', 'warn'); return; }
  mp.socket.emit('group:create');
}

function mpLeaveGroup() {
  if (!mp.connected) return;
  mp.socket.emit('group:leave');
  mpRenderPanel();
}

function mpInviteById() {
  const input = document.getElementById('mpInviteId');
  if (!input) return;
  mpInvitePlayer(input.value.trim());
  input.value = '';
}

function mpInvitePlayer(targetId) {
  if (!mp.connected || !targetId) return;
  if (!mp.groupId) { addLog('Primero crea un grupo.', 'warn'); return; }
  mp.socket.emit('group:invite', { targetId });
}

function mpAcceptInvite(idx) {
  const inv = mp.pendingInvites[idx];
  if (!inv) return;
  mp.pendingInvites.splice(idx, 1);
  mp.socket.emit('group:join', { groupId: inv.groupId });
  mpRenderPanel();
}

function mpDeclineInvite(idx) {
  mp.pendingInvites.splice(idx, 1);
  mpRenderPanel();
}

function mpChangeName() {
  mpClosePanel();
  const modal = document.createElement('div');
  modal.style.cssText = `
    position:fixed;top:0;left:0;width:100%;height:100%;
    background:rgba(0,0,0,0.75);z-index:9999;
    display:flex;align-items:center;justify-content:center;
    font-family:'Share Tech Mono',monospace;
  `;
  modal.innerHTML = `
    <div style="background:rgba(1,6,16,0.99);border:2px solid rgba(0,212,255,0.4);border-radius:10px;padding:26px 32px;min-width:300px;text-align:center">
      <div style="font-size:11px;color:#00d4ff;letter-spacing:2px;margin-bottom:16px">✏ CAMBIAR NOMBRE DE PILOTO</div>
      <input id="mpChangeNameInput" type="text" maxlength="20" value="${mp.playerName}"
        style="width:100%;background:rgba(0,212,255,0.06);border:1px solid rgba(0,212,255,0.4);
        color:#00ffcc;font-family:'Share Tech Mono',monospace;font-size:14px;
        padding:10px;border-radius:4px;box-sizing:border-box;outline:none;text-align:center;letter-spacing:2px;margin-bottom:14px;">
      <div style="display:flex;gap:8px">
        <button onclick="this.closest('div[style*=position]').remove()" style="flex:1;background:none;border:1px solid #ff6b35;color:#ff6b35;font-family:Share Tech Mono,monospace;font-size:9px;padding:8px;cursor:pointer;border-radius:3px">CANCELAR</button>
        <button id="mpChangeNameBtn" style="flex:2;background:rgba(0,212,255,0.12);border:1px solid #00d4ff;color:#00d4ff;font-family:Share Tech Mono,monospace;font-size:9px;padding:8px;cursor:pointer;border-radius:3px;letter-spacing:1px">✓ GUARDAR</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const input = document.getElementById('mpChangeNameInput');
  input.focus(); input.select();
  const save = () => {
    let name = input.value.trim();
    if (!name) return;
    mp.playerName = name;
    localStorage.setItem('vf_playerName', name);
    if (mp.connected && mp.socket) {
      mp.socket.emit('player:register', { name, color: (typeof player !== 'undefined' && player.shipColor) ? player.shipColor : '#00d4ff' });
    }
    modal.remove();
    addLog('✏ Nombre cambiado a: ' + name, 'good');
    mpRenderHUD();
  };
  document.getElementById('mpChangeNameBtn').onclick = save;
  input.onkeydown = (e) => { if (e.key === 'Enter') save(); };
}

function mpOpenTradeOffer(targetId, targetName) {
  const panel = document.getElementById('mpPanel');
  if (panel) {
    panel._activeTab = 'COMERCIO';
    mpRenderPanel();
    setTimeout(() => {
      const el = document.getElementById('mpTradeTargetId');
      if (el) el.value = targetId;
    }, 50);
  }
}

function mpSendTradeOffer() {
  if (!mp.connected) { addLog('No conectado.', 'warn'); return; }
  const targetId = document.getElementById('mpTradeTargetId')?.value?.trim();
  if (!targetId) { addLog('Introduce el ID del jugador destino.', 'warn'); return; }
  const credits = parseInt(document.getElementById('mpTradeCredits')?.value || '0');
  const items = [];
  player.cargo.forEach((c, i) => {
    const sel = document.getElementById('mpTradeCargoQty_' + i);
    const qty = sel ? parseInt(sel.value) : 0;
    if (qty > 0) items.push({ name: c.name, qty });
  });
  if (credits === 0 && items.length === 0) { addLog('Selecciona algo para intercambiar.', 'warn'); return; }
  mp.socket.emit('trade:offer', { targetId, items, credits });
}

function mpJoinArenaQueue() {
  if (!mp.connected) { addLog('No conectado.', 'warn'); return; }
  const bet = parseInt(document.getElementById('mpArenaBet')?.value || '0');
  if (bet > player.credits) { addLog('No tienes suficientes créditos para esa apuesta.', 'warn'); return; }
  mp.socket.emit('arena:queue', { bet });
}

function mpRenderPlayerList() {
  const panel = document.getElementById('mpPanel');
  if (panel && panel._activeTab === 'JUGADORES') mpRenderTab('JUGADORES');
}

// ── Trade modal (incoming offer) ─────────────────────────────────
function mpShowTradeModal(offer) {
  let modal = document.getElementById('mpTradeModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'mpTradeModal';
    modal.style.cssText = `
      position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
      width:380px;background:rgba(1,6,16,0.98);
      border:2px solid #ffd700;border-radius:8px;padding:20px;
      z-index:3000;font-family:'Share Tech Mono',monospace;
      backdrop-filter:blur(20px);
    `;
    document.body.appendChild(modal);
  }
  modal.style.display = 'block';
  modal.innerHTML = `
    <div style="font-family:Orbitron,sans-serif;font-size:13px;color:#ffd700;letter-spacing:2px;margin-bottom:10px">💱 OFERTA DE INTERCAMBIO</div>
    <div style="font-size:9px;color:#c8e8ff;margin-bottom:10px">
      De: <b style="color:${offer.senderColor || '#00d4ff'}">${offer.senderName}</b>
    </div>
    <div style="background:rgba(255,215,0,0.06);border:1px solid rgba(255,215,0,0.2);border-radius:4px;padding:10px;margin-bottom:12px">
      <div style="font-size:9px;color:#ffd700;margin-bottom:4px">Ofrece:</div>
      ${offer.credits > 0 ? `<div style="font-size:10px;color:#ffd700">₢${offer.credits.toLocaleString()}</div>` : ''}
      ${offer.items.map(it => `<div style="font-size:9px;color:#c8e8ff">${it.name} x${it.qty}</div>`).join('')}
      ${offer.credits === 0 && offer.items.length === 0 ? '<div style="font-size:9px;color:#4a7a9b">Nada (oferta vacía)</div>' : ''}
    </div>
    <div style="display:flex;gap:8px">
      <button onclick="mpAcceptTrade('${offer.tradeId}')" style="
        flex:1;background:rgba(0,255,136,0.1);border:1px solid #00ff88;color:#00ff88;
        font-family:Share Tech Mono,monospace;font-size:9px;padding:8px;cursor:pointer;border-radius:3px
      ">✓ ACEPTAR</button>
      <button onclick="mpRejectTrade('${offer.tradeId}')" style="
        flex:1;background:none;border:1px solid #ff4444;color:#ff4444;
        font-family:Share Tech Mono,monospace;font-size:9px;padding:8px;cursor:pointer;border-radius:3px
      ">✕ RECHAZAR</button>
    </div>
  `;
}

function mpAcceptTrade(tradeId) {
  if (!mp.connected) return;
  mp.socket.emit('trade:accept', { tradeId });
  document.getElementById('mpTradeModal').style.display = 'none';
  mp.activeTrade = null;
}

function mpRejectTrade(tradeId) {
  if (!mp.connected) return;
  mp.socket.emit('trade:reject', { tradeId });
  document.getElementById('mpTradeModal').style.display = 'none';
  mp.activeTrade = null;
}

// ── Arena lobby ───────────────────────────────────────────────────
function mpShowArenaLobby(data) {
  let modal = document.getElementById('mpArenaLobby');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'mpArenaLobby';
    modal.style.cssText = `
      position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
      width:440px;background:rgba(10,0,5,0.99);
      border:2px solid #ff2244;border-radius:8px;padding:22px;
      z-index:3000;font-family:'Share Tech Mono',monospace;
      backdrop-filter:blur(20px);box-shadow:0 0 60px rgba(255,34,68,0.3);
    `;
    document.body.appendChild(modal);
  }
  modal.style.display = 'block';
  mpUpdateArenaLobby();
  // Start countdown display
  if (mp._arenaCountdownInterval) clearInterval(mp._arenaCountdownInterval);
  const autoStartIn = data.autoStartIn || 8000;
  const startedAt = Date.now();
  mp._arenaCountdownInterval = setInterval(() => {
    const el = document.getElementById('mpArenaCountdown');
    if (!el) { clearInterval(mp._arenaCountdownInterval); return; }
    const remaining = Math.max(0, Math.ceil((autoStartIn - (Date.now() - startedAt)) / 1000));
    el.textContent = remaining > 0 ? '⏳ El combate comienza en ' + remaining + 's...' : '⚔ ¡COMENZANDO!';
    if (remaining <= 0) clearInterval(mp._arenaCountdownInterval);
  }, 500);
}

function mpUpdateArenaLobby() {
  const modal = document.getElementById('mpArenaLobby');
  if (!modal || !mp.arenaState) return;
  const d = mp.arenaState;
  const pot = (d.p1.bet || 0) + (d.p2.bet || 0);
  const isP1 = mp.myId === d.p1.id;
  const me = isP1 ? d.p1 : d.p2;
  const opp = isP1 ? d.p2 : d.p1;

  modal.innerHTML = `
    <div style="font-family:Orbitron,sans-serif;font-size:14px;color:#ff2244;letter-spacing:2px;margin-bottom:12px;text-align:center">⚔ ARENA PvP</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
      <div style="background:rgba(0,212,255,0.08);border:1px solid rgba(0,212,255,0.3);border-radius:6px;padding:10px;text-align:center">
        <div style="font-size:11px;color:#00d4ff;margin-bottom:4px">TÚ</div>
        <div style="font-size:10px;color:#c8e8ff">${me.name}</div>
        <div style="font-size:12px;color:#ffd700;margin-top:4px">₢${(me.bet||0).toLocaleString()}</div>
      </div>
      <div style="background:rgba(255,34,68,0.08);border:1px solid rgba(255,34,68,0.3);border-radius:6px;padding:10px;text-align:center">
        <div style="font-size:11px;color:#ff2244;margin-bottom:4px">RIVAL</div>
        <div style="font-size:10px;color:#c8e8ff">${opp.name}</div>
        <div style="font-size:12px;color:#ffd700;margin-top:4px">₢${(opp.bet||0).toLocaleString()}</div>
      </div>
    </div>
    <div style="text-align:center;font-family:Orbitron,sans-serif;font-size:18px;color:#ffd700;margin-bottom:12px">
      BOTE: ₢${pot.toLocaleString()}
    </div>
    <div style="margin-bottom:10px">
      <div style="font-size:9px;color:#4a7a9b;margin-bottom:4px">Subir apuesta:</div>
      <input type="range" min="0" max="${Math.min(player.credits - (me.bet||0), 500000)}" step="1000" value="0" id="mpArenaRaiseBet"
        oninput="document.getElementById('mpArenaRaiseBetVal').textContent=parseInt(this.value).toLocaleString()"
        style="width:100%;margin-bottom:3px">
      <div style="font-size:10px;color:#ffd700">+₢ <span id="mpArenaRaiseBetVal">0</span></div>
    </div>
    <div style="text-align:center;font-size:10px;color:#ffd700;margin-top:4px" id="mpArenaCountdown">⏳ El combate comienza en 8 segundos...</div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button onclick="mpArenaRaiseBet()" style="
        flex:1;background:rgba(255,107,53,0.1);border:1px solid #ff6b35;color:#ff6b35;
        font-family:Share Tech Mono,monospace;font-size:9px;padding:7px;cursor:pointer;border-radius:3px
      ">💰 SUBIR APUESTA</button>
      <button onclick="mpArenaReadyNow()" style="
        flex:2;background:rgba(0,255,136,0.12);border:1px solid #00ff88;color:#00ff88;
        font-family:Share Tech Mono,monospace;font-size:9px;padding:7px;cursor:pointer;border-radius:3px;letter-spacing:1px
      ">⚔ ¡EMPEZAR YA!</button>
    </div>
  `;
}

function mpArenaRaiseBet() {
  if (!mp.arenaState || !mp.connected) return;
  const extra = parseInt(document.getElementById('mpArenaRaiseBet')?.value || '0');
  if (extra <= 0) return;
  mp.socket.emit('arena:raise_bet', { arenaId: mp.arenaState.id, extraBet: extra });
}

function mpArenaReady() {
  if (!mp.arenaState || !mp.connected) return;
  mp.socket.emit('arena:ready', { arenaId: mp.arenaState.id });
}

function mpArenaReadyNow() {
  if (!mp.arenaState || !mp.connected) return;
  mp.socket.emit('arena:ready', { arenaId: mp.arenaState.id });
  addLog('⚔ Señal de inicio enviada — el combate empezará pronto.', 'warn');
  const btn = document.getElementById('mpArenaLobby')?.querySelector('button:last-child');
  if (btn) { btn.textContent = '⏳ ESPERANDO...'; btn.disabled = true; btn.style.opacity = '0.5'; }
}

function mpCloseArenaLobby() {
  const modal = document.getElementById('mpArenaLobby');
  if (modal) modal.style.display = 'none';
}

// ── Invite toast ──────────────────────────────────────────────────
function mpShowInviteToast(inv) {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position:fixed;bottom:90px;right:20px;
    background:rgba(1,6,16,0.97);border:1px solid #ffd700;
    border-radius:6px;padding:12px 16px;
    font-family:Share Tech Mono,monospace;font-size:9px;color:#c8e8ff;
    z-index:4000;max-width:280px;
  `;
  toast.innerHTML = `
    <div style="color:#ffd700;font-size:10px;margin-bottom:6px">📨 Invitación al grupo</div>
    <div style="margin-bottom:8px">De: <b>${inv.inviterName}</b></div>
    <div style="display:flex;gap:6px">
      <button onclick="mpAcceptInviteFromToast('${inv.groupId}',this)" style="
        background:rgba(0,255,136,0.1);border:1px solid #00ff88;color:#00ff88;
        font-family:Share Tech Mono,monospace;font-size:8px;padding:4px 8px;cursor:pointer;border-radius:2px
      ">✓ ACEPTAR</button>
      <button onclick="this.closest('div[style]').remove()" style="
        background:none;border:1px solid #ff4444;color:#ff4444;
        font-family:Share Tech Mono,monospace;font-size:8px;padding:4px 8px;cursor:pointer;border-radius:2px
      ">✕ IGNORAR</button>
    </div>
  `;
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 15000);
}

window.mpAcceptInviteFromToast = function(groupId, btn) {
  if (!mp.connected) return;
  mp.pendingInvites = mp.pendingInvites.filter(i => i.groupId !== groupId);
  mp.socket.emit('group:join', { groupId });
  btn.closest('div[style*="position:fixed"]').remove();
};

// ── Username modal ────────────────────────────────────────────────
function mpShowNameModal(callback) {
  const saved = localStorage.getItem('vf_playerName') || '';
  const modal = document.createElement('div');
  modal.id = 'mpNameModal';
  modal.style.cssText = `
    position:fixed;top:0;left:0;width:100%;height:100%;
    background:rgba(0,0,0,0.85);z-index:9999;
    display:flex;align-items:center;justify-content:center;
    font-family:'Share Tech Mono',monospace;
  `;
  modal.innerHTML = `
    <div style="background:rgba(1,6,16,0.99);border:2px solid rgba(0,212,255,0.4);border-radius:10px;padding:30px 36px;min-width:320px;text-align:center">
      <div style="font-family:Orbitron,sans-serif;font-size:16px;color:#00d4ff;letter-spacing:3px;margin-bottom:6px;text-shadow:0 0 20px #00d4ff">VOID FRONTIER</div>
      <div style="font-size:10px;color:#4a7a9b;margin-bottom:22px;letter-spacing:1px">SERVIDOR MULTIJUGADOR</div>
      <div style="font-size:10px;color:#c8e8ff;margin-bottom:8px;text-align:left">TU NOMBRE DE PILOTO:</div>
      <input id="mpNameInput" type="text" maxlength="20" placeholder="Ej: StarWolf, Dracon, Nova..."
        value="${saved}"
        style="
          width:100%;background:rgba(0,212,255,0.06);border:1px solid rgba(0,212,255,0.4);
          color:#00ffcc;font-family:'Share Tech Mono',monospace;font-size:14px;
          padding:10px 14px;border-radius:4px;box-sizing:border-box;outline:none;
          text-align:center;letter-spacing:2px;margin-bottom:16px;
        ">
      <div style="font-size:8px;color:#4a7a9b;margin-bottom:18px">Máx. 20 caracteres. Se guardará para futuras sesiones.</div>
      <button id="mpNameBtn" style="
        width:100%;background:rgba(0,212,255,0.12);border:2px solid #00d4ff;color:#00d4ff;
        font-family:'Share Tech Mono',monospace;font-size:11px;padding:12px;
        cursor:pointer;border-radius:4px;letter-spacing:2px;
        transition:all 0.2s;
      " onmouseover="this.style.background='rgba(0,212,255,0.25)'" onmouseout="this.style.background='rgba(0,212,255,0.12)'">
        ▶ ENTRAR AL SERVIDOR
      </button>
    </div>
  `;
  document.body.appendChild(modal);
  const input = document.getElementById('mpNameInput');
  const btn = document.getElementById('mpNameBtn');
  input.focus();
  const confirm = () => {
    let name = input.value.trim();
    if (!name) name = 'Pilot-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    mp.playerName = name;
    localStorage.setItem('vf_playerName', name);
    modal.remove();
    callback();
  };
  btn.onclick = confirm;
  input.onkeydown = (e) => { if (e.key === 'Enter') confirm(); };
}

// ── Init ──────────────────────────────────────────────────────────
(function init() {
  const checkSocketIO = setInterval(() => {
    if (window.io) {
      clearInterval(checkSocketIO);
      mpCreateHUD();
      mpShowNameModal(() => mpConnect());
    }
  }, 200);

  // Stop trying after 10s
  setTimeout(() => clearInterval(checkSocketIO), 10000);
})();
