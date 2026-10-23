// アイテムの価値を測る：片方だけそのアイテムを持たない CPU どうしの対戦で、持たない側の勝率がどれだけ下がるか
// 盤面は大会と同じ置き方（Tour の置き方の計画）。席は1試合ごとに入れ替える。
// 使い方: node tools/item_value.js <prelim|final> <試合数> <seed> <アイテム名|none>
//   例: node tools/item_value.js prelim 2000 7 line    （予選2000局で約2分半）
//       node tools/item_value.js final 240 8 line      （決勝は1局約3.5秒。240局で約20分）
//   変更前のコードと比べるときは、別のフォルダに src を写して SB_SRC=<そのフォルダ> を付けて同じ seed で回す
// 結果: winPct＝持たない側の勝率（50から引いた分がそのアイテムの価値）、se＝誤差の目安
const path = require('path');
const SRC = process.env.SB_SRC || path.join(__dirname, '..', 'src');
const E = require(path.join(SRC, 'engine.js'));
const AI = require(path.join(SRC, 'ai.js'));
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
const [rules, nStr, seedStr, remove] = process.argv.slice(2);
if (rules !== 'prelim' && rules !== 'final') { console.log('使い方: node tools/item_value.js <prelim|final> <試合数> <seed> <アイテム名|none>'); process.exit(1); }
const n = +nStr || 100, rng = mulberry32(+seedStr || 1);
let wins = 0, draws = 0, games = 0, turns = 0, uses = 0;
const t0 = Date.now();
for (let g = 0; g < n; g++) {
  const T = E.Tour.create({ rng, cpu: [true, true, true, true] });
  T.round = 0;
  const plans = [AI.tourSetupPlan(T, 0, rules), AI.tourSetupPlan(T, 1, rules)];
  const G = new E.Game({ rules, rng, cpu: [true, true], setupPlan: plans });
  G.rules.draft = false;
  const me = g % 2;   // アイテムを持たない側
  AI.policy[0] = {}; AI.policy[1] = {};
  AI.setup(G, 0); AI.setup(G, 1); G.finishSetup(0); G.finishSetup(1);
  if (remove && remove !== 'none') G.players[me].items[remove] = 0;
  let guard = 0;
  while (G.phase === 'play' && guard++ < 400) {
    AI.playTurn(G, G.cur, (s) => { if (s.kind === 'item' && s.r.ok && s.it.key === remove) uses++; });
  }
  if (G.phase !== 'over') continue;
  games++; turns += G.turn;
  if (G.result.draw) draws++; else if (G.result.winner === me) wins++;
}
const pct = 100 * (wins + draws / 2) / games;
console.log(JSON.stringify({ rules, remove, games, winPct: +pct.toFixed(1), value: +(pct - 50).toFixed(1), se: +(100 * Math.sqrt(0.25 / games)).toFixed(1), avgTurns: +(turns / games).toFixed(1), usesPerGame: +(uses / games).toFixed(2), sec: Math.round((Date.now() - t0) / 1000) }));
