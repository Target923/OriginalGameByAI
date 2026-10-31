// ステルスの見破り（v15.1）の検証：ステルスを複数使ったとき、見破られるのはそのキューブだけ（ほかのステルスは隠れたまま）。
//  ステルスが重なりやすいように、ステルスを3つずつ持たせ、使えるときはよく使う（ランダムなキューブ・トリガー）。
//  確かめること：
//   1. トリガーのコール：見破られるのは、トリガーのキューブだけ
//   2. 隠れたキューブをぴったりアンサー：そのキューブだけ撃破され、ほかのステルスは隠れたまま
//   3. ステルスアンサー：見破られるのは、宣言したブロックを含むステルスのキューブだけ
//   4. CPU の推理が正しい：本当の置き方がいつも候補にあり、確かなアンサーは外れない。リプレイで同じ盤面になる
//  使い方: node test/stealth_check.js [試合数（既定120）]
const E = require('../src/engine.js');
const AI = require('../src/ai.js');
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
const N_GAMES = +(process.argv[2] || 120);
const st = { games: 0, uses: 0, multi: 0, byTrigger: 0, byExact: 0, byStealthAnswer: 0, keptHidden: 0, bad: 0, sound: 0, missing: 0, certainWrong: 0, replays: 0, replayBad: 0 };
const bads = [];
function bad(tag, info) { st.bad++; if (bads.length < 8) bads.push({ tag, info }); }

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

// 見破りを見張る：コール・アンサーの前に隠れていたキューブと、あとで隠れているキューブを比べる
const hiddenOf = (P) => P.pieces.filter((p) => p.alive && p.stealth);
const origCall = E.Game.prototype.call, origAnswer = E.Game.prototype.answer;
E.Game.prototype.call = function (pi, c) {
  const foe = this.players[1 - pi];
  const before = hiddenOf(foe);
  const p = this.pieceAt(foe.idx, c);
  const trig = p && p.stealth && p.stealthTrigger === c ? p : null;
  const r = origCall.call(this, pi, c);
  if (r.ok && before.length) {
    const gone = before.filter((q) => q.stealth !== true);
    const expect = trig ? [trig] : [];
    if (gone.length !== expect.length || gone.some((q) => expect.indexOf(q) < 0)) bad('call-reveal', { c, gone: gone.map((q) => q.cells), expect: expect.map((q) => q.cells) });
    if (trig) { st.byTrigger++; if (before.length > 1) st.keptHidden += before.length - 1; }
  }
  return r;
};
E.Game.prototype.answer = function (pi, cells) {
  const foe = this.players[1 - pi];
  const before = hiddenOf(foe);
  const mask = E.maskOf(cells);
  const exact = before.find((q) => q.mask === mask);
  const r = origAnswer.call(this, pi, cells);
  if (r.ok && before.length) {
    const gone = before.filter((q) => q.stealth !== true);
    let expect = [];
    if (exact) { expect = [exact]; st.byExact++; }
    else if (r.stealth) { expect = before.filter((q) => q.mask & mask); st.byStealthAnswer++; }
    if (gone.length !== expect.length || gone.some((q) => expect.indexOf(q) < 0)) bad('answer-reveal', { cells, stealth: !!r.stealth, gone: gone.map((q) => q.cells), expect: expect.map((q) => q.cells) });
    if (expect.length) st.keptHidden += before.length - expect.length;
  }
  return r;
};

for (let gi = 0; gi < N_GAMES; gi++) {
  for (const rules of ['prelim', 'final']) {
    const rng = mulberry32(7300 + gi * 11 + (rules === 'final' ? 5 : 0));
    const inv = {}; for (const k of E.ITEM_KEYS) inv[k] = 1; inv.stealth = 3;
    const G = new E.Game({ rules, rng, cpu: [true, true], inventory: [inv, Object.assign({}, inv)] });
    const sizes = rules === 'prelim' ? [[2, 3, 4], [2, 2, 3, 3], [3, 3, 4]] : [[2, 3, 4, 5], [3, 3, 4, 4], [2, 2, 3, 4, 5]];
    for (const pi of [0, 1]) { G.randomSetup(pi, sizes[Math.floor(rng() * sizes.length)], rng); G.finishSetup(pi); }
    while (G.phase === 'draft') { const pi = G.draftTurn(); G.draftPick(pi, AI.draftPick(G, pi)); }
    st.games++;
    let guard = 0;
    while (G.phase === 'play' && guard++ < 500) {
      const pi = G.cur;
      // 使えるときはよくステルスを使う（隠れていない・ワープを決めていないキューブの、まだ当たっていないブロックをトリガーに）
      if (G.sub === 'item' && G.itemStatus(pi, 'stealth').usable && rng() < 0.6) {
        const ps = G.players[pi].pieces.filter((p) => p.alive && !p.stealth && !p.stealthRevealed && !p.warpPlan && p.cells.some((c) => !(p.hitMask & (1 << c))));
        if (ps.length) {
          const p = ps[Math.floor(rng() * ps.length)];
          const open = p.cells.filter((c) => !(p.hitMask & (1 << c)));
          const r = G.useItem(pi, 'stealth', { pieceId: p.id, cell: open[Math.floor(rng() * open.length)] });
          if (r.ok) { st.uses++; if (hiddenOf(G.players[pi]).length > 1) st.multi++; }
        }
      }
      AI.playTurn(G, G.cur);
      if (G.phase === 'play') { sound(G, 0); sound(G, 1); }
    }
    if (G.replayRecord) {
      st.replays++;
      try {
        const g2 = E.replayGame(G.replayRecord());
        const sig = (g) => g.players.map((P) => P.pieces.map((p) => p.id + ':' + p.cells.join('.') + ':' + p.alive + ':' + !!p.stealth).join('|')).join('/');
        if (!g2 || sig(g2) !== sig(G)) { st.replayBad++; bad('replay', {}); }
      } catch (e) { st.replayBad++; bad('replay-error', { e: String(e) }); }
    }
  }
}
console.log(st);
if (bads.length) console.log(JSON.stringify(bads, null, 1).slice(0, 4000));
process.exitCode = st.bad ? 1 : 0;
