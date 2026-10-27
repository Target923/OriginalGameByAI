/* IMAGINE TILE — Multiplayer & Formation Core Module (P2P Host-Authoritative)
 * Works in both Browser (window.ITMulti) and Node.js (module.exports) for automated testing.
 */
(function (root) {
  'use strict';

  const APP = 'imaginetile';
  const NET_VERSION = 1;
  const MAX_PLAYERS = 5;
  const PEER_PREFIX = 'imaginetile-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const CODE_LEN = 6;
  const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js';
  const PING_MS = 4000;
  const TIMEOUT_MS = 45000;
  const JOIN_TIMEOUT_MS = 20000;

  function randomInt(n) {
    const c = root && root.crypto;
    if (c && c.getRandomValues) {
      const a = new Uint32Array(1);
      c.getRandomValues(a);
      return a[0] % n;
    }
    return Math.floor(Math.random() * n);
  }

  function makeCode(rand) {
    const r = rand || randomInt;
    let s = '';
    for (let i = 0; i < CODE_LEN; i++) s += CODE_CHARS[r(CODE_CHARS.length)];
    return s;
  }

  function normCode(s) {
    const t = String(s == null ? '' : s).normalize('NFKC').toUpperCase().replace(/[\s\-ー－]/g, '');
    if (t.length !== CODE_LEN) return null;
    for (const ch of t) {
      if (CODE_CHARS.indexOf(ch) < 0) return null;
    }
    return t;
  }

  function cleanName(s, fallback) {
    const t = String(s == null ? '' : s)
      .normalize('NFKC')
      .replace(/[\u0000-\u001f\u007f<>&"'`:]/g, '')
      .trim();
    return Array.from(t).slice(0, 12).join('') || (fallback || 'PILOT');
  }

  // Deterministic PRNG for syncing tile color palettes across all peers with a single integer seed
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Resource & Math Rules (1〜5 players) ──
  function calcBonusPerPlayer(bonusPool, numPlayers) {
    const b = Math.max(0, parseInt(bonusPool, 10) || 0);
    const p = Math.max(1, parseInt(numPlayers, 10) || 1);
    if (b <= 0) return { en: 0, core: 0 };
    return {
      en: Math.ceil(b / p),
      core: Math.max(1, Math.ceil(b / (3 * p)))
    };
  }

  function calcPoolPerPlayer(pool, numPlayers) {
    const b = Math.max(0, parseInt(pool, 10) || 0);
    const p = Math.max(1, parseInt(numPlayers, 10) || 1);
    return b <= 0 ? 0 : Math.ceil(b / p);
  }

  function calcEndlessEn(sz, numPlayers) {
    const s = Math.max(1, parseInt(sz, 10) || 7);
    const p = Math.max(1, parseInt(numPlayers, 10) || 1);
    return Math.ceil((s * 5) / p);
  }

  function calcAnsCost(sz, numPlayers) {
    const s = Math.max(1, parseInt(sz, 10) || 7);
    const p = Math.max(1, parseInt(numPlayers, 10) || 1);
    return Math.max(1, Math.ceil(s / p));
  }

  function calcStageClearCore(unrevealedLeft, numPlayers, coreSystemOn) {
    if (!coreSystemOn || unrevealedLeft <= 0) return 0;
    const baseCore = Math.ceil(unrevealedLeft / 25);
    const p = Math.max(1, parseInt(numPlayers, 10) || 1);
    return Math.ceil((baseCore * 5) / p);
  }

  function sanitizeUnitsList(arr) {
    if (!Array.isArray(arr)) return [0, 1, 2, 3, 4];
    const seen = new Set();
    const out = [];
    for (const v of arr) {
      const n = parseInt(v, 10);
      if (Number.isInteger(n) && n >= 0 && n <= 4 && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    out.sort((a, b) => a - b);
    return out.length ? out : [0];
  }

  // ── Host Room Controller (Star Topology: 1 Host + up to 4 Guests) ──
  class HostRoom {
    constructor(opts) {
      const o = opts || {};
      this.code = o.code || makeCode();
      this.phase = 'lobby'; // 'lobby' | 'playing'
      this.hostName = cleanName(o.hostName, 'HOST');
      this.nextGuestSeq = 1;
      this.members = [
        {
          peerId: 'host',
          name: this.hostName,
          unitIdx: Number.isInteger(o.hostUnit) && o.hostUnit >= 0 && o.hostUnit <= 4 ? o.hostUnit : 0,
          ready: true,
          isHost: true,
          connected: true,
          controlledByHost: true
        }
      ];
      this.links = new Map(); // peerId -> link
      this.config = {
        world: o.world || 'cyber',
        mode: o.mode || 'normal',
        settings: Object.assign({
          initEnergy: 50,
          clearEnergy: 25,
          bonusEnergy: 50,
          initCore: 0,
          stageHazard: true,
          coreSystem: true
        }, o.settings || {}),
        customSummary: o.customSummary || ''
      };
      this.onLobbyChange = o.onLobbyChange || null;
      this.onGuestAction = o.onGuestAction || null;
      this.onPeerLeftInGame = o.onPeerLeftInGame || null;
      this.closed = false;
    }

    _firstFreeUnit() {
      const used = new Set(this.members.filter(m => m.unitIdx >= 0).map(m => m.unitIdx));
      for (let u = 0; u < 5; u++) {
        if (!used.has(u)) return u;
      }
      return -1;
    }

    getLobbyState() {
      return {
        code: this.code,
        phase: this.phase,
        members: this.members.map(m => ({
          peerId: m.peerId,
          name: m.name,
          unitIdx: m.unitIdx,
          ready: !!m.ready,
          isHost: !!m.isHost,
          connected: !!m.connected
        })),
        config: JSON.parse(JSON.stringify(this.config))
      };
    }

    broadcast(msg, exceptPeerId) {
      for (const [pid, link] of this.links.entries()) {
        if (pid === exceptPeerId || link.closed) continue;
        link.send(msg);
      }
    }

    sendTo(peerId, msg) {
      const link = this.links.get(peerId);
      if (link && !link.closed) link.send(msg);
    }

    _notifyLobby() {
      const st = this.getLobbyState();
      this.broadcast({ t: 'lobby_state', state: st });
      if (this.onLobbyChange) this.onLobbyChange(st);
    }

    setHostName(name) {
      this.hostName = cleanName(name, 'HOST');
      const hm = this.members.find(m => m.peerId === 'host');
      if (hm) hm.name = this.hostName;
      this._notifyLobby();
    }

    updateConfig(partial) {
      if (partial.world) this.config.world = partial.world;
      if (partial.mode) this.config.mode = partial.mode;
      if (partial.settings) this.config.settings = Object.assign({}, this.config.settings, partial.settings);
      if (partial.customSummary !== undefined) this.config.customSummary = partial.customSummary;
      this._notifyLobby();
    }

    pickUnit(peerId, unitIdx) {
      if (this.phase !== 'lobby') return { ok: false, reason: '進行中は変更できません' };
      const u = parseInt(unitIdx, 10);
      if (!Number.isInteger(u) || u < -1 || u > 4) return { ok: false, reason: '不正な機体番号です' };
      const me = this.members.find(m => m.peerId === peerId);
      if (!me) return { ok: false, reason: '参加者が見つかりません' };
      // 自分の搭乗中機体を再クリック（または -1 指定）で搭乗解除 ➔ 5人満員時でも機体入れ替えが可能
      if (u === -1 || me.unitIdx === u) {
        if (me.unitIdx === -1) return { ok: true, unselected: true };
        me.unitIdx = -1;
        this._notifyLobby();
        return { ok: true, unselected: true };
      }
      const conflict = this.members.find(m => m.peerId !== peerId && m.unitIdx === u);
      if (conflict) return { ok: false, reason: `${conflict.name} が搭乗中です` };
      me.unitIdx = u;
      this._notifyLobby();
      return { ok: true, unselected: false };
    }

    setReady(peerId, ready) {
      if (this.phase !== 'lobby') return;
      const me = this.members.find(m => m.peerId === peerId);
      if (!me || me.isHost) return;
      if (ready && (!Number.isInteger(me.unitIdx) || me.unitIdx < 0 || me.unitIdx > 4)) return;
      me.ready = !!ready;
      this._notifyLobby();
    }

    canStart() {
      if (this.phase !== 'lobby') return { ok: false, reason: 'すでに開始しています' };
      if (this.members.length < 2) return { ok: false, reason: '2人以上で出撃できます（現在1人）' };
      if (this.members.length > MAX_PLAYERS) return { ok: false, reason: '定員オーバーです' };
      const unpicked = this.members.filter(m => !Number.isInteger(m.unitIdx) || m.unitIdx < 0 || m.unitIdx > 4);
      if (unpicked.length > 0) {
        return { ok: false, reason: `機体を選択中のメンバーがいます (${unpicked.map(m => m.name).join(', ')})` };
      }
      const notReady = this.members.filter(m => !m.isHost && !m.ready);
      if (notReady.length > 0) {
        return { ok: false, reason: `準備待ちのメンバーがいます (${notReady.map(m => m.name).join(', ')})` };
      }
      return { ok: true };
    }

    buildOrderedPlayers(vehicleNames, initCore) {
      const sorted = this.members.slice().sort((a, b) => a.unitIdx - b.unitIdx);
      return sorted.map(m => ({
        name: (vehicleNames && vehicleNames[m.unitIdx]) || ('UNIT-' + (m.unitIdx + 1)),
        playerName: m.name,
        peerId: m.peerId,
        controlledByHost: !!m.isHost || !m.connected,
        unitIdx: m.unitIdx,
        energy: 0,
        core: initCore || 0,
        specUsed: false
      }));
    }

    attachGuestLink(rawLink) {
      if (this.closed) {
        rawLink.close({ t: 'bye', reason: 'closed' });
        return;
      }
      let assignedPeerId = null;
      rawLink.onmessage = (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (!assignedPeerId) {
          if (msg.t !== 'hello') return;
          if (msg.app !== APP || msg.net !== NET_VERSION) {
            rawLink.close({ t: 'bye', reason: 'version' });
            return;
          }
          if (this.phase !== 'lobby') {
            rawLink.close({ t: 'bye', reason: 'playing' });
            return;
          }
          if (this.members.length >= MAX_PLAYERS) {
            rawLink.close({ t: 'bye', reason: 'full' });
            return;
          }
          const freeU = this._firstFreeUnit();
          if (freeU < 0) {
            rawLink.close({ t: 'bye', reason: 'full' });
            return;
          }
          assignedPeerId = 'g' + (this.nextGuestSeq++);
          const gName = cleanName(msg.name, 'GUEST ' + (this.nextGuestSeq - 1));
          this.members.push({
            peerId: assignedPeerId,
            name: gName,
            unitIdx: freeU,
            ready: true,
            isHost: false,
            connected: true,
            controlledByHost: false
          });
          this.links.set(assignedPeerId, rawLink);
          rawLink.send({
            t: 'welcome',
            peerId: assignedPeerId,
            code: this.code,
            state: this.getLobbyState()
          });
          this._notifyLobby();
          return;
        }

        // Subsequent messages from authenticated guest
        switch (msg.t) {
          case 'pick_unit': {
            const res = this.pickUnit(assignedPeerId, msg.unitIdx);
            if (!res.ok) rawLink.send({ t: 'reject', reason: res.reason });
            break;
          }
          case 'set_ready':
            this.setReady(assignedPeerId, !!msg.ready);
            break;
          case 'set_name': {
            if (this.phase === 'lobby') {
              const m = this.members.find(x => x.peerId === assignedPeerId);
              if (m) {
                m.name = cleanName(msg.name, m.name);
                this._notifyLobby();
              }
            }
            break;
          }
          case 'act':
            if (this.phase === 'playing' && this.onGuestAction) {
              this.onGuestAction(assignedPeerId, msg);
            }
            break;
          case 'bye':
            this._handleGuestDisconnect(assignedPeerId);
            break;
        }
      };

      rawLink.onclose = () => {
        if (assignedPeerId) this._handleGuestDisconnect(assignedPeerId);
      };
    }

    _handleGuestDisconnect(peerId) {
      const link = this.links.get(peerId);
      if (link) {
        this.links.delete(peerId);
        try { link.close(); } catch (e) {}
      }
      const idx = this.members.findIndex(m => m.peerId === peerId);
      if (idx < 0) return;
      const member = this.members[idx];
      if (!member.connected) return;

      if (this.phase === 'lobby') {
        this.members.splice(idx, 1);
        this._notifyLobby();
      } else {
        member.connected = false;
        member.controlledByHost = true;
        this.broadcast({ t: 'peer_left', peerId, name: member.name });
        if (this.onPeerLeftInGame) this.onPeerLeftInGame(peerId, member);
      }
    }

    returnToLobby() {
      this.phase = 'lobby';
      this.members = this.members.filter(m => m.isHost || m.connected);
      this.members.forEach(m => {
        if (!m.isHost) m.ready = true;
      });
      const st = this.getLobbyState();
      this.broadcast({ t: 'back_to_lobby', state: st });
      if (this.onLobbyChange) this.onLobbyChange(st);
    }

    closeRoom() {
      if (this.closed) return;
      this.closed = true;
      for (const link of this.links.values()) {
        try { link.close({ t: 'bye', reason: 'host_closed' }); } catch (e) {}
      }
      this.links.clear();
    }
  }

  // ── Guest Client Controller ──
  class GuestClient {
    constructor(link, opts) {
      const o = opts || {};
      this.link = link;
      this.peerId = null;
      this.code = null;
      this.name = cleanName(o.name, 'GUEST');
      this.lobbyState = null;
      this.handlers = o.handlers || {};
      this.closed = false;

      link.onmessage = (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'welcome') {
          this.peerId = msg.peerId;
          this.code = msg.code;
          this.lobbyState = msg.state;
          if (this.handlers.welcome) this.handlers.welcome(msg);
          return;
        }
        if (msg.t === 'lobby_state') {
          this.lobbyState = msg.state;
          if (this.handlers.lobby_state) this.handlers.lobby_state(msg.state);
          return;
        }
        if (msg.t === 'back_to_lobby') {
          this.lobbyState = msg.state;
          if (this.handlers.back_to_lobby) this.handlers.back_to_lobby(msg.state);
          return;
        }
        if (msg.t === 'bye') {
          this.closed = true;
          if (this.handlers.bye) this.handlers.bye(msg.reason || 'left');
          return;
        }
        if (this.handlers[msg.t]) {
          this.handlers[msg.t](msg);
        }
      };

      link.onclose = (reason) => {
        if (this.closed) return;
        this.closed = true;
        if (this.handlers.bye) this.handlers.bye(reason || 'disconnected');
      };

      link.send({
        t: 'hello',
        app: APP,
        net: NET_VERSION,
        name: this.name
      });
    }

    pickUnit(unitIdx) {
      if (!this.closed) this.link.send({ t: 'pick_unit', unitIdx });
    }

    setReady(ready) {
      if (!this.closed) this.link.send({ t: 'set_ready', ready: !!ready });
    }

    setName(name) {
      this.name = cleanName(name, this.name);
      if (!this.closed) this.link.send({ t: 'set_name', name: this.name });
    }

    sendAct(payload) {
      if (!this.closed) this.link.send(Object.assign({ t: 'act' }, payload));
    }

    leave() {
      if (this.closed) return;
      this.closed = true;
      try { this.link.close({ t: 'bye', reason: 'left' }); } catch (e) {}
    }
  }

  // ── In-Memory Link Pair (for deterministic unit testing) ──
  function createMemoryLinkPair() {
    let closed = false;
    const a = { onmessage: null, onclose: null, closed: false };
    const b = { onmessage: null, onclose: null, closed: false };
    a.send = (msg) => {
      if (closed) return;
      const copy = JSON.parse(JSON.stringify(msg));
      queueMicrotask(() => { if (!closed && b.onmessage) b.onmessage(copy); });
    };
    b.send = (msg) => {
      if (closed) return;
      const copy = JSON.parse(JSON.stringify(msg));
      queueMicrotask(() => { if (!closed && a.onmessage) a.onmessage(copy); });
    };
    a.close = (lastMsg) => {
      if (closed) return;
      if (lastMsg && b.onmessage) {
        const copy = JSON.parse(JSON.stringify(lastMsg));
        b.onmessage(copy);
      }
      closed = true;
      a.closed = true;
      b.closed = true;
      queueMicrotask(() => { if (b.onclose) b.onclose('close'); });
    };
    b.close = (lastMsg) => {
      if (closed) return;
      if (lastMsg && a.onmessage) {
        const copy = JSON.parse(JSON.stringify(lastMsg));
        a.onmessage(copy);
      }
      closed = true;
      a.closed = true;
      b.closed = true;
      queueMicrotask(() => { if (a.onclose) a.onclose('close'); });
    };
    return [a, b];
  }

  // ── BroadcastChannel Transport (Same-Origin Multi-Tab / Local Fallback) ──
  function openBroadcastRoom(code, onGuestLink) {
    if (typeof BroadcastChannel !== 'function') return null;
    const chName = PEER_PREFIX + 'bc-' + code;
    const hub = new BroadcastChannel(chName);
    const links = new Map();

    hub.onmessage = (ev) => {
      const d = ev.data;
      if (!d || typeof d !== 'object') return;
      if (d.bcType === 'connect' && d.clientId) {
        const cid = d.clientId;
        if (links.has(cid)) return;
        const link = {
          closed: false,
          onmessage: null,
          onclose: null,
          send(msg) {
            if (link.closed) return;
            hub.postMessage({ bcType: 's2c', to: cid, msg });
          },
          close(lastMsg) {
            if (link.closed) return;
            if (lastMsg) hub.postMessage({ bcType: 's2c', to: cid, msg: lastMsg });
            link.closed = true;
            links.delete(cid);
            hub.postMessage({ bcType: 'closed', to: cid });
          }
        };
        links.set(cid, link);
        hub.postMessage({ bcType: 'accepted', to: cid });
        onGuestLink(link);
      } else if (d.bcType === 'c2s' && d.from) {
        const link = links.get(d.from);
        if (link && !link.closed && link.onmessage) link.onmessage(d.msg);
      } else if (d.bcType === 'c_close' && d.from) {
        const link = links.get(d.from);
        if (link && !link.closed) {
          link.closed = true;
          links.delete(d.from);
          if (link.onclose) link.onclose('close');
        }
      }
    };

    return {
      close() {
        for (const l of links.values()) l.close({ t: 'bye', reason: 'host_closed' });
        links.clear();
        try { hub.close(); } catch (e) {}
      }
    };
  }

  function joinBroadcastRoom(code, callbacks) {
    if (typeof BroadcastChannel !== 'function') {
      callbacks.onError('BroadcastChannel非対応のブラウザです');
      return { close() {} };
    }
    const cid = 'bc_' + Date.now() + '_' + randomInt(1000000);
    const ch = new BroadcastChannel(PEER_PREFIX + 'bc-' + code);
    let connected = false;
    let closed = false;

    const link = {
      closed: false,
      onmessage: null,
      onclose: null,
      send(msg) {
        if (link.closed) return;
        ch.postMessage({ bcType: 'c2s', from: cid, msg });
      },
      close(lastMsg) {
        if (link.closed) return;
        if (lastMsg) ch.postMessage({ bcType: 'c2s', from: cid, msg: lastMsg });
        link.closed = true;
        closed = true;
        ch.postMessage({ bcType: 'c_close', from: cid });
        setTimeout(() => { try { ch.close(); } catch (e) {} }, 100);
      }
    };

    const timer = setTimeout(() => {
      if (!connected && !closed) {
        closed = true;
        link.closed = true;
        try { ch.close(); } catch (e) {}
        callbacks.onError('同じブラウザ内にそのコードの部屋が見つかりませんでした');
      }
    }, 5000);

    ch.onmessage = (ev) => {
      const d = ev.data;
      if (!d || d.to !== cid) return;
      if (d.bcType === 'accepted' && !connected) {
        connected = true;
        clearTimeout(timer);
        callbacks.onLink(link);
      } else if (d.bcType === 's2c') {
        if (!link.closed && link.onmessage) link.onmessage(d.msg);
      } else if (d.bcType === 'closed') {
        if (!link.closed) {
          link.closed = true;
          try { ch.close(); } catch (e) {}
          if (link.onclose) link.onclose('close');
        }
      }
    };

    ch.postMessage({ bcType: 'connect', clientId: cid });
    return {
      close() {
        clearTimeout(timer);
        link.close();
      }
    };
  }

  // ── PeerJS WebRTC Transport ──
  let peerjsLoading = null;
  function loadPeerJS() {
    if (root.Peer) return Promise.resolve(root.Peer);
    if (!peerjsLoading) {
      peerjsLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = PEERJS_URL;
        s.async = true;
        s.onload = () => (root.Peer ? resolve(root.Peer) : reject(new Error('Peer not found')));
        s.onerror = () => { peerjsLoading = null; reject(new Error('load failed')); };
        (document.head || document.documentElement).appendChild(s);
      });
    }
    return peerjsLoading;
  }

  function peerOptions() {
    const o = { debug: 0 };
    try {
      const m = /[?&]peer=([^&#]+)/.exec((root.location && root.location.search) || '');
      if (m) {
        const hp = decodeURIComponent(m[1]).split(':');
        Object.assign(o, { host: hp[0], port: +hp[1] || 9000, path: '/', secure: false, config: { iceServers: [] } });
      }
    } catch (e) {}
    return o;
  }

  const ERR_TEXT = {
    'browser-incompatible': 'このブラウザはオンライン協力（WebRTC）に対応していません',
    network: '通信仲介サーバーに接続できません。ネット接続を確認してください',
    'server-error': '通信仲介サーバーが一時的に混雑しています',
    'socket-error': '通信仲介サーバーとの接続が切れました',
    'socket-closed': '通信仲介サーバーとの接続が閉じられました',
    'unavailable-id': '部屋コードが重複しました。もう一度作成してください',
    'peer-unavailable': 'その部屋コードは見つかりませんでした。コードを確認してください',
    webrtc: '直接通信を確立できませんでした。別の回線でお試しください',
    'ssl-unavailable': '安全な接続（HTTPS）が必要です'
  };
  function errorText(err) {
    return ERR_TEXT[err && err.type] || '通信エラーが発生しました';
  }

  function wrapPeerConn(conn, destroyPeerOnClose) {
    const link = { onmessage: null, onclose: null, closed: false };
    let lastSeen = Date.now();
    let timer = null;
    const end = (reason) => {
      if (link.closed) return;
      link.closed = true;
      clearInterval(timer);
      try { conn.close(); } catch (e) {}
      if (destroyPeerOnClose) {
        try { destroyPeerOnClose.destroy(); } catch (e) {}
      }
      if (link.onclose) link.onclose(reason);
    };
    link.send = (msg) => {
      if (link.closed) return;
      try { conn.send(msg); } catch (e) { end('error'); }
    };
    link.close = (lastMsg) => {
      if (link.closed) return;
      if (lastMsg) link.send(lastMsg);
      link.onclose = null;
      link.onmessage = null;
      setTimeout(() => end('local'), 250);
    };
    timer = setInterval(() => {
      if (Date.now() - lastSeen > TIMEOUT_MS) end('timeout');
      else link.send({ t: 'ping' });
    }, PING_MS);
    conn.on('data', (msg) => {
      lastSeen = Date.now();
      if (msg && msg.t === 'ping') return;
      if (link.onmessage) link.onmessage(msg);
    });
    conn.on('close', () => end('close'));
    conn.on('error', () => end('error'));
    return link;
  }

  function openPeerRoom(opts) {
    let peer = null, bcHub = null, stopped = false, tries = 0;
    const useLocalOnly = opts && opts.localOnly;

    if (useLocalOnly) {
      const code = makeCode();
      bcHub = openBroadcastRoom(code, (link) => { if (!stopped) opts.onGuest(link); });
      setTimeout(() => { if (!stopped) opts.onOpen(code); }, 10);
      return {
        close() {
          stopped = true;
          if (bcHub) bcHub.close();
        }
      };
    }

    const start = (Peer) => {
      if (stopped) return;
      const code = makeCode();
      const p = new Peer(PEER_PREFIX + code, peerOptions());
      peer = p;
      p.on('open', () => {
        if (!stopped && peer === p) {
          // Also open BroadcastChannel on same browser for instant zero-latency local tab join if needed
          bcHub = openBroadcastRoom(code, (link) => { if (!stopped) opts.onGuest(link); });
          opts.onOpen(code);
        }
      });
      p.on('connection', (conn) => {
        if (stopped) {
          conn.on('open', () => conn.close());
          return;
        }
        conn.on('open', () => {
          if (!stopped) opts.onGuest(wrapPeerConn(conn, null));
        });
      });
      p.on('disconnected', () => {
        if (!stopped && peer === p) {
          try { p.reconnect(); } catch (e) {}
        }
      });
      p.on('error', (err) => {
        if (stopped || peer !== p) return;
        if (err && err.type === 'unavailable-id' && tries++ < 4) {
          try { p.destroy(); } catch (e) {}
          start(Peer);
          return;
        }
        // Only abort if room hasn't opened yet
        if (!bcHub) {
          stopped = true;
          try { p.destroy(); } catch (e) {}
          opts.onError(errorText(err));
        }
      });
    };

    loadPeerJS().then(start, () => {
      if (!stopped) {
        // Fallback to BroadcastChannel if offline/CDN blocked
        const code = makeCode();
        bcHub = openBroadcastRoom(code, (link) => { if (!stopped) opts.onGuest(link); });
        if (bcHub) {
          opts.onOpen(code, true);
        } else {
          stopped = true;
          opts.onError('通信ライブラリ（PeerJS）を読み込めませんでした');
        }
      }
    });

    return {
      close() {
        stopped = true;
        if (bcHub) { try { bcHub.close(); } catch (e) {} bcHub = null; }
        if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
      }
    };
  }

  function joinPeerRoom(rawCode, opts) {
    const code = normCode(rawCode);
    if (!code) {
      opts.onError('6文字の部屋コードを正しく入力してください');
      return { close() {} };
    }
    if (opts && opts.localOnly) {
      return joinBroadcastRoom(code, opts);
    }

    let peer = null, done = false, bcAttempt = null;
    const finishLink = (link) => {
      if (done) {
        try { link.close(); } catch (e) {}
        return;
      }
      done = true;
      clearTimeout(timer);
      if (bcAttempt) { try { bcAttempt.close(); } catch (e) {} bcAttempt = null; }
      opts.onLink(link);
    };
    const fail = (text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
      opts.onError(text);
    };

    // Fast path: check if host is open in another tab of the same browser first (within 350ms), while PeerJS connects in parallel!
    if (typeof BroadcastChannel === 'function') {
      let bcDone = false;
      const cid = 'bc_' + Date.now() + '_' + randomInt(1000000);
      const ch = new BroadcastChannel(PEER_PREFIX + 'bc-' + code);
      const bcLink = {
        closed: false,
        onmessage: null,
        onclose: null,
        send(msg) { if (!bcLink.closed) ch.postMessage({ bcType: 'c2s', from: cid, msg }); },
        close(lastMsg) {
          if (bcLink.closed) return;
          if (lastMsg) ch.postMessage({ bcType: 'c2s', from: cid, msg: lastMsg });
          bcLink.closed = true;
          ch.postMessage({ bcType: 'c_close', from: cid });
          setTimeout(() => { try { ch.close(); } catch (e) {} }, 80);
        }
      };
      ch.onmessage = (ev) => {
        const d = ev.data;
        if (!d || d.to !== cid) return;
        if (d.bcType === 'accepted' && !bcDone && !done) {
          bcDone = true;
          if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
          bcAttempt = null;
          finishLink(bcLink);
        } else if (d.bcType === 's2c') {
          if (!bcLink.closed && bcLink.onmessage) bcLink.onmessage(d.msg);
        } else if (d.bcType === 'closed') {
          if (!bcLink.closed) {
            bcLink.closed = true;
            try { ch.close(); } catch (e) {}
            if (bcLink.onclose) bcLink.onclose('close');
          }
        }
      };
      bcAttempt = {
        close() {
          if (!bcDone) {
            bcLink.closed = true;
            try { ch.close(); } catch (e) {}
          }
        }
      };
      ch.postMessage({ bcType: 'connect', clientId: cid });
    }

    const timer = setTimeout(() => fail('部屋に接続できませんでした。コードを確認してもう一度お試しください'), JOIN_TIMEOUT_MS);

    loadPeerJS().then((Peer) => {
      if (done) return;
      peer = new Peer(peerOptions());
      peer.on('open', () => {
        if (done) { try { peer.destroy(); } catch (e) {} return; }
        const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
        conn.on('open', () => {
          if (done) { try { conn.close(); peer.destroy(); } catch (e) {} return; }
          finishLink(wrapPeerConn(conn, peer));
        });
        conn.on('error', () => fail('相手との通信に失敗しました'));
      });
      peer.on('error', (err) => fail(errorText(err)));
    }, () => {
      // Wait briefly in case BroadcastChannel succeeds on offline local tabs
      setTimeout(() => fail('通信ライブラリ（PeerJS）を読み込めませんでした'), 800);
    });

    return {
      close() {
        if (!done) {
          done = true;
          clearTimeout(timer);
          if (bcAttempt) { try { bcAttempt.close(); } catch (e) {} }
          if (peer) { try { peer.destroy(); } catch (e) {} }
        }
      }
    };
  }

  const api = {
    APP,
    NET_VERSION,
    MAX_PLAYERS,
    PEER_PREFIX,
    CODE_CHARS,
    CODE_LEN,
    makeCode,
    normCode,
    cleanName,
    mulberry32,
    calcBonusPerPlayer,
    calcPoolPerPlayer,
    calcEndlessEn,
    calcAnsCost,
    calcStageClearCore,
    sanitizeUnitsList,
    HostRoom,
    GuestClient,
    createMemoryLinkPair,
    openBroadcastRoom,
    joinBroadcastRoom,
    openPeerRoom,
    joinPeerRoom
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ITMulti = api;
})(typeof window !== 'undefined' ? window : globalThis);
