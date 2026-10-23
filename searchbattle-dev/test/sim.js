// CPU同士・CPU対ベースラインの自動対戦
const E = require('../src/engine.js');
const AI = require('../src/ai.js');

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}

// ベースライン：ヒットの周囲を優先して撃つだけ（アイテム・アンサーなし）
function baselineTurn(G, pi) {
  const me = G.players[pi], N = G.N;
  const cells = [...Array(G.NN).keys()].filter(c => G.isCallable(pi, c));
  const hits = [...Array(G.NN).keys()].filter(c => me.view.marks[c] && me.view.marks[c].r !== 'x' && !me.view.dead[c]);
  let pick = null;
  for (const h of hits) { const r=Math.floor(h/N), c=h%N; for (const [x,y] of [[r-1,c],[r+1,c],[r,c-1],[r,c+1]]) { if (x>=0&&y>=0&&x<N&&y<N && G.isCallable(pi,x*N+y)) { pick = x*N+y; break; } } if (pick!=null) break; }
  if (pick == null) pick = cells[Math.floor(G.rng()*cells.length)];
  G.call(pi, pick);
  if (G.phase !== 'play') return;
  G.endTurn(pi);
  if (G.sub === 'treasure') { const cs=[...Array(G.NN).keys()].filter(c=>G.isTreasureCallable(pi,c)); G.treasureCall(pi, cs[Math.floor(G.rng()*cs.length)]); }
}

function run(rules, nGames, seed, mode) {
  const rng = mulberry32(seed);
  const st = { games:0, wins:[0,0], draws:0, turns:0, answers:0, answerFail:0, items:{}, maxMs:0, totMs:0, decisions:0, errors:0, pts:[0,0] };
  for (let g = 0; g < nGames; g++) {
    const G = new E.Game({ rules, rng, cpu:[true,true], names:['A','B'] });
    AI.setup(G, 0);
    if (mode === 'cpu') AI.setup(G, 1); else G.randomSetup(1, null, rng);
    G.finishSetup(0); G.finishSetup(1);
    while (G.phase === 'draft') { const pi = G.draftTurn(); G.draftPick(pi, AI.draftPick(G, pi)); }
    let guard = 0;
    while (G.phase === 'play' && guard++ < 400) {
      const pi = G.cur;
      if (pi === 1 && mode === 'base') { baselineTurn(G, pi); continue; }
      const t0 = Date.now();
      try {
        AI.playTurn(G, pi, (s) => {
          if (s.kind === 'answer') { st.answers++; if (!s.r.success) { st.answerFail++; } }
          if (s.kind === 'item' && s.r.ok) st.items[s.it.key] = (st.items[s.it.key]||0) + 1;
          if (s.kind === 'item' && !s.r.ok) { st.errors++; console.log('item rejected', s.it, s.r.reason); }
        });
      } catch (e) { st.errors++; console.log('EXC', e.stack); break; }
      const dt = Date.now() - t0; st.maxMs = Math.max(st.maxMs, dt); st.totMs += dt; st.decisions++;
    }
    if (G.phase !== 'over') { st.errors++; console.log('not finished', G.turn, G.sub); continue; }
    st.games++; st.turns += G.turn;
    if (G.result.draw) st.draws++; else st.wins[G.result.winner]++;
    st.pts[0] += G.players[0].score.total; st.pts[1] += G.players[1].score.total;
  }
  st.avgTurns = (st.turns / st.games).toFixed(2);
  st.avgMs = (st.totMs / st.decisions).toFixed(1);
  st.avgPts = st.pts.map(p => (p/st.games).toFixed(1));
  delete st.turns; delete st.totMs; delete st.pts;
  return st;
}
const args = process.argv.slice(2);
const n = +args[0] || 60;
for (const rules of ['prelim','final']) {
  console.log(rules, 'AI vs baseline', JSON.stringify(run(rules, n, 7, 'base')));
  console.log(rules, 'AI vs AI      ', JSON.stringify(run(rules, n, 11, 'cpu')));
}
