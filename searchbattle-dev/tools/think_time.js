#!/usr/bin/env node
// サーチバトル — CPUの考える時間の測定（CPUどうしの1試合モード・大会の決勝）
//  手番ごとの時間（考える時間＋操作）の平均・上位5%・最大と、1試合の合計を出す。
//  使い方: node tools/think_time.js [--src ../src] [--rules final|prelim] [--n 10] [--seed 1] [--tour]
//   --tour：大会の決勝の置き方（tourSetupPlan）で置く。付けなければ1試合モードの置き方（setupSizes）
//   --src：比べたい版の src フォルダ（既定はこのリポジトリの src）
const path = require('path');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SRC = path.resolve(opt('src', path.join(__dirname, '..', 'src')));
global.SBEngine = require(path.join(SRC, 'engine.js'));
const E = global.SBEngine, AI = require(path.join(SRC, 'ai.js'));
const rules = opt('rules', 'final'), n = +opt('n', 10), seed0 = +opt('seed', 1), tour = args.includes('--tour');
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const moves = [], totals = [], cubes = [];
for (let i = 0; i < n; i++) {
  const rng = mulberry32(seed0 + i);
  let g;
  if (tour) {
    const T = E.Tour.create({ rng, cpu: [true, true, true, true], personas: null });
    T.round = 3;
    g = new E.Game(Object.assign(E.Tour.matchOpts(T, 0, 1, 'final', { first: i % 2, setupPlan: [AI.tourSetupPlan(T, 0, 'final'), AI.tourSetupPlan(T, 1, 'final')] }), { rng }));
  } else g = new E.Game({ rules, rng, cpu: [true, true] });
  let last = Date.now();
  const t0 = last;
  AI.autoMatch(g, () => { const now = Date.now(); moves.push(now - last); last = now; });
  totals.push(Date.now() - t0);
  cubes.push(g.players.map((p) => p.pieces.length).join('v'));
}
moves.sort((a, b) => a - b);
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`${tour ? '大会の決勝' : '1試合 ' + rules}・${n}試合（${path.relative(process.cwd(), SRC) || SRC}）  手番 ${moves.length}回：平均 ${avg(moves).toFixed(0)}ms・上位5% ${moves[Math.floor(moves.length * 0.95)]}ms・最大 ${moves[moves.length - 1]}ms  1試合 平均 ${(avg(totals) / 1000).toFixed(1)}秒  個体数 ${cubes.slice(0, 6).join(' ')}…`);
