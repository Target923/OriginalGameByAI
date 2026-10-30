// CPU の方針どうしの対戦（CPUどうし・1試合ずつ）：方針 A（JSON）と方針 B（JSON）を戦わせて、A の勝率とアイテムの使用回数を出す
// 盤面は大会と同じ置き方。アイテムは両者とも全種類。席は1試合ごとに入れ替える。
// 使い方: node tools/policy_duel.js <prelim|final> <試合数> <seed> '<A の方針 JSON>' '<B の方針 JSON>'
//   例: node tools/policy_duel.js prelim 800 1 '{}' '{"bzFrag":false,"bzFacts":false}'
const path = require('path');
const SRC = process.env.SB_SRC || path.join(__dirname, '..', 'src');
const E = require(path.join(SRC, 'engine.js'));
const AI = require(path.join(SRC, 'ai.js'));
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
const [rules, nStr, seedStr, aStr, bStr] = process.argv.slice(2);
const A = JSON.parse(aStr || '{}'), B = JSON.parse(bStr || '{}');
const n = +nStr || 100, rng = mulberry32(+seedStr || 1);
let wins = 0, draws = 0, games = 0, turns = 0;
const usedA = {}, usedB = {};
const t0 = Date.now();
for (let g = 0; g < n; g++) {
  const T = E.Tour.create({ rng, cpu: [true, true, true, true] });
  T.round = 0;
  const G = new E.Game({ rules, rng, cpu: [true, true], setupPlan: [AI.tourSetupPlan(T, 0, rules), AI.tourSetupPlan(T, 1, rules)] });
  G.rules.draft = false;
  const a = g % 2;
  AI.policy[a] = Object.assign({}, A); AI.policy[1 - a] = Object.assign({}, B);
  AI.setup(G, 0); AI.setup(G, 1); G.finishSetup(0); G.finishSetup(1);
  let guard = 0;
  while (G.phase === 'play' && guard++ < 400) AI.playTurn(G, G.cur);
  if (G.phase !== 'over') continue;
  games++; turns += G.turn;
  for (const e of G.log) if (e.kind === 'item' && e.key) { const u = e.actor === a ? usedA : usedB; u[e.key] = (u[e.key] || 0) + 1; }
  if (G.result.draw) draws++; else if (G.result.winner === a) wins++;
}
AI.policy[0] = {}; AI.policy[1] = {};
const per = (u) => Object.fromEntries(Object.entries(u).map(([k, v]) => [k, +(v / games).toFixed(2)]));
console.log(JSON.stringify({ rules, A, B, games, winPctA: +(100 * (wins + draws / 2) / games).toFixed(1), se: +(100 * Math.sqrt(0.25 / games)).toFixed(1), avgTurns: +(turns / games).toFixed(1), bazookaA: per(usedA).bazooka || 0, bazookaB: per(usedB).bazooka || 0, sec: Math.round((Date.now() - t0) / 1000) }));
