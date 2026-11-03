// クロスボム（v15.7）の検証：クロスボムを3つずつ持たせ、ワープも多めに持たせて CPU どうしで対戦する。
//  確かめること：
//   1. 十字（中心と上下左右）に全ブロックが収まる、生きていて隠れていないキューブだけが撃破される（ワープ待ちは逃げる）。なければ不発
//   2. CPU の推理が正しい（不発の十字の候補を消しても、本当の置き方はいつも候補にある。確かなアンサーは外れない）
//   3. リプレイで同じ盤面になる
//  使い方: node test/cross_check.js [試合数（既定60）]
const E = require('../src/engine.js');
const AI = require('../src/ai.js');
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
const N_GAMES = +(process.argv[2] || 60);
const st = { games: 0, uses: 0, miss: 0, kills: 0, escaped: 0, bad: 0, sound: 0, missing: 0, certainWrong: 0, replays: 0, replayBad: 0 };
const bads = [];
function bad(tag, info) { st.bad++; if (bads.length < 8) bads.push({ tag, info }); }
const origUse = E.Game.prototype.useItem;
E.Game.prototype.useItem = function (pi, key, params) {
  if (key !== 'cross' || !this.actions) return origUse.call(this, pi, key, params);
  const foe = this.players[1 - pi];
  const area = E.crossMask(params.cell, this.N);
  const exp = foe.pieces.filter((p) => p.alive && !p.stealth && (p.mask & ~area) === 0);
  const r = origUse.call(this, pi, key, params);
  if (r.ok) {
    st.uses++;
    if (!exp.length) { st.miss++; if (!r.miss) bad('should-miss', {}); }
    for (const p of exp) {
      if (p.warpPlan) bad('plan-left', {});
      if (p.alive) { st.escaped++; if ((p.mask & area) === p.mask && !p.cells.some((c) => !(area & (1 << c)))) bad('escape-not-moved', { cells: p.cells }); }
      else st.kills++;
    }
    for (const p of foe.pieces) if (p.alive && !p.stealth && exp.indexOf(p) < 0 && (p.mask & ~area) === 0) bad('left-inside', { cells: p.cells });
  }
  return r;
};
function sound(G, pi) {
  const me = G.players[pi], foe = G.players[1 - pi];
  const A = AI.analyze(me.kb, G.N, G.rng);
  st.sound++;
  A.ctx.groups.forEach((g, i) => {
    const p = G.pieceAt(foe.idx, g.c);
    if (!p) { bad('group-no-piece', { g: g.c }); return; }
    if (g.q && A.ctx.U.some((u) => u.t < g.t && (p.mask & (1 << u.c)))) return;
    const k = g.cands.findIndex((cd) => cd.mask === p.mask);
    if (k < 0) { st.missing++; bad('truth-missing', { g: g.c, cells: p.cells, miss: me.kb.crossMiss }); return; }
    if (A.joint.exact && !A.joint.inconsistent && A.joint.candW[i][k] <= 0) bad('truth-pruned', { g: g.c, cells: p.cells });
  });
  for (const ce of A.certain) if (!G.living(foe.idx).some((p) => p.mask === ce.cand.mask)) { st.certainWrong++; bad('certain-wrong', { cells: ce.cand.cells }); }
}
for (let gi = 0; gi < N_GAMES; gi++) {
  for (const rules of ['prelim', 'final']) {
    const rng = mulberry32(6100 + gi * 17 + (rules === 'final' ? 5 : 0));
    const inv = {}; for (const k of E.ITEM_KEYS) inv[k] = 1; inv.cross = 3; inv.warp = 2; inv.stealth = 2;
    const G = new E.Game({ rules, rng, cpu: [true, true], inventory: [inv, Object.assign({}, inv)] });
    // 小さいキューブの多い置き方（クロスボムが当たるように）
    const sizes = rules === 'prelim' ? [[2, 2, 3], [2, 3, 3], [2, 2, 4]] : [[2, 2, 3, 4], [2, 3, 3, 4], [2, 2, 3, 5]];
    for (const pi of [0, 1]) { G.randomSetup(pi, sizes[Math.floor(rng() * sizes.length)], rng); G.finishSetup(pi); }
    st.games++;
    let guard = 0;
    while (G.phase === 'play' && guard++ < 500) {
      AI.playTurn(G, G.cur);
      if (G.phase === 'play') { sound(G, 0); sound(G, 1); }
    }
    st.replays++;
    try {
      const g2 = E.replayGame(G.replayRecord());
      const sig = (g) => g.players.map((P) => P.pieces.map((p) => p.id + ':' + p.cells.join('.') + ':' + p.alive).join('|')).join('/');
      if (!g2 || sig(g2) !== sig(G)) { st.replayBad++; bad('replay', {}); }
    } catch (e) { st.replayBad++; bad('replay-error', { e: String(e) }); }
  }
}
console.log(st);
if (bads.length) console.log(JSON.stringify(bads, null, 1).slice(0, 3000));
process.exitCode = st.bad ? 1 : 0;
