#!/usr/bin/env node
// サーチバトル — 大会でのアイテムの強さ（CPUだけの大会）
//  ねらい：1つのアイテムを大会のあいだずっと持たない（2つとも取り上げ、決勝のドラフトでも取らない）CPUが、
//   ふつうに持っているときと比べて、どれだけ勝てなくなるかを測る。下がった分がそのアイテムの価値。
//  比べ方：同じ大会（同じ seed・同じ顔ぶれ・同じ「持たない人」）を、取り上げなし＋9種それぞれで10回ずつ回す（対になった比べ方）。
//   乱数は試合の中で枝分かれするので結果は変わるが、顔ぶれや性格の偏りは条件の間でそろう。
//   「持たない人」は大会ごとに 0〜3番を順に回す（性格がかたよらないように）。
//  あわせて、取り上げなしの大会で、各アイテムが1試合に何回使われたか（予選・決勝）も数える。
//  使い方: node tools/item_tour.js [--tours 160] [--seed 1] [--workers 2] [--json out.json]
const path = require('path');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const SRC = process.env.SB_SRC || path.join(__dirname, '..', 'src');
const KEYS = ['cube', 'line', 'number', 'shape', 'pair', 'node', 'bazooka', 'warp', 'stealth'];
const CONDS = ['none'].concat(KEYS);

function load() {
  global.SBEngine = require(path.join(SRC, 'engine.js'));
  const AI = require(path.join(SRC, 'ai.js'));
  return { E: global.SBEngine, AI };
}
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// 1大会を回す。h＝アイテムを持たない人（大会の番号）、ban＝取り上げるアイテム（'none' なら取り上げない）
function runTour(E, AI, seed, h, ban) {
  const Tour = E.Tour;
  const rng = mulberry32(seed);
  const T = Tour.create({ rng, cpu: [true, true, true, true] });
  AI.policy.tourSetup = {};
  if (ban !== 'none') T.players[h].inv[ban] = 0;
  const rec = { h, ban, p: [0, 1, 2, 3].map((id) => Tour.persona(T, id) || 'std'), m: [], use: [] };
  // 試合を最後まで回す。使ったアイテムの数＝試合の前に持っていた数−終わったときの数（決勝はドラフトの後で数える）
  const play = (g, kind, a, b) => {
    const ids = [a, b];
    for (const pi of [0, 1]) if (!g.players[pi].setupDone) { AI.setup(g, pi); g.finishSetup(pi); }
    while (g.phase === 'draft') {
      const pi = g.draftTurn();
      let k = AI.draftPick(g, pi);
      // 持たない人は、取り上げたアイテムをドラフトで取らない（ほかに取れるものがなければそのまま）
      if (ids[pi] === h && k === ban) {
        const save = g.draft.pool;
        const alt = save.filter((x) => x !== ban);
        if (alt.length) { g.draft.pool = alt; k = AI.draftPick(g, pi); g.draft.pool = save; }
      }
      g.draftPick(pi, k);
    }
    for (const pi of [0, 1]) if (ids[pi] === h && ban !== 'none') g.players[pi].items[ban] = 0;
    const before = [0, 1].map((pi) => Object.assign({}, g.players[pi].items));
    let guard = 0;
    while (g.phase === 'play' && guard++ < 600) AI.playTurn(g, g.cur);
    const w = g.result && !g.result.draw ? ids[g.result.winner] : -1;
    rec.m.push({ k: kind, ids, w, turns: g.turn });
    for (const pi of [0, 1]) for (const k of KEYS) {
      const u = (before[pi][k] || 0) - (g.players[pi].items[k] || 0);
      if (u > 0) rec.use.push([kind, ids[pi], k, u]);
    }
  };
  for (let r = 0; r < 3; r++) {
    T.round = r;
    const plans = {}, keeps = {};
    for (let id = 0; id < 4; id++) { plans[id] = AI.tourSetupPlan(T, id, 'prelim'); keeps[id] = AI.tourItemKeep(T, id, 'prelim'); }
    for (const [a, b] of T.rounds[r]) {
      const g = new E.Game(Object.assign(Tour.matchOpts(T, a, b, 'prelim', { setupPlan: [plans[a], plans[b]], itemKeep: [keeps[a], keeps[b]] }), { rng }));
      play(g, 'P', a, b);
      Tour.apply(T, a, b, g, 'prelim');
    }
  }
  const st = Tour.standings(T);
  const f1 = st[0].id, f2 = st[1].id;
  rec.qual = [f1, f2];
  rec.pts = T.players.map((P) => Tour.total(P));
  const choice = AI.tourChooseFirst(T, f1);
  const g = new E.Game(Object.assign(Tour.matchOpts(T, f1, f2, 'final', { first: choice === 'first' ? 0 : 1, setupPlan: [AI.tourSetupPlan(T, f1, 'final'), AI.tourSetupPlan(T, f2, 'final')] }), { rng }));
  play(g, 'F', f1, f2);
  rec.champ = rec.m[rec.m.length - 1].w;
  return rec;
}

if (!isMainThread) {
  const { E, AI } = load();
  for (const job of workerData.jobs) parentPort.postMessage(runTour(E, AI, job.seed, job.h, job.ban));
  parentPort.postMessage(null);
  return;
}

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const tours = +opt('tours', 160), seed0 = +opt('seed', 1), workers = Math.max(1, +opt('workers', Math.min(2, os.cpus().length)));
const jobs = [];
for (let i = 0; i < tours; i++) for (const ban of CONDS) jobs.push({ seed: seed0 + i, h: i % 4, ban });
const recs = [];
const t0 = Date.now();
let done = 0, got = 0;
for (let w = 0; w < workers; w++) {
  const wk = new Worker(__filename, { workerData: { jobs: jobs.filter((_, i) => i % workers === w) } });
  wk.on('message', (m) => {
    if (m) { recs.push(m); if (++got % 100 === 0) console.error(`${got}/${jobs.length} 大会 ${Math.round((Date.now() - t0) / 1000)}秒`); }
    else if (++done === workers) report();
  });
  wk.on('error', (e) => { console.error(e); process.exit(1); });
}

function report() {
  // 条件ごとに「持たない人」の成績を集める
  const S = {};
  for (const c of CONDS) S[c] = { n: 0, pm: 0, pw: 0, qual: 0, fm: 0, fw: 0, champ: 0, pts: 0 };
  const use = {}; let pN = 0, fN = 0;
  for (const k of KEYS) use[k] = { P: 0, F: 0 };
  for (const r of recs) {
    const x = S[r.ban]; x.n++;
    for (const m of r.m) {
      if (!m.ids.includes(r.h)) continue;
      if (m.k === 'P') { x.pm++; if (m.w === r.h) x.pw++; } else { x.fm++; if (m.w === r.h) x.fw++; }
    }
    if (r.qual.includes(r.h)) x.qual++;
    if (r.champ === r.h) x.champ++;
    x.pts += r.pts[r.h];
    if (r.ban === 'none') {
      for (const m of r.m) { if (m.k === 'P') pN += 2; else fN += 2; }
      for (const [kind, , k, u] of r.use) use[k][kind] += u;
    }
  }
  const pct = (a, b) => b ? +(100 * a / b).toFixed(1) : null;
  const base = S.none;
  const rows = CONDS.map((c) => {
    const x = S[c];
    return {
      item: c, tours: x.n,
      prelimWin: pct(x.pw, x.pm), qual: pct(x.qual, x.n), finalWin: pct(x.fw, x.fm), champ: pct(x.champ, x.n), prelimPts: +(x.pts / x.n).toFixed(1),
      dPrelimWin: +(pct(x.pw, x.pm) - pct(base.pw, base.pm)).toFixed(1), dQual: +(pct(x.qual, x.n) - pct(base.qual, base.n)).toFixed(1),
      dChamp: +(pct(x.champ, x.n) - pct(base.champ, base.n)).toFixed(1), dPts: +((x.pts / x.n) - (base.pts / base.n)).toFixed(1),
      useP: c === 'none' ? null : +(use[c].P / pN).toFixed(2), useF: c === 'none' ? null : +(use[c].F / fN).toFixed(2),
    };
  });
  const out = { tours, seed0, sec: Math.round((Date.now() - t0) / 1000), rows };
  console.log(JSON.stringify(out, null, 1));
  const j = opt('json'); if (j) require('fs').writeFileSync(j, JSON.stringify({ out, recs }));
}
