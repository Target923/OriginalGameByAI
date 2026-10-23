// リプレイの確認：記録した操作をやり直した盤面が、本物の試合と最後まで完全に同じになるか
//  単発の試合（予選・決勝）と大会（予選・決勝）を CPU どうしで回して比べる
// 使い方: node test/replay_check.js [単発の局数] [大会の数]
const E = require('../src/engine.js');
const AI = require('../src/ai.js');
const { Tour } = E;
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
const nGames = +(process.argv[2] || 200), nTours = +(process.argv[3] || 20);
const st = { games: 0, tours: 0, matches: 0, mismatch: 0, frames: 0, actions: 0, bytes: 0, warps: 0, splits: 0 };
const snap = (g) => { const o = Object.assign({}, g); delete o.actions; delete o.rng; delete o.initOpts; return JSON.stringify(o); };
function check(g, tag) {
  const rec = g.replayRecord();
  if (!rec) { st.mismatch++; console.log('NO RECORD', tag); return; }
  const r = E.replayGame(rec);
  if (snap(r) !== snap(g)) { st.mismatch++; if (st.mismatch < 5) console.log('MISMATCH', tag, rec.actions.length); }
  const { frames, final } = E.replayFrames(rec);
  if (snap(final) !== snap(g)) { st.mismatch++; console.log('FRAMES MISMATCH', tag); }
  // 場面ごとの盤面は、その数の操作をやり直した盤面と同じ
  const f = frames[Math.floor(frames.length / 2)];
  if (f && E.replayGame(rec, f.n).events.length !== f.ev) { st.mismatch++; console.log('FRAME EV MISMATCH', tag); }
  st.frames += frames.length; st.actions += rec.actions.length; st.bytes += JSON.stringify(rec).length; st.matches++;
  for (const e of g.events) { if (e.type === 'item' && e.key === 'warp') st.warps++; if (e.type === 'item' && e.key === 'bazooka' && e.hit) st.splits++; }
}
const rng = mulberry32(4242);
for (let i = 0; i < nGames; i++) {
  const rules = i % 3 === 2 ? 'final' : 'prelim';
  const g = new E.Game({ rules, rng, cpu: [true, true] });
  AI.autoMatch(g);
  check(g, rules + ' ' + i);
  st.games++;
}
for (let k = 0; k < nTours; k++) {
  const trng = mulberry32(9000 + k);
  const T = Tour.create({ rng: trng, cpu: [true, true, true, true] });
  for (let r = 0; r < 3; r++) {
    T.round = r;
    for (const [a, b] of T.rounds[r]) {
      const g = new E.Game(Object.assign(Tour.matchOpts(T, a, b, 'prelim', { setupPlan: [AI.tourSetupPlan(T, a, 'prelim'), AI.tourSetupPlan(T, b, 'prelim')], itemKeep: [AI.tourItemKeep(T, a, 'prelim'), AI.tourItemKeep(T, b, 'prelim')] }), { rng: trng }));
      AI.autoMatch(g);
      const res = Tour.apply(T, a, b, g, 'prelim');
      if (!res.replay || res.replay.actions.length !== g.actions.length) { st.mismatch++; console.log('TOUR RESULT HAS NO REPLAY'); }
      check(g, `tour ${k} r${r}`);
    }
  }
  const [f1, f2] = Tour.finalists(T);
  const g = new E.Game(Object.assign(Tour.matchOpts(T, f1, f2, 'final', { first: 0, setupPlan: [AI.tourSetupPlan(T, f1, 'final'), AI.tourSetupPlan(T, f2, 'final')] }), { rng: trng }));
  AI.autoMatch(g);
  Tour.apply(T, f1, f2, g, 'final');
  check(g, `tour ${k} final`);
  // 大会の記録（JSON）を通しても再現できる
  const T2 = JSON.parse(JSON.stringify(T));
  for (const res of T2.results) { const r2 = E.replayGame(res.replay); if (!r2.result || r2.result.winner !== (res.winner === res.a ? 0 : res.winner === res.b ? 1 : -1)) { st.mismatch++; console.log('TOUR JSON REPLAY WINNER MISMATCH'); } }
  st.tours++;
}
st.bytesPerMatch = Math.round(st.bytes / st.matches);
st.framesPerMatch = +(st.frames / st.matches).toFixed(1);
st.actionsPerMatch = +(st.actions / st.matches).toFixed(1);
console.log(st);
process.exit(st.mismatch ? 1 : 0);
