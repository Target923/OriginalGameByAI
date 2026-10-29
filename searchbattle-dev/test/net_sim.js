// オンライン対戦の模擬テスト（通信なし）
//  ホストとゲストを同じプログラムの中で動かし、メッセージを（JSON にして戻してから）直接渡す。
//  CPU（ai.js）に両者の手を選ばせて決着まで進め、次を確かめる：
//   1. ゲストに送ったどのスナップショットにも、ホストの秘密（生きているキューブ・トレジャー・ワープ先など）が入っていない
//      （送ってよい項目の一覧に無いものが混ざっていたら失敗。engine に新しい項目が増えたときも気づける）
//   2. 決着のあとにゲストが受け取った全部（full）が、ホストの対戦とまったく同じ
//   3. ホストの操作の記録をやり直す（＝ふつうの試合と同じ）と、同じ盤面・同じ結果になる
//   4. ルールにない操作・変な形のデータ・違う版のゲームは断られ、盤面が変わらない
//  ゲストの CPU は、ゲストに届いた（伏せた）盤面だけを見て手を選ぶ（人と同じ情報）。
// 使い方：node test/net_sim.js [試合数（既定 24）]
const E = require('../src/engine.js');
const AI = require('../src/ai.js');
const NET = require('../src/net.js');

const deep = (o) => JSON.parse(JSON.stringify(o));
const strip = (g, drop) => { const o = Object.assign({}, g, { rng: undefined }); for (const k of drop || []) o[k] = undefined; return JSON.stringify(o); };
const fails = [];
const fail = (m) => { fails.push(m); if (fails.length <= 20) console.log('FAIL', m); };

// ---------------- 1. 秘密が入っていないか（送ってよい項目の一覧） ----------------
const TOP_KEYS = ['rules', 'N', 'NN', 'mode', 'v', 'itemKeys', 'draftEach', 'oncePerMatch', 'treasurePts', 'treasureSteal', 'victoryPts', 'speedBonus', 'clock', 'turn', 'first', 'cur', 'phase', 'sub', 'itemUsed', 'pending', 'draft', 'log', 'result', 'lastAction', 'events', 'players'];
const PLAYER_KEYS = ['idx', 'name', 'isCPU', 'stock', 'pieces', 'nextId', 'treasure', 'setupDone', 'splitPieces', 'items', 'used', 'wallet', 'rebuys', 'score', 'view', 'kb'];
// ホストにかかわる（ホストが操作した・ホストの盤で起きた）演出の記録で、送ってよい項目
const EV_BASE = ['type', 'id', 'turn', 'actor', 'owner'];
const EV_KEYS = {
  start: ['first'], turn: ['cur'], call: ['c', 'r', 'num'], destroy: ['cells', 'size', 'isAdd', 'key', 'cause'],
  answer: ['cells', 'success', 'stealth'], reveal: ['cells'], tchance: ['left', 'max'], treasure: ['c', 'r'], tfail: [], over: ['result'],
  item: ['key', 'rebuy', 'n', 'kind', 'value', 'line', 'index', 'k', 'cell', 'size', 'cat', 'a', 'b', 'same', 'oldCells', 'treasureMoved', 'hit', 'killed'],
};
const LOG_KEYS = ['id', 'turn', 'actor', 'text', 'priv', 'kind', 'key', 'cells'];
const LA_KEYS = ['kind', 'pi', 'c', 'res', 'ok', 'cells', 'key', 'r', 'result', 'stealth'];
const LA_RESULT_KEYS = ['ok', 'key', 'n', 'k', 'size', 'cat', 'same', 'hit', 'killed', 'ended', 'oldCells', 'treasureMoved', 'r', 'num', 'destroyed'];
const only = (obj, allowed, where) => { for (const k of Object.keys(obj || {})) if (allowed.indexOf(k) < 0) fail(`${where}: 送ってはいけない項目 ${k}`); };

function checkSnap(snap, hostGame, where) {
  only(snap, TOP_KEYS, where);
  if ('actions' in snap || 'initOpts' in snap || 'rng' in snap) fail(where + ': actions/initOpts/rng');
  const H = snap.players[0], realH = hostGame.players[0];
  only(H, PLAYER_KEYS, where + ' host');
  if (H.treasure !== null) fail(where + ': トレジャー');
  if (H.splitPieces.length) fail(where + ': splitPieces');
  if (H.nextId !== 0) fail(where + ': nextId');
  const realDead = realH.pieces.filter((p) => !p.alive);
  if (H.pieces.length !== realDead.length || H.pieces.some((p) => p.alive)) fail(where + ': 生きている個体が入っている');
  H.pieces.forEach((p, i) => { only(p, NET.DEAD_FIELDS, where + ' dead piece'); if (p.id !== i + 1) fail(where + ': 個体の番号'); });
  // 撃破された個体のマスは、本物と同じ（番号だけ付け直す）
  const realCells = realDead.map((p) => p.cells.slice().sort((a, b) => a - b).join(',')).sort();
  const sentCells = H.pieces.map((p) => p.cells.slice().sort((a, b) => a - b).join(',')).sort();
  if (realCells.join('|') !== sentCells.join('|')) fail(where + ': 撃破された個体のマス');
  for (const d of snap.players[1].view.dead) if (d && !(d.pieceId >= 1 && d.pieceId <= realDead.length)) fail(where + ': view.dead の番号');
  if (snap.phase === 'setup' && (snap.first != null || snap.cur != null)) fail(where + ': 配置中に先攻が見える');
  for (const ev of snap.events) {
    if (ev.actor !== 0 && ev.owner !== 0) continue;
    // ゲスト自身のワープ・ステルス（priv）、ゲストの盤で分解された個体（ownerPriv）は、ゲストが見てよい
    const ok = EV_BASE.concat(EV_KEYS[ev.type] || [], ev.actor === 1 ? ['priv'] : [], ev.owner === 1 ? ['ownerPriv'] : []);
    only(ev, ok, `${where} event ${ev.type}`);
  }
  for (const e of snap.log) {
    only(e, LOG_KEYS, where + ' log');
    if (e.actor === 0 && e.priv != null) fail(where + ': ログの priv');
  }
  const la = snap.lastAction;
  if (la && la.pi === 0) {
    only(la, LA_KEYS, where + ' lastAction');
    if (la.result) only(la.result, LA_RESULT_KEYS, where + ' lastAction.result');
    if (la.res) only(la.res, LA_RESULT_KEYS, where + ' lastAction.res');
  }
  // 見本の数と同じ：伏せる前の演出の記録と同じ数（ゲストの画面は番号で覚えている）
  if (snap.events.length !== hostGame.events.length) fail(where + ': 演出の記録の数');
}

// ---------------- ホストとゲストをつなぐ（メッセージは JSON にして戻してから渡す＝送れる形かも確かめる） ----------------
function makePair(gameOpts, opt) {
  opt = opt || {};
  const sent = { toGuest: [], toHost: [] };
  let host = null, guest = null;
  host = new NET.Host({
    name: opt.hostName || 'ホスト',
    send: (m) => {
      const c = deep(m);
      sent.toGuest.push(c);
      if (c.t === 'state' || c.t === 'welcome') checkSnap(c.snap, host.game, `${opt.tag || ''} ${c.t}#${sent.toGuest.length}`);
      guest.receive(c);
    },
    makeGame: (names) => new E.Game(Object.assign({ names, cpu: [false, false], mode: 'online' }, gameOpts)),
  });
  guest = new NET.Guest({ name: opt.guestName || 'ゲスト', send: (m) => { const c = deep(m); sent.toHost.push(c); host.receive(c); } });
  return { host, guest, sent };
}
// CPU に渡す「盤面」：読むときはそれぞれの手元の対戦を見て、盤面を変える操作は通信の窓口を通す
function hostView(host) {
  return new Proxy({}, {
    get(_, k) {
      if (NET.SYNC_ACTS.indexOf(k) >= 0) return (...args) => host.run(k, args);
      const g = host.game, v = g[k];
      return typeof v === 'function' ? v.bind(g) : v;
    },
  });
}
function guestView(guest) {
  return new Proxy({}, {
    get(_, k) {
      if (NET.PLAY_ACTS.indexOf(k) >= 0) return (pi, ...args) => guest.act(k, args);
      const g = guest.game, v = g[k];
      return typeof v === 'function' ? v.bind(g) : v;
    },
  });
}

// ---------------- 2・3. CPU どうしでオンライン対戦を決着まで ----------------
function playOnline(gameOpts, i) {
  const tag = `#${i} ${gameOpts.rules}${gameOpts.draftEach ? ' draft' : ''}`;
  const P = makePair(gameOpts, { tag });
  const { host, guest } = P;
  guest.hello();
  if (!host.game || !guest.game || guest.game.phase !== 'setup') { fail(tag + ': welcome'); return null; }
  // 配置：ホストが先・ゲストが先を交互に
  const hostSetup = () => { if (!AI.setup(host.game, 0)) host.game.randomSetup(0); const r = host.run('finishSetup', [0]); if (!r.ok) fail(tag + ': host setup ' + r.reason); };
  const guestSetup = () => {
    if (!AI.setup(guest.game, 1)) guest.game.randomSetup(1);
    const r = guest.sendSetup();
    if (!r.ok) fail(tag + ': guest setup ' + r.reason);
  };
  if (i % 2) { hostSetup(); if (!guest.foeReady) fail(tag + ': 相手の配置完了が届かない'); guestSetup(); }
  else { guestSetup(); if (!host.game.players[1].setupDone) fail(tag + ': ゲストの配置が反映されない'); hostSetup(); }
  if (host.game.phase === 'setup' || guest.game.phase === 'setup') { fail(tag + ': 配置のあとに進まない'); return null; }
  let guard = 0;
  while (host.game.phase === 'draft' && guard++ < 40) {
    const pi = host.game.draftTurn();
    if (pi === 0) host.run('draftPick', [0, AI.draftPick(host.game, 0)]);
    else guest.act('draftPick', [AI.draftPick(guest.game, 1)]);
  }
  const hv = hostView(host), gv = guestView(guest);
  while (host.game.phase === 'play' && guard++ < 800) {
    const g = host.game, sig = `${g.clock}/${g.sub}/${g.turn}/${g.cur}`;
    if (g.cur === 0) AI.playTurn(hv, 0); else AI.playTurn(gv, 1);
    if (sig === `${host.game.clock}/${host.game.sub}/${host.game.turn}/${host.game.cur}`) { fail(tag + ': 進まない ' + sig); break; }
  }
  if (host.game.phase !== 'over') { fail(tag + ': 決着しない'); return null; }
  const rejects = P.sent.toGuest.filter((m) => m.t === 'reject');
  if (rejects.length) fail(tag + ': ふつうの対戦で断られた ' + JSON.stringify(rejects[0]));
  // 2. 決着のあとの全部
  const last = P.sent.toGuest[P.sent.toGuest.length - 1];
  if (!last || last.t !== 'full') fail(tag + ': 最後が full ではない');
  if (strip(guest.game) !== strip(host.game)) fail(tag + ': ゲストの全部がホストと違う');
  if (!guest.game.replayRecord()) fail(tag + ': ゲストがリプレイを開けない');
  // 3. 操作の記録をやり直す（ふつうの試合と同じ流れ）と同じになる
  const g2 = E.replayGame(host.game.replayRecord());
  if (strip(g2, ['actions', 'initOpts']) !== strip(host.game, ['actions', 'initOpts'])) fail(tag + ': 記録のやり直しと違う');
  return { turns: host.game.turn, msgs: P.sent.toGuest.length, bytes: JSON.stringify(P.sent.toGuest).length, winner: host.game.result.winner, items: host.game.log.filter((e) => e.kind === 'item').length };
}

// ---------------- 4. 断られるべきもの ----------------
function negativeTests() {
  // 違う版のゲーム
  {
    const P = makePair({ rules: 'prelim' });
    P.guest.send({ t: 'hello', app: 'searchbattle', net: NET.NET_VERSION, v: E.VERSION + 1, name: 'x' });
    const m = P.sent.toGuest[0];
    if (!m || m.t !== 'bye' || m.reason !== 'version' || P.host.game) fail('版が違う相手を断らない');
    const P2 = makePair({ rules: 'prelim' });
    P2.guest.send({ t: 'hello', app: 'other', net: NET.NET_VERSION, v: E.VERSION });
    if (P2.host.game) fail('別のアプリを断らない');
  }
  // 配置
  const P = makePair({ rules: 'prelim' }, { hostName: '同じ', guestName: '同じ' });
  P.guest.hello();
  const { host, guest } = P;
  if (host.guestName === host.name) fail('同じ名前を見分けない');
  const before = () => strip(host.game);
  const badSetups = [
    { pieces: [{ key: 'D2', t: 0, r0: 0, c0: 0 }, { key: 'D2', t: 0, r0: 0, c0: 0 }], treasure: 0 },      // 重なる
    { pieces: Array.from({ length: 6 }, (_, i) => ({ key: 'D2', t: 0, r0: i % 4, c0: i < 4 ? 0 : 2 })), treasure: 0 },   // 2マスは5個まで
    { pieces: [{ key: '__proto__', t: 0, r0: 0, c0: 0 }], treasure: 0 },
    { pieces: [{ key: 'A1', t: 0, r0: 0, c0: 0 }], treasure: 0 },
    { pieces: [{ key: 'I5', t: 0, r0: 0, c0: 0 }], treasure: 0 },                                         // 4×4には入らない
    { pieces: [{ key: 'D2', t: '0', r0: 0, c0: 0 }], treasure: 0 },
    { pieces: [{ key: 'D2', t: 0, r0: 0.5, c0: 0 }], treasure: 0 },
    { pieces: [{ key: 'D2', t: 0, r0: 0, c0: 0 }], treasure: 5 },                                         // トレジャーが個体の外
    { pieces: [{ key: 'D2', t: 0, r0: 0, c0: 0 }] },
    { pieces: [], treasure: 0 },
    { pieces: 'x', treasure: 0 },
  ];
  for (const s of badSetups) {
    const b = before();
    const n = P.sent.toGuest.length;
    host.receive(deep(Object.assign({ t: 'setup' }, s)));
    const m = P.sent.toGuest[n];
    if (!m || m.t !== 'reject' || m.what !== 'setup') fail('配置を断らない ' + JSON.stringify(s).slice(0, 80));
    if (host.game.players[1].pieces.length || host.game.players[1].setupDone) fail('断った配置が残る');
    if (before() !== b && host.game.players[1].pieces.length) fail('断った配置で盤面が変わる');
  }
  // 配置を済ませて対戦へ
  AI.setup(host.game, 0); host.run('finishSetup', [0]);
  AI.setup(guest.game, 1); guest.sendSetup();
  if (host.game.phase !== 'play') fail('配置のあとに対戦にならない');
  // 対戦中に配置をもう一度送る
  { const n = P.sent.toGuest.length; host.receive({ t: 'setup', pieces: [{ key: 'D2', t: 0, r0: 0, c0: 0 }], treasure: 0 }); if ((P.sent.toGuest[n] || {}).t !== 'reject') fail('対戦中の配置を断らない'); }
  // ルールにない操作・変な形のデータ・相手の番の操作
  const send = (name, args) => { const n = P.sent.toGuest.length; const b = before(); host.receive(deep({ t: 'act', name, args, seq: 999 })); const m = P.sent.toGuest[n]; return { rejected: !!m && m.t === 'reject', same: before() === b }; };
  const hostTurn = host.game.cur === 0;
  const bad = [
    ['placePiece', [1, 'D2', 0, 0, 0]], ['finishSetup', []], ['__proto__', []], ['constructor', []], ['toString', []], ['_destroy', [{}]], ['randomSetup', []],
    ['call', ['3']], ['call', [99]], ['call', [-1]], ['call', [null]], ['call', []], ['call', [1.5]],
    ['answer', ['abc']], ['answer', [[0, 1, 2, 3, 4, 5]]], ['answer', [[0.5, 1]]], ['answer', [null]],
    ['useItem', ['nope', {}]], ['useItem', ['line', null]], ['useItem', ['line', { line: 'row', index: 9 }]], ['useItem', ['warp', { pieceId: 1, t: 9, r0: 0, c0: 0 }]],
    ['useItem', ['cube', { kind: 'size', value: '2' }]], ['useItem', ['pair', { a: 0, b: '1' }]], ['useItem', ['__proto__', {}]],
    ['sacrifice', [1]], ['treasureCall', [0]], ['draftPick', ['cube']], ['endTurn', []],
  ];
  if (!hostTurn) bad.push(['endTurn', []]);
  for (const [name, args] of bad) {
    const r = send(name, args);
    if (!r.rejected || !r.same) fail(`断るべき操作 ${name} ${JSON.stringify(args)}：${r.rejected ? '' : '断らない '}${r.same ? '' : '盤面が変わった'}`);
  }
  // 相手（ホスト）の番に、ふつうならできる操作を送っても断る
  if (hostTurn) {
    const c = [...Array(host.game.NN).keys()].find((x) => host.game.isCallable(1, x));
    const r = send('call', [c]);
    if (!r.rejected || !r.same) fail('相手の番のコールを断らない');
  }
  // 結果を待っているあいだは、次の操作を送らない
  { const gu = new NET.Guest({ name: 'x', send: () => {} }); gu.act('endTurn', []); const r = gu.act('endTurn', []); if (r.ok) fail('結果待ちのあいだに送れてしまう'); }
}

// ---------------- 小物 ----------------
function utilTests() {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) { const c = NET.makeCode(); if (NET.normCode(c) !== c) fail('コードの形 ' + c); seen.add(c); }
  if (seen.size < 1990) fail('コードがかぶりすぎ');
  const cases = [['k7p2qx', 'K7P2QX'], ['Ｋ７Ｐ２ＱＸ', 'K7P2QX'], [' K7P-2QX ', 'K7P2QX'], ['K0P2QX', null], ['K7P2Q', null], ['K7P2QXX', null], ['KIP2QX', null], [null, null]];
  for (const [a, b] of cases) if (NET.normCode(a) !== b) fail(`normCode(${a}) = ${NET.normCode(a)}`);
  const nm = NET.cleanName('<img src=x onerror=alert(1)>名前：長い名前長い名前長い名前', 'F');
  if (/[<>"'&:：]/.test(nm) || Array.from(nm).length > 12) fail('cleanName ' + nm);
  if (NET.cleanName('   ', 'F') !== 'F') fail('cleanName 空');
}

const n = +process.argv[2] || 24;
const t0 = Date.now();
utilTests();
negativeTests();
const stats = [];
const kinds = [
  { rules: 'prelim' }, { rules: 'final' }, { rules: 'prelim', draftEach: 3 }, { rules: 'prelim', items: ['bazooka', 'warp', 'stealth', 'line', 'pair', 'node'] },
  { rules: 'final', draftEach: 4 }, { rules: 'prelim', items: ['warp', 'stealth', 'bazooka'] },
];
for (let i = 0; i < n; i++) {
  const s = playOnline(Object.assign({ label: 'オンライン' }, kinds[i % kinds.length]), i);
  if (s) stats.push(s);
}
const avg = (k) => (stats.reduce((a, s) => a + s[k], 0) / Math.max(1, stats.length)).toFixed(1);
console.log(`net_sim: ${stats.length}/${n} 試合が決着  平均 ${avg('turns')}ターン・メッセージ${avg('msgs')}通・合計${(avg('bytes') / 1024).toFixed(0)}KB・アイテム${avg('items')}回  ホストの勝ち ${stats.filter((s) => s.winner === 0).length}  ${((Date.now() - t0) / 1000).toFixed(1)}秒`);
console.log(fails.length ? `NG ${fails.length}件` : 'OK');
process.exit(fails.length ? 1 : 0);
