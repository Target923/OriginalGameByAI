// ステルスの使い方どうしの対戦（CPUどうし）：方針 A と方針 B を戦わせて、A の勝率を出す
// 盤面は大会と同じ置き方（Tour の置き方の計画）。アイテムは両者とも全種類（item_value.js と同じ）。席は1試合ごとに入れ替える。
// 使い方: node tools/stealth_duel.js <prelim|final> <試合数> <seed> <A> <B>
//   方針は「mode[:pick]」。mode＝found・hit・early1・none、pick＝rand・big・near（policy.stealth / policy.stealthPick）
//   例: node tools/stealth_duel.js prelim 1000 3 found:rand none
const path = require('path');
const SRC = process.env.SB_SRC || path.join(__dirname, '..', 'src');
const E = require(path.join(SRC, 'engine.js'));
const AI = require(path.join(SRC, 'ai.js'));
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
const [rules, nStr, seedStr, aStr, bStr] = process.argv.slice(2);
const pol = (s) => { const [mode, pick] = String(s || 'found').split(':'); return { stealth: mode, stealthPick: pick || 'rand' }; };
const n = +nStr || 100, rng = mulberry32(+seedStr || 1);
let wins = 0, draws = 0, games = 0, qA = 0, qB = 0, fails = 0;
const t0 = Date.now();
for (let g = 0; g < n; g++) {
  const T = E.Tour.create({ rng, cpu: [true, true, true, true] });
  T.round = 0;
  const plans = [AI.tourSetupPlan(T, 0, rules), AI.tourSetupPlan(T, 1, rules)];
  const G = new E.Game({ rules, rng, cpu: [true, true], setupPlan: plans });
  G.rules.draft = false;
  const a = g % 2;   // 方針 A の席
  AI.policy[a] = pol(aStr); AI.policy[1 - a] = pol(bStr);
  AI.setup(G, 0); AI.setup(G, 1); G.finishSetup(0); G.finishSetup(1);
  let guard = 0;
  while (G.phase === 'play' && guard++ < 400) AI.playTurn(G, G.cur);
  if (G.phase !== 'over') continue;
  games++;
  // Stealth hit の回数（A のキューブに出た数＝B のコールの結果）
  qA += G.players[1 - a].kb.calls.filter((k) => k.r === 'q').length;
  qB += G.players[a].kb.calls.filter((k) => k.r === 'q').length;
  fails += G.players[0].kb.failedAnswers.length + G.players[1].kb.failedAnswers.length;
  if (G.result.draw) draws++; else if (G.result.winner === a) wins++;
}
AI.policy[0] = {}; AI.policy[1] = {};
const pct = 100 * (wins + draws / 2) / games;
console.log(JSON.stringify({ rules, A: aStr, B: bStr, games, winPctA: +pct.toFixed(1), se: +(100 * Math.sqrt(0.25 / games)).toFixed(1), stealthHitsOnA: +(qA / games).toFixed(2), stealthHitsOnB: +(qB / games).toFixed(2), answerFails: fails, sec: Math.round((Date.now() - t0) / 1000) }));
