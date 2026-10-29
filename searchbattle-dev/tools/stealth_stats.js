// ステルスの効き方を調べる（CPUどうし）
//  1) 決勝のドラフト：ドラフト前の手持ち（予選の残り）と、最後に余ったアイテム
//  2) ステルスを付けた個体のその後：全マス当てられたか・そこから何手生き延びたか・どう倒されたか・勝敗
// 使い方: node tools/stealth_stats.js <大会の数> [seed]
//   決勝は CPU だけの大会（予選3試合）を回し、その決勝の顔ぶれで1試合する。予選のステルスは同じ盤面の予選の試合を別に回して数える
const path = require('path');
const SRC = process.env.SB_SRC || path.join(__dirname, '..', 'src');
const E = require(path.join(SRC, 'engine.js'));
const AI = require(path.join(SRC, 'ai.js'));
const S = require(path.join(SRC, 'sim.js'));

const nTours = +process.argv[2] || 50, seed0 = +process.argv[3] || 1;
const pop = (m) => { let n = 0; while (m) { n += m & 1; m >>>= 1; } return n; };

// 1試合のステルスの記録を集める（手番ごとに盤を見て、付いた・全マス当たった・倒れたを記録）
function track(g, out) {
  const rec = new Map();   // 個体id（持ち主つき）→ 記録
  const scan = () => {
    for (const P of g.players) {
      for (const p of P.pieces.concat(P.splitPieces.map((s) => ({ ...s, _split: true })))) {
        const key = P.idx + ':' + p.id;
        let r = rec.get(key);
        if (!r && p.stealth) { r = { owner: P.idx, size: p.size, at: g.turn, hitAt: pop(p.hitMask), full: null, dead: null, cause: null }; rec.set(key, r); }
        if (!r) continue;
        if (p._split) { if (!r.dead) { r.dead = g.turn; r.cause = 'bazooka'; } continue; }
        if (r.full == null && p.hitMask === p.mask) r.full = g.turn;
        if (!p.alive && !r.dead) { r.dead = g.turn; r.cause = p.cause; }
      }
    }
  };
  let guard = 0;
  while (g.phase === 'play' && guard++ < 600) { AI.playTurn(g, g.cur); scan(); }
  for (const r of rec.values()) {
    r.win = g.result && !g.result.draw ? (g.result.winner === r.owner ? 1 : 0) : 0.5;
    r.endTurn = g.turn;
    out.push(r);
  }
  return g;
}

function summary(name, list, games) {
  const n = list.length;
  const f = (x) => (100 * x / Math.max(1, n)).toFixed(1) + '%';
  const full = list.filter((r) => r.full != null);
  const killedAfterFull = full.filter((r) => r.dead && r.cause === 'answer');
  const gained = killedAfterFull.map((r) => r.dead - r.full);
  const mean = (a) => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : '-';
  const causes = {};
  for (const r of list) { const k = r.dead ? r.cause : 'alive'; causes[k] = (causes[k] || 0) + 1; }
  console.log(`\n■ ${name}：${games}試合で ステルス ${n}回（1試合あたり ${(n / games).toFixed(2)}）`);
  console.log(`  付けた個体の大きさ：` + [1, 2, 3, 4, 5].map((s) => `${s}マス ${list.filter((r) => r.size === s).length}`).join('・') + `／付けた手番の平均 ${mean(list.map((r) => r.at))}`);
  console.log(`  全マス当てられた：${full.length}（${f(full.length)}）／そのうちアンサーで倒された ${killedAfterFull.length}、試合が先に終わった ${full.filter((r) => !r.dead).length}`);
  console.log(`  全マス当てられてから倒されるまで（手番の差。同じ手番なら0）：平均 ${mean(gained)}、0手 ${gained.filter((x) => x === 0).length}・1手 ${gained.filter((x) => x === 1).length}・2手 ${gained.filter((x) => x === 2).length}・3手以上 ${gained.filter((x) => x >= 3).length}`);
  console.log(`  その後：` + Object.entries(causes).map(([k, v]) => `${k} ${v}（${f(v)}）`).join('・'));
  console.log(`  付けた側の勝率：${(100 * list.reduce((a, r) => a + r.win, 0) / Math.max(1, n)).toFixed(1)}%`);
}

const draft = { left: {}, before: { have: 0, n: 0 }, pickRank: {} };
const fin = [], pre = [];
let finGames = 0, preGames = 0;
const t0 = Date.now();
for (let i = 0; i < nTours; i++) {
  const seed = seed0 * 100000 + i;
  const rec = S.runTour(seed, null, false);
  const [f1, f2] = S.finalistsOf(rec, null);
  // 決勝（playFinal と同じ作り方。ドラフトの前後を見るため自分で進める）
  const T = JSON.parse(rec.post);
  const rng = S.mulberry32(seed ^ 0x5bd1e995);
  const choice = AI.tourChooseFirst(T, f1);
  const g = new E.Game(Object.assign(E.Tour.matchOpts(T, f1, f2, 'final', { first: choice === 'first' ? 0 : 1, setupPlan: [AI.tourSetupPlan(T, f1, 'final'), AI.tourSetupPlan(T, f2, 'final')] }), { rng }));
  for (const pi of [0, 1]) { AI.setup(g, pi); g.finishSetup(pi); }
  if (g.phase === 'draft') {
    for (const pi of [0, 1]) { draft.before.n++; if ((g.players[pi].items.stealth || 0) > 0) draft.before.have++; }
    while (g.phase === 'draft') {
      const pi = g.draftTurn(), k = AI.draftPick(g, pi);
      const step = g.draft.step;
      (draft.pickRank[k] = draft.pickRank[k] || []).push(step + 1);
      g.draftPick(pi, k);
    }
    // 余ったアイテム：9種から8つ取るので1つ残る
    const leftKeys = E.ITEM_KEYS ? E.ITEM_KEYS.filter((k) => !g.draft.picks[0].concat(g.draft.picks[1]).includes(k)) : [];
    for (const k of leftKeys) draft.left[k] = (draft.left[k] || 0) + 1;
  }
  track(g, fin); finGames++;
  // 予選のステルス：大会と同じ置き方・アイテムで予選の試合を1つ
  const T2 = E.Tour.create({ rng: S.mulberry32(seed + 7), cpu: [true, true, true, true] });
  T2.round = 0;
  const g2 = new E.Game({ rules: 'prelim', rng: S.mulberry32(seed + 9), cpu: [true, true], setupPlan: [AI.tourSetupPlan(T2, 0, 'prelim'), AI.tourSetupPlan(T2, 1, 'prelim')] });
  g2.rules.draft = false;
  AI.policy[0] = {}; AI.policy[1] = {};
  for (const pi of [0, 1]) { AI.setup(g2, pi); g2.finishSetup(pi); }
  track(g2, pre); preGames++;
  if ((i + 1) % 10 === 0) process.stderr.write(`${i + 1}/${nTours} ${Math.round((Date.now() - t0) / 1000)}s\n`);
}
console.log(`大会 ${nTours}（${Math.round((Date.now() - t0) / 1000)}秒）`);
console.log(`\n■ 決勝のドラフト：余ったアイテム ` + Object.entries(draft.left).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}（${(100 * v / nTours).toFixed(0)}%）`).join('・'));
console.log(`  ドラフト前（予選の残り）にステルスを持っていた決勝進出者：${draft.before.have}/${draft.before.n}`);
console.log(`  取られた順番の平均（1〜8）：` + Object.entries(draft.pickRank).map(([k, a]) => [k, a.reduce((x, y) => x + y, 0) / a.length, a.length]).sort((a, b) => a[1] - b[1]).map(([k, m, n]) => `${k} ${m.toFixed(1)}（${n}回）`).join('・'));
summary('決勝', fin, finGames);
summary('予選', pre, preGames);
