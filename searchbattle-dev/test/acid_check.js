// アシッド（v15.8）の検証：アシッドを3つずつ持たせ、ワープも持たせて CPU どうしで対戦する。
//  確かめること：
//   1. 酸をかけたあと、その人の手番のはじめに自動でコールされ、手でのコールはない（手番のはじめから「アンサー」の段階）
//   2. 自動コールは、まずアシッドマーク、そのあと同じキューブの当たったブロックに隣り合うブロック（読み順）
//   3. キューブが撃破・ワープ・分解されたら酸はなくなる
//   4. CPU の推理が正しい・リプレイで同じ盤面になる
//  使い方: node test/acid_check.js [試合数（既定60）]
const E = require('../src/engine.js');
const AI = require('../src/ai.js');
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
const N_GAMES = +(process.argv[2] || 60);
const st = { games: 0, uses: 0, nd: 0, autoCalls: 0, dissolved: 0, washed: 0, bad: 0, sound: 0, missing: 0, certainWrong: 0, replays: 0, replayBad: 0 };
const bads = [];
function bad(tag, info) { st.bad++; if (bads.length < 8) bads.push({ tag, info }); }
const origTick = E.Game.prototype._acidTick;
E.Game.prototype._acidTick = function () {
  const me = this.players[this.cur], foe = this.players[1 - this.cur];
  const acid = me.acid ? Object.assign({}, me.acid) : null;
  const p = acid ? foe.pieces.find((x) => x.alive && x.acid) : null;
  const before = this.players[this.cur].kb.calls.length;
  const hitBefore = p ? p.hitMask : 0;
  const cellsBefore = p ? p.cells.slice() : [];   // 自動コールでワープが発動すると、キューブが動くので前の位置で比べる
  const maskBefore = p ? p.mask : 0;
  origTick.call(this);
  if (!acid || !this.actions) return;
  const calls = this.players[this.cur].kb.calls.slice(before);
  if (!p) { if (calls.length) bad('call-without-cube', {}); return; }
  if (!calls.length) { if (p.alive && p.hitMask !== p.mask && !p.stealth) bad('no-auto-call', { cells: p.cells, hit: p.hitMask }); return; }
  st.autoCalls++;
  const c = calls[0].c;
  const N = this.N;
  // 期待するブロック
  let exp = -1;
  if ((maskBefore & (1 << acid.cell)) && !(hitBefore & (1 << acid.cell))) exp = acid.cell;
  else for (const x of cellsBefore.slice().sort((a, b) => a - b)) { if (hitBefore & (1 << x)) continue; if (cellsBefore.some((y) => (hitBefore & (1 << y)) && Math.abs(Math.floor(x / N) - Math.floor(y / N)) + Math.abs(x % N - y % N) === 1)) { exp = x; break; } }
  // ランダム（v15.13 から既定。game.acidPick で切り替えられる）：アシッドマークのブロックのあとは、そのキューブのまだ当たっていないブロックのどれか
  const random = (this.acidPick || E.ACID_PICK) === 'random';
  if (random && exp !== acid.cell) { if (!cellsBefore.includes(c) || (hitBefore & (1 << c))) bad('wrong-cell', { c, cells: cellsBefore }); }
  else if (c !== exp) bad('wrong-cell', { c, exp, cells: cellsBefore });
  if (this.phase === 'play' && this.cur === this.players.indexOf(me) && this.sub !== 'answer' && this.sub !== 'sacrifice') bad('sub-after', { sub: this.sub });
  if (!p.alive) st.dissolved++;
  else if (p.warpTrig != null && !me.acid) st.washed++;
};
const origUse = E.Game.prototype.useItem;
E.Game.prototype.useItem = function (pi, key, params) {
  const r = origUse.call(this, pi, key, params);
  if (key === 'acid' && r.ok && this.actions) { st.uses++; if (r.nd) st.nd++; }
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
    const rng = mulberry32(8300 + gi * 19 + (rules === 'final' ? 3 : 0));
    const inv = {}; for (const k of E.ITEM_KEYS) inv[k] = 1; inv.acid = 3; inv.warp = 2;
    const G = new E.Game({ rules, rng, cpu: [true, true], inventory: [inv, Object.assign({}, inv)] });
    for (const pi of [0, 1]) { AI.setup(G, pi); G.finishSetup(pi); }
    st.games++;
    let guard = 0;
    while (G.phase === 'play' && guard++ < 500) {
      AI.playTurn(G, G.cur);
      if (G.phase === 'play') { sound(G, 0); sound(G, 1); }
    }
    if (G.phase !== 'over') bad('not-over', { sub: G.sub });
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
