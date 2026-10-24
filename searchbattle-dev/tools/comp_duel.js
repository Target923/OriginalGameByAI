#!/usr/bin/env node
// サーチバトル — キューブの組み合わせの対戦（CPUどうし・1試合ずつ）
//  基準の組み合わせ（--ref）と、比べる組み合わせ（--vs、何個でも）を同じ条件で戦わせ、勝率と持ち点の収支を出す。
//  先攻は交互。アイテムは大会のはじめの持ち物（9種を2つずつ）で、予選なら予選の使い方（tourItemKeep）、決勝ならドラフト。
//  置き方は大会と同じ決め方（盤の80%以上を埋めるなら寄せる cluster、それより少なければ離して外周に寄せる edge）。
//  「2,2,3@cluster」のように @ の後に置き方を書くと、その置き方に固定する（cluster・edge・spread・center・room・any）。
//  使い方: node tools/comp_duel.js --kind prelim --round 0 --n 300 --ref 2,2,2,3,3 --vs 2,2,3,3,4 --vs 3,3,4,4@edge [--workers 2] [--seed 1]
//         総当たり: node tools/comp_duel.js --n 200 --rr "2,2,2,3,3;3,3,4,4;2,3,3,4,4"
//   収支＝撃破で奪ったマス−奪われたマス＋勝利点（勝てば＋、負ければ−）＋宝石（見つけた−見つけられた）×5。比べる側から見た値
const path = require('path');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const SRC = path.join(__dirname, '..', 'src');
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const parse = (s) => { const [a, l] = String(s).split('@'); const sizes = a.split(',').map(Number).sort((x, y) => x - y); return { sizes, layout: l || null, name: sizes.join('') + (l ? '@' + l : '') }; };

function duel(E, AI, kind, round, A, B, seed, first) {
  const rng = mulberry32(seed);
  const T = E.Tour.create({ rng, cpu: [true, true, true, true], personas: null });
  T.round = round;
  const N = kind === 'final' ? 5 : 4;
  const lay = (p) => p.layout || (p.sizes.reduce((a, b) => a + b, 0) >= 0.8 * N * N ? 'cluster' : 'edge');
  const extra = { setupPlan: [{ sizes: A.sizes, layout: lay(A) }, { sizes: B.sizes, layout: lay(B) }], first };
  if (kind !== 'final') extra.itemKeep = [AI.tourItemKeep(T, 0, 'prelim'), AI.tourItemKeep(T, 1, 'prelim')];
  const g = new E.Game(Object.assign(E.Tour.matchOpts(T, 0, 1, kind, extra), { rng }));
  AI.autoMatch(g);
  const s = g.summary(), r = g.result || { draw: true };
  const w = r.draw ? -1 : r.winner;
  const V = E.Tour.victoryFor(kind, round);
  const net = s[0].attack - s[1].attack + (w === 0 ? V : w === 1 ? -V : 0) + 5 * ((s[0].treasureFound ? 1 : 0) - (s[1].treasureFound ? 1 : 0));
  return { w, net, lostA: s[0].lost.reduce((a, b) => a + b, 0), lostB: s[1].lost.reduce((a, b) => a + b, 0), placedA: s[0].placed.join(''), turns: g.turn, first };
}

if (!isMainThread) {
  global.SBEngine = require(path.join(SRC, 'engine.js'));
  const E = global.SBEngine, AI = require(path.join(SRC, 'ai.js'));
  const { jobs, kind, round } = workerData;
  // 比べる側を 0番に置く（先攻は j.first）
  for (const j of jobs) parentPort.postMessage(Object.assign({ key: j.key }, duel(E, AI, kind, round, j.vs, j.ref, j.seed, j.first)));
  parentPort.postMessage(null);
  return;
}

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const optAll = (n) => args.flatMap((a, i) => (a === '--' + n && args[i + 1] ? [args[i + 1]] : []));
const kind = opt('kind', 'prelim'), round = +opt('round', kind === 'final' ? 3 : 0), n = +opt('n', 300), seed0 = +opt('seed', 1);
const workers = Math.max(1, +opt('workers', Math.min(4, os.cpus().length)));
const ref = parse(opt('ref', kind === 'final' ? '2,3,4,4,5' : '2,2,2,3,3'));
const vsList = optAll('vs').map(parse);
const rrList = opt('rr') ? opt('rr').split(';').map(parse) : null;
const jobs = [];
if (rrList) {
  for (let a = 0; a < rrList.length; a++) for (let b = a + 1; b < rrList.length; b++)
    for (let i = 0; i < n; i++) jobs.push({ key: a + '-' + b, vs: rrList[a], ref: rrList[b], seed: seed0 + i, first: i % 2 });
} else for (const vs of vsList) for (let i = 0; i < n; i++) jobs.push({ key: vs.name, vs, ref, seed: seed0 + i, first: i % 2 });
const t0 = Date.now();
const res = {};
let done = 0;
for (let w = 0; w < workers; w++) {
  const wk = new Worker(__filename, { workerData: { jobs: jobs.filter((_, i) => i % workers === w), kind, round } });
  wk.on('message', (m) => {
    if (!m) { if (++done === workers) report(); return; }
    (res[m.key] || (res[m.key] = [])).push(m);
  });
  wk.on('error', (e) => { console.error(e); process.exit(1); });
}
function report() {
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const title = kind === 'final' ? '決勝5×5' : '予選4×4・' + (round + 1) + '試合目';
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (rrList) {
    const K = rrList.length, M = rrList.map(() => rrList.map(() => null)), NET = rrList.map(() => rrList.map(() => null));
    for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) {
      const L = res[a + '-' + b] || [];
      const pa = (L.filter((x) => x.w === 0).length + 0.5 * L.filter((x) => x.w === -1).length) / Math.max(1, L.length);
      M[a][b] = pa; M[b][a] = 1 - pa;
      const net = sum(L.map((x) => x.net)) / Math.max(1, L.length);
      NET[a][b] = net; NET[b][a] = -net;
    }
    console.log(`総当たり ${title}  各組${n}試合（${secs}秒）  行の組み合わせから見た勝率%`);
    const w = Math.max(7, ...rrList.map((s) => s.name.length + 1));
    console.log(' '.repeat(w) + rrList.map((s) => s.name.padStart(w)).join('') + '   平均勝率  平均収支');
    for (let a = 0; a < K; a++) {
      const avg = sum(M[a].filter((v) => v != null)) / (K - 1), net = sum(NET[a].filter((v) => v != null)) / (K - 1);
      console.log(rrList[a].name.padEnd(w) + M[a].map((v) => (v == null ? '-' : (100 * v).toFixed(0)).padStart(w)).join('') + `   ${(100 * avg).toFixed(1).padStart(6)}%  ${net.toFixed(2).padStart(6)}`);
    }
    return;
  }
  console.log(`${title}  基準 [${ref.name}]（${sum(ref.sizes)}マス）  各${n}試合（${secs}秒）`);
  for (const vs of vsList) {
    const L = res[vs.name] || [];
    const win = L.filter((x) => x.w === 0).length, lose = L.filter((x) => x.w === 1).length;
    const pct = (100 * (win + 0.5 * (L.length - win - lose)) / L.length);
    const se = 100 * Math.sqrt(pct / 100 * (1 - pct / 100) / L.length);
    const winF = L.filter((x) => x.first === 0 && x.w === 0).length / Math.max(1, L.filter((x) => x.first === 0).length);
    const winS = L.filter((x) => x.first === 1 && x.w === 0).length / Math.max(1, L.filter((x) => x.first === 1).length);
    const asPlanned = L.filter((x) => x.placedA === vs.sizes.join('')).length;
    console.log(`  [${vs.name}]（${vs.sizes.length}個・${sum(vs.sizes)}マス） 勝率 ${pct.toFixed(1)}%（±${se.toFixed(1)}、先攻 ${(100 * winF).toFixed(0)}%・後攻 ${(100 * winS).toFixed(0)}%）` +
      ` 収支 ${(sum(L.map((x) => x.net)) / L.length).toFixed(2)}点  失ったマス 自${(sum(L.map((x) => x.lostA)) / L.length).toFixed(1)}・相手${(sum(L.map((x) => x.lostB)) / L.length).toFixed(1)}` +
      `  ターン ${(sum(L.map((x) => x.turns)) / L.length).toFixed(1)}${asPlanned < L.length ? `  （予定どおり置けた ${asPlanned}/${L.length}）` : ''}`);
  }
}
