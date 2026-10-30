/* サーチバトル — シミュレーター（計算用のエンジン）
 * CPUだけの大会を回して、試合ごとの結果を小さな記録に残し、点数のルールを当てはめて集計する。
 *  ・CPUの置き方・アイテムの使い方・推理は持ち点を見ないので、試合の中身は点数のルールに左右されない。
 *    だから同じ試合結果に、別の点数のルール（はじめの持ち点・宝石・勝利点）を当てはめ直せる。
 *    決勝の顔ぶれ（予選1位・2位）が変わったときだけ、決勝を回し直す（予選の後の大会の状態を記録してある）
 * ブラウザでは window.SBSim（Web Worker の中でも使う）、Node では module.exports として公開する。
 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const E = isNode ? require('./engine.js') : root.SBEngine;
  const AI = isNode ? require('./ai.js') : root.SBAI;
  const { Tour } = E;

  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  // いまのゲームの点数のルール
  const DEFAULT_RULES = { start: Tour.START, gems: Tour.GEMS, gemPts: Tour.GEM_PTS, vic: Tour.VICTORY_BY.slice(), speed: Tour.SPEED.slice() };
  const PERSONA_KEYS = ['std', 'mass', 'save', 'steady', 'items'];
  const PERSONA_NAMES = { std: '標準', mass: '物量型', save: 'キューブ温存型', steady: '堅実型', items: 'アイテム浪費型' };

  // 1試合の記録（小さく）。k＝P（予選）/F（決勝）、r＝何試合目（0〜2、決勝は3）、a・b＝大会の番号、f＝先攻、w＝勝者（引き分けは-1）、
  // at＝撃破したブロック数、tf＝相手のトレジャーを見つけたか、t＝ターン数、pl＝置いたキューブの数、lo＝失ったキューブの数、it＝使ったアイテムの数
  function compactMatch(g, kind, round, a, b) {
    const sum = g.summary(), r = g.result || { winner: -1, draw: true };
    const it = [0, 0];
    for (const e of g.events) if (e.type === 'item' && e.actor != null) it[e.actor]++;
    return {
      k: kind === 'final' ? 'F' : 'P', r: round, a, b, f: g.first === 0 ? a : b, w: r.draw ? -1 : (r.winner === 0 ? a : b),
      at: [sum[0].attack, sum[1].attack], tf: [sum[0].treasureFound ? 1 : 0, sum[1].treasureFound ? 1 : 0], t: g.turn,
      pl: [sum[0].placed.length, sum[1].placed.length], lo: [sum[0].lost.length, sum[1].lost.length], it,
    };
  }
  const hash3 = (a, b, c) => (Math.imul(a | 0, 2654435761) ^ Math.imul((b + 1) * 97 + (c + 1) * 13, 40503)) | 0;

  // 予選の後の大会の状態から、決勝（f1＝予選1位、f2＝2位）を戦う。予選1位は「先攻」を選ぶ（CPUの決め方）
  function playFinal(post, f1, f2, seed) {
    const T = typeof post === 'string' ? JSON.parse(post) : post;
    const rng = mulberry32(hash3(seed, f1, f2));
    const choice = AI.tourChooseFirst(T, f1);
    const g = new E.Game(Object.assign(Tour.matchOpts(T, f1, f2, 'final', { first: choice === 'first' ? 0 : 1, setupPlan: [AI.tourSetupPlan(T, f1, 'final'), AI.tourSetupPlan(T, f2, 'final')] }), { rng }));
    AI.autoMatch(g);
    return compactMatch(g, 'final', 3, f1, f2);
  }

  // CPUだけの大会を1つ回す。rules は決勝の顔ぶれを決めるのに使う（予選の試合の中身には関係しない）
  function runTour(seed, rules, withFinal) {
    rules = rules || DEFAULT_RULES;
    const rng = mulberry32(seed);
    const T = Tour.create({ rng, cpu: [true, true, true, true] });
    const m = [];
    for (let r = 0; r < 3; r++) {
      T.round = r;
      const plans = {}, keeps = {};
      for (let id = 0; id < 4; id++) { plans[id] = AI.tourSetupPlan(T, id, 'prelim'); keeps[id] = AI.tourItemKeep(T, id, 'prelim'); }
      for (const [a, b] of T.rounds[r]) {
        const g = new E.Game(Object.assign(Tour.matchOpts(T, a, b, 'prelim', { setupPlan: [plans[a], plans[b]], itemKeep: [keeps[a], keeps[b]] }), { rng }));
        AI.autoMatch(g);
        m.push(compactMatch(g, 'prelim', r, a, b));
        Tour.apply(T, a, b, g, 'prelim');
      }
    }
    const rec = { v: E.VERSION, seed, p: [0, 1, 2, 3].map((id) => Tour.persona(T, id) || 'std'), lotto: T.players.map((p) => +p.lotto.toFixed(6)), m, finals: {} };
    // 決勝を回し直すための、予選の後の大会の状態（試合の記録とログは除く）
    rec.post = JSON.stringify(Object.assign({}, T, { results: [], log: [] }));
    if (withFinal !== false) {
      const [f1, f2] = finalistsOf(rec, rules);
      rec.finals[f1 + '-' + f2] = playFinal(rec.post, f1, f2, seed);
    }
    return rec;
  }

  // ---------------- 点数のルールを当てはめる ----------------
  function normRules(r) {
    r = Object.assign({}, DEFAULT_RULES, r || {});
    r.vic = (r.vic || DEFAULT_RULES.vic).slice(0, 4).map((x) => +x || 0);
    while (r.vic.length < 4) r.vic.push(r.vic[r.vic.length - 1] || 0);
    r.start = +r.start || 0; r.gems = Math.max(0, r.gems | 0); r.gemPts = +r.gemPts || 0;
    // スピードペナルティ（予選だけ。負けた側の減点）：index＝決着したターン（0は使わない）
    const SPN = DEFAULT_RULES.speed.length;
    r.speed = [0].concat((r.speed || DEFAULT_RULES.speed).slice(1, SPN).map((x) => Math.max(0, +x || 0)));
    while (r.speed.length < SPN) r.speed.push(0);
    return r;
  }
  const startTotal = (rules) => rules.start + rules.gems * rules.gemPts;
  // スピードペナルティの表記（後ろの0は省く。例：24/21/18/15/12/9/6/3）
  const speedLabel = (rules) => { const a = (rules.speed || []).slice(1); while (a.length && !a[a.length - 1]) a.pop(); return a.length ? a.join('/') : 'なし'; };
  // 1試合の持ち点の増減（m の a・b の順）。宝石は持っていなければ奪えない
  function applyMatch(st, m, rules) {
    const A = st[m.a], B = st[m.b];
    const v = m.k === 'F' ? rules.vic[3] : rules.vic[m.r];
    A.total += m.at[0] - m.at[1]; B.total += m.at[1] - m.at[0];
    A.take += m.at[0]; B.take += m.at[1];
    if (m.w === m.a) { A.total += v; B.total -= v; A.wins++; B.losses++; }
    else if (m.w === m.b) { B.total += v; A.total -= v; B.wins++; A.losses++; }
    // スピードペナルティ（予選だけ。v12.16）：負けた側だけ減らす（勝った側には渡さない自滅点）
    if (m.k === 'P' && m.w >= 0) { const sp = rules.speed[m.t] || 0; if (sp) { const L = m.w === m.a ? B : A; L.total -= sp; } }
    if (m.tf[0] && B.gems > 0) { B.gems--; A.gems++; A.total += rules.gemPts; B.total -= rules.gemPts; }
    if (m.tf[1] && A.gems > 0) { A.gems--; B.gems++; B.total += rules.gemPts; A.total -= rules.gemPts; }
  }
  // rounds 試合目までの順位（同点は 勝ち数 → 撃破ブロック数 → 抽選）。low＝途中でいちばん減ったときの持ち点
  function standing(rec, rules, rounds) {
    const st = [0, 1, 2, 3].map((id) => ({ id, total: startTotal(rules), wins: 0, losses: 0, take: 0, gems: rules.gems, lotto: rec.lotto[id], low: startTotal(rules) }));
    for (const m of rec.m) if (m.r < rounds) { applyMatch(st, m, rules); st[m.a].low = Math.min(st[m.a].low, st[m.a].total); st[m.b].low = Math.min(st[m.b].low, st[m.b].total); }
    const order = st.slice().sort((x, y) => y.total - x.total || y.wins - x.wins || y.take - x.take || y.lotto - x.lotto);
    return { st, order };
  }
  function finalistsOf(rec, rules) { const o = standing(rec, normRules(rules), 3).order; return [o[0].id, o[1].id]; }

  // ---------------- 集計 ----------------
  const pct = (a, b) => (b ? 100 * a / b : null);
  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const quant = (xs, q) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]; };
  function summarize(recs, rulesIn) {
    const rules = normRules(rulesIn);
    const noGem = Object.assign({}, rules, { gemPts: 0 });
    const N = recs.length;
    const P = {}; for (const k of PERSONA_KEYS) P[k] = { n: 0, nf: 0, qual: 0, champ: 0, fin: 0, finWin: 0, pts: [], wins: 0, placed: 0, placedN: 0, items: 0, itemsN: 0 };
    const c = { r3change: 0, last2in: 0, lead1out: 0, w: [[0, 0], [0, 0], [0, 0], [0, 0]], wonR1: [0, 0], lostR1: [0, 0], wonR3: [0, 0],
      tie: 0, tieWins: 0, tieTake: 0, tieLotto: 0, topTie: 0, treChange: 0,
      firstPre: [0, 0], firstFin: [0, 0], turnsPre: [], turnsFin: [], placedPre: [], placedFin: [], itemsPre: [], itemsFin: [], lostPre: [],
      foundPre: [0, 0], foundFin: [0, 0], both: 0, one: 0, none: 0, gemDist: {}, champ: [], runnerAbove: 0, finals: 0, missingFinal: 0,
      lowPrelim: Infinity, lowAll: Infinity, negPrelim: 0 };
    for (const rec of recs) {
      const S1 = standing(rec, rules, 1), S2 = standing(rec, rules, 2), S3 = standing(rec, rules, 3);
      const q2 = new Set([S2.order[0].id, S2.order[1].id]), q3 = new Set([S3.order[0].id, S3.order[1].id]);
      if (![...q3].every((id) => q2.has(id))) c.r3change++;
      if (q3.has(S2.order[3].id)) c.last2in++;
      if (!q3.has(S1.order[0].id)) c.lead1out++;
      for (const x of S3.st) { const wv = Math.min(3, x.wins); c.w[wv][1]++; if (q3.has(x.id)) c.w[wv][0]++; c.lowPrelim = Math.min(c.lowPrelim, x.low); if (x.low < 0) c.negPrelim++; c.gemDist[x.gems] = (c.gemDist[x.gems] || 0) + 1; }
      const Z = standing(rec, noGem, 3).order; if (!(q3.has(Z[0].id) && q3.has(Z[1].id))) c.treChange++;
      const b = S3.order[1], d = S3.order[2];
      if (b.total === d.total) { c.tie++; if (b.wins !== d.wins) c.tieWins++; else if (b.take !== d.take) c.tieTake++; else c.tieLotto++; }
      if (S3.order[0].total === S3.order[1].total) c.topTie++;
      for (const m of rec.m) {
        if (m.w >= 0) {
          c.firstPre[1]++; if (m.w === m.f) c.firstPre[0]++;
          const lo = m.w === m.a ? m.b : m.a;
          if (m.r === 0) { c.wonR1[1]++; if (q3.has(m.w)) c.wonR1[0]++; c.lostR1[1]++; if (q3.has(lo)) c.lostR1[0]++; }
          if (m.r === 2) { c.wonR3[1]++; if (q3.has(m.w)) c.wonR3[0]++; }
        }
        c.turnsPre.push(m.t); c.placedPre.push(m.pl[0], m.pl[1]); c.itemsPre.push(m.it[0], m.it[1]); c.lostPre.push(m.lo[0], m.lo[1]);
        c.foundPre[0] += m.tf[0] + m.tf[1]; c.foundPre[1] += 2;
        if (m.tf[0] && m.tf[1]) c.both++; else if (m.tf[0] || m.tf[1]) c.one++; else c.none++;
        for (const [id, k] of [[m.a, 0], [m.b, 1]]) { const pp = P[rec.p[id]]; if (!pp) continue; pp.placed += m.pl[k]; pp.placedN++; pp.items += m.it[k]; pp.itemsN++; }
      }
      for (const x of S3.st) { const pp = P[rec.p[x.id]]; if (!pp) continue; pp.n++; pp.pts.push(x.total); pp.wins += x.wins; if (q3.has(x.id)) pp.qual++; }
      // 決勝：同じ顔ぶれ（予選1位・2位）の決勝の記録があれば使う
      const f1 = S3.order[0].id, f2 = S3.order[1].id;
      const fm = rec.finals && rec.finals[f1 + '-' + f2];
      if (!fm) { c.missingFinal++; continue; }
      c.finals++;
      for (const x of S3.st) { const pp = P[rec.p[x.id]]; if (pp) pp.nf++; }
      if (fm.w >= 0) { c.firstFin[1]++; if (fm.w === fm.f) c.firstFin[0]++; }
      c.turnsFin.push(fm.t); c.placedFin.push(fm.pl[0], fm.pl[1]); c.itemsFin.push(fm.it[0], fm.it[1]);
      c.foundFin[0] += fm.tf[0] + fm.tf[1]; c.foundFin[1] += 2;
      const after = S3.st.map((x) => Object.assign({}, x));
      applyMatch(after, fm, rules);
      c.lowAll = Math.min(c.lowAll, ...after.map((x) => x.total));
      const champ = fm.w >= 0 ? fm.w : (after[f1].total >= after[f2].total ? f1 : f2);
      const runner = champ === f1 ? f2 : f1;
      c.champ.push(after[champ].total);
      if (after[runner].total > after[champ].total) c.runnerAbove++;
      for (const id of [f1, f2]) { const pp = P[rec.p[id]]; if (!pp) continue; pp.fin++; if (id === champ) { pp.champ++; pp.finWin++; } }
    }
    const persona = PERSONA_KEYS.map((k) => { const x = P[k]; return { key: k, name: PERSONA_NAMES[k], n: x.n, qual: pct(x.qual, x.n), champ: pct(x.champ, x.nf), finWin: pct(x.finWin, x.fin), pts: mean(x.pts), wins: x.n ? x.wins / x.n : null, placed: x.placedN ? x.placed / x.placedN : null, items: x.itemsN ? x.items / x.itemsN : null }; }).filter((x) => x.n > 0);
    const gemTotal = Object.values(c.gemDist).reduce((s, x) => s + x, 0);
    return {
      rules, startTotal: startTotal(rules), tours: N, finals: c.finals, missingFinal: c.missingFinal,
      persona,
      first: { prelim: pct(...c.firstPre), final: pct(...c.firstFin) },
      comeback: { r3change: pct(c.r3change, N), last2in: pct(c.last2in, N), lead1out: pct(c.lead1out, N),
        byWins: c.w.map(([q, n], k) => ({ wins: k, n, qual: pct(q, n) })), wonR1: pct(...c.wonR1), lostR1: pct(...c.lostR1), wonR3: pct(...c.wonR3) },
      ties: { line: pct(c.tie, N), byWins: pct(c.tieWins, N), byTake: pct(c.tieTake, N), lotto: pct(c.tieLotto, N), top: pct(c.topTie, N), count: c.tie },
      gems: { foundPrelim: pct(...c.foundPre), foundFinal: pct(...c.foundFin), both: pct(c.both, rec0len(recs)), one: pct(c.one, rec0len(recs)), none: pct(c.none, rec0len(recs)),
        dist: Object.keys(c.gemDist).map(Number).sort((a, b) => a - b).map((k) => ({ gems: k, share: pct(c.gemDist[k], gemTotal) })), changesFinalists: pct(c.treChange, N) },
      prize: { mean: mean(c.champ), min: c.champ.length ? Math.min(...c.champ) : null, max: c.champ.length ? Math.max(...c.champ) : null, p10: quant(c.champ, 0.1), p50: quant(c.champ, 0.5), p90: quant(c.champ, 0.9),
        runnerAbove: pct(c.runnerAbove, c.finals), list: c.champ },
      low: { prelim: isFinite(c.lowPrelim) ? c.lowPrelim : null, all: isFinite(c.lowAll) ? c.lowAll : null, negativeShare: pct(c.negPrelim, N * 4) },
      play: { turnsPrelim: mean(c.turnsPre), turnsFinal: mean(c.turnsFin), placedPrelim: mean(c.placedPre), placedFinal: mean(c.placedFin), itemsPrelim: mean(c.itemsPre), itemsFinal: mean(c.itemsFin), lostPrelim: mean(c.lostPre) },
    };
  }
  function rec0len(recs) { return recs.reduce((s, r) => s + r.m.length, 0); }
  // 点数のルールを変えたときに、まだ戦っていない決勝（顔ぶれ）。{ i: 記録の番号, f1, f2 }
  function missingFinals(recs, rulesIn) {
    const rules = normRules(rulesIn), out = [];
    recs.forEach((rec, i) => { const [f1, f2] = finalistsOf(rec, rules); if (!(rec.finals && rec.finals[f1 + '-' + f2]) && rec.post) out.push({ i, f1, f2 }); });
    return out;
  }
  // 記録を保存するとき（予選の後の大会の状態は大きいので除く）
  function slim(rec) { const o = Object.assign({}, rec); delete o.post; return o; }

  const api = { DEFAULT_RULES, PERSONA_KEYS, PERSONA_NAMES, mulberry32, runTour, playFinal, standing, finalistsOf, normRules, startTotal, speedLabel, summarize, missingFinals, slim };
  if (isNode) module.exports = api;
  else root.SBSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
