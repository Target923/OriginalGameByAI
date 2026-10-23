#!/usr/bin/env node
// サーチバトル — シミュレーター（コマンド）
//  CPUだけの大会を並列で回して記録を残し、点数のルールを当てはめて短い表を出す。
//  使い方:
//    node tools/sim.js run --tours 300 [--seed 1] [--no-final] [--workers 2] [--save rec.json] [--rules "vic=5/10/15/20,gem=5,gems=4,start=80"]
//    node tools/sim.js rescore --load rec.json --rules "vic=6/9/12/15" --rules "vic=4/8/12/16,gem=4" [--refinal] [--detail]
//      --rules は何個でも（比べる表になる）。--refinal：顔ぶれの変わった決勝を回し直す（記録に予選の後の状態があるときだけ）
//    node tools/sim.js sample --tours 200 --out src/sim-sample.json   （シミュレーターのページに入れる見本）
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const SRC = path.join(__dirname, '..', 'src');

if (!isMainThread) {
  const S = require(path.join(SRC, 'sim.js'));
  const { cmd, seeds, rules, withFinal, jobs } = workerData;
  if (cmd === 'run') for (const seed of seeds) parentPort.postMessage({ type: 'rec', rec: S.runTour(seed, rules, withFinal) });
  if (cmd === 'final') for (const j of jobs) parentPort.postMessage({ type: 'final', i: j.i, key: j.f1 + '-' + j.f2, m: S.playFinal(j.post, j.f1, j.f2, j.seed) });
  parentPort.postMessage({ type: 'done' });
  return;
}

const S = require(path.join(SRC, 'sim.js'));
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def; };
const optAll = (name) => { const out = []; args.forEach((a, i) => { if (a === '--' + name && args[i + 1]) out.push(args[i + 1]); }); return out; };
function parseRules(str) {
  const r = Object.assign({}, S.DEFAULT_RULES, { vic: S.DEFAULT_RULES.vic.slice() });
  if (!str) return r;
  for (const part of String(str).split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    if (k === 'vic') r.vic = v.split('/').map(Number);
    else if (k === 'gem' || k === 'gemPts') r.gemPts = +v;
    else if (k === 'gems') r.gems = +v;
    else if (k === 'start') r.start = +v;
  }
  return r;
}
const rulesLabel = (r) => `勝利${r.vic.join('/')}・宝石${r.gems}×${r.gemPts}・はじめ${r.start}+${r.gems * r.gemPts}`;

function parallel(cmdName, chunks, extra, onMsg) {
  return Promise.all(chunks.filter((c) => c.length).map((chunk) => new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: Object.assign({ cmd: cmdName }, extra, cmdName === 'run' ? { seeds: chunk } : { jobs: chunk }) });
    w.on('message', (msg) => { if (msg.type === 'done') resolve(); else onMsg(msg); });
    w.on('error', reject);
  })));
}
const split = (arr, n) => { const out = Array.from({ length: n }, () => []); arr.forEach((x, i) => out[i % n].push(x)); return out; };

async function runTours(tours, seed0, rules, withFinal, workers) {
  const recs = [];
  const t0 = Date.now();
  let last = 0;
  await parallel('run', split(Array.from({ length: tours }, (_, k) => seed0 + k), workers), { rules, withFinal }, (msg) => {
    recs.push(msg.rec);
    if (Date.now() - last > 15000) { last = Date.now(); process.stderr.write(`  ${recs.length}/${tours}（${Math.round((Date.now() - t0) / 1000)}秒）\n`); }
  });
  recs.sort((a, b) => a.seed - b.seed);
  process.stderr.write(`  ${tours}大会 ${Math.round((Date.now() - t0) / 1000)}秒\n`);
  return recs;
}
async function refinal(recs, rulesList, workers) {
  const jobs = [];
  const seen = new Set();
  for (const r of rulesList) for (const j of S.missingFinals(recs, r)) { const key = j.i + ':' + j.f1 + '-' + j.f2; if (seen.has(key)) continue; seen.add(key); jobs.push({ i: j.i, f1: j.f1, f2: j.f2, post: recs[j.i].post, seed: recs[j.i].seed }); }
  if (!jobs.length) return 0;
  await parallel('final', split(jobs, workers), {}, (msg) => { recs[msg.i].finals[msg.key] = msg.m; });
  return jobs.length;
}

// ---------------- 表 ----------------
const f1 = (x) => (x == null ? '—' : x.toFixed(1));
const f0 = (x) => (x == null ? '—' : Math.round(x).toString());
function table(rows) {
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r) => r.map((x, c) => String(x).padEnd(w[c])).join(' | ')).join('\n');
}
function report(recs, rulesList, detail) {
  const sums = rulesList.map((r) => S.summarize(recs, r));
  console.log(`大会 ${recs.length}回（記録したバージョン ${recs[0] && recs[0].v}）`);
  console.log(table([['点数のルール', '3試合目で入れ替わる', '2試合目の後4位→決勝', '1試合目の後1位が落ちる', '1勝で決勝', '2勝で決勝', '1試合目に勝った人の通過', '3試合目に勝った人の通過', 'トレジャーで決勝が変わる', '2位3位が同点', '抽選まで', '優勝者の持ち点（平均・最低・最高）', '準優勝の方が多い', '予選の最低', '決勝あり']]
    .concat(sums.map((s) => [rulesLabel(s.rules), f1(s.comeback.r3change), f1(s.comeback.last2in), f1(s.comeback.lead1out), f1(s.comeback.byWins[1].qual), f1(s.comeback.byWins[2].qual), f1(s.comeback.wonR1), f1(s.comeback.wonR3), f1(s.gems.changesFinalists), f1(s.ties.line), f1(s.ties.lotto),
      `${f1(s.prize.mean)}・${f0(s.prize.min)}・${f0(s.prize.max)}`, f1(s.prize.runnerAbove), f0(s.low.prelim), `${s.finals}/${s.tours}`]))));
  if (!detail) return;
  const s = sums[0];
  console.log('\n性格ごと（' + rulesLabel(s.rules) + '）');
  console.log(table([['性格', '出場', '予選通過', '優勝', '決勝の勝率', '予選後の持ち点', '1試合に置いた個体', '1試合に使ったアイテム']].concat(s.persona.map((p) => [p.name, p.n, f1(p.qual), f1(p.champ), f1(p.finWin), f1(p.pts), f1(p.placed), f1(p.items)]))));
  console.log(`\n先攻の勝率：予選 ${f1(s.first.prelim)}%・決勝 ${f1(s.first.final)}%`);
  console.log(`宝石：見つけられる割合 予選${f1(s.gems.foundPrelim)}%・決勝${f1(s.gems.foundFinal)}%、予選1試合で 両方が奪う${f1(s.gems.both)}%・片方${f1(s.gems.one)}%・どちらも奪えない${f1(s.gems.none)}%`);
  console.log('予選後の宝石の数：' + s.gems.dist.map((d) => `${d.gems}つ ${f1(d.share)}%`).join('・'));
  console.log(`同点（2位と3位）：${f1(s.ties.line)}%（勝ち数で${f1(s.ties.byWins)}%・撃破マス数で${f1(s.ties.byTake)}%・抽選${f1(s.ties.lotto)}%）、予選1位の同点 ${f1(s.ties.top)}%`);
  console.log(`賞金（優勝者の持ち点）：10%点 ${f0(s.prize.p10)}・中央 ${f0(s.prize.p50)}・90%点 ${f0(s.prize.p90)}`);
  console.log(`試合：ターン数 予選${f1(s.play.turnsPrelim)}・決勝${f1(s.play.turnsFinal)}、置いた個体 予選${f1(s.play.placedPrelim)}・決勝${f1(s.play.placedFinal)}、使ったアイテム 予選${f1(s.play.itemsPrelim)}・決勝${f1(s.play.itemsFinal)}`);
}

(async () => {
  const workers = Math.max(1, +opt('workers', Math.max(1, os.cpus().length)));
  if (cmd === 'run' || cmd === 'sample') {
    const tours = +opt('tours', 100), seed0 = +opt('seed', Date.now() % 1e6);
    const rulesList = optAll('rules').map(parseRules);
    const rules = rulesList[0] || parseRules('');
    const recs = await runTours(tours, seed0, rules, opt('no-final') !== true, workers);
    if (cmd === 'sample') {
      const out = opt('out', path.join(SRC, 'sim-sample.json'));
      fs.writeFileSync(out, JSON.stringify({ v: recs[0].v, made: new Date().toISOString().slice(0, 10), tours: recs.length, recs: recs.map(S.slim) }));
      console.log('見本を保存', out, Math.round(fs.statSync(out).size / 1024) + 'KB');
      return;
    }
    const save = opt('save');
    if (save) { fs.writeFileSync(save, JSON.stringify(recs)); process.stderr.write(`  記録を保存 ${save}\n`); }
    report(recs, rulesList.length ? rulesList : [rules], opt('detail', true) !== 'no');
    return;
  }
  if (cmd === 'rescore') {
    const load = opt('load');
    if (!load) { console.log('--load 記録.json を指定してください'); process.exit(1); }
    const data = JSON.parse(fs.readFileSync(load, 'utf8'));
    const recs = Array.isArray(data) ? data : data.recs;
    const rulesList = optAll('rules').map(parseRules);
    if (!rulesList.length) rulesList.push(parseRules(''));
    if (opt('refinal')) { const n = await refinal(recs, rulesList, workers); process.stderr.write(`  決勝を回し直した ${n}試合\n`); }
    report(recs, rulesList, !!opt('detail'));
    return;
  }
  console.log('使い方: node tools/sim.js run|rescore|sample ...（ファイルの先頭の説明を見てください）');
})().catch((e) => { console.error(e); process.exit(1); });
