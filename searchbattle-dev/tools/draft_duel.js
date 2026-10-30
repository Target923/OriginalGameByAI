// ドラフトの優先順位どうしの対戦（CPUどうし・決勝5×5・1試合ずつ）
//  大会の決勝と同じく、両者とも手持ち0からドラフトで4つずつ取って戦う（トゥエ・モース順、後攻から）。
//  A の順と B の順で取り、ほかの考え方は同じ。席は1試合ごとに入れ替える（先攻・後攻も入れ替わる）。
// 使い方: node tools/draft_duel.js <試合数> <seed> '<A の順 JSON 配列>' '<B の順 JSON 配列>'
//   例: node tools/draft_duel.js 200 1 '["number","shape",...]' '["warp","number",...]'
// 結果: winPctA＝A の勝率、se＝誤差の目安、picksA／picksB＝それぞれが取ったアイテムの1試合あたりの数
const path = require('path');
const SRC = process.env.SB_SRC || path.join(__dirname, '..', 'src');
const E = require(path.join(SRC, 'engine.js'));
const AI = require(path.join(SRC, 'ai.js'));
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
const [nStr, seedStr, aStr, bStr] = process.argv.slice(2);
const A = JSON.parse(aStr), B = JSON.parse(bStr);
const n = +nStr || 100, rng = mulberry32(+seedStr || 1);
let wins = 0, draws = 0, games = 0;
const pickA = {}, pickB = {};
const t0 = Date.now();
for (let g = 0; g < n; g++) {
  const T = E.Tour.create({ rng, cpu: [true, true, true, true] });
  T.round = 0;
  // draftEach 4＝大会の決勝と同じドラフト（手持ち0から4つずつ）
  const G = new E.Game({ rules: 'final', rng, cpu: [true, true], draftEach: 4, setupPlan: [AI.tourSetupPlan(T, 0, 'final'), AI.tourSetupPlan(T, 1, 'final')] });
  const a = g % 2;
  AI.policy[a] = { draft: A }; AI.policy[1 - a] = { draft: B };
  AI.autoMatch(G);
  if (G.phase !== 'over') continue;
  games++;
  for (const pi of [0, 1]) for (const k of G.draft.picks[pi]) { const u = pi === a ? pickA : pickB; u[k] = (u[k] || 0) + 1; }
  if (G.result.draw) draws++; else if (G.result.winner === a) wins++;
}
AI.policy[0] = {}; AI.policy[1] = {};
const per = (u) => Object.fromEntries(Object.entries(u).map(([k, v]) => [k, +(v / games).toFixed(2)]));
console.log(JSON.stringify({ games, winPctA: +(100 * (wins + draws / 2) / games).toFixed(1), se: +(100 * Math.sqrt(0.25 / games)).toFixed(1), picksA: per(pickA), picksB: per(pickB), sec: Math.round((Date.now() - t0) / 1000) }));
