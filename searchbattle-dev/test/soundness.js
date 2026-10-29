// 毎手番ごとに「真の配置が推論の候補に含まれているか」を検証する
const E = require('../src/engine.js');
const AI = require('../src/ai.js');
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
const n = +process.argv[2] || 100;
let checks=0, bad=0, inconsistent=0, aborted=0, certainChecks=0, certainBad=0, fragChecks=0, splits=0;
function verify(G, pi) {
  const me = G.players[pi], foe = G.players[1-pi];
  const A = AI.analyze(me.kb, G.N, G.rng);
  if (A.joint.inconsistent) { inconsistent++; console.log('INCONSISTENT joint', G.rules.kind, 'turn', G.turn); }
  if (!A.joint.exact) aborted++;
  A.ctx.groups.forEach((g, i) => {
    checks++;
    const p = G.pieceAt(foe.idx, g.c);
    if (!p) { bad++; console.log('group cell has no living piece!', g); return; }
    // Stealth hit（v13）のグループ：その個体にそれより前のヒットがあれば、本当は○（merge）。merge の候補があればよい
    if (g.q && A.ctx.U.some((u) => u.t < g.t && (p.mask & (1 << u.c)))) { if (!g.cands.some((cd) => cd.merge)) { bad++; console.log('MERGE MISSING', G.turn); } return; }
    const k = g.cands.findIndex(cd => cd.mask === p.mask);
    if (k < 0) { bad++; console.log('TRUE PLACEMENT MISSING', G.rules.kind, 'turn', G.turn, 'group', g, 'truth', p.shape, p.cells, 'cands', g.cands.length); return; }
    if (A.joint.exact && !A.joint.inconsistent && A.joint.candW[i][k] <= 0) { bad++; console.log('TRUE PLACEMENT PRUNED BY JOINT', G.turn, g, p.shape); }
  });
  for (const ce of A.certain) { certainChecks++; if (ce.gi < 0) fragChecks++; if (!G.living(foe.idx).some((p) => p.mask === ce.cand.mask)) { certainBad++; console.log('CERTAIN WRONG', G.rules.kind, 'turn', G.turn, ce.cand.cells, ce.gi < 0 ? '(1マスキューブ)' : ''); } }
}
for (let gi = 0; gi < n; gi++) {
  for (const rules of ['prelim','final']) {
    const rng = mulberry32(1000 + gi);
    // 分解（バズーカ）の後の推論も確かめるため、奇数番目の対戦はバズーカを積極的に使う方針にする
    const bz = gi % 2 === 1 ? { bazooka: 'eh', bzMin: 1.5 } : {};
    AI.policy[0] = bz; AI.policy[1] = bz;
    // 3番目ごとに、大会のCPUのような厚い盤面（個体をくっつけて多く置く）にする
    const dense = gi % 3 === 2 ? (rules === 'prelim' ? { sizes: [3, 3, 4, 4], layout: 'cluster' } : { sizes: [2, 3, 3, 4, 4, 5], layout: 'cluster' }) : null;
    const G = new E.Game({ rules, rng, cpu:[true,true], setupPlan: dense ? [dense, dense] : null });
    AI.setup(G, 0); AI.setup(G, 1); G.finishSetup(0); G.finishSetup(1);
    while (G.phase === 'draft') { const pi = G.draftTurn(); G.draftPick(pi, AI.draftPick(G, pi)); }
    let guard = 0;
    while (G.phase === 'play' && guard++ < 400) {
      const pi = G.cur;
      AI.playTurn(G, pi, () => { if (G.phase==='play') { verify(G, 0); verify(G, 1); } });
    }
    splits += G.players[0].kb.splits.length + G.players[1].kb.splits.length;
  }
}
console.log({checks, bad, inconsistent, aborted, certainChecks, certainBad, fragChecks, splits});
