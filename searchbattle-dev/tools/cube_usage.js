#!/usr/bin/env node
// サーチバトル — キューブの使い方の測定（CPUだけの大会）
//  性格ごと・試合ごとに、置いたマス数の内訳・失ったマス数・大会の最後まで使わなかったキューブ・予選通過率・優勝率・持ち点、
//  5マスを置いた割合と、置いたとき・置かなかったときの勝率を出す。
//  使い方: node tools/cube_usage.js [--tours 200] [--seed 1] [--workers 4] [--setup '{"mass":{...},"save":{...}}'] [--json out.json]
//   --setup：性格ごとの置き方の確率の上書き（ai.js の SETUP_PROB に重ねる。キーは mass・save・steady・items・std、中身は prelim・final・prelimByRound）。比べるときに使う
const path = require('path');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const SRC = path.join(__dirname, '..', 'src');

function load() {
  global.SBEngine = require(path.join(SRC, 'engine.js'));
  const AI = require(path.join(SRC, 'ai.js'));
  return { E: global.SBEngine, AI };
}
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function runTour(E, AI, seed, setup) {
  const Tour = E.Tour;
  const rng = mulberry32(seed);
  const T = Tour.create({ rng, cpu: [true, true, true, true] });
  const per = (id) => Tour.persona(T, id) || 'std';
  // 性格ごとの上書きを、大会の番号ごとの上書き（AI.policy.tourSetup）に直す
  AI.policy.tourSetup = {};
  if (setup) for (let id = 0; id < 4; id++) if (setup[per(id)]) AI.policy.tourSetup[id] = setup[per(id)];
  const rec = { p: [0, 1, 2, 3].map(per), m: [] };
  const play = (g, kind, r, a, b) => {
    AI.autoMatch(g);
    const s = g.summary(), w = g.result && !g.result.draw ? (g.result.winner === 0 ? a : b) : -1;
    rec.m.push({ k: kind, r, ids: [a, b], placed: [s[0].placed, s[1].placed], lost: [s[0].lost, s[1].lost], w });
  };
  for (let r = 0; r < 3; r++) {
    T.round = r;
    const plans = {}, keeps = {};
    for (let id = 0; id < 4; id++) { plans[id] = AI.tourSetupPlan(T, id, 'prelim'); keeps[id] = AI.tourItemKeep(T, id, 'prelim'); }
    for (const [a, b] of T.rounds[r]) {
      const g = new E.Game(Object.assign(Tour.matchOpts(T, a, b, 'prelim', { setupPlan: [plans[a], plans[b]], itemKeep: [keeps[a], keeps[b]] }), { rng }));
      play(g, 'P', r, a, b);
      Tour.apply(T, a, b, g, 'prelim');
    }
  }
  const st = Tour.standings(T);
  const f1 = st[0].id, f2 = st[1].id;
  rec.qual = [f1, f2];
  rec.prelimPts = T.players.map((P) => Tour.total(P));
  rec.stockAfterPrelim = T.players.map((P) => Object.assign({}, P.stock));
  const choice = AI.tourChooseFirst(T, f1);
  const g = new E.Game(Object.assign(Tour.matchOpts(T, f1, f2, 'final', { first: choice === 'first' ? 0 : 1, setupPlan: [AI.tourSetupPlan(T, f1, 'final'), AI.tourSetupPlan(T, f2, 'final')] }), { rng }));
  play(g, 'F', 3, f1, f2);
  rec.champ = rec.m[rec.m.length - 1].w;
  return rec;
}

if (!isMainThread) {
  const { E, AI } = load();
  for (const seed of workerData.seeds) parentPort.postMessage(runTour(E, AI, seed, workerData.setup));
  parentPort.postMessage(null);
  return;
}

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const tours = +opt('tours', 200), seed0 = +opt('seed', 1), workers = Math.max(1, +opt('workers', Math.min(4, os.cpus().length)));
const setup = opt('setup') ? JSON.parse(opt('setup')) : null;
const seeds = Array.from({ length: tours }, (_, i) => seed0 + i);
const recs = [];
const t0 = Date.now();
let done = 0;
for (let w = 0; w < workers; w++) {
  const wk = new Worker(__filename, { workerData: { seeds: seeds.filter((_, i) => i % workers === w), setup } });
  wk.on('message', (m) => { if (m) recs.push(m); else if (++done === workers) report(); });
  wk.on('error', (e) => { console.error(e); process.exit(1); });
}

function report() {
  const P = {};
  const get = (k) => P[k] || (P[k] = { n: 0, qual: 0, champ: 0, fin: 0, pts: 0, rounds: [0, 1, 2, 3].map(() => ({ n: 0, cubes: 0, cells: 0, sz: { 2: 0, 3: 0, 4: 0, 5: 0 }, lostCells: 0, win: 0, f5: 0, f5win: 0, n5win: 0 })), unused: { 2: 0, 3: 0, 4: 0, 5: 0 }, unusedN: 0 });
  // 5マスの効き目：その試合で5マスを置いたか・置いたときと置かなかったときの勝率（性格・予選／決勝ごと）
  for (const rec of recs) {
    rec.p.forEach((k, id) => {
      const x = get(k); x.n++;
      if (rec.qual.includes(id)) x.qual++;
      if (rec.champ === id) x.champ++;
      x.pts += rec.prelimPts[id];
    });
    for (const m of rec.m) m.ids.forEach((id, j) => {
      const x = get(rec.p[id]), R = x.rounds[m.r];
      R.n++; R.cubes += m.placed[j].length; R.cells += m.placed[j].reduce((a, b) => a + b, 0);
      for (const s of m.placed[j]) R.sz[s]++;
      R.lostCells += m.lost[j].reduce((a, b) => a + b, 0);
      if (m.w === id) R.win++;
      if (m.placed[j].includes(5)) { R.f5++; if (m.w === id) R.f5win++; } else if (m.w === id) R.n5win++;
      if (m.k === 'F') x.fin++;
    });
    // 大会の最後まで使わなかったキューブ：決勝に出た2人は決勝で置かなかった分、出なかった2人は予選の後に残った分（決勝がなかったので、その時点）
    const fm = rec.m[rec.m.length - 1];
    rec.p.forEach((k, id) => {
      const x = get(k), stock = Object.assign({}, rec.stockAfterPrelim[id]);
      const j = fm.ids.indexOf(id);
      if (j >= 0) for (const s of fm.placed[j]) stock[s] = Math.max(0, (stock[s] | 0) - 1);
      for (const s of [2, 3, 4, 5]) x.unused[s] += stock[s] | 0;
      x.unusedN++;
    });
  }
  const f1 = (v) => v.toFixed(1), pc = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '-';
  const NAMES = { mass: '物量型', save: '温存型', steady: '堅実型', items: '浪費型', std: '標準' };
  console.log(`大会 ${recs.length} 回（${((Date.now() - t0) / 1000).toFixed(0)}秒）${setup ? ' 上書き ' + JSON.stringify(setup) : ''}`);
  for (const k of Object.keys(P)) {
    const x = P[k];
    console.log(`\n■ ${NAMES[k] || k}（${x.n}回）予選通過 ${pc(x.qual, x.n)}・優勝 ${pc(x.champ, x.n)}（決勝の勝率 ${pc(x.champ, x.fin)}）・予選後の持ち点 ${f1(x.pts / x.n)}`);
    x.rounds.forEach((R, r) => {
      if (!R.n) return;
      const sz = [2, 3, 4, 5].map((s) => `${s}:${f1(R.sz[s] / R.n)}`).join(' ');
      console.log(`  ${r < 3 ? '予選' + (r + 1) : '決勝 '}  個体 ${f1(R.cubes / R.n)}（${sz}）・${f1(R.cells / R.n)}マス・失ったマス ${f1(R.lostCells / R.n)}・勝率 ${pc(R.win, R.n)}・5マスを置いた ${pc(R.f5, R.n)}（勝率 あり ${pc(R.f5win, R.f5)}／なし ${pc(R.n5win, R.n - R.f5)}）`);
    });
    console.log(`  最後まで使わなかった：` + [2, 3, 4, 5].map((s) => `${s}マス ${(x.unused[s] / x.unusedN).toFixed(2)}個`).join('・'));
  }
  for (const [label, rs] of [['予選', [0, 1, 2]], ['決勝', [3]]]) {
    let n = 0, f5 = 0, f5w = 0, n5w = 0;
    for (const k of Object.keys(P)) for (const r of rs) { const R = P[k].rounds[r]; n += R.n; f5 += R.f5; f5w += R.f5win; n5w += R.n5win; }
    console.log(`\n${label}（全員）：5マスを置いた ${pc(f5, n)}・勝率 あり ${pc(f5w, f5)}／なし ${pc(n5w, n - f5)}`);
  }
  const out = opt('json');
  if (out) require('fs').writeFileSync(out, JSON.stringify({ setup, summary: P }, null, 1));
}
