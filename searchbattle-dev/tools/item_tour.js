#!/usr/bin/env node
// サーチバトル — 大会でのアイテムの強さ（CPUだけの大会）
//  ねらい：1つのアイテムを大会のあいだずっと持たない（2つとも取り上げ、決勝のドラフトでも取らない）CPUが、
//   ふつうに持っているときと比べて、どれだけ勝てなくなるかを測る。下がった分がそのアイテムの価値。
//  比べ方：同じ大会（同じ seed・同じ顔ぶれ・同じ「持たない人」）を、取り上げなし＋各アイテムで回す（対になった比べ方）。
//   2026-11-04：12種類（ベース8種類＋レア4種類）に対応。レアは「持たない人」がその大会で選んでいる2種類だけを取り上げる
//   （選んでいないレアは、取り上げても同じ大会になるので回さない）。決勝に補充するレアは CPU の決め方（tourChooseFinalRare）で選び、
//   取り上げたレアは選ばない。あわせて、取り上げなしの大会で、レアを選んだ人と選ばなかった人の成績も比べる（CPU はレアをランダムに選ぶので、そのまま比べられる）。
//   乱数は試合の中で枝分かれするので結果は変わるが、顔ぶれや性格の偏りは条件の間でそろう。
//   「持たない人」は大会ごとに 0〜3番を順に回す（性格がかたよらないように）。
//  あわせて、取り上げなしの大会で、各アイテムが1試合に何回使われたか（予選・決勝）も数える。
//  使い方: node tools/item_tour.js [--tours 160] [--seed 1] [--workers 2] [--json out.json]
const path = require('path');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const SRC = process.env.SB_SRC || path.join(__dirname, '..', 'src');
const KEYS = ['cube', 'line', 'number', 'shape', 'pair', 'node', 'warp', 'stealth', 'bazooka', 'homing', 'cross', 'acid'];
const RARES = ['bazooka', 'homing', 'cross', 'acid'];
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
  // 選んでいないレアを取り上げる条件は、取り上げなしと同じ大会になるので回さない
  if (RARES.indexOf(ban) >= 0 && (T.players[h].rares || []).indexOf(ban) < 0) return { skip: true };
  if (ban !== 'none') T.players[h].inv[ban] = 0;
  const rec = { h, ban, p: [0, 1, 2, 3].map((id) => Tour.persona(T, id) || 'std'), rares: T.players.map((P) => P.rares || []), m: [], use: [] };
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
  // 決勝に補充するレア（CPU の決め方。取り上げたレアは選ばない）
  for (const id of [f1, f2]) {
    let fr = AI.tourChooseFinalRare(T, id);
    if (id === h && fr === ban) fr = (T.players[id].rares || []).find((k) => k !== ban) || fr;
    if (fr) Tour.setFinalRare(T, id, fr);
  }
  rec.finalRare = [f1, f2].map((id) => T.players[id].finalRare);
  const choice = AI.tourChooseFirst(T, f1);
  const g = new E.Game(Object.assign(Tour.matchOpts(T, f1, f2, 'final', { first: choice === 'first' ? 0 : 1, setupPlan: [AI.tourSetupPlan(T, f1, 'final'), AI.tourSetupPlan(T, f2, 'final')] }), { rng }));
  play(g, 'F', f1, f2);
  rec.champ = rec.m[rec.m.length - 1].w;
  return rec;
}

if (!isMainThread) {
  const { E, AI } = load();
  for (const job of workerData.jobs) { const r = runTour(E, AI, job.seed, job.h, job.ban); r.seed = job.seed; parentPort.postMessage(r); }
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
  const live = recs.filter((r) => !r.skip);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const se = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1) / a.length); };
  const f1 = (x) => +(100 * x).toFixed(1);
  // 1大会の「持たない人」（h）の成績
  const perf = (r) => {
    let pm = 0, pw = 0, fm = 0, fw = 0;
    for (const m of r.m) {
      if (!m.ids.includes(r.h)) continue;
      if (m.k === 'P') { pm++; if (m.w === r.h) pw++; } else { fm++; if (m.w === r.h) fw++; }
    }
    return { pwin: pm ? pw / pm : 0, qual: r.qual.includes(r.h) ? 1 : 0, champ: r.champ === r.h ? 1 : 0, fwin: fm ? fw / fm : null, pts: r.pts[r.h] };
  };
  const base = new Map();
  for (const r of live) if (r.ban === 'none') base.set(r.seed, perf(r));
  // 使った回数（取り上げなしの大会。1試合1人あたり）
  const use = {}; let pN = 0, fN = 0;
  for (const k of KEYS) use[k] = { P: 0, F: 0 };
  for (const r of live) if (r.ban === 'none') {
    for (const m of r.m) { if (m.k === 'P') pN += 2; else fN += 2; }
    for (const [kind, , k, u] of r.use) if (use[k]) use[k][kind] += u;
  }
  // 条件ごと：同じ seed の取り上げなしとの差（対になった差の平均と誤差）
  const rows = CONDS.map((c) => {
    const xs = live.filter((r) => r.ban === c && base.has(r.seed));
    const P = xs.map(perf), B = xs.map((r) => base.get(r.seed));
    const d = (key) => xs.map((_, i) => P[i][key] - B[i][key]);
    const fwins = P.filter((p) => p.fwin != null).map((p) => p.fwin);
    const row = {
      item: c, tours: xs.length,
      prelimWin: f1(mean(P.map((p) => p.pwin))), qual: f1(mean(P.map((p) => p.qual))), champ: f1(mean(P.map((p) => p.champ))), finalWin: fwins.length ? f1(mean(fwins)) : null,
      pts: +mean(P.map((p) => p.pts)).toFixed(1),
    };
    if (c !== 'none') {
      row.dPrelimWin = f1(mean(d('pwin'))); row.seP = f1(se(d('pwin')));
      row.dQual = f1(mean(d('qual'))); row.seQ = f1(se(d('qual')));
      row.dChamp = f1(mean(d('champ'))); row.seC = f1(se(d('champ')));
      row.dPts = +mean(d('pts')).toFixed(1); row.sePts = +se(d('pts')).toFixed(1);
      row.useP = +(use[c].P / pN).toFixed(2); row.useF = +(use[c].F / fN).toFixed(2);
    }
    return row;
  });
  // レアを選んだ人と選ばなかった人（取り上げなしの大会・4人とも）。予選の勝率・決勝進出・優勝・決勝の勝率・決勝に持ちこんだ割合
  const rareRows = RARES.map((k) => {
    const S = { y: { pm: 0, pw: 0, n: 0, q: 0, c: 0, fm: 0, fw: 0, fr: 0 }, n: { pm: 0, pw: 0, n: 0, q: 0, c: 0, fm: 0, fw: 0 } };
    for (const r of live) {
      if (r.ban !== 'none') continue;
      for (let id = 0; id < 4; id++) {
        const x = S[(r.rares[id] || []).indexOf(k) >= 0 ? 'y' : 'n'];
        x.n++;
        if (r.qual.includes(id)) x.q++;
        if (r.champ === id) x.c++;
        for (const m of r.m) {
          if (!m.ids.includes(id)) continue;
          if (m.k === 'P') { x.pm++; if (m.w === id) x.pw++; } else { x.fm++; if (m.w === id) x.fw++; }
        }
        if (x === S.y && r.finalRare && r.qual.indexOf(id) >= 0 && r.finalRare[r.qual.indexOf(id)] === k) x.fr++;
      }
    }
    const pc = (a, b) => (b ? f1(a / b) : null);
    return { rare: k, holders: S.y.n, prelimWin: [pc(S.y.pw, S.y.pm), pc(S.n.pw, S.n.pm)], qual: [pc(S.y.q, S.y.n), pc(S.n.q, S.n.n)],
      champ: [pc(S.y.c, S.y.n), pc(S.n.c, S.n.n)], finalWin: [pc(S.y.fw, S.y.fm), pc(S.n.fw, S.n.fm)], broughtToFinal: pc(S.y.fr, S.y.q) };
  });
  const out = { tours, seed0, sec: Math.round((Date.now() - t0) / 1000), rows, rareRows };
  console.log(JSON.stringify(out, null, 1));
  const j = opt('json'); if (j) require('fs').writeFileSync(j, JSON.stringify({ out, recs }));
}
