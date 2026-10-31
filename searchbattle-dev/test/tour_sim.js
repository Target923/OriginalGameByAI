// 大会をCPUだけで最後まで進めて、決まりごと（キューブ・アイテム・ポイント・順位）が崩れないか確かめる
// 使い方: node test/tour_sim.js [大会の数]
const E = require('../src/engine.js');
const AI = require('../src/ai.js');
const { Tour, ITEM_KEYS } = E;
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
const n = +process.argv[2] || 50;
const st = { itemsPerPrelim: 0, itemsAtFinal: 0, keepViolations: 0, planned: 0, planFollowed: 0, planWhy: {}, placedPieces: { prelim: 0, final: 0 }, tours: 0, errors: 0, matches: 0, finals: 0, msPerMatch: 0, supplied: 0, splitsBack: 0,
  qualifyById: [0, 0, 0, 0], champById: [0, 0, 0, 0], champPts: 0, firstWinsFinal: 0, draftChoice: 0, prelimTurns: 0, finalTurns: 0 };
const err = (...a) => { st.errors++; if (st.errors < 20) console.log('ERR', ...a); };
const t0 = Date.now();
for (let k = 0; k < n; k++) {
  const rng = mulberry32(500 + k);
  const T = Tour.create({ rng, cpu: [true, true, true, true] });
  const play = (a, b, kind, extra) => {
    const before = [a, b].map((id) => JSON.parse(JSON.stringify(T.players[id])));
    const g = new E.Game(Object.assign(Tour.matchOpts(T, a, b, kind, extra), { rng }));
    // 置けるキューブ・手持ちのアイテムが大会の記録どおりか
    [a, b].forEach((id, i) => {
      const P = g.players[i], p = T.players[id];
      for (const s of [2, 3, 4, 5]) if (P.stock[s] !== (kind === 'final' && Tour.cubes(p) === 0 ? (s === 2 ? 1 : 0) : p.stock[s])) err('stock mismatch', kind, s);
      for (const key of ITEM_KEYS) if (P.items[key] !== p.inv[key]) err('inventory mismatch', key);
      if (kind === 'final' && Tour.cubes(p) === 0) st.supplied++;
    });
    const usedCount = [{}, {}];
    const tm = Date.now();
    AI.autoMatch(g, () => {});
    for (const e of g.events) if (e.type === 'item' && e.actor != null) usedCount[e.actor][e.key] = (usedCount[e.actor][e.key] || 0) + 1;
    // 温存すると決めた数を割り込んで使っていない（予選）
    if (kind !== 'final' && g.itemKeep) for (let i = 0; i < 2; i++) { const keep = g.itemKeep[i] || {}; for (const key in keep) if ((before[i].inv[key] || 0) - (usedCount[i][key] || 0) < Math.min(keep[key], before[i].inv[key] || 0)) { st.keepViolations++; err('used a kept item', key); } }
    if (kind !== 'final') for (let i = 0; i < 2; i++) for (const key in usedCount[i]) st.itemsPerPrelim += usedCount[i][key];
    // 試合ごとの攻撃アイテムの数の上限（ワープ・ステルスは数えない）
    if (kind !== 'final' && g.itemKeep) for (let i = 0; i < 2; i++) { const b = g.itemKeep[i] && g.itemKeep[i]._budget; if (b == null) continue; let n = 0; for (const key in usedCount[i]) if (key !== 'warp' && key !== 'stealth') n += usedCount[i][key]; if (n > b) { st.keepViolations++; err('over item budget', n, b); } }
    // CPUのアンサーは確信があるときだけ（大会でキューブの数が減っても外さない）
    //  例外（v14）：相手がステルスを使ったあと、×のマス1つに賭けるステルスアンサーは外れることがある（ステルスの探り）
    for (const e of g.events) {
      if (e.type !== 'answer' || e.success) continue;
      const kb = g.players[e.actor].kb;
      const m = g.players[e.actor].view.marks[e.cells[0]];
      // ×のブロック1つへのステルスアンサーの外れ（あとでワープの再コールなどで印が変わることがあるので、×だったことは記録で見る）
      const hunt = e.probe || (e.cells.length === 1 && (kb.stealths || []).length > 0 && ((m && m.r === 'x') || kb.calls.some((k) => k.c === e.cells[0] && k.r === 'x')));
      if (hunt) st.stealthHuntMiss = (st.stealthHuntMiss || 0) + 1; else err('CPU answer failed', kind);
    }
    st.msPerMatch += Date.now() - tm;
    if (g.phase !== 'over') { err('not over', kind, g.turn, g.sub); return null; }
    // 予選は1試合で同じ種類を1回まで
    if (kind !== 'final') for (const u of usedCount) for (const key in u) if (u[key] > 1) err('item used twice in a prelim match', key);
    for (let i = 0; i < 2; i++) for (const key in usedCount[i]) {
      const drafted = g.draft ? g.draft.picks[i].filter((x) => x === key).length : 0;
      if (usedCount[i][key] > before[i].inv[key] + drafted) err('used more than held', key);
    }
    // 置いた個体はすべて大会の手持ちから
    for (let i = 0; i < 2; i++) {
      const P = g.players[i];
      for (const s of [2, 3, 4, 5]) if (g.stockLeft(i, s) < 0) err('placed beyond stock', s);
      if (P.splitPieces.length) st.splitsBack += P.splitPieces.filter((sp) => P.pieces.some((f) => f.frag && f.fromId === sp.id && f.alive)).length;
    }
    // CPUの配置の方針（大会の方針）どおりに置いたか
    for (let i = 0; i < 2; i++) {
      const plan = g.setupPlan && g.setupPlan[i];
      // バズーカで分解された元の個体は splitPieces に移っている
      const placed = g.players[i].pieces.filter((q) => !q.frag && !q.isAdd).concat(g.players[i].splitPieces).map((q) => q.size).sort((x, y) => x - y);
      st.placedPieces[kind === 'final' ? 'final' : 'prelim'] += placed.length;
      if (!plan) continue;
      st.planned++; st.planWhy[plan.why] = (st.planWhy[plan.why] || 0) + 1;
      if (JSON.stringify(placed) === JSON.stringify(plan.sizes)) st.planFollowed++;
      else if (st.planned - st.planFollowed < 5) console.log('plan not followed', kind, JSON.stringify(plan), JSON.stringify(placed));
    }
    const res = Tour.apply(T, a, b, g, kind);
    st.matches++;
    if (kind === 'final') st.finalTurns += g.turn; else st.prelimTurns += g.turn;
    // 失った個体の分だけキューブが減る
    [a, b].forEach((id, i) => {
      const p = T.players[id], was = before[i];
      const lost = res.lost[i];
      for (const s of [2, 3, 4, 5]) {
        const expect = Math.max(0, was.stock[s] - lost.filter((x) => x === s).length);
        if (p.stock[s] !== expect) err('stock not reduced correctly', s, was.stock[s], lost, p.stock[s]);
        if (p.stock[s] < 0) err('negative stock');
      }
      for (const key of ITEM_KEYS) {
        if (p.inv[key] < 0) err('negative inventory');
        const usedN = usedCount[i][key] || 0;
        const drafted = g.draft ? g.draft.picks[i].filter((x) => x === key).length : 0;
        if (p.inv[key] !== was.inv[key] - usedN + drafted) err('inventory not updated', key, was.inv[key], usedN, drafted, p.inv[key]);
      }
      const gain = res.pts[i].total;
      if (Tour.total(p) !== Tour.total(was) + gain) err('points not added');
      // 奪い合い：撃破で奪った分は相手の奪われた分と同じ。勝利点は勝者に＋、敗者に−で同じ大きさ
      const o = res.pts[1 - i];
      if (res.pts[i].take !== o.taken) err('steal mismatch');
      if (res.pts[i].victory !== -o.victory) err('victory steal mismatch');
      // 勝利点は予選1試合目から 5・10・15、決勝20
      if (!g.result.draw && Math.abs(res.pts[i].victory) !== Tour.victoryFor(kind, T.round)) err('victory amount', kind, T.round, res.pts[i].victory);
      // 宝石：見つけたら相手から1つ奪う（増えも減りもしない・マイナスにならない）
      if (res.pts[i].gems !== -o.gems) err('gem steal mismatch');
      if ((p.gems | 0) !== (was.gems | 0) + res.pts[i].gems) err('gems not moved', was.gems, res.pts[i].gems, p.gems);
      if (p.gems < 0) err('negative gems');
      if (res.pts[i].treasure !== res.pts[i].gems * Tour.GEM_PTS) err('gem points');
    });
    return g;
  };
  for (let r = 0; r < 3; r++) {
    T.round = r;
    // 方針はラウンドのはじめに全員分を決める（画面と同じ）
    const plans = {}, keeps = {};
    for (let id = 0; id < 4; id++) { plans[id] = AI.tourSetupPlan(T, id, 'prelim'); keeps[id] = AI.tourItemKeep(T, id, 'prelim'); }
    for (const [a, b] of T.rounds[r]) play(a, b, 'prelim', { setupPlan: [plans[a], plans[b]], itemKeep: [keeps[a], keeps[b]] });
  }
  // 持ち点の合計：はじめの合計（100点×4人＝400点）から、スピードペナルティで失った分だけ減る（v12.16で相手に渡さない自滅点になったため）
  { const tsum = T.players.reduce((a, p) => a + Tour.total(p), 0), gsum = T.players.reduce((a, p) => a + p.gems, 0);
    const spdLostSum = T.players.reduce((a, p) => a + (p.pts.spdLost || 0), 0);
    if (tsum !== 4 * (Tour.START + Tour.GEMS * Tour.GEM_PTS) - spdLostSum) err('points not conserved', tsum, spdLostSum);
    if (gsum !== 4 * Tour.GEMS) err('gems not conserved', gsum); }
  for (const p of T.players) if (Tour.total(p) < 0) st.negative = (st.negative || 0) + 1;
  const [f1, f2] = Tour.finalists(T);
  st.qualifyById[f1]++; st.qualifyById[f2]++;
  for (const id of [f1, f2]) st.itemsAtFinal += Tour.items(T.players[id]);
  const choice = AI.tourChooseFirst(T, f1);
  if (choice === 'draft') st.draftChoice++;
  const g = play(f1, f2, 'final', { first: choice === 'first' ? 0 : 1, setupPlan: [AI.tourSetupPlan(T, f1, 'final'), AI.tourSetupPlan(T, f2, 'final')] });
  if (g) {
    st.finals++;
    const champ = g.result.winner === 0 ? f1 : f2;
    st.champById[champ]++;
    st.champPts += Tour.total(T.players[champ]);
    if (g.result.winner === g.first) st.firstWinsFinal++;
    if (!g.draft || g.draft.picks[0].length !== 4 || g.draft.picks[1].length !== 4) err('final draft not 4 each');
  }
  st.tours++;
}
st.msPerMatch = +(st.msPerMatch / st.matches).toFixed(1);
st.itemsPerPrelim = +(st.itemsPerPrelim / ((st.matches - st.finals) * 2)).toFixed(2);
st.itemsAtFinal = +(st.itemsAtFinal / (st.finals * 2)).toFixed(2);
st.placedPieces.prelim = +(st.placedPieces.prelim / ((st.matches - st.finals) * 2)).toFixed(2);
st.placedPieces.final = +(st.placedPieces.final / (st.finals * 2)).toFixed(2);
st.champPts = +(st.champPts / st.finals).toFixed(1);
st.prelimTurns = +(st.prelimTurns / (st.matches - st.finals)).toFixed(1);
st.finalTurns = +(st.finalTurns / st.finals).toFixed(1);
st.firstWinsFinal = +(100 * st.firstWinsFinal / st.finals).toFixed(1);
st.totalSec = +((Date.now() - t0) / 1000).toFixed(1);
console.log(st);
