// ワープ（v15）の検証：トリガーと移動先を決めておき、トリガーのコールかアンサーで当てられたときに移動する。
//  ワープが起きやすいように、キューブを少なめ（空きブロックが多い）に置き、使えるときはよくワープを使う。
//  確かめること：
//   1. 決めたとき：移動先は空きブロック（生きている・撃破済みのキューブ、自分の位置、ほかのワープ先と重ならない）、向きは回転だけ、トリガーは当たっていないブロック
//   2. トリガーのコール：移動前の当たっていたブロックだけが×（W付き）、当たっていないブロックには印がない、ほかの×はもう一度コールできる、
//      移動後のトリガーにあたるブロックにワープレティクル（ヒット1つ）
//   3. アンサーで当てたとき：撃破されずに移動し、宣言したブロックは×（W付き）、レティクルは出ない、手番は続く
//   4. キューブの形・向き・位置が一致し、重ならない。リプレイ（記録のやり直し）で同じ盤面になる
//   5. CPU の推理が正しい：本当の置き方がいつも候補にあり、確かなアンサーは外れない（ワープで逃げられるのは外れではない）
//  使い方: node test/warp_check.js [試合数（既定120）]
const E = require('../src/engine.js');
const AI = require('../src/ai.js');
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
const N_GAMES = +(process.argv[2] || 120);
const st = { games: 0, plans: 0, fireTrigger: 0, fireAnswer: 0, full: 0, late: 0, lateFirst: 0, bad: 0, sound: 0, certainWrong: 0, missing: 0, replays: 0, replayBad: 0 };
const bads = [];
function bad(tag, info) { st.bad++; if (bads.length < 8) bads.push({ tag, info }); }

function checkPlan(G, pi) {
  const P = G.players[pi];
  for (const p of P.pieces) {
    if (!p.alive || !p.warpPlan) continue;
    const w = p.warpPlan;
    if (!(p.mask & (1 << w.trigger)) || (p.hitMask & (1 << w.trigger))) bad('plan-trigger', { p: p.cells, w });
    if (w.mask & p.mask) bad('plan-self', { p: p.cells, w: w.cells });
    if (w.mask & G.livingMask(pi, p.id)) bad('plan-overlap', { w: w.cells });
    if (w.mask & G.deadMask(pi)) bad('plan-dead', { w: w.cells });
    for (const q of P.pieces) if (q !== p && q.alive && q.warpPlan && (q.warpPlan.mask & w.mask)) bad('plan-plan', { a: w.cells, b: q.warpPlan.cells });
    if (!E.rotationOf(p.shape, p.t, w.t)) bad('plan-flip', { shape: p.shape, from: p.t, to: w.t });
    if (p.stealth) bad('plan-stealth', {});
  }
}
function checkPieces(G) {
  for (const P of G.players) {
    let live = 0;
    for (const p of P.pieces) {
      const cells = E.cellsFor(p.shape, p.t, p.r0, p.c0, G.N);
      if (!cells || cells.join() !== p.cells.join() || E.maskOf(p.cells) !== p.mask) bad('geom', { p });
      if (!p.alive) continue;
      if (p.mask & live) bad('overlap', { p: p.cells });
      live |= p.mask;
      // 生きているキューブのブロックに、もうコールできない×があってはいけない（当てられなくなる）
      const fv = G.players[1 - P.idx].view;
      for (const c of p.cells) { const m = fv.marks[c]; if (m && m.r === 'x' && !m.callable && !p.stealth) bad('unhittable', { c, m }); }
    }
  }
}
function sound(G, pi) {
  const me = G.players[pi], foe = G.players[1 - pi];
  const A = AI.analyze(me.kb, G.N, G.rng);
  st.sound++;
  A.ctx.groups.forEach((g, i) => {
    const p = G.pieceAt(foe.idx, g.c);
    if (!p) { bad('group-no-piece', { g }); return; }
    if (g.q && A.ctx.U.some((u) => u.t < g.t && (p.mask & (1 << u.c)))) return;
    const k = g.cands.findIndex((cd) => cd.mask === p.mask);
    if (k < 0) { st.missing++; if (process.env.WDBG && st.missing === 1) console.log(JSON.stringify({ g: { c: g.c, t: g.t, wp: !!g.wp }, truth: p.cells, cands: g.cands.map((x) => x.cells.join(',')), calls: me.kb.calls, warps: me.kb.warps, deads: me.kb.deads.map((d) => ({ t: d.t, cells: d.cells })), occs: me.kb.occs, empties: me.kb.empties, pairs: me.kb.pairs, N: G.N })); bad('truth-missing', { g: { c: g.c, wp: !!g.wp }, cells: p.cells }); return; }
    if (A.joint.exact && !A.joint.inconsistent && A.joint.candW[i][k] <= 0) bad('truth-pruned', { g: { c: g.c, wp: !!g.wp }, cells: p.cells });
  });
  for (const ce of A.certain) if (!G.living(foe.idx).some((p) => p.mask === ce.cand.mask)) { st.certainWrong++; bad('certain-wrong', { cells: ce.cand.cells }); }
}

// 発動を見張る：トリガーのコールとアンサーの前後で盤を比べる
const origCall = E.Game.prototype.call, origAnswer = E.Game.prototype.answer;
E.Game.prototype.call = function (pi, c) {
  const foe = this.players[1 - pi];
  const p = this.pieceAt(foe.idx, c);
  const armed = p && p.warpPlan && p.warpPlan.trigger === c ? { p, plan: Object.assign({}, p.warpPlan), cells: p.cells.slice(), cellsMask: p.mask, hit: p.hitMask | (1 << c) } : null;
  const xBefore = [];
  if (armed) for (let k = 0; k < this.NN; k++) { const m = this.players[pi].view.marks[k]; if (m && m.r === 'x') xBefore.push(k); }
  // v15.2：アンサーで逃げたキューブの、移動先のトリガーにあたるブロック（隠れたレティクル）
  const late = p && p.warpHidden && p.warpTrig === c && !p.stealth && !p.stealthRevealed && !armed ? { first: p.hitMask === 0 } : null;
  const logN = this.log.length;
  const r = origCall.call(this, pi, c);
  if (late && r.ok) {
    st.late++; if (late.first) st.lateFirst++;
    const m = this.players[pi].view.marks[c];
    if (!(m && m.r === 'wp') || !r.late) bad('late-mark', { c, m, r });
    const k = this.players[pi].kb.calls[this.players[pi].kb.calls.length - 1];
    if (k.r !== (late.first ? 'wp' : 'o')) bad('late-kb', { k });
    if (late.first && !this.players[pi].kb.warps.some((w) => w.reticle === c && w.reticleT === k.t)) bad('late-link', {});
  }
  if (armed && r.ok) {
    // v15.2：トリガーが最後に残ったブロックなら「自動撃破後、ワープ発動」（通知・ログ・推論の記録）
    const full = armed.hit === armed.p.mask || (armed.hit & armed.cellsMask) === armed.cellsMask;
    if (full) {
      st.full++;
      if (!r.full) bad('full-flag', { r });
      if (!this.log.slice(logN).some((e) => /自動撃破後、ワープ発動/.test(e.text))) bad('full-log', {});
      const w = this.players[pi].kb.warps[this.players[pi].kb.warps.length - 1];
      if (!w.full) bad('full-kb', {});
    } else if (r.full) bad('full-wrong', {});
    st.fireTrigger++;
    const v = this.players[pi].view, p2 = armed.p;
    if (r.r !== 'wp') bad('trigger-result', { r });
    if (p2.cells.join() !== armed.plan.cells.join()) bad('trigger-move', { to: p2.cells, plan: armed.plan.cells });
    for (const k of armed.cells) {
      const m = v.marks[k];
      const wasHit = !!(armed.hit & (1 << k));
      if (wasHit && !(m && m.r === 'x' && m.warp && !m.callable)) bad('trigger-oldhit', { k, m });
      if (!wasHit && m && !(m.r === 'x')) bad('trigger-oldopen', { k, m });
    }
    const ret = p2.cells[armed.cells.indexOf(c)];
    // 前の×はもう一度コールできる（移動後のレティクルのブロックは除く。レティクルが上書きする）
    for (const k of xBefore) if (armed.cells.indexOf(k) < 0 && k !== ret && !(v.marks[k] && v.marks[k].callable)) bad('trigger-xcallable', { k });
    if (p2.alive && !(v.marks[ret] && v.marks[ret].r === 'wp')) bad('trigger-reticle', { ret, m: v.marks[ret] });
    if (p2.alive && p2.hitMask !== (1 << ret)) bad('trigger-hitmask', { hit: p2.hitMask });
  }
  return r;
};
E.Game.prototype.answer = function (pi, cells) {
  const foe = this.players[1 - pi];
  const mask = E.maskOf(cells);
  const tgt = foe.pieces.find((p) => p.alive && p.mask === mask);
  const armed = tgt && tgt.warpPlan ? { p: tgt, plan: Object.assign({}, tgt.warpPlan), cells: tgt.cells.slice() } : null;
  const r = origAnswer.call(this, pi, cells);
  if (armed && r.ok) {
    st.fireAnswer++;
    const v = this.players[pi].view;
    if (!r.escaped || !armed.p.alive) bad('answer-escape', { r });
    if (armed.p.cells.join() !== armed.plan.cells.join()) bad('answer-move', {});
    for (const k of armed.cells) { const m = v.marks[k]; if (!(m && m.r === 'x' && m.warp)) bad('answer-old', { k, m }); }
    for (const k of armed.p.cells) if (v.marks[k] && v.marks[k].r === 'wp') bad('answer-reticle', { k });
    if (this.sub !== 'answer') bad('answer-turn', { sub: this.sub });
  }
  return r;
};

for (let gi = 0; gi < N_GAMES; gi++) {
  for (const rules of ['prelim', 'final']) {
    const rng = mulberry32(9100 + gi * 7 + (rules === 'final' ? 3 : 0));
    // アイテムは全種類（ワープだけ3つ）。記録（リプレイ）に残るよう、はじめの設定で渡す
    const inv = {}; for (const k of E.ITEM_KEYS) inv[k] = 1; inv.warp = 3;
    const G = new E.Game({ rules, rng, cpu: [true, true], inventory: [inv, Object.assign({}, inv)] });
    // 空きブロックが多い置き方（ワープの移動先があるように）
    const sizes = rules === 'prelim' ? [[3, 4], [2, 3, 3], [4, 4], [2, 3, 4]] : [[3, 4, 4], [3, 3, 4, 5], [2, 4, 5], [3, 4]];
    for (const pi of [0, 1]) { G.randomSetup(pi, sizes[Math.floor(rng() * sizes.length)], rng); G.finishSetup(pi); }
    while (G.phase === 'draft') { const pi = G.draftTurn(); G.draftPick(pi, AI.draftPick(G, pi)); }
    st.games++;
    let guard = 0;
    while (G.phase === 'play' && guard++ < 500) {
      const pi = G.cur;
      // 使えるときはよくワープを使う（ランダムなキューブ・トリガー・移動先）
      if (G.sub === 'item' && G.itemStatus(pi, 'warp').usable && rng() < 0.5) {
        const ps = G.warpable(pi);
        if (ps.length) {
          const p = ps[Math.floor(rng() * ps.length)];
          const open = p.cells.filter((c) => !(p.hitMask & (1 << c)));
          const opts = G.warpOptions(pi, p);
          const o = opts[Math.floor(rng() * opts.length)];
          const r = G.useItem(pi, 'warp', { pieceId: p.id, cell: open[Math.floor(rng() * open.length)], t: o.t, r0: o.r0, c0: o.c0 });
          if (!r.ok) bad('use-failed', { r }); else st.plans++;
          checkPlan(G, pi);
        }
      }
      AI.playTurn(G, G.cur);
      checkPieces(G);
      checkPlan(G, 0); checkPlan(G, 1);
      if (G.phase === 'play') { sound(G, 0); sound(G, 1); }
    }
    // リプレイ：記録をやり直して、最後の盤面が同じになるか
    if (G.replayRecord) {
      st.replays++;
      try {
        const g2 = E.replayGame(G.replayRecord());
        const sig = (g) => g.players.map((P) => P.pieces.map((p) => p.id + ':' + p.cells.join('.') + ':' + p.alive).join('|')).join('/');
        if (!g2 || sig(g2) !== sig(G)) { st.replayBad++; bad('replay', {}); }
      } catch (e) { st.replayBad++; bad('replay-error', { e: String(e) }); }
    }
  }
}
console.log(st);
if (bads.length) console.log(JSON.stringify(bads, null, 1).slice(0, 4000));
process.exitCode = st.bad ? 1 : 0;
