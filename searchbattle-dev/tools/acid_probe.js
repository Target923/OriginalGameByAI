#!/usr/bin/env node
// サーチバトル — アシッドを「いま使う／使わない」の打ち比べ（2026-11-04）
//  ねらい：CPU がアシッドを使える局面（◎のキューブに酸をかけられる手番）で、使ったときと使わなかったときの勝率の差を、
//   局面の特徴（まだ当たっていないブロックの見込み R・候補の割れ方 H・見つけていないキューブの見込み・ターンなど）ごとに出す。
//   ふつうの対戦（片方だけ持たない）では、使う場面が少ないと差が誤差に埋もれるので、同じ局面から両方を打って比べる。
//  しくみ：
//   1. ふつうに1試合回し、アシッドを使える局面（ai.js の acidHook が呼ばれたところ）を全部記録する（このときは使わない）
//   2. その中から1つ選び、同じ乱数でその局面まで同じ試合をやり直す（CPU は乱数が同じなら同じ手を選ぶ）
//   3. その局面で「使う」「使わない」に分け、そこから先の乱数を K 通りに変えて最後まで打つ（同じ k どうしで比べる）
//   測る側の CPU はその後アシッドを使わず、相手はアシッドを使わない（1回使うことの価値だけを見る）
//  使い方: node tools/acid_probe.js <prelim|final> <試合数> [--seed 1] [--k 4] [--workers 2] [--json out.json]
const path = require('path');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const SRC = process.env.SB_SRC || path.join(__dirname, '..', 'src');

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function load() {
  global.SBEngine = require(path.join(SRC, 'engine.js'));
  return { E: global.SBEngine, AI: require(path.join(SRC, 'ai.js')) };
}

// 1試合を回す。hook(game, pi, ab) は測る側の CPU がアシッドを使えるときに呼ばれ、true なら使う
function playGame(E, AI, rules, seed, P, hook) {
  const rng = mulberry32(seed);
  const T = E.Tour.create({ rng, cpu: [true, true, true, true] });
  T.round = 0;
  const G = new E.Game({ rules, rng, cpu: [true, true], setupPlan: [AI.tourSetupPlan(T, 0, rules), AI.tourSetupPlan(T, 1, rules)] });
  G.rules.draft = false;
  // 測る側は、しきい値なし（どんな局面でも候補を出す）で、使うかどうかは hook が決める
  AI.policy[P] = { acidR: 0, acidH: 0, acidMinN: 0, acidHuntMax: 99, acidHook: hook };
  AI.policy[1 - P] = { acid: 'none' };
  AI.setup(G, 0); AI.setup(G, 1); G.finishSetup(0); G.finishSetup(1);
  let guard = 0;
  while (G.phase === 'play' && guard++ < 600) AI.playTurn(G, G.cur);
  AI.policy[0] = {}; AI.policy[1] = {};
  if (G.phase !== 'over' || G.result.draw) return null;
  return G.result.winner === P ? 1 : 0;
}

function runOne(E, AI, rules, seed, K) {
  const P = seed % 2;
  // 1. 使える局面を記録する
  const feats = [];
  const base = playGame(E, AI, rules, seed, P, (g, pi, ab) => { feats.push({ R: ab.R, h: ab.h, hunt: ab.hunt, turn: ab.turn, bestH: ab.bestH, groups: ab.groups }); return false; });
  if (base == null || !feats.length) return null;
  const pick = mulberry32(seed * 31 + 7);
  const d = Math.floor(pick() * feats.length);
  // 2・3. その局面まで同じに打ち、使う／使わないに分けて K 通りの続きを打つ
  const out = { f: feats[d], n: feats.length, use: [], skip: [] };
  for (let k = 0; k < K; k++) {
    for (const use of [true, false]) {
      let idx = 0;
      const w = playGame(E, AI, rules, seed, P, (g) => {
        const i = idx++;
        if (i !== d) return false;
        g.rng = mulberry32(seed * 1000 + k + 1);   // ここから先の乱数（同じ k なら使う・使わないで同じ）
        return use;
      });
      (use ? out.use : out.skip).push(w == null ? 0.5 : w);
    }
  }
  return out;
}

if (!isMainThread) {
  const { E, AI } = load();
  for (const s of workerData.seeds) parentPort.postMessage(runOne(E, AI, workerData.rules, s, workerData.K) || { none: true });
  parentPort.postMessage(null);
  return;
}

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const rules = args[0] || 'prelim', games = +(args[1] || 200);
const seed0 = +opt('seed', 1), K = +opt('k', 4), workers = Math.max(1, +opt('workers', Math.min(2, os.cpus().length)));
const seeds = [];
for (let i = 0; i < games; i++) seeds.push(seed0 * 100000 + i);
const recs = [];
const t0 = Date.now();
let done = 0, got = 0;
for (let w = 0; w < workers; w++) {
  const wk = new Worker(__filename, { workerData: { rules, K, seeds: seeds.filter((_, i) => i % workers === w) } });
  wk.on('message', (m) => {
    if (m) { if (!m.none) recs.push(m); if (++got % 50 === 0) console.error(`${got}/${games} 試合 ${Math.round((Date.now() - t0) / 1000)}秒`); }
    else if (++done === workers) report();
  });
  wk.on('error', (e) => { console.error(e); process.exit(1); });
}

function report() {
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  // 局面ごとの差（使う−使わない）と、その平均・誤差
  const diff = recs.map((r) => mean(r.use) - mean(r.skip));
  const stat = (idx) => {
    const ds = idx.map((i) => diff[i]);
    if (!ds.length) return null;
    const m = mean(ds), v = ds.reduce((x, y) => x + (y - m) * (y - m), 0) / Math.max(1, ds.length - 1);
    return { n: ds.length, d: +(100 * m).toFixed(1), se: +(100 * Math.sqrt(v / ds.length)).toFixed(1), use: +(100 * mean(idx.map((i) => mean(recs[i].use)))).toFixed(1) };
  };
  const all = recs.map((_, i) => i);
  const by = (name, fn, bins) => {
    const o = {};
    for (const [label, lo, hi] of bins) o[label] = stat(all.filter((i) => { const x = fn(recs[i].f); return x >= lo && x < hi; }));
    return o;
  };
  const out = {
    rules, games, K, positions: recs.length, sec: Math.round((Date.now() - t0) / 1000),
    all: stat(all),
    R: by('R', (f) => f.R, [['<1.5', 0, 1.5], ['1.5-2.5', 1.5, 2.5], ['2.5-3.5', 2.5, 3.5], ['>=3.5', 3.5, 99]]),
    H: by('H', (f) => f.h, [['<1', 0, 1], ['1-2', 1, 2], ['2-3', 2, 3], ['>=3', 3, 99]]),
    hunt: by('hunt', (f) => f.hunt, [['<0.3', 0, 0.3], ['0.3-0.8', 0.3, 0.8], ['0.8-1.5', 0.8, 1.5], ['>=1.5', 1.5, 99]]),
    turn: by('turn', (f) => f.turn, [['1-3', 1, 4], ['4-6', 4, 7], ['7-9', 7, 10], ['10-', 10, 99]]),
    bestH: by('bestH', (f) => f.bestH, [['<=0.6', 0, 0.61], ['0.6-1.5', 0.61, 1.5], ['>=1.5', 1.5, 99]]),
  };
  console.log(JSON.stringify(out, null, 1));
  const j = opt('json'); if (j) require('fs').writeFileSync(j, JSON.stringify({ out, recs }));
}
