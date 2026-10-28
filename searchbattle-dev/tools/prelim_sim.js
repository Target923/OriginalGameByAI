// 4x4 予選ルールでのCPU対戦の決着ターン数をシミュレーションするツール
// 使用例: node tools/prelim_sim.js [試合数] (省略時 500)
const E = require('../src/engine.js');
const AI = require('../src/ai.js');

const N_GAMES = parseInt(process.argv[2], 10) || 500;
console.log(`Running simulation of ${N_GAMES} matches in 4x4 prelim rules...`);

const turns = [];
let hasFiveCount = 0;
let hasZCount = 0;
const turnsWithFive = [];
const turnsWithoutFive = [];
const turnsWithZ = [];
const turnsWithoutZ = [];

let answerSuccess = 0;
let answerFail = 0;
const dist = {};

const t0 = Date.now();

for (let g = 0; g < N_GAMES; g++) {
  const game = new E.Game({ rules: 'prelim' }, 10000 + g);
  AI.autoMatch(game);
  
  const t = game.turn;
  turns.push(t);
  dist[t] = (dist[t] || 0) + 1;

  const anyFive = game.players.some(p => p.pieces.some(q => q.size === 5));
  if (anyFive) {
    hasFiveCount++;
    turnsWithFive.push(t);
  } else {
    turnsWithoutFive.push(t);
  }

  const anyZ = game.players.some(p => p.pieces.some(q => q.shape === 'Z4' || q.shape === 'Z5' || q.shape === 'S5'));
  if (anyZ) {
    hasZCount++;
    turnsWithZ.push(t);
  } else {
    turnsWithoutZ.push(t);
  }

  for (const log of game.log || []) {
    if (log.type === 'answer') {
      if (log.extra && log.extra.success) answerSuccess++;
      else answerFail++;
    }
  }
}

const elapsed = (Date.now() - t0) / 1000;
turns.sort((a, b) => a - b);

const sum = turns.reduce((a, b) => a + b, 0);
const avg = sum / turns.length;
const median = turns[Math.floor(turns.length / 2)];
const min = turns[0];
const max = turns[turns.length - 1];

const avgWithFive = turnsWithFive.length ? (turnsWithFive.reduce((a, b) => a + b, 0) / turnsWithFive.length).toFixed(2) : 'N/A';
const avgWithoutFive = turnsWithoutFive.length ? (turnsWithoutFive.reduce((a, b) => a + b, 0) / turnsWithoutFive.length).toFixed(2) : 'N/A';

const avgWithZ = turnsWithZ.length ? (turnsWithZ.reduce((a, b) => a + b, 0) / turnsWithZ.length).toFixed(2) : 'N/A';
const avgWithoutZ = turnsWithoutZ.length ? (turnsWithoutZ.reduce((a, b) => a + b, 0) / turnsWithoutZ.length).toFixed(2) : 'N/A';

const buckets = { '1-5T': 0, '6-8T': 0, '9-11T': 0, '12-14T': 0, '15-17T': 0, '18T+': 0 };
for (const t of turns) {
  if (t <= 5) buckets['1-5T']++;
  else if (t <= 8) buckets['6-8T']++;
  else if (t <= 11) buckets['9-11T']++;
  else if (t <= 14) buckets['12-14T']++;
  else if (t <= 17) buckets['15-17T']++;
  else buckets['18T+']++;
}

console.log('=== 4x4 PRELIM RULES SIMULATION ===');
console.log(`Execution Time: ${elapsed.toFixed(1)}s (average ${((elapsed/N_GAMES)*1000).toFixed(1)}ms per match)`);
console.log(`Average Turns : ${avg.toFixed(2)} turns`);
console.log(`Median Turns  : ${median} turns`);
console.log(`Min / Max     : ${min} / ${max} turns`);
console.log(`Historical Baseline (v12.12 - v12.16): 10.40 turns`);
const diff = avg - 10.40;
console.log(`Turn Difference    : ${diff >= 0 ? '+' : ''}${diff.toFixed(2)} turns (${(diff / 10.40 * 100).toFixed(1)}%)`);
console.log(`[Z-Shape Impact]`);
console.log(`  Matches with Z-shapes: ${hasZCount} / ${N_GAMES} (${(hasZCount/N_GAMES*100).toFixed(1)}%)`);
console.log(`    Avg turns when Z-shape present   : ${avgWithZ} turns`);
console.log(`    Avg turns when NO Z-shape present: ${avgWithoutZ} turns`);
console.log(`[5-Cell Impact]`);
console.log(`  Matches with 5-cell piece: ${hasFiveCount} / ${N_GAMES} (${(hasFiveCount/N_GAMES*100).toFixed(1)}%)`);
console.log(`    Avg turns when 5-cell present   : ${avgWithFive} turns`);
console.log(`    Avg turns when NO 5-cell present: ${avgWithoutFive} turns`);
console.log('Turn Distribution:');
for (const k in buckets) {
  const cnt = buckets[k];
  const bar = '■'.repeat(Math.round(cnt / N_GAMES * 40));
  console.log(`  ${k.padEnd(8)}: ${cnt.toString().padStart(3)} games (${(cnt/N_GAMES*100).toFixed(1).padStart(4)}%) ${bar}`);
}
