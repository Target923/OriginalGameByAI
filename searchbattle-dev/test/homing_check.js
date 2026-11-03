// ホーミングミサイル（v15.5）の検証：ホーミングミサイルを3つずつ持たせ、CPU どうしで対戦する。
//  確かめること：
//   1. 合計は、そのとき生きていて隠れていない相手のキューブ（バズーカの破片も）のどれかのブロックの番号（読み順 1〜NN）の合計
//      隠れていないキューブがなければ NoData
//   2. CPU の推理が正しい（本当の置き方がいつも候補にあり、確かなアンサーは外れない）
//   3. リプレイ（記録のやり直し）で同じ盤面・同じ合計になる（ランダムに選んだキューブを記録している）
//  使い方: node test/homing_check.js [試合数（既定80）]
const E = require('../src/engine.js');
const AI = require('../src/ai.js');
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
const N_GAMES = +(process.argv[2] || 80);
const st = { games: 0, uses: 0, nd: 0, bad: 0, sound: 0, missing: 0, certainWrong: 0, replays: 0, replayBad: 0, wins: [0, 0] };
const bads = [];
function bad(tag, info) { st.bad++; if (bads.length < 8) bads.push({ tag, info }); }
const sumOf = (cells) => cells.reduce((a, c) => a + c + 1, 0);
const origUse = E.Game.prototype.useItem;
E.Game.prototype.useItem = function (pi, key, params) {
  if (key !== 'homing') return origUse.call(this, pi, key, params);
  const foe = this.players[1 - pi];
  const vis = foe.pieces.filter((p) => p.alive && !p.stealth).map((p) => sumOf(p.cells));
  const before = foe.pieces.filter((p) => p.alive && !p.stealth && !p.homed).map((p) => p.id);
  const r = origUse.call(this, pi, key, params);
  if (r.ok && this.actions) {
    st.uses++;
    // v15.6：一通り狙うまで同じキューブを選ばない（まだ狙っていないキューブがあれば、その中から）
    const last = this.actions[this.actions.length - 1];
    const tid = last && last[3] && last[3].target;
    if (tid != null && before.length && before.indexOf(tid) < 0) bad('repeat-target', { tid, before });
    if (tid != null && !before.length) st.resets = (st.resets || 0) + 1;
    if (r.nd) { st.nd++; if (vis.length) bad('nd-but-visible', { vis }); }
    else if (vis.indexOf(r.sum) < 0) bad('sum-not-a-cube', { sum: r.sum, vis });
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
    if (k < 0) { st.missing++; bad('truth-missing', { g: g.c, cells: p.cells }); return; }
    if (A.joint.exact && !A.joint.inconsistent && A.joint.candW[i][k] <= 0) bad('truth-pruned', { g: g.c, cells: p.cells });
  });
  for (const ce of A.certain) if (!G.living(foe.idx).some((p) => p.mask === ce.cand.mask)) { st.certainWrong++; bad('certain-wrong', { cells: ce.cand.cells }); }
}
for (let gi = 0; gi < N_GAMES; gi++) {
  for (const rules of ['prelim', 'final']) {
    const rng = mulberry32(5100 + gi * 13 + (rules === 'final' ? 7 : 0));
    const inv = {}; for (const k of E.ITEM_KEYS) inv[k] = 1; inv.homing = 3;
    const G = new E.Game({ rules, rng, cpu: [true, true], inventory: [inv, Object.assign({}, inv)] });
    for (const pi of [0, 1]) { AI.setup(G, pi); G.finishSetup(pi); }
    st.games++;
    let guard = 0;
    while (G.phase === 'play' && guard++ < 500) {
      AI.playTurn(G, G.cur);
      if (G.phase === 'play') { sound(G, 0); sound(G, 1); }
    }
    if (G.result) st.wins[G.result.winner]++;
    st.replays++;
    try {
      const g2 = E.replayGame(G.replayRecord());
      const sig = (g) => g.players.map((P) => P.pieces.map((p) => p.id + ':' + p.cells.join('.') + ':' + p.alive).join('|') + '#' + (P.kb.sums || []).map((q) => q.nd ? 'nd' : q.sum).join(',')).join('/');
      if (!g2 || sig(g2) !== sig(G)) { st.replayBad++; bad('replay', { a: sig(G).slice(0, 200), b: g2 && sig(g2).slice(0, 200) }); }
    } catch (e) { st.replayBad++; bad('replay-error', { e: String(e) }); }
  }
}
console.log(st);
if (bads.length) console.log(JSON.stringify(bads, null, 1).slice(0, 3000));
process.exitCode = st.bad ? 1 : 0;
