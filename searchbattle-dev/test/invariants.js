// ランダムな操作（人間がやりそうな手も含む）で盤面の不変条件を検証する
//  1. 生きている個体のマスに「再コール不可の×」が付いていない（当てられない状態にならない）
//  2. 個体のマスが (形, 向き, 位置) と一致し、生きている個体どうしが重ならない
//  3. ◎・○ は生きている個体のヒット済みマスか、撃破済みのマスにだけ付く
//  4. ワープのログ・イベント・×マークがすべて同じ移動前のマスを指す
//  5. バズーカで分解した個体は1マスキューブに置き換わり、ヒット済みのマスは撃破済み。トレジャーは残ったマスの持ち主を指す
const E = require('../src/engine.js');
const AI = require('../src/ai.js');
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
const N_GAMES = +(process.argv[2] || 400);
const stats = { games: 0, actions: 0, warps: 0, roundtrips: 0, fail: 0 };
const fails = [];
let CUR = '';
function fail(tag, info) { stats.fail++; if (fails.length < 8) fails.push({ tag, game: CUR, info }); }

// 推論の健全性：その人の知識（kb）から作った候補に、本当の配置が必ず含まれる
function sound(G, pi, tag) {
  const me = G.players[pi], foe = G.players[1 - pi];
  const A = AI.analyze(me.kb, G.N, G.rng);
  stats.sound = (stats.sound || 0) + 1;
  if (A.joint.inconsistent) fail('inconsistent', { tag, turn: G.turn });
  A.ctx.groups.forEach((g, i) => {
    const p = G.pieceAt(foe.idx, g.c);
    if (!p) { fail('group-no-piece', { tag, g }); return; }
    // Stealth hit（v13）のグループ：その個体にそれより前のヒットがあれば、本当は○（merge）。merge の候補があればよい
    if (g.q && A.ctx.U.some((u) => u.t < g.t && (p.mask & (1 << u.c)))) {
      if (!g.cands.some((cd) => cd.merge)) fail('truth-missing-merge', { tag, turn: G.turn, cells: p.cells });
      return;
    }
    const k = g.cands.findIndex((cd) => cd.mask === p.mask);
    if (k < 0 && process.env.INV_DEBUG && !stats.dbg) { stats.dbg = 1; console.log(JSON.stringify({ g: { c: g.c, t: g.t, q: g.q, num: g.num }, truth: { cells: p.cells, stealth: p.stealth, stealthAt: p.stealthAt, rev: p.stealthRevealed, hit: p.hitMask }, calls: me.kb.calls, empties: me.kb.empties, stealths: me.kb.stealths, reveals: me.kb.reveals, warps: me.kb.warps.map((w) => ({ t: w.t, old: w.oldCells })), deads: me.kb.deads.map((d) => ({ t: d.t, cells: d.cells })), counts: me.kb.counts, cands: g.cands.map((cd) => cd.cells.join(',') + (cd.st ? 's' : '')) })); }
    if (k < 0) { fail('truth-missing', { tag, turn: G.turn, shape: p.shape, cells: p.cells, logs: me.kb.logs, occs: me.kb.occs }); return; }
    if (A.joint.exact && !A.joint.inconsistent && A.joint.candW[i][k] <= 0 && process.env.INV_DEBUG && !stats.dbg2) { stats.dbg2 = 1; console.log(JSON.stringify({ pruned: true, gi: i, g: { c: g.c, t: g.t, q: g.q, num: g.num }, truthCand: g.cands[k].cells.join(',') + (g.cands[k].st ? 's' : ''), truth: { stealth: p.stealth, stealthAt: p.stealthAt, rev: p.stealthRevealed, hit: p.hitMask }, groups: A.ctx.groups.map((h) => ({ c: h.c, t: h.t, q: h.q, n: h.cands.length })), truthAll: A.ctx.groups.map((h) => { const pp = G.pieceAt(foe.idx, h.c); return pp ? pp.cells.join(',') + (pp.stealth ? 'S' : '') : null; }), calls: me.kb.calls, empties: me.kb.empties, occs: me.kb.occs, stealths: me.kb.stealths, reveals: me.kb.reveals, counts: me.kb.counts, pairs: me.kb.pairs, deads: me.kb.deads.map((d) => ({ t: d.t, cells: d.cells })), warps: me.kb.warps.map((w) => ({ t: w.t, old: w.oldCells })) })); }
    if (A.joint.exact && !A.joint.inconsistent && A.joint.candW[i][k] <= 0) fail('truth-pruned', { tag, turn: G.turn, shape: p.shape, logs: me.kb.logs, pairs: me.kb.pairs });
  });
  for (const ce of A.certain) { if (!G.living(foe.idx).some((p) => p.mask === ce.cand.mask)) fail('certain-wrong', { tag, turn: G.turn, cells: ce.cand.cells }); }
  stats.fragCertain = (stats.fragCertain || 0) + A.certain.filter((ce) => ce.gi < 0).length;
}

function check(G, tag) {
  if (G.phase === 'play') { sound(G, 0, tag); sound(G, 1, tag); }
  const N = G.N;
  // バズーカ：分解された個体は残っておらず、破片は1マス。トレジャーの持ち主は今ある個体（生きているか撃破済み）
  for (const P of G.players) {
    for (const sp of P.splitPieces) if (P.pieces.some((p) => p.id === sp.id)) fail('split-still-there', { tag, sp });
    for (const p of P.pieces) if (p.frag && (p.size !== 1 || p.cells.length !== 1 || p.shape !== 'A1' || p.isAdd)) fail('frag-shape', { tag, p });
    if (P.treasure && !P.pieces.some((p) => p.id === P.treasure.pieceId && p.cells.indexOf(P.treasure.cell) >= 0)) fail('treasure-owner', { tag, t: P.treasure });
  }
  for (const P of G.players) {
    const foe = G.players[1 - P.idx];
    const fv = foe.view;
    let liveMask = 0;
    for (const p of P.pieces) {
      const cells = E.cellsFor(p.shape, p.t, p.r0, p.c0, N);
      if (!cells || cells.join() !== p.cells.join() || E.maskOf(p.cells) !== p.mask) fail('piece-geom', { tag, p });
      if (!p.alive) continue;
      if (p.mask & liveMask) fail('overlap', { tag, p });
      liveMask |= p.mask;
      if ((p.hitMask & ~p.mask) !== 0) fail('hitmask', { tag, p });
      for (const c of p.cells) {
        const m = fv.marks[c];
        // 隠れているステルスのキューブ（v14）は、当たっても×に見える（見破られると STEALTH HIT に変わる）
        if (m && m.r === 'x' && !m.callable && !p.stealth) fail('unhittable', { tag, c: G.coord(c), piece: p.cells.map((x) => G.coord(x)), mark: m });
        if (fv.dead[c]) fail('dead-on-live', { tag, c });
        const hit = !!(p.hitMask & (1 << c));
        const hm = m && (m.r === 'o' || m.r === 'oo' || m.r === 'q');   // q＝Stealth hit（v13）
        if (hit !== !!hm && !(p.stealth && hit && m && m.r === 'x')) fail('hit-mark', { tag, c: G.coord(c), hit, m });
      }
    }
    for (let c = 0; c < G.NN; c++) {
      const m = fv.marks[c];
      if (!m || m.r === 'x') continue;
      const onLive = !!(liveMask & (1 << c));
      if (!onLive && !fv.dead[c]) fail('stray-hit', { tag, c: G.coord(c), m });
    }
  }
}

// 人間がやりそうな、ランダムだが有効なアイテムの使い方
function randomItem(G, pi, rng) {
  const keys = E.ITEM_KEYS.filter((k) => G.itemStatus(pi, k).usable);
  if (!keys.length) return false;
  const k = keys[Math.floor(rng() * keys.length)];
  const NN = G.NN, N = G.N, v = G.players[pi].view;
  const pickCell = (f) => { const cs = []; for (let c = 0; c < NN; c++) if (f(c)) cs.push(c); return cs.length ? cs[Math.floor(rng() * cs.length)] : null; };
  const hit = (c) => v.marks[c] && v.marks[c].r !== 'x' && !v.dead[c];
  let params = null;
  switch (k) {
    case 'cube': params = rng() < 0.5 ? { kind: 'cat', value: E.CATS[Math.floor(rng() * E.CATS.length)] } : { kind: 'size', value: 1 + Math.floor(rng() * 5) }; break;
    case 'number': case 'line': params = { line: rng() < 0.5 ? 'row' : 'col', index: Math.floor(rng() * N), cell: pickCell((c) => !v.dead[c]) }; break;
    case 'shape': case 'node': params = { cell: pickCell((c) => !v.dead[c]) }; break;
    case 'bazooka': params = { cell: rng() < 0.6 ? (pickCell(hit) ?? pickCell((c) => !v.dead[c])) : pickCell((c) => !v.dead[c]) }; break;
    case 'pair': {
      // 半分はヒットのマスを含める（推論に効く組）、半分は完全にランダム
      const a = rng() < 0.5 ? pickCell(hit) : pickCell((c) => !v.dead[c]);
      const b = pickCell((c) => !v.dead[c] && c !== a);
      params = { a, b }; break;
    }
    case 'warp': {
      const ps = G.living(pi); const p = ps[Math.floor(rng() * ps.length)];
      const opts = [];
      for (let t = 0; t < 8; t++) for (let r0 = 0; r0 < N; r0++) for (let c0 = 0; c0 < N; c0++) {
        const pr = { pieceId: p.id, t, r0, c0 };
        if (G.validateItem(pi, 'warp', pr).ok) opts.push(pr);
      }
      if (!opts.length) return false;
      params = opts[Math.floor(rng() * opts.length)];
      break;
    }
    case 'stealth': { const ps = G.living(pi).filter((p) => !p.stealth); if (!ps.length) return false; params = { pieceId: ps[Math.floor(rng() * ps.length)].id }; break; }
  }
  if (!params) return false;
  const r = G.useItem(pi, k, params);
  if (k === 'bazooka' && r.ok && r.hit) stats.splits = (stats.splits || 0) + 1;
  return r.ok;
}

const origUse = E.Game.prototype.useItem;
E.Game.prototype.useItem = function (pi, key, params) {
  if (key !== 'warp') return origUse.call(this, pi, key, params);
  const p = this.players[pi].pieces.find((x) => x.id === (params && params.pieceId));
  const before = p ? p.cells.slice() : null;
  const nEv = this.events.length, nLog = this.log.length;
  const r = origUse.call(this, pi, key, params);
  if (!r.ok) return r;
  stats.warps++;
  const ev = this.events.slice(nEv).find((e) => e.type === 'item' && e.key === 'warp');
  const lg = this.log[nLog];
  const fromTxt = E.coordList(before, this.N);
  if (!ev || ev.oldCells.join() !== before.join()) fail('warp-event', { before, ev });
  if (!lg || lg.text.indexOf(fromTxt) < 0) fail('warp-log', { fromTxt, text: lg && lg.text });
  if (p.cells.some((c) => before.indexOf(c) >= 0)) fail('warp-overlap', { before, after: p.cells });
  return r;
};

for (let gi = 0; gi < N_GAMES; gi++) {
  for (const rules of ['prelim', 'final']) {
    // 調べたい1試合だけ回す：INV_ONLY=<gi>:<rules>
    if (process.env.INV_ONLY && process.env.INV_ONLY !== gi + ':' + rules) continue;
    CUR = gi + ':' + rules;
    const rng = mulberry32(9100 + gi * 7 + (rules === 'final' ? 3 : 0));
    let G = new E.Game({ rules, rng, cpu: [true, true], wallet: 15 });
    AI.setup(G, 0); AI.setup(G, 1); G.finishSetup(0); G.finishSetup(1);
    while (G.phase === 'draft') { const pi = G.draftTurn(); G.draftPick(pi, AI.draftPick(G, pi)); }
    stats.games++;
    let guard = 0;
    // 片方はCPU、もう片方は「ランダムな人間」
    const human = gi % 2;
    while (G.phase === 'play' && guard++ < 600) {
      if (guard % 9 === 0) {
        const data = JSON.parse(JSON.stringify(Object.assign({}, G, { rng: undefined })));
        const g2 = Object.create(E.Game.prototype); Object.assign(g2, data); g2.rng = rng; G = g2; stats.roundtrips++;
      }
      const pi = G.cur;
      if (G.sub === 'sacrifice') { G.sacrifice(G.pending.who, AI.chooseSacrifice(G, G.pending.who)); check(G, 'sacrifice'); continue; }
      if (pi !== human) { AI.playTurn(G, pi); stats.actions++; check(G, 'cpu'); continue; }
      // ランダムな人間の手番
      if (G.sub === 'item' && rng() < 0.5) { randomItem(G, pi, rng); stats.actions++; check(G, 'h-item-pre'); if (G.phase !== 'play') break; }
      if (G.sub === 'item' || G.sub === 'call') {
        const cs = []; for (let c = 0; c < G.NN; c++) if (G.isCallable(pi, c)) cs.push(c);
        G.call(pi, cs[Math.floor(rng() * cs.length)]); stats.actions++; check(G, 'h-call');
        if (G.phase !== 'play') break;
      }
      if (G.sub === 'answer' && rng() < 0.15) {
        // ときどき当てずっぽうのアンサー（失敗→差し出し）
        const ps = G.living(1 - pi); const p = ps[Math.floor(rng() * ps.length)];
        const cells = rng() < 0.5 ? p.cells.slice() : p.cells.map((c) => (c + 1) % G.NN);
        G.answer(pi, cells); stats.actions++; check(G, 'h-answer');
        if (G.phase !== 'play') break;
        if (G.sub === 'sacrifice') continue;
      }
      if (G.sub === 'answer' && !G.itemUsed && rng() < 0.6) { randomItem(G, pi, rng); stats.actions++; check(G, 'h-item-post'); if (G.phase !== 'play') break; }
      if (G.sub === 'answer') G.endTurn(pi);
      if (G.sub === 'treasure') {
        const cs = []; for (let c = 0; c < G.NN; c++) if (G.isTreasureCallable(pi, c)) cs.push(c);
        G.treasureCall(pi, cs[Math.floor(rng() * cs.length)]);
      }
      check(G, 'h-end');
    }
    // リプレイ：記録した操作をやり直すと、最後まで同じ盤面になる（ワープ・バズーカ・アンサー失敗・途中の保存と読み込みも含めて）
    { const snap = (g) => { const o = Object.assign({}, g); delete o.actions; delete o.rng; delete o.initOpts; return JSON.stringify(o); };
      const rec = G.replayRecord();
      stats.replays = (stats.replays || 0) + 1;
      if (!rec || snap(E.replayGame(rec)) !== snap(G)) fail('replay-mismatch', { rules, gi }); }
  }
}
console.log(stats);
for (const f of fails) console.log(JSON.stringify(f).slice(0, 400));
process.exit(stats.fail ? 1 : 0);
