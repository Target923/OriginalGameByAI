/* サーチバトル — CPU
 * 人間と同じ情報（自分の盤面・攻撃ログ・防御ログ・アイテム状況）だけで推論する。
 *  1. 確定推論：◎ごとに「ありうる配置」を列挙し、すべての事実と矛盾しない組み合わせを全探索。
 *     候補が1つに絞れた個体だけアンサーする（失敗しない）。
 *  2. 確率推論：未発見の個体について、×・ヒット・アイテム結果と矛盾しない配置の密度から
 *     各マスに個体がいる確率を求め、索敵に使う。
 */
(function (root) {
  'use strict';
  const E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.SBEngine;
  const { SHAPES, SHAPES_BY_SIZE, ITEM_KEYS, ORIENT, CATS, placements, bit, popcount, bitsOf, lineMask, cellsFor, blockDist, nodeDegree } = E;
  // ノードショットの答え（つながりの数 0〜3）の出方の目安：CPUの配置で測った、個体のあるマスのうちの割合
  const NODE_PRIOR = [0, 0.6, 0.37, 0.03];
  const CAT_INDEX = {}; CATS.forEach((c, i) => { CAT_INDEX[c] = i; });
  // 実験用：プレイヤーごとの方針の上書き（ふだんは空＝標準の方針）
  const policy = [{}, {}];
  // 未発見の個体数の見積もり方（0＝旧方式、1＝見つかった数を考慮、2＝さらに重ならない分を証拠に数えない）。
  // CPU同士の対戦とキャリブレーションの検証で 2 がいちばん良かった
  const CALIB_DEFAULT = 2;

  // ------------------------------------------------------------------
  // 事実の整理
  // ------------------------------------------------------------------
  function currentCounts(kb, N) {
    const res = { all: null, size: {}, cat: {}, lines: [] };
    const matchDead = (q, d) => q.kind === 'all' || (q.kind === 'size' ? d.size === q.value : d.cat === q.value);
    const matchAdd = (q) => q.kind === 'all' || (q.kind === 'size' ? q.value === 1 : q.value === 'キューブ');
    for (const q of kb.counts) {
      if (q.kind === 'line') {
        if (kb.warps.some((w) => w.t > q.t) || kb.adds.some((a) => a.t > q.t)) continue;
        // サーチライン＝その列・行にかかっている個体の数 k と、そのマスの数 n（v12.12）。その後に撃破された個体の分を引く。
        // その後にバズーカの分解があると、破片の数だけ個体が増える（分解された個体がかかっていたかは分からない）ので、k は使わない
        const lm = lineMask(q.line, q.index, N);
        let n = q.n;
        let k = q.k != null && !(kb.splits || []).some((sp) => sp.t > q.t) ? q.k : null;
        for (const d of kb.deads) {
          if (d.t <= q.t || !(d.mask & lm)) continue;
          n -= popcount(d.mask & lm);
          if (k != null) k--;
        }
        res.lines.push({ mask: lm, n, k });
        continue;
      }
      // バズーカで分解があった後は、分解された個体の形・マス数が分からないので、それより前の個数は使えない
      if ((kb.splits || []).some((sp) => sp.t > q.t)) continue;
      let n = q.n;
      for (const d of kb.deads) if (d.t > q.t && matchDead(q, d)) n--;
      for (const a of kb.adds) if (a.t > q.t && matchAdd(q)) n++;
      if (q.kind === 'all') res.all = n;
      else if (q.kind === 'size') res.size[q.value] = n;
      else res.cat[q.value] = n;
    }
    return res;
  }

  function buildContext(kb, N) {
    const NN = N * N;
    const intervals = [];
    for (const d of kb.deads) intervals.push({ mask: d.mask, end: d.t });
    for (const w of kb.warps) intervals.push({ mask: w.oldMask, end: w.t });
    const explained = (c, t) => { for (const iv of intervals) if ((iv.mask & bit(c)) && t < iv.end) return true; return false; };

    let deadMask = 0; for (const d of kb.deads) deadMask |= d.mask;
    let oldMaskAll = 0; for (const w of kb.warps) oldMaskAll |= w.oldMask;

    const xs = [];
    for (const k of kb.calls) if (k.r === 'x') xs.push({ c: k.c, t: k.t });
    for (const e of kb.empties) xs.push({ c: e.c, t: e.t });
    let xMaskAll = 0; for (const x of xs) xMaskAll |= bit(x.c);
    const xMaskAfter = (t0) => { let m = 0; for (const x of xs) if (x.t > t0) m |= bit(x.c); return m; };
    const xMaskBetween = (t0, t1) => { let m = 0; for (const x of xs) if (x.t > t0 && x.t < t1) m |= bit(x.c); return m; };
    const oldMaskAfter = (t0) => { let m = 0; for (const w of kb.warps) if (w.t > t0) m |= w.oldMask; return m; };
    const oldMaskBefore = (t0) => { let m = 0; for (const w of kb.warps) if (w.t < t0) m |= w.oldMask; return m; };

    const counts = currentCounts(kb, N);
    let lineZeroMask = 0;
    const lineMax = [];
    for (const L of counts.lines) { if (L.n <= 0) lineZeroMask |= L.mask; else lineMax.push(L); }

    // 説明のつかないヒット＝今もそこにいる個体への命中
    const latest = new Map();
    for (const k of kb.calls) if (k.r !== 'x' && !explained(k.c, k.t)) latest.set(k.c, k);
    const U = Array.from(latest.values()).sort((a, b) => a.t - b.t);
    const groups = U.filter((k) => k.r === 'oo').map((k) => ({ num: k.num, c: k.c, t: k.t }));
    const oList = U.filter((k) => k.r === 'o').map((k) => ({ c: k.c, t: k.t }));
    let ooMask = 0; for (const g of groups) ooMask |= bit(g.c);
    let hitMask = 0; for (const u of U) hitMask |= bit(u.c);
    const Ucell = new Map(U.map((u) => [u.c, u]));

    // ペアショット（どの2マスでも）：
    //  同じ個体 → 2マスの持ち主は今も同じ（どちらのマスからも個体が去っていなければ）
    //  同じではない → 今も同じではない（どちらかがその前からのヒット、またはその後ワープがなければ）
    const warpedAfter = (t) => kb.warps.some((w) => w.t > t);
    // バズーカの分解：その前に調べた「同じ個体」「形・マス数・つながり」は、分解された個体のマスだったなら使えない。
    // 分解された個体ではないと言い切れるマスの事実はそのまま使う：
    //  ・分解の前からヒットしていて、撃破されなかったマス（分解ではその個体のヒット済みのマスがすべて撃破されるので、別の個体）
    //  ・撃ち込んだマスから5ブロック以上離れたマス（個体は5マス以下でつながっているので、撃ち込んだマスから4ブロック以内）
    const splitList = (kb.splits || []).map((sp) => { let km = 0; for (const c of sp.killed) km |= bit(c); return { t: sp.t, c: sp.c, km }; });
    const safeFromSplit = (c, sp) => {
      const u = Ucell.get(c);
      if (u && u.t < sp.t && !(sp.km & bit(c))) return true;
      return Math.abs(Math.floor(c / N) - Math.floor(sp.c / N)) + Math.abs((c % N) - (sp.c % N)) > 4;
    };
    // t より後の分解のどれかで、c が分解された個体のマスだったかもしれない
    const splitTouches = (c, t) => splitList.some((sp) => sp.t > t && !safeFromSplit(c, sp));
    const hitBefore = (c, t) => { const u = Ucell.get(c); return !!u && u.t < t; };
    const pairs = [];
    const derivedOccs = [];
    for (const p of kb.pairs) {
      if (p.same) {
        // 同じ個体の2マス：どちらかが分解された個体でなければ、もう片方も同じ個体なので分解されていない
        if (explained(p.a, p.t) || explained(p.b, p.t)) continue;
        if (splitList.some((sp) => sp.t > p.t && !safeFromSplit(p.a, sp) && !safeFromSplit(p.b, sp))) continue;
        pairs.push(p);
        derivedOccs.push({ c: p.a, t: p.t, cat: null }, { c: p.b, t: p.t, cat: null, dup: true });
      } else if (hitBefore(p.a, p.t) || hitBefore(p.b, p.t) || !warpedAfter(p.t)) pairs.push(p);
    }
    // バズーカで分解した個体：撃ち込んだマスがヒット済みでなければ、そこに1マスキューブが残る（撃破・ワープで説明がつくまで）
    const splits = [];
    for (const sp of (kb.splits || [])) {
      let killedMask = 0;
      for (const c of sp.killed) killedMask |= bit(c);
      const targetFrag = !(killedMask & bit(sp.c)) && !explained(sp.c, sp.t) ? sp.c : -1;
      splits.push({ t: sp.t, c: sp.c, killedMask, targetFrag });
    }
    // 生きていると分かっている破片のマス（ヒットしたマスは◎の個体として数えるので除く。同じマスに2回撃っても1つ）
    let fragMask = 0;
    for (const sp of splits) if (sp.targetFrag >= 0) fragMask |= bit(sp.targetFrag);
    fragMask &= ~hitMask;
    // ステルス：使われた時刻だけが分かる。全マスに当たっても生きている個体は、それより前にステルスになっていたはず
    const stealthTimes = (kb.stealths || []).map((x) => x.t).sort((a, b) => a - b);
    const occs = kb.occs.filter((o) => !explained(o.c, o.t))
      .map((o) => ((o.cat || o.size || o.deg != null) && splitTouches(o.c, o.t) ? { c: o.c, t: o.t, cat: null, src: o.src } : o))
      .concat(derivedOccs);
    const occMaskBefore = (t0) => { let m = 0; for (const o of occs) if (o.t < t0) m |= bit(o.c); return m; };

    const deadSetup = { 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const d of kb.deads) if (!d.isAdd && d.size >= 2) deadSetup[d.size]++;
    const stockBound = {};
    for (const s of [2, 3, 4, 5]) stockBound[s] = kb.stock[s] - deadSetup[s];
    const PL = placements(N);
    const sizeAllowed = (s) => stockBound[s] > 0 && (counts.size[s] == null || counts.size[s] > 0);
    const catAllowed = (cat) => counts.cat[cat] == null || counts.cat[cat] > 0;

    const groupIndexByNum = new Map(groups.map((g, i) => [g.num, i]));

    // ワープ・アッドで動いた個体の追跡（索敵用の近似）
    const wEnt = [];
    const addEnt = kb.adds.map((a) => ({ t: a.t, col: a.col, alive: true }));
    const sortedWarps = kb.warps.slice().sort((a, b) => a.t - b.t);
    for (const w of sortedWarps) {
      if (w.size === 1) {
        const col = bitsOf(w.oldMask)[0] % N;
        const pick = addEnt.filter((a) => a.alive && a.t < w.t && a.col === col).pop()
          || wEnt.filter((e) => e.alive && e.key === 'A1' && e.t < w.t).pop()
          || addEnt.filter((a) => a.alive && a.t < w.t).pop();
        if (pick) pick.alive = false;
      } else {
        const neverMoved = !(w.oldMask & (xMaskBetween(-1, w.t) | oldMaskBefore(w.t)));
        if (!neverMoved) {
          const prev = wEnt.filter((e) => e.alive && e.key === w.key && e.t < w.t && !(w.oldMask & e.oldMask) && !(w.oldMask & xMaskBetween(e.t, w.t))).pop();
          if (prev) prev.alive = false;
        }
      }
      wEnt.push({ t: w.t, key: w.key, size: w.size, cat: w.cat, oldMask: w.oldMask, treasure: !!w.treasure, alive: true });
    }
    for (const d of kb.deads.slice().sort((a, b) => a.t - b.t)) {
      if (d.isAdd) {
        const col = bitsOf(d.mask)[0] % N;
        const pick = addEnt.filter((a) => a.alive && a.t < d.t && a.col === col).pop()
          || wEnt.filter((e) => e.alive && e.key === 'A1' && e.t < d.t).pop()
          || addEnt.filter((a) => a.alive && a.t < d.t).pop();
        if (pick) pick.alive = false;
        continue;
      }
      const cands = wEnt.filter((e) => e.alive && e.key === d.key && e.t < d.t && !(d.mask & e.oldMask) && !(d.mask & xMaskBetween(e.t, d.t)));
      const neverMoved = !(d.mask & (xMaskBetween(-1, d.t) | oldMaskBefore(d.t)));
      if (cands.length && !neverMoved) cands[cands.length - 1].alive = false;
    }

    return {
      N, NN, kb, PL, explained, deadMask, oldMaskAll, xs, xMaskAll, xMaskAfter, xMaskBetween, oldMaskAfter, oldMaskBefore,
      counts, lineZeroMask, lineMax, U, Ucell, groups, oList, ooMask, hitMask, occs, occMaskBefore,
      deadSetup, stockBound, sizeAllowed, catAllowed, groupIndexByNum, pairs, splits, fragPossible: splits.length > 0, fragMask, stealthTimes,
      wEnt: wEnt.filter((e) => e.alive), addEnt: addEnt.filter((a) => a.alive),
    };
  }

  // sizeW：マス数ごとの重み（実験用。既定はどのマス数も同じ）
  function shapePrior(ctx, sizeW) {
    const sizes = [2, 3, 4, 5].filter((s) => ctx.sizeAllowed(s));
    let wsum = 0; for (const s of sizes) wsum += sizeW ? (sizeW[s] || 0) : 1;
    const list = [];
    for (const s of sizes) {
      const keys = SHAPES_BY_SIZE[s].filter((k) => ctx.PL[k].length && ctx.catAllowed(SHAPES[k].cat));
      const ws = wsum > 0 ? (sizeW ? (sizeW[s] || 0) : 1) / wsum : 1 / sizes.length;
      for (const k of keys) list.push({ key: k, size: s, prior: ws / keys.length });
    }
    return list;
  }

  // ------------------------------------------------------------------
  // ◎ごとの候補配置（健全：本当の配置を必ず含む）
  // ------------------------------------------------------------------
  // サーチシェイプ（形状）・サーチサイズ（マス数）・ノードショット（つながりの数）の結果と矛盾しないか
  function factsOK(P, occs, tp, N) {
    for (const o of occs) {
      if (o.t <= tp || !(P.mask & bit(o.c))) continue;
      if (o.cat && o.cat !== P.cat) return false;
      if (o.size && o.size !== P.size) return false;
      if (o.deg != null && nodeDegree(P.mask, o.c, N) !== o.deg) return false;
    }
    return true;
  }

  function groupCands(g, ctx, priorByKey) {
    const out = new Map();
    const others = ctx.ooMask & ~bit(g.c);
    let early = 0;
    for (const u of ctx.U) if (u.t < g.t) early |= bit(u.c);
    const base = others | early | ctx.deadMask | ctx.lineZeroMask;
    const add = (P, branch) => {
      const ex = out.get(P.mask);
      if (ex) { if (ex.branches.indexOf(branch) < 0) ex.branches.push(branch); return; }
      // 全マスに当たっているのに生きている＝ステルス。その最後のヒットより前にステルスが使われていなければありえない
      let full = (P.mask & ~ctx.hitMask) === 0, lastHit = -1;
      if (full) {
        for (const c of P.cells) { const u = ctx.Ucell.get(c); lastHit = Math.max(lastHit, u ? u.t : Infinity); }
        if (!ctx.stealthTimes.length || ctx.stealthTimes[0] >= lastHit) return;
      }
      const pr = priorByKey[P.key] || 0.05;
      out.set(P.mask, { mask: P.mask, key: P.key, size: P.size, cat: P.cat, cells: P.cells, branches: [branch], w: pr / ctx.PL[P.key].length, full, lastHit });
    };
    const fa = base | ctx.xMaskAll | ctx.oldMaskAll;
    // 1マスキューブ（バズーカの破片）は、ステルスで当たっても残っているときだけ◎になりうる
    const sizes = ctx.fragPossible ? [1, 2, 3, 4, 5] : [2, 3, 4, 5];
    for (const s of sizes) {
      if (s === 1) {
        // 1マスキューブは分解のときにできるので、それより前の×やワープ前の位置とは関係ない。◎のマスそのものだけを考える
        if (ctx.counts.size[1] === 0 || !ctx.catAllowed('キューブ')) continue;
        const P = ctx.PL.A1.find((x) => x.mask === bit(g.c));
        if (P && !(P.mask & base) && factsOK(P, ctx.occs, 0, ctx.N)) add(P, 'a');
        continue;
      }
      if (!ctx.sizeAllowed(s)) continue;
      for (const key of SHAPES_BY_SIZE[s]) {
        if (!ctx.catAllowed(SHAPES[key].cat)) continue;
        for (const P of ctx.PL[key]) {
          if (!(P.mask & bit(g.c)) || (P.mask & fa)) continue;
          if (!factsOK(P, ctx.occs, 0, ctx.N)) continue;
          add(P, 'a');
        }
      }
    }
    for (const w of ctx.kb.warps) {
      if (w.t >= g.t || w.size < 2) continue;
      if (!ctx.sizeAllowed(w.size) || !ctx.catAllowed(w.cat)) continue;
      const fb = base | ctx.xMaskAfter(w.t) | w.oldMask | ctx.oldMaskAfter(w.t) | ctx.occMaskBefore(w.t);
      for (const P of ctx.PL[w.key]) {
        if (!(P.mask & bit(g.c)) || (P.mask & fb)) continue;
        if (!factsOK(P, ctx.occs, w.t, ctx.N)) continue;
        add(P, 'w');
      }
    }
    return Array.from(out.values());
  }

  // ------------------------------------------------------------------
  // ◎個体の組み合わせを全探索（重なり・○の帰属・アイテム結果・在庫を同時に満たすもの）
  // ------------------------------------------------------------------
  function jointEnumerate(ctx, cap, rng) {
    const G = ctx.groups, nG = G.length, NN = ctx.NN;
    const res = { total: 0, count: 0, nodes: 0, aborted: false, inconsistent: false, cellW: new Float64Array(NN), candW: G.map((g) => new Float64Array(g.cands.length)), sameW: null, nodeW: new Map(),
      qSize: [0, 1, 2, 3, 4, 5].map(() => new Float64Array(nG + 1)), qCat: CATS.map(() => new Float64Array(nG + 1)) };
    if (!nG) return res;
    if (G.some((g) => !g.cands.length)) { res.inconsistent = true; return res; }
    const order = G.map((g, i) => i).sort((a, b) => G[a].cands.length - G[b].cands.length);
    const assign = new Int32Array(nG).fill(-1);
    const owner = new Int32Array(NN).fill(-1);
    const tOf = G.map((g) => g.t);
    const oList = ctx.oList;
    const counts = ctx.counts;
    const sameW = new Float64Array(NN * NN);
    res.sameW = sameW;
    const szCnt = new Int32Array(6), ctCnt = new Int32Array(CATS.length);
    const candOrder = G.map((g) => {
      const idx = g.cands.map((c, i) => i);
      if (rng) for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp; }
      return idx;
    });

    function setOwner(mask, v) { let m = mask; while (m) { const lb = m & -m; owner[31 - Math.clz32(lb)] = v; m ^= lb; } }
    function partialOK(depth, used) {
      for (const o of oList) {
        const ow = owner[o.c];
        if (ow >= 0) { if (tOf[ow] >= o.t) return false; continue; }
        let ok = false;
        for (let d = depth + 1; d < nG && !ok; d++) {
          const gj = order[d];
          if (tOf[gj] >= o.t) continue;
          for (const cd of G[gj].cands) if ((cd.mask & bit(o.c)) && !(cd.mask & used)) { ok = true; break; }
        }
        if (!ok) return false;
      }
      return true;
    }
    // サーチライン（v12.12）の条件で、探索の途中でも枝を刈る（v12.13）。order[0..depth] の◎個体だけで判断する。
    //  ・マスの数・個体の数は、◎個体を足すほど増えるので、途中で n・k を超えたらその先も超える
    //  ・ちょうど k になったら、残りの◎個体はその列・行にかからない（かかれば k を超える）ので、マスもいまの数で n に決まる
    // 終わりでしか確かめていなかった頃は、厚い盤面（3・4マスの7個体など）で全探索が打ち切られると、近似の部分探索が
    // 条件を満たす組み合わせに1つも届かず、「矛盾」と判定することがあった（invariants の決勝で1件）
    function lineOK(depth) {
      for (const L of ctx.lineMax) {
        let cells = 0, pcs = 0;
        for (let d = 0; d <= depth; d++) { const i = order[d]; const m = G[i].cands[assign[i]].mask & L.mask; if (m) { pcs++; cells += popcount(m); } }
        if (cells > L.n) return false;
        if (L.k != null) {
          const fr = popcount(ctx.fragMask & L.mask);
          if (pcs + fr > L.k) return false;
          if (pcs + fr === L.k && cells + fr !== L.n) return false;
        }
      }
      return true;
    }
    function finalOK() {
      if (counts.all != null && nG > counts.all) return false;
      const bySize = {}, byCat = {};
      for (let i = 0; i < nG; i++) {
        const cd = G[i].cands[assign[i]];
        bySize[cd.size] = (bySize[cd.size] || 0) + 1;
        byCat[cd.cat] = (byCat[cd.cat] || 0) + 1;
      }
      for (const s in bySize) {
        if (bySize[s] > ctx.stockBound[s]) return false;
        if (counts.size[s] != null && bySize[s] > counts.size[s]) return false;
      }
      for (const c in byCat) if (counts.cat[c] != null && byCat[c] > counts.cat[c]) return false;
      for (const L of ctx.lineMax) {
        // マスの数：◎個体がその列・行で埋めるマス ≦ n。
        // 個体の数（分かっていれば）：かかっている◎個体＋生きている破片 ≦ k。ちょうど k なら、ほかの個体はかかっていないので、マスもちょうど n
        let cells = 0, pcs = 0;
        for (let i = 0; i < nG; i++) { const m = G[i].cands[assign[i]].mask & L.mask; if (m) { pcs++; cells += popcount(m); } }
        if (cells > L.n) return false;
        if (L.k != null) {
          const fr = popcount(ctx.fragMask & L.mask);
          if (pcs + fr > L.k) return false;
          if (pcs + fr === L.k && cells + fr !== L.n) return false;
        }
      }
      for (const p of ctx.pairs) {
        const oa = owner[p.a], ob = owner[p.b];
        if (p.same) { if (oa !== ob) return false; }
        else if (oa >= 0 && oa === ob) return false;
      }
      // 全マス命中で生きている個体には、それぞれ別の（より前の）ステルスが要る
      let fulls = null;
      for (let i = 0; i < nG; i++) { const cd = G[i].cands[assign[i]]; if (cd.full) (fulls || (fulls = [])).push(cd.lastHit); }
      if (fulls) {
        if (fulls.length > ctx.stealthTimes.length) return false;
        fulls.sort((a, b) => a - b);
        // 締め切り（最後のヒット）の早い順に、いちばん早いステルスを割り当てる
        let j = 0;
        for (const dl of fulls) { if (j >= ctx.stealthTimes.length || ctx.stealthTimes[j] >= dl) return false; j++; }
      }
      return true;
    }
    // ノードショットを撃ったときの結果の分布（0＝◎個体のマスではない、1〜4＝つながり0〜3）。撃破済み以外のマス
    const probe = [];
    for (let c = 0; c < NN; c++) if (!(ctx.deadMask & bit(c))) probe.push(c);
    for (const c of probe) res.nodeW.set(c, new Float64Array(5));
    function dfs(depth, used, w) {
      if (res.aborted) return;
      if (++res.nodes > cap) { res.aborted = true; return; }
      if (depth === nG) {
        if (!finalOK()) return;
        res.total += w; res.count++;
        for (let i = 0; i < nG; i++) {
          res.candW[i][assign[i]] += w;
          const cells = G[i].cands[assign[i]].cells;
          for (let a = 0; a < cells.length; a++) for (let b = 0; b < cells.length; b++) if (a !== b) sameW[cells[a] * NN + cells[b]] += w;
        }
        let m = used;
        while (m) { const lb = m & -m; res.cellW[31 - Math.clz32(lb)] += w; m ^= lb; }
        for (const c of probe) { const gi = owner[c]; res.nodeW.get(c)[gi >= 0 ? 1 + nodeDegree(G[gi].cands[assign[gi]].mask, c, ctx.N) : 0] += w; }
        // サーチキューブを使ったときの結果の分布用：◎個体のうち、各マス数・各形状に当てはまる数
        szCnt.fill(0); ctCnt.fill(0);
        for (let i = 0; i < nG; i++) { const cd = G[i].cands[assign[i]]; szCnt[cd.size]++; ctCnt[CAT_INDEX[cd.cat]]++; }
        for (let sz = 2; sz <= 5; sz++) res.qSize[sz][szCnt[sz]] += w;
        for (let ci = 0; ci < CATS.length; ci++) res.qCat[ci][ctCnt[ci]] += w;
        return;
      }
      const gi = order[depth], g = G[gi];
      for (const k of candOrder[gi]) {
        const cd = g.cands[k];
        if (cd.mask & used) continue;
        assign[gi] = k;
        setOwner(cd.mask, gi);
        if (partialOK(depth, used | cd.mask) && lineOK(depth)) dfs(depth + 1, used | cd.mask, w * cd.w);
        setOwner(cd.mask, -1);
        if (res.aborted) break;
      }
      assign[gi] = -1;
    }
    dfs(0, 0, 1);
    if (res.count === 0 && !res.aborted) res.inconsistent = true;
    return res;
  }

  function solveGroups(ctx, rng) {
    let joint = jointEnumerate(ctx, 120000, null);
    let exact = !joint.aborted;
    if (joint.aborted) {
      // 大きすぎるときは順序を変えた部分探索を重ねて近似する
      const acc = jointEnumerate(ctx, 1, null);
      acc.aborted = false;
      for (let rep = 0; rep < 24; rep++) {
        const part = jointEnumerate(ctx, 6000, rng || Math.random);
        acc.total += part.total; acc.count += part.count;
        for (let c = 0; c < ctx.NN; c++) acc.cellW[c] += part.cellW[c];
        for (let i = 0; i < ctx.groups.length; i++) for (let k = 0; k < acc.candW[i].length; k++) acc.candW[i][k] += part.candW[i][k];
        if (part.sameW) for (let x = 0; x < part.sameW.length; x++) acc.sameW[x] += part.sameW[x];
        for (const [c, arr] of part.nodeW) { const dst = acc.nodeW.get(c); if (dst) for (let k = 0; k < arr.length; k++) dst[k] += arr[k]; }
        for (let sz = 0; sz < part.qSize.length; sz++) for (let k = 0; k < part.qSize[sz].length; k++) acc.qSize[sz][k] += part.qSize[sz][k];
        for (let ci = 0; ci < part.qCat.length; ci++) for (let k = 0; k < part.qCat[ci].length; k++) acc.qCat[ci][k] += part.qCat[ci][k];
      }
      acc.inconsistent = acc.count === 0;
      joint = acc;
    }
    joint.exact = exact;
    return joint;
  }

  // 分解した個体の破片が確実にいるマス（分解の後に相手がワープ・ステルスを使っていないときだけ。破片は動かず、当たれば撃破される）
  //  置き方の条件：撃ち込んだマスと、分解で撃破したマスを含む。×（分解の前の最後のワープより後）・ヒットして生きているマス（別の個体）・
  //  分解の前に撃破された個体のマス・2マス以上の撃破された個体のマスを含まない
  function fragCertainCells(ctx, sp) {
    const kb = ctx.kb;
    if (kb.warps.some((w) => w.t > sp.t)) return [];
    if ((kb.stealths || []).some((x) => x.t > sp.t)) return [];
    // 前にも分解していて、今回撃破したマスがないときは、撃ち込んだのが前の分解の破片（1マス）かもしれない（マス数は伏せられる）。
    // そのときは隣に破片がいるとは限らないので、確定させない（ヒット済みのマスがあれば、破片ではなく2マス以上の個体）
    if (!sp.killedMask && ctx.splits.some((s0) => s0.t < sp.t)) return [];
    const fixed = sp.killedMask | bit(sp.c);
    const nFixed = popcount(fixed);
    let lw = -1;
    for (const w of kb.warps) if (w.t < sp.t && w.t > lw) lw = w.t;
    let forb = ctx.xMaskBetween(lw, Infinity) | ctx.hitMask;
    let fragDead = 0;
    for (const d of kb.deads) {
      if (d.t < sp.t || d.size > 1) forb |= d.mask;
      else if (d.t > sp.t) fragDead |= d.mask;
    }
    forb &= ~fixed;
    let common = 0, any = false;
    for (const key in SHAPES) {
      const sz = SHAPES[key].size;
      if (sz < 2 || sz < nFixed) continue;
      for (const Pl of ctx.PL[key]) {
        if ((Pl.mask & fixed) !== fixed || (Pl.mask & forb)) continue;
        common = any ? (common & Pl.mask) : Pl.mask;
        any = true;
        if (!(common & ~fixed)) return [];
      }
    }
    if (!any) return [];
    const m = common & ~fixed & ~fragDead & ~ctx.deadMask;
    return bitsOf(m);
  }

  // ------------------------------------------------------------------
  // 解析本体
  // ------------------------------------------------------------------
  function analyze(kb, N, rng, opt) {
    const ctx = buildContext(kb, N);
    const prior = shapePrior(ctx, opt && opt.sizePrior);
    const priorByKey = {};
    for (const p of prior) priorByKey[p.key] = p.prior;
    for (const g of ctx.groups) g.cands = groupCands(g, ctx, priorByKey);
    const joint = solveGroups(ctx, rng);
    const NN = ctx.NN;

    // 確定個体
    const certain = [];
    ctx.groups.forEach((g, i) => {
      if (g.cands.length === 1) { certain.push({ gi: i, cand: g.cands[0] }); return; }
      if (joint.exact && !joint.inconsistent) {
        const live = [];
        for (let k = 0; k < g.cands.length; k++) if (joint.candW[i][k] > 0) live.push(k);
        if (live.length === 1) certain.push({ gi: i, cand: g.cands[live[0]] });
      }
    });
    // バズーカで分解した個体の、撃ち込んだマスに残った1マスキューブ（撃破もワープもされていなければ確定）
    for (const sp of ctx.splits) {
      if (sp.targetFrag < 0 || certain.some((x) => x.cand.mask === bit(sp.targetFrag))) continue;
      certain.push({ gi: -1, cand: { mask: bit(sp.targetFrag), key: 'A1', size: 1, cat: 'キューブ', cells: [sp.targetFrag] } });
    }
    // ほかの破片：分解した個体の置き方（撃ち込んだマスと撃破したマスを含む）のどれにも入っているマスには、破片が確実に残っている（v12.6）。
    // 例：角に撃ち込んで分解し、角の隣の片方が×なら、もう片方の隣は破片。アンサー（1マス）で撃破できる
    for (const sp of ctx.splits) {
      for (const c of fragCertainCells(ctx, sp)) {
        if (certain.some((x) => x.cand.mask & bit(c))) continue;
        certain.push({ gi: -1, cand: { mask: bit(c), key: 'A1', size: 1, cat: 'キューブ', cells: [c] } });
      }
    }

    const targetP = new Float64Array(NN);
    let certainCover = 0, anyCover = 0;
    if (joint.total > 0) {
      for (let c = 0; c < NN; c++) {
        const p = joint.cellW[c] / joint.total;
        targetP[c] = p;
        if (p > 0.9999) certainCover |= bit(c);
        if (p > 0) anyCover |= bit(c);
      }
    } else {
      // 矛盾時のフォールバック：各◎の候補の和集合
      for (const g of ctx.groups) {
        const tot = g.cands.reduce((s, cd) => s + cd.w, 0) || 1;
        for (const cd of g.cands) for (const c of cd.cells) targetP[c] = Math.min(1, targetP[c] + cd.w / tot);
      }
      for (let c = 0; c < NN; c++) if (targetP[c] > 0) anyCover |= bit(c);
    }
    for (const u of ctx.U) { certainCover |= bit(u.c); anyCover |= bit(u.c); }

    for (const ce of certain) if (ce.gi < 0) { certainCover |= ce.cand.mask; anyCover |= ce.cand.mask; }
    const H = huntModel(ctx, prior, joint, certainCover, anyCover, opt || {}, priorByKey);
    return { ctx, joint, certain, targetP, certainCover, anyCover, hunt: H };
  }

  // 未発見の個体がいる確率（索敵用）
  function huntModel(ctx, prior, joint, certainCover, anyCover, opt, priorByKey) {
    const N = ctx.N, NN = ctx.NN, PL = ctx.PL;
    const forbidA = ctx.xMaskAll | ctx.deadMask | ctx.oldMaskAll | ctx.hitMask | ctx.lineZeroMask | certainCover;

    // 形ごとの「証拠を避けられた割合」と被覆密度
    // calib 2 以上：見つかった個体・撃破済みの個体のマスとは最初から重ならない（個体は重ねて置けない）ので、
    // 「そこを避けた」ことは証拠に数えない。分母を「それらと重ならない置き方の数」にする
    const calibLv = opt.calib != null ? opt.calib : CALIB_DEFAULT;
    const occupied = ctx.hitMask | certainCover | ctx.deadMask | ctx.oldMaskAll;
    const bySize = {};
    const shapeW = {};   // 未発見の個体がその形である重み（サーチキューブの見積もり用）
    const shapeCov = {}; // 形ごとの被覆（形状の個体数が分かったときに使う）
    for (const sh of prior) {
      let T = PL[sh.key].length;
      if (calibLv >= 2) { T = 0; for (const P of PL[sh.key]) if (!(P.mask & occupied)) T++; if (!T) { shapeW[sh.key] = 0; continue; } }
      let V = 0;
      const cov = new Float64Array(NN);
      for (const P of PL[sh.key]) {
        if (P.mask & forbidA) continue;
        V++;
        for (const c of P.cells) cov[c] += 1;
      }
      shapeW[sh.key] = sh.prior * V / T;
      shapeCov[sh.key] = { cov, V, size: sh.size, cat: SHAPES[sh.key].cat };
      const b = bySize[sh.size] || (bySize[sh.size] = { q: 0, dens: new Float64Array(NN), z: 0, pr: 0 });
      b.pr += sh.prior;
      b.q += sh.prior * V / T;
      for (let c = 0; c < NN; c++) b.dens[c] += sh.prior * cov[c] / T;
    }
    const sizes = Object.keys(bySize).map(Number);
    let q = 0;
    for (const s of sizes) q += bySize[s].q;
    if (calibLv >= 2) { let pz = 0; for (const s of sizes) pz += bySize[s].pr; if (pz > 0) q /= pz; }

    // ◎個体のサイズ期待値
    const EgSize = { 2: 0, 3: 0, 4: 0, 5: 0 };
    if (joint.total > 0) {
      ctx.groups.forEach((g, i) => {
        for (let k = 0; k < g.cands.length; k++) EgSize[g.cands[k].size] += joint.candW[i][k] / joint.total;
      });
    }
    // 位置の分かっている未ヒット個体（サーチシェイプ・トレジャー的中）
    const occPseudo = [];
    for (const o of ctx.occs) {
      if (o.dup || (anyCover & bit(o.c))) continue;
      const ex = occPseudo.find((x) => x.c === o.c);
      if (ex) { if (o.cat) ex.cat = o.cat; if (o.size) ex.size = o.size; if (o.deg != null) ex.deg = o.deg; continue; }
      occPseudo.push({ c: o.c, t: o.t, cat: o.cat || null, size: o.size || 0, deg: o.deg != null ? o.deg : null });
    }
    const relocAlive = ctx.wEnt.length + ctx.addEnt.length;
    const nG = ctx.groups.length;

    let Etotal;
    let kDist = [1];   // 未発見の個体数の分布（索敵とサーチキューブの見積もり用）
    if (ctx.counts.all != null) {
      Etotal = Math.max(0, ctx.counts.all - nG - relocAlive - occPseudo.length);
      kDist = []; for (let k = 0; k < Math.round(Etotal); k++) kDist.push(0); kDist.push(1);
    } else {
      const known = Object.values(ctx.deadSetup).reduce((a, b) => a + b, 0) + nG + ctx.wEnt.length + occPseudo.length + ctx.splits.length;
      const pri = (opt.kPrior && opt.kPrior[N]) || (N === 4 ? [0, 0.10, 0.20, 0.27, 0.22, 0.12, 0.06, 0.03] : [0, 0.05, 0.12, 0.20, 0.22, 0.18, 0.11, 0.07, 0.03, 0.02]);
      let Z = 0, S = 0;
      const kd = [];
      // 見つかった個体が known 体あるとき、総数 K の見込みには K!/(K-known)!（どの個体が見つかったかの選び方）が掛かる。
      // これを入れないと「もう残っていない」と思い込みやすい
      for (let K = Math.max(1, known); K < pri.length; K++) {
        const k = K - known;
        let ff = 1;
        if (calibLv >= 1) for (let j = 0; j < known; j++) ff *= (K - j);
        const p = pri[K] * ff * Math.pow(q, k);
        Z += p; S += k * p;
        kd[k] = p;
      }
      Etotal = Z > 0 ? S / Z : 0;
      if (Z > 0) { kDist = []; for (let k = 0; k < kd.length; k++) kDist.push((kd[k] || 0) / Z); }
    }
    // サイズ別の期待個数
    const Es = {};
    let knownSum = 0;
    const free = [];
    for (const s of sizes) {
      if (ctx.counts.size[s] != null) {
        const relocS = ctx.wEnt.filter((e) => e.size === s).length;
        Es[s] = Math.max(0, ctx.counts.size[s] - EgSize[s] - relocS);
        knownSum += Es[s];
      } else free.push(s);
    }
    if (ctx.counts.all == null) Etotal = Math.max(Etotal, knownSum);
    const rest = Math.max(0, Etotal - knownSum);
    let fq = 0;
    for (const s of free) fq += bySize[s].q;
    for (const s of free) Es[s] = fq > 0 ? rest * bySize[s].q / fq : 0;

    // 形ごとの「まだ見つけていない個数」の期待値。サーチキューブで形状の個体数が分かっていれば、それに合わせる
    const Esh = {};
    for (const key in shapeCov) {
      const x = shapeCov[key], b = bySize[x.size];
      Esh[key] = b && b.q > 0 && Es[x.size] ? Es[x.size] * shapeW[key] / b.q : 0;
    }
    for (const cat of CATS) {
      if (ctx.counts.cat[cat] == null) continue;
      let EgCat = 0;
      if (joint.total > 0) ctx.groups.forEach((g, i) => { g.cands.forEach((cd, k) => { if (cd.cat === cat) EgCat += joint.candW[i][k] / joint.total; }); });
      const relocC = ctx.wEnt.filter((e) => SHAPES[e.key] && SHAPES[e.key].cat === cat).length;
      const target = Math.max(0, ctx.counts.cat[cat] - EgCat - relocC);
      let cur = 0, wsum = 0;
      for (const key in Esh) if (shapeCov[key].cat === cat) { cur += Esh[key]; wsum += shapeW[key]; }
      for (const key in Esh) {
        if (shapeCov[key].cat !== cat) continue;
        Esh[key] = cur > 0 ? Esh[key] * target / cur : (wsum > 0 ? target * shapeW[key] / wsum : 0);
      }
    }
    for (const s of sizes) { Es[s] = 0; }
    for (const key in Esh) Es[shapeCov[key].size] = (Es[shapeCov[key].size] || 0) + Esh[key];
    if (Object.keys(ctx.counts.cat).length) { let t = 0; for (const key in Esh) t += Esh[key]; Etotal = t; }
    const occU = new Float64Array(NN);
    for (const key in Esh) {
      const x = shapeCov[key];
      if (!Esh[key] || !x.V) continue;
      for (let c = 0; c < NN; c++) occU[c] += Esh[key] * x.cov[c] / x.V;
    }
    const notOcc = new Float64Array(NN);
    for (let c = 0; c < NN; c++) notOcc[c] = 1 - Math.min(0.98, occU[c]);

    // ワープで動いた個体
    const entP = [];
    for (const e of ctx.wEnt) {
      if (e.size < 2) {
        // ワープしたアッド：1マスの候補
        const forb = ctx.xMaskAfter(e.t) | ctx.deadMask | e.oldMask | ctx.oldMaskAfter(e.t) | ctx.hitMask | certainCover;
        const cells = [];
        for (let c = 0; c < NN; c++) if (!(forb & bit(c))) cells.push(c);
        if (!cells.length) continue;
        const p = new Float64Array(NN);
        for (const c of cells) p[c] = 1 / cells.length;
        entP.push({ p, ent: e });
        continue;
      }
      const forb = ctx.xMaskAfter(e.t) | ctx.deadMask | e.oldMask | ctx.oldMaskAfter(e.t) | ctx.hitMask | ctx.occMaskBefore(e.t) | ctx.lineZeroMask | certainCover;
      const p = new Float64Array(NN);
      let V = 0;
      for (const P of PL[e.key]) { if (P.mask & forb) continue; V++; for (const c of P.cells) p[c] += 1; }
      if (!V) continue;
      const hitLater = ctx.groups.some((g) => g.t > e.t);
      const scale = (hitLater ? 0.5 : 1) / V;
      for (let c = 0; c < NN; c++) p[c] *= scale;
      entP.push({ p, ent: e });
    }
    // アッド（列だけ分かっている）
    for (const a of ctx.addEnt) {
      const forb = ctx.xMaskAfter(a.t) | ctx.deadMask | ctx.oldMaskAfter(a.t) | ctx.hitMask | certainCover;
      const cells = [];
      for (let r = 0; r < N; r++) { const c = r * N + a.col; if (!(forb & bit(c))) cells.push(c); }
      if (!cells.length) continue;
      const p = new Float64Array(NN);
      for (const c of cells) p[c] = 1 / cells.length;
      entP.push({ p, ent: a, isAdd: true });
    }
    // 位置の分かっている未ヒット個体
    for (const o of occPseudo) {
      const p = new Float64Array(NN);
      if (o.size === 1 || o.deg === 0) { p[o.c] = 1; entP.push({ p, occ: o }); continue; }   // 1マスキューブ（サーチサイズ1・ノード0）
      let Z = 0;
      for (const sh of prior) {
        if (o.cat && SHAPES[sh.key].cat !== o.cat) continue;
        if (o.size && sh.size !== o.size) continue;
        const T = PL[sh.key].length;
        for (const P of PL[sh.key]) {
          if (!(P.mask & bit(o.c)) || (P.mask & (forbidA & ~bit(o.c)))) continue;
          if (o.deg != null && nodeDegree(P.mask, o.c, N) !== o.deg) continue;
          const w = sh.prior / T;
          Z += w;
          for (const c of P.cells) p[c] += w;
        }
      }
      if (Z <= 0) continue;
      for (let c = 0; c < NN; c++) p[c] /= Z;
      entP.push({ p, occ: o });
    }

    // バズーカで分解した個体の、ほかの破片がいそうなマス（分解した個体の置き方：撃破したマスと撃ち込んだマスを含む）
    for (const sp of ctx.splits) {
      const fixed = sp.killedMask | bit(sp.c);
      const nFixed = popcount(fixed);
      let lw = -1, fw = Infinity;
      for (const w of ctx.kb.warps) { if (w.t < sp.t && w.t > lw) lw = w.t; if (w.t > sp.t && w.t < fw) fw = w.t; }
      let forb = ctx.xMaskBetween(lw, fw) | ctx.hitMask | certainCover;
      let fragDead = 0;
      for (const d of ctx.kb.deads) {
        if (d.t < sp.t || d.size > 1) forb |= d.mask;
        else if (d.t > sp.t) fragDead |= d.mask;
      }
      forb &= ~fixed;
      const p = new Float64Array(NN);
      let Z = 0;
      for (const key in SHAPES) {
        const sz = SHAPES[key].size;
        if (sz < 2 || sz < nFixed) continue;
        const w0 = ((priorByKey && priorByKey[key]) || 0.05) / PL[key].length;
        for (const Pl of PL[key]) {
          if ((Pl.mask & fixed) !== fixed || (Pl.mask & forb)) continue;
          Z += w0;
          for (const c of Pl.cells) if (!(fixed & bit(c)) && !(fragDead & bit(c))) p[c] += w0;
        }
      }
      if (Z > 0) { for (let c = 0; c < NN; c++) p[c] /= Z; entP.push({ p, frag: sp }); }
    }

    const P = new Float64Array(NN);
    for (let c = 0; c < NN; c++) {
      let none = notOcc[c];
      for (const e of entP) none *= 1 - Math.min(0.999, e.p[c]);
      P[c] = 1 - none;
    }
    // サーチラインの結果（その列・行で埋まっているマスの数）に合うように、列・行ごとに見込みを合わせる。
    // 分かっている「埋まっている」マス（ヒット・確定した個体）と「空き」（×・撃破済み）を除いた残りで、
    // ◎個体の候補が埋める見込みを引き、足りない分を見つけていない個体の見込みとして配り直す
    const lines = ctx.counts.lines.filter((L) => L.n > 0);
    if (lines.length) {
      const known1 = ctx.hitMask | certainCover;
      const known0 = lineKnownEmpty(ctx);
      const tP = (c) => (joint.total > 0 ? Math.min(1, joint.cellW[c] / joint.total) : 0);
      // 個体の数が分かっている列・行で、◎のマスがその列・行にある個体と生きている破片だけで k に届いていれば、
      // 見つけていない個体（と、ほかの◎個体）はその列・行にかかっていない
      const closed = lines.filter((L) => {
        if (L.k == null) return false;
        let m = 0;
        for (const g of ctx.groups) if (L.mask & bit(g.c)) m++;
        return m + popcount(ctx.fragMask & L.mask) >= L.k;
      });
      for (const L of closed) for (let c = 0; c < NN; c++) if (L.mask & bit(c)) P[c] = 0;
      for (let it = 0; it < 6; it++) {
        for (const L of lines) {
          if (closed.indexOf(L) >= 0) continue;
          let K = 0, T = 0, S = 0, room = 0;
          const freeCells = [];
          for (let c = 0; c < NN; c++) {
            if (!(L.mask & bit(c))) continue;
            if (known1 & bit(c)) { K++; continue; }
            if (known0 & bit(c)) continue;
            const t = tP(c);
            T += t; S += (1 - t) * P[c]; room += 1 - t;
            freeCells.push(c);
          }
          if (!freeCells.length) continue;
          const R = L.n - K - T;
          if (R <= 1e-6) { for (const c of freeCells) P[c] = 0; continue; }
          if (S > 1e-9) { const f = R / S; for (const c of freeCells) P[c] = Math.min(0.995, P[c] * f); }
          else if (room > 0) for (const c of freeCells) P[c] = Math.min(0.995, R / room);
        }
      }
    }
    return { P, occU, entP, Etotal, Es, q, occPseudo, kDist, shapeW };
  }

  function lineKnownEmpty(ctx) {
    let lastW = -1;
    for (const w of ctx.kb.warps) if (w.t > lastW) lastW = w.t;
    return ctx.deadMask | ctx.xMaskAfter(lastW) | ctx.lineZeroMask;
  }
  // サーチラインの見積もり：答え（その列・行にかかっている個体の数 k と、そのマスの数 n）の分布の情報量（v12.12）。
  //  マスごとに独立に「埋まっている」とみなし、列・行の並びで隣り合う埋まったマスは確率 LINE_SPLIT で別の個体とみなす
  //  （同じ個体は列・行の中で途切れない形だけなので、離れたマスは別の個体）。分かっているヒット・確定した個体は埋まっている、×・撃破済みは空き
  const LINE_SPLIT = 0.6;
  function lineOptions(A) {
    const ctx = A.ctx, N = ctx.N, P = A.hunt.P;
    const known1 = ctx.hitMask | A.certainCover, known0 = lineKnownEmpty(ctx);
    const done = new Set(ctx.counts.lines.map((L) => L.mask));
    const out = [];
    for (const line of ['row', 'col']) for (let i = 0; i < N; i++) {
      const lm = lineMask(line, i, N);
      if (done.has(lm)) continue;
      // 状態：[n][k][直前のマスが埋まっているか]
      let st = new Map([['0,0,0', 1]]);
      for (let j = 0; j < N; j++) {
        const c = line === 'row' ? i * N + j : j * N + i;
        let p;
        if (known1 & bit(c)) p = 1;
        else if (known0 & bit(c)) p = 0;
        else { const t = A.targetP[c]; p = Math.min(1, t + (1 - t) * P[c]); }
        const nx = new Map();
        const put = (key, w) => { if (w > 0) nx.set(key, (nx.get(key) || 0) + w); };
        for (const [key, w] of st) {
          const [n, k, prev] = key.split(',').map(Number);
          put(`${n},${k},0`, w * (1 - p));
          if (prev) { put(`${n + 1},${k + 1},1`, w * p * LINE_SPLIT); put(`${n + 1},${k},1`, w * p * (1 - LINE_SPLIT)); }
          else put(`${n + 1},${k + 1},1`, w * p);
        }
        st = nx;
      }
      const joint = new Map();
      for (const [key, w] of st) { const nk = key.slice(0, key.lastIndexOf(',')); joint.set(nk, (joint.get(nk) || 0) + w); }
      out.push({ params: { line, index: i }, H: entropyOf(Array.from(joint.values())) });
    }
    return out;
  }

  // ------------------------------------------------------------------
  // サーチキューブの見積もり
  //  結果＝「◎個体のうち当てはまる数」＋「まだ見つけていない個体のうち当てはまる数」。
  //  前者は全探索の分布、後者は索敵モデルの「未発見の個体数の分布」と「形ごとの重み」から求める。
  //  結果の分かれ方（情報量）のうち、◎個体の絞り込みに効く分を infoA として分けて返す
  // ------------------------------------------------------------------
  function entropyOf(arr) {
    let tot = 0, h = 0;
    for (let i = 0; i < arr.length; i++) tot += arr[i];
    if (tot <= 0) return 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] > 0) { const p = arr[i] / tot; h -= p * Math.log2(p); }
    return h;
  }
  function convolve(a, b) {
    const out = new Float64Array(a.length + b.length - 1);
    for (let i = 0; i < a.length; i++) if (a[i]) for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
    return out;
  }
  function binomDist(k, p) {
    const out = new Float64Array(k + 1);
    let c = 1;
    for (let i = 0; i <= k; i++) { out[i] = c * Math.pow(p, i) * Math.pow(1 - p, k - i); c = c * (k - i) / (i + 1); }
    return out;
  }
  function cubeOptions(A) {
    const ctx = A.ctx, H = A.hunt, J = A.joint;
    if (ctx.groups.length && !(J.total > 0)) return [];
    const queries = [];
    for (const s of [2, 3, 4, 5]) if (ctx.counts.size[s] == null && ctx.stockBound[s] > 0) queries.push({ kind: 'size', value: s, match: (key) => SHAPES[key].size === s });
    for (const c of CATS) if (ctx.counts.cat[c] == null) queries.push({ kind: 'cat', value: c, match: (key) => SHAPES[key].cat === c });
    let totalW = 0;
    for (const key in H.shapeW) totalW += H.shapeW[key];
    const out = [];
    for (const qy of queries) {
      // まだ見つけていない個体：k 個体いるとき、それぞれが当てはまる確率 p
      let pm = 0;
      for (const key in H.shapeW) if (qy.match(key)) pm += H.shapeW[key];
      const p = totalW > 0 ? pm / totalW : 0;
      const U = new Float64Array(H.kDist.length);
      for (let k = 0; k < H.kDist.length; k++) {
        if (!H.kDist[k]) continue;
        const b = binomDist(k, p);
        for (let i = 0; i <= k; i++) U[i] += H.kDist[k] * b[i];
      }
      // 場所の分かっている未ヒット個体（形状・マス数が分かっていれば、それで絞る）
      let R = U;
      for (const o of H.occPseudo) {
        let a = 0, z = 0;
        for (const key in H.shapeW) {
          if (o.cat && SHAPES[key].cat !== o.cat) continue;
          if (o.size && SHAPES[key].size !== o.size) continue;
          z += H.shapeW[key];
          if (qy.match(key)) a += H.shapeW[key];
        }
        const po = z > 0 ? a / z : 0;
        R = convolve(R, new Float64Array([1 - po, po]));
      }
      // ワープで動いた個体（形が分かっている）
      let shift = 0;
      for (const e of ctx.wEnt) if (SHAPES[e.key] && qy.match(e.key)) shift++;
      if (shift) { const t = new Float64Array(R.length + shift); for (let i = 0; i < R.length; i++) t[i + shift] = R[i]; R = t; }
      // ◎個体のうち当てはまる数
      let D = new Float64Array([1]);
      if (ctx.groups.length) {
        const arr = qy.kind === 'size' ? J.qSize[qy.value] : J.qCat[CAT_INDEX[qy.value]];
        D = new Float64Array(arr.length);
        for (let i = 0; i < arr.length; i++) D[i] = arr[i] / J.total;
      }
      const Hn = entropyOf(convolve(D, R)), HR = entropyOf(R), HD = entropyOf(D);
      out.push({ params: { kind: qy.kind, value: qy.value }, Hn, infoA: Math.max(0, Hn - HR), infoR: Math.max(0, Hn - HD) });
    }
    return out;
  }

  // ------------------------------------------------------------------
  // 判断
  // ------------------------------------------------------------------
  function H2(p) { if (p <= 0 || p >= 1) return 0; return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)); }
  function pickMax(cells, score, rng) {
    let best = -Infinity, list = [];
    for (const c of cells) {
      const s = score(c);
      if (s > best + 1e-9) { best = s; list = [c]; } else if (Math.abs(s - best) <= 1e-9) list.push(c);
    }
    if (!list.length) return null;
    return list[Math.floor((rng || Math.random)() * list.length)];
  }
  function callableCells(game, pi) {
    const out = [];
    for (let c = 0; c < game.NN; c++) if (game.isCallable(pi, c)) out.push(c);
    return out;
  }

  function chooseCall(game, pi, A) {
    const rng = game.rng;
    const me = game.players[pi];
    A = A || analyze(me.kb, game.N, rng, policy[pi]);
    let cells = callableCells(game, pi);
    let exclude = 0;
    for (const ce of A.certain) exclude |= ce.cand.mask;
    const pool = cells.filter((c) => !(exclude & bit(c)));
    if (pool.length) cells = pool;
    const certainSet = new Set(A.certain.map((x) => x.gi));
    const uncertain = A.ctx.groups.filter((g, i) => !certainSet.has(i));
    const hp = A.hunt.P;
    if (uncertain.length && A.joint.total > 0) {
      const scored = cells.map((c) => ({ c, s: H2(A.targetP[c]) + 0.35 * (1 - A.targetP[c]) * hp[c] }));
      const best = Math.max(...scored.map((x) => x.s));
      if (best > 0.02) return pickMax(cells, (c) => H2(A.targetP[c]) + 0.35 * (1 - A.targetP[c]) * hp[c], rng);
    }
    const best = pickMax(cells, (c) => hp[c] + 0.15 * A.targetP[c] * (1 - A.targetP[c]), rng);
    return best != null ? best : cells[Math.floor(rng() * cells.length)];
  }

  // 確定した個体のアンサー（1件ずつ。成功後は解析し直す）。
  // コールできるマスが1つも残っていないのに倒せていない個体（ステルスなど）がいるときだけ、いちばんありそうな置き方に賭ける
  function chooseAnswer(game, pi) {
    const me = game.players[pi];
    const A = analyze(me.kb, game.N, game.rng, policy[pi]);
    if (!A.certain.length) {
      if (game.hasCallable(pi) || !A.ctx.groups.length) return null;
      let best = null, bw = -1;
      A.ctx.groups.forEach((g, i) => g.cands.forEach((cd, k) => {
        const w = A.joint.total > 0 ? A.joint.candW[i][k] : cd.w;
        if (w > bw) { bw = w; best = cd; }
      }));
      return best ? best.cells.slice() : null;
    }
    A.certain.sort((a, b) => b.cand.size - a.cand.size);
    return A.certain[0].cand.cells.slice();
  }

  function chooseTreasure(game, pi, A) {
    const rng = game.rng;
    const me = game.players[pi];
    const kb = me.kb;
    const N = game.N, NN = game.NN;
    A = A || analyze(kb, N, rng, policy[pi]);
    const ctx = A.ctx;
    const lastGray = kb.grays.length ? kb.grays[kb.grays.length - 1] : -1;
    const logs = kb.tlogs.filter((l) => l.t > lastGray);
    const occ = new Float64Array(NN);
    if (lastGray >= 0) {
      // トレジャー入りの個体がワープした後：その個体の候補を優先
      const ent = A.hunt.entP.find((e) => e.ent && e.ent.treasure);
      if (ent) for (let c = 0; c < NN; c++) occ[c] += ent.p[c];
      ctx.groups.forEach((g, i) => {
        if (g.t <= lastGray || !(A.joint.total > 0)) return;
        g.cands.forEach((cd, k) => { const w = A.joint.candW[i][k] / A.joint.total; for (const c of cd.cells) occ[c] += w; });
      });
    }
    let any = false;
    for (let c = 0; c < NN; c++) if (occ[c] > 0) { any = true; break; }
    if (!any) {
      for (const d of kb.deads) if (!d.isAdd) for (const c of d.cells) occ[c] = Math.max(occ[c], 0.8);
      for (let c = 0; c < NN; c++) occ[c] = Math.max(occ[c], A.targetP[c], A.hunt.P[c] * 0.9);
      for (const e of A.hunt.entP) if (e.isAdd) for (let c = 0; c < NN; c++) occ[c] = Math.max(0, occ[c] - e.p[c] * 0.5);
    }
    const sameKnown = (x, y) => {
      for (const d of kb.deads) if ((d.mask & bit(x)) && (d.mask & bit(y))) return 1;
      if (A.joint.sameW && A.joint.total > 0) return Math.min(1, A.joint.sameW[x * NN + y] / A.joint.total);
      return 0;
    };
    const dist = (x, y) => Math.abs(Math.floor(x / N) - Math.floor(y / N)) + Math.abs((x % N) - (y % N));
    const prior = policy[pi] && policy[pi].treasurePrior;
    const score = (x) => {
      let s = occ[x];
      if (s <= 0) return 0;
      if (prior) s *= prior[x];
      for (const l of logs) {
        if (l.r === 'H') continue;
        const d = dist(x, l.c);
        const same = sameKnown(x, l.c);
        if (l.r === 'N') {
          if (d === 1) continue;
          if (x === l.c) { s *= 0.05; continue; }
          s *= Math.max(same, d <= 4 ? 0.25 : 0.03);
        } else {
          if (x === l.c || d === 1) { s = 0; break; }
          s *= (1 - same) * (d <= 4 ? 0.85 : 1);
        }
      }
      return s;
    };
    const cells = [];
    for (let c = 0; c < NN; c++) if (game.isTreasureCallable(pi, c)) cells.push(c);
    const best = pickMax(cells, score, rng);
    return best != null ? best : cells[Math.floor(rng() * cells.length)];
  }

  // 相手から見た自分の個体の危険度
  function exposure(game, pi) {
    const foe = game.players[1 - pi];
    const me = game.players[pi];
    const B = analyze(foe.kb, game.N, game.rng);
    const out = new Map();
    for (const p of me.pieces) if (p.alive) out.set(p.id, { danger: 0, hitsLeft: p.size - popcount(p.hitMask), cands: Infinity });
    B.ctx.groups.forEach((g, i) => {
      const p = game.pieceAt(pi, g.c);
      if (!p) return;
      let live = 0;
      if (B.joint.exact && B.joint.total > 0) { for (let k = 0; k < g.cands.length; k++) if (B.joint.candW[i][k] > 0) live++; }
      else live = g.cands.length;
      const info = out.get(p.id);
      if (info) { info.cands = live; info.danger = live <= 0 ? 0 : 1 / live; }
    });
    return out;
  }

  // 次の相手の手番で自分の個体がすべてアンサーされる見込み（相手の推論で候補が1つに絞れている個体ほど危ない）
  function doomProb(game, pi) {
    const ex = exposure(game, pi);
    let p = 1;
    for (const piece of game.living(pi)) {
      if (piece.isAdd) continue;
      const e = ex.get(piece.id);
      p *= e ? e.danger : 0;
      if (p <= 0) break;
    }
    return p;
  }

  function bestWarpTarget(game, pi, piece) {
    const N = game.N;
    const opts = [];
    for (let t = 0; t < 8; t++) {
      const o = ORIENT[piece.shape][t];
      for (let r0 = 0; r0 + o.h <= N; r0++) for (let c0 = 0; c0 + o.w <= N; c0++) {
        const params = { pieceId: piece.id, t, r0, c0 };
        if (game.validateItem(pi, 'warp', params).ok) opts.push(params);
      }
    }
    if (!opts.length) return null;
    // 相手がすでに×を付けたマスを少し好む（見落とされやすい）
    const foeView = game.players[1 - pi].view;
    const score = (p) => {
      const cells = cellsFor(piece.shape, p.t, p.r0, p.c0, N);
      let s = 0;
      for (const c of cells) if (foeView.marks[c] && foeView.marks[c].r === 'x') s += 1;
      return s + game.rng() * 1.5;
    };
    opts.sort((a, b) => score(b) - score(a));
    return opts[0];
  }

  function bestAddCell(game, pi) {
    const N = game.N;
    let bestCells = [];
    for (let col = 0; col < N; col++) {
      const cells = [];
      for (let r = 0; r < N; r++) { const c = r * N + col; if (game.validateItem(pi, 'add', { cell: c }).ok) cells.push(c); }
      if (cells.length > bestCells.length || (cells.length === bestCells.length && game.rng() < 0.5)) bestCells = cells;
    }
    if (!bestCells.length) return null;
    return bestCells[Math.floor(game.rng() * bestCells.length)];
  }

  // 防御のワープ：見破られかけた個体を逃がす
  function defensiveWarp(game, pi, free) {
    const me = game.players[pi];
    const living = game.living(pi);
    const livingReal = living.filter((p) => !p.isAdd);
    const ex = exposure(game, pi);
    let best = null, bestV = 0;
    for (const p of living) {
      if (p.isAdd) continue;
      const e = ex.get(p.id);
      if (!e) continue;
      const hits = popcount(p.hitMask);
      if (!hits) continue;
      const danger = Math.max(e.danger, e.hitsLeft <= 1 ? 0.9 : 0);
      const last = livingReal.length === 1 ? 4 : 0;
      const value = (p.size + last + (me.treasure && me.treasure.pieceId === p.id ? 1 : 0)) * danger;
      if (danger >= 0.5 && value > bestV && (p.size >= 3 || last)) { best = p; bestV = value; }
    }
    if (best && (free('warp') || best.size >= 4 || livingReal.length === 1)) {
      const tgt = bestWarpTarget(game, pi, best);
      if (tgt) return { key: 'warp', params: tgt };
    }
    return null;
  }

  // ステルス：使った時機から「どの個体か」を読まれないようにする。
  //  ・◎を受けた直後の個体には使わない（ステルスはアンサーを防げないので、小さい個体だと読まれてすぐ撃破される）
  //  ・序盤（1〜3ターン目）に、まだ当たっていない2〜3マスの個体へ先に付けておく（どれにするかは毎回ばらつかせる）
  //  ・最後の1個体だけは例外（どの個体かは相手も分かっているので、時機から読まれる情報がない）
  //  when: 'first'＝攻撃アイテムより先に判断、'spare'＝その手番に攻撃アイテムを使わなかったとき
  //  mode: 'early1'（既定：1〜3ターン目の手番のはじめ）／'early'（攻撃アイテムを使わなかった手番だけ）
  //        'reactive'（v10までの「あと1マスで撃破」の個体に使う方針。比較用）／'none'
  //  測定（各600局）：early1 は early より勝率 +5.5（予選）／+9.8（決勝）
  function chooseStealth(game, pi, when) {
    const pol = policy[pi] || {};
    const mode = pol.stealth || 'early1';
    const living = game.living(pi);
    const open = living.filter((p) => !p.stealth);
    if (!open.length || mode === 'none') return null;
    if (mode === 'reactive') {
      // v10までの方針（比較用）：あと1マスで撃破される個体か、最後の1個体
      if (when !== 'first') return null;
      const livingReal = living.filter((p) => !p.isAdd);
      let best = null, bestV = 0;
      for (const p of open) {
        const hitsLeft = p.size - popcount(p.hitMask);
        const v = (hitsLeft <= 1 ? 2 : 0) + (livingReal.length === 1 ? 1.5 : 0) + p.size * 0.1;
        if (v >= 1.5 && v > bestV) { bestV = v; best = p; }
      }
      return best;
    }
    if (when === 'first' && living.length === 1 && !living[0].stealth) return living[0];
    const from = pol.stealthFrom || 1, until = pol.stealthTurn || 3;
    if (game.turn < from || game.turn > until) return null;
    let cand = open.filter((p) => !p.hitMask && p.size >= 2 && p.size <= 3);
    if (!cand.length) return null;
    // stealthPick：'rand'（既定）／'big'（いちばん大きい個体）／'small'（いちばん小さい個体）
    if (pol.stealthPick === 'big' || pol.stealthPick === 'small') {
      const target = pol.stealthPick === 'big' ? Math.max(...cand.map((p) => p.size)) : Math.min(...cand.map((p) => p.size));
      cand = cand.filter((p) => p.size === target);
    }
    const pick = cand[Math.floor(game.rng() * cand.length)];
    if (mode === 'early' && when === 'spare') return pick;
    if (mode === 'early1' && when === 'first') return pick;
    return null;
  }

  // 攻撃用アイテム（相手フィールドに使うもの）
  function attackItem(game, pi, stage, A) {
    const pol = policy[pi] || {};
    const cubeMode = pol.cube || 'eig';
    const me = game.players[pi];
    const N = game.N, NN = game.NN;
    const free = (k) => itemOK(game, pi, k);
    const ctx = A.ctx;
    const certainSet = new Set(A.certain.map((x) => x.gi));
    const uncertain = ctx.groups.map((g, i) => i).filter((i) => !certainSet.has(i));
    if (uncertain.length && A.joint.total > 0) {
      // 絞り込み系はコールの結果を見てから使う
      if (stage === 'pre') return null;
      const entropy = (wmap) => { let tot = 0, h = 0; for (const k in wmap) tot += wmap[k]; for (const k in wmap) { const p = wmap[k] / tot; if (p > 0) h -= p * Math.log2(p); } return h; };
      // 候補の割れ方（情報量）がいちばん大きいアイテムを使う
      let best = null, bestH = 0.6;
      const consider = (key, params, h) => { if (h > bestH) { bestH = h; best = { key, params }; } };
      // サーチシェイプ（形状）・サーチサイズ（マス数）：候補が割れている◎
      for (const i of uncertain) {
        const g = ctx.groups[i];
        const catW = {}, sizeW = {};
        g.cands.forEach((cd, k) => { const w = A.joint.candW[i][k]; catW[cd.cat] = (catW[cd.cat] || 0) + w; sizeW[cd.size] = (sizeW[cd.size] || 0) + w; });
        if (free('shape')) consider('shape', { cell: g.c }, entropy(catW));
        if (free('number')) consider('number', { cell: g.c }, entropy(sizeW));
      }
      // ペアショット：ヒットのマスと、同じ個体か分からないマスの組
      if (free('pair') && A.joint.sameW) {
        const hits = ctx.U.filter((u) => me.view.marks[u.c] && !me.view.dead[u.c]).map((u) => u.c);
        for (const a of hits) for (let b = 0; b < NN; b++) {
          if (b === a || me.view.dead[b]) continue;
          const p = A.joint.sameW[a * NN + b] / A.joint.total;
          consider('pair', { a, b }, H2(Math.min(1, p)) * 0.95);
        }
      }
      // ノードショット：つながりの数（0〜3）か NoData の割れ方。
      // ◎個体のマスでない見込みの分は、見つけていない個体（つながりは目安の割合で）か空きに分ける
      if (free('node') && A.joint.nodeW) {
        const tot = A.joint.total;
        for (const [c, arr] of A.joint.nodeW) {
          if (me.view.dead[c]) continue;
          const out = arr[0] / tot;
          const q = Math.min(0.999, A.hunt.P[c]);
          const wmap = { nd: out * (1 - q) };
          for (let k = 0; k <= 3; k++) wmap[k] = arr[k + 1] / tot + out * q * NODE_PRIOR[k];
          consider('node', { cell: c }, entropy(wmap));
        }
      }
      // サーチライン：その列・行で埋まっているマスの数の割れ方（◎の候補と、見つけていない個体の両方に効く）
      if (free('line')) {
        const lp = pol.linePost != null ? pol.linePost : 0.5;
        for (const o of lineOptions(A)) consider('line', o.params, lp * o.H);
      }
      // サーチキューブ：◎個体の絞り込みに効く分＋まだ見つけていない個体の情報（少し割り引く）
      if (cubeMode === 'eig' && free('cube')) {
        const beta = pol.beta != null ? pol.beta : 0.3;
        for (const o of cubeOptions(A)) consider('cube', o.params, (1 - beta) * o.infoA + beta * o.Hn);
      }
      // バズーカ：◎のマスに撃ち込むと、その個体のヒット済みのマスをその場で撃破できる。
      // 全マスに当たっているのに残っている個体（ステルス）はまるごと撃破できる。
      // ただし分解すると、まだ当たっていないマスは1マスずつ当てないと撃破できなくなる（アンサー1回でまとめて撃破できなくなる）。
      // 測定では「ヒットが多い個体に使う」は勝率を下げた（決勝で使わない方が 71.7%）ので、既定は
      // 「全マスに当たっている見込みが80%以上の個体（ステルス）」に使う（50%以上より勝率 +5.3（決勝）／+3.2（予選））。
      // ほかは、負けそうなときにヒット済みのマスを撃破ポイントにしておくときだけ（下）。
      //  mode: 'smart'（既定）／'eh'（v11途中の方針：ヒットの見込みが bzMin 以上でも使う。比較用）／'never'
      //  bzWarp：相手がまだワープを使えるとき、ヒットの見込みがこの数以上なら先に撃破して進み具合を守る（既定は使わない）
      const bzMode = pol.bazooka || 'smart';
      if (free('bazooka') && bzMode !== 'never') {
        let bzF = null, bzH = null;
        for (const i of uncertain) {
          const g = ctx.groups[i];
          let eh = 0, pf = 0, tot = 0;
          g.cands.forEach((cd, k) => { const w = A.joint.candW[i][k]; tot += w; eh += w * popcount(cd.mask & ctx.hitMask); if (cd.full) pf += w; });
          if (!(tot > 0)) continue;
          eh /= tot; pf /= tot;
          if (!bzF || pf > bzF.pf || (pf === bzF.pf && eh > bzF.eh)) bzF = { eh, pf, cell: g.c };
          if (!bzH || eh > bzH.eh) bzH = { eh, pf, cell: g.c };
        }
        if (bzF && bzF.pf >= (pol.bzPf != null ? pol.bzPf : 0.8)) return { key: 'bazooka', params: { cell: bzF.cell } };
        // 負けそうなとき（次の相手の手番で全個体をアンサーされる見込みが50%以上）は、ヒット済みのマスを撃破ポイントにしておく。
        // 勝率は変わらず（4回の測定で平均50.5%）、決勝の得点が+0.8〜1.1pt。見込み30%以上で使うと勝率が下がった（46〜47%）
        const bzLast = pol.bzLast != null ? pol.bzLast : 1.0;
        if (bzH && bzLast !== false && bzH.eh >= bzLast && doomProb(game, pi) >= (pol.bzDoom != null ? pol.bzDoom : 0.5)) {
          return { key: 'bazooka', params: { cell: bzH.cell } };
        }
        if (bzH && bzMode === 'eh') {
          const bzMin = pol.bzMin != null ? pol.bzMin : 2.5;
          if (bzH.eh >= bzMin || (!best && bzH.eh >= bzMin - 0.5)) return { key: 'bazooka', params: { cell: bzH.cell } };
        }
        if (bzH && pol.bzWarp != null && bzH.eh >= pol.bzWarp) {
          const foeWarp = game.itemStatus(1 - pi, 'warp');
          const fp = game.players[1 - pi];
          if (foeWarp.inPlay && (foeWarp.have > 0 || (fp.used.warp && fp.wallet >= 3))) return { key: 'bazooka', params: { cell: bzH.cell } };
        }
      }
      if (best) return best;
    }
    if (!ctx.groups.length || !uncertain.length) {
      // 索敵中
      const hp = A.hunt.P;
      const cells = callableCells(game, pi).filter((c) => hp[c] > 0.05);
      // サーチライン：埋まっているマスの数の割れ方がいちばん大きい列・行
      let lineBest = null, lineS = pol.lineMin != null ? pol.lineMin : 0.6;
      if (free('line') && cells.length >= 3) {
        const lk = pol.lineK != null ? pol.lineK : 1.0;
        for (const o of lineOptions(A)) { const v = lk * o.H; if (v > lineS) { lineS = v; lineBest = o.params; } }
      }
      // サーチキューブ：見つけていない個体の数とマス数・形状の割れ方が大きければ、サーチラインより優先
      if (cubeMode === 'eig' && free('cube') && game.turn >= (pol.minTurn || 1)) {
        const bh = pol.huntBeta != null ? pol.huntBeta : 1.0;
        let cb = null;
        for (const o of cubeOptions(A)) { const v = bh * o.Hn; if (!cb || v > cb.v) cb = { v, params: o.params }; }
        if (cb && cb.v >= (pol.huntMin != null ? pol.huntMin : 0.3) && cb.v > (lineBest ? lineS : 0)) return { key: 'cube', params: cb.params };
      }
      if (lineBest) return { key: 'line', params: lineBest };
      // バズーカで角を探る（v12.6）：まだ分かっていない角に個体がいそうなら、コールの前に撃ち込む。
      // 分解すると、角の破片はその場でアンサーでき、ほかの破片は角の隣（2つしかない）からたどれる（片方が×ならもう片方は確定）
      if (stage === 'pre' && free('bazooka') && pol.bzCorner !== false) {
        const min = pol.bzCornerMin != null ? pol.bzCornerMin : 0.5;
        let cb = null;
        for (const c of [0, N - 1, NN - N, NN - 1]) {
          if (cells.indexOf(c) < 0 || hp[c] < min) continue;
          if (!cb || hp[c] > hp[cb]) cb = c;
        }
        if (cb != null) return { key: 'bazooka', params: { cell: cb } };
      }
      // 当たりそうなマスを、コールせずに中身ごと調べる（マス数・形状・つながり）
      const probeKey = free('number') ? 'number' : free('shape') ? 'shape' : free('node') ? 'node' : null;
      if (probeKey && cells.length >= 3) {
        const sorted = cells.slice().sort((a, b) => hp[b] - hp[a]);
        const probe = sorted[1];
        if (probe != null && hp[probe] > 0.2 && hp[probe] < 0.95) return { key: probeKey, params: { cell: probe } };
      }
      if (cubeMode === 'old' && free('cube') && game.turn >= 4 && ctx.counts.size[5] == null && ctx.sizeAllowed(5) && A.hunt.Es[5] > 0.3) {
        return { key: 'cube', params: { kind: 'size', value: 5 } };
      }
    }
    return null;
  }

  // その種類を今使ってよいか（使える状態で、大会で温存すると決めた数より多く持っている）
  // 大会：この試合で使ってよい攻撃アイテムの残り（itemKeep[pi]._budget から、この試合で使った攻撃アイテムを引く）。
  // 防御（ワープ・ステルス）は数えない（見破られかけた個体を逃がすのは、数より優先）
  const isDefItem = (k) => k === 'warp' || k === 'stealth';
  function budgetLeft(game, pi) {
    const keep = game.itemKeep && game.itemKeep[pi];
    if (!keep || keep._budget == null) return Infinity;
    const P = game.players[pi];
    let used = 0;
    for (const k in P.used) if (P.used[k] && !isDefItem(k)) used++;
    return keep._budget - used;
  }
  function itemOK(game, pi, k) {
    if (!game.itemStatus(pi, k).usable || !(game.players[pi].items[k] > 0)) return false;
    const keep = game.itemKeep && game.itemKeep[pi] ? game.itemKeep[pi][k] | 0 : 0;
    if (game.players[pi].items[k] <= keep) return false;
    return isDefItem(k) || budgetLeft(game, pi) > 0;
  }
  // stage: 'pre'＝コール前、'post'＝コール後（どちらかで1手番1つまで）
  function chooseItem(game, pi, stage) {
    stage = stage || 'pre';
    const pol = policy[pi] || {};
    const me = game.players[pi];
    const can = (k) => itemOK(game, pi, k);
    const free = (k) => itemOK(game, pi, k);

    // 1) 防御：見破られかけた個体をワープで逃がす
    if (can('warp')) {
      const w = defensiveWarp(game, pi, free);
      if (w) return w;
    }
    // 2) ステルス（最後の1個体、または序盤に先に付ける方針のとき）
    if (free('stealth')) {
      const p = chooseStealth(game, pi, 'first');
      if (p) return { key: 'stealth', params: { pieceId: p.id } };
    }
    // 3) 攻撃用アイテム
    const A = analyze(me.kb, game.N, game.rng, pol);
    const it = attackItem(game, pi, stage, A);
    if (it) return it;
    // 4) 序盤、攻撃用アイテムを使わなかった手番には、ステルスを先に付けておく
    if (stage === 'post' && free('stealth')) {
      const p = chooseStealth(game, pi, 'spare');
      if (p) return { key: 'stealth', params: { pieceId: p.id } };
    }
    return null;
  }

  function chooseSacrifice(game, pi) {
    const living = game.living(pi);
    const add = living.find((p) => p.isAdd);
    if (add) return add.id;
    let ex = null;
    try { ex = exposure(game, pi); } catch (e) { ex = null; }
    living.sort((a, b) => {
      if (a.size !== b.size) return a.size - b.size;
      const da = ex && ex.get(a.id) ? ex.get(a.id).danger : 0;
      const db = ex && ex.get(b.id) ? ex.get(b.id).danger : 0;
      return db - da;
    });
    return living[0].id;
  }

  // ------------------------------------------------------------------
  // 置くキューブの決め方（v12.17の後。それまでは「型」を重みつきで抽選していた）
  //  性格ごと・試合ごとに、2つの確率を持つ（表 SETUP_PROB。数は割合（%）で、合計が100でなくても比で使う）：
  //   count：何個置くか（例：{ 4: 50, 5: 50 } ＝ 4個が50%・5個が50%）
  //   size ：1個ごとに、何マスのキューブにするか（例：{ 2: 15, 3: 45, 4: 35, 5: 5 }）
  //  決め方：まず個数を抽選し、1個ずつマス数を抽選する。手持ちにないマス数・盤（cap マス）に入らないマス数は除いて抽選し直す。
  //   残りの個数ぶん（2マスずつ）の場所を残して選ぶので、決めた個数をできるだけそのまま置ける（大きいキューブばかりで止まらない）。
  //   割合のあるマス数がどれも置けないときは、2マス → 5マスの順で埋める（3・4マスを使い切った堅実型が5マスばかり置かないように）。
  //   何も置けなくなったら、その数で止める
  //  決まった組み合わせだと読まれるので、抽選で幅を持たせる（ユーザーの希望）。
  //  強さの目安（v12.13、Z字の前）：3・4マスが強く、2・5マスは弱い。Z字（v12.17）で5マスは4マスに化けられるようになった
  //  1試合モード（大会でない）のCPUは、標準の性格の表を使う（4×4＝予選、5×5＝決勝）
  // ------------------------------------------------------------------
  const SETUP_PROB = {
    // 標準（あなたの席の自動配置・性格なし）と、アイテム浪費型（置き方は標準と同じ）
    std: {
      prelim: { count: { 4: 50, 5: 50 }, size: { 2: 15, 3: 45, 4: 34, 5: 6 } },
      final: { count: { 6: 50, 7: 50 }, size: { 2: 5, 3: 40, 4: 45, 5: 10 } },
    },
    // 物量型：個数を多く、2マスも使って盤面を埋める。5マスも多め
    mass: {
      prelim: { count: { 4: 15, 5: 45, 6: 40 }, size: { 2: 35, 3: 34, 4: 21, 5: 10 } },
      final: { count: { 6: 70, 7: 30 }, size: { 2: 3, 3: 37, 4: 44, 5: 16 } },
    },
    // キューブ温存型：1・2試合目は2マスを3個だけ（3・4マスを残す）。3試合目から使い、決勝は5マスを多く出す
    save: {
      prelim: { count: { 4: 50, 5: 50 }, size: { 2: 15, 3: 44, 4: 31, 5: 10 } },
      prelimByRound: { 0: { count: { 3: 100 }, size: { 2: 85, 3: 14, 4: 0, 5: 1 } }, 1: { count: { 3: 100 }, size: { 2: 85, 3: 14, 4: 0, 5: 1 } } },
      final: { count: { 6: 80, 7: 20 }, size: { 2: 2, 3: 34, 4: 43, 5: 21 } },
    },
    // 堅実型：3・4マスで4個（2マスは使わない）
    steady: {
      prelim: { count: { 4: 100 }, size: { 2: 0, 3: 52, 4: 44, 5: 4 } },
      final: { count: { 6: 40, 7: 60 }, size: { 2: 5, 3: 43, 4: 44, 5: 8 } },
    },
  };
  SETUP_PROB.items = SETUP_PROB.std;
  const SETUP_CAP = { prelim: 16, final: 24 };   // 置くマスの上限（4×4は16マス、5×5は24マス＝1マスは空ける）

  // 割合の表から1つ選ぶ（keys に入っているものだけ。割合が0のものは選ばない）
  function pickWeighted(table, keys, rng) {
    let tot = 0; for (const k of keys) tot += Math.max(0, table[k] || 0);
    if (tot <= 0) return null;
    let r = rng() * tot;
    for (const k of keys) { r -= Math.max(0, table[k] || 0); if (r < 0) return +k; }
    return +keys[keys.length - 1];
  }
  // spec（count・size）から、置くマス数の並びを決める。stock：置けるキューブの数、cap：マスの上限
  function drawSizes(spec, stock, cap, rng) {
    const left = {}; for (const s of [2, 3, 4, 5]) left[s] = Math.max(0, stock[s] | 0);
    const K = pickWeighted(spec.count, Object.keys(spec.count), rng) || 0;
    const list = []; let cells = 0;
    for (let i = 0; i < K; i++) {
      // 残りの個数ぶん（少なくとも2マスずつ）の場所を残す（「何個置くか」をできるだけ守るため。大きいキューブばかりで止まらない）
      const rest = 2 * (K - i - 1);
      let can = [2, 3, 4, 5].filter((s) => left[s] > 0 && cells + s + rest <= cap);
      if (!can.length) can = [2, 3, 4, 5].filter((s) => left[s] > 0 && cells + s <= cap);
      if (!can.length) break;
      let s = pickWeighted(spec.size, can.filter((x) => (spec.size[x] || 0) > 0), rng);
      if (s == null) s = can.indexOf(2) >= 0 ? 2 : can.indexOf(5) >= 0 ? 5 : can[0];
      list.push(s); left[s]--; cells += s;
    }
    if (!list.length) { const s = [2, 3, 4, 5].find((x) => left[x] > 0 && x <= cap); if (s) list.push(s); }
    return list.sort((a, b) => a - b);
  }
  // 1試合モード：標準の表で、手持ち（1試合でも数に限りがある）から選ぶ
  function setupSizes(game, pi) {
    const kind = game.N === 4 ? 'prelim' : 'final';
    const stock = {}; for (const s of [2, 3, 4, 5]) stock[s] = game.stockLeft(pi, s);
    return drawSizes(SETUP_PROB.std[kind], stock, SETUP_CAP[kind], game.rng);
  }

  // 置き方の評価（小さいほどよい）。layout：
  //  'spread'（既定）：個体どうしが接しない／'any'：最初に見つかった置き方／'cluster'：個体どうしを接して固める
  //  'edge'：盤の外周に寄せる／'center'：内側に寄せる／'room'：ワープの逃げ場（空きマスだけで同じ形を置ける場所）を残す
  // ワープの逃げ場：個体ごとに、同じ形（向きは自由）をいま空いているマスだけで置ける場所の数（cap まで数える）
  function warpRoom(game, pi, cap) {
    const PLC = placements(game.N), ps = game.players[pi].pieces;
    let occ = 0; for (const p of ps) occ |= p.mask;
    let room = 0, none = 0;
    for (const p of ps) {
      let k = 0;
      for (const P of PLC[p.shape] || []) { if (!(P.mask & occ)) { k++; if (k >= cap) break; } }
      room += k; if (!k) none++;
    }
    return { room, none };
  }
  function layoutScore(game, pi, layout, rng) {
    const N = game.N, ps = game.players[pi].pieces;
    if (layout === 'any') return rng();
    let adj = 0;
    for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) {
      for (const c of ps[a].cells) {
        const rr = Math.floor(c / N), cc = c % N;
        const nb = [[rr - 1, cc], [rr + 1, cc], [rr, cc - 1], [rr, cc + 1]];
        for (const [x, y] of nb) if (x >= 0 && y >= 0 && x < N && y < N && (ps[b].mask & bit(x * N + y))) adj++;
      }
    }
    let edge = 0, cells = 0;
    for (const p of ps) for (const c of p.cells) { cells++; const r = Math.floor(c / N), k = c % N; if (r === 0 || k === 0 || r === N - 1 || k === N - 1) edge++; }
    const noise = rng() * 2;
    if (layout === 'cluster') return -adj + noise;
    if (layout === 'edge') return adj - 3 * edge / Math.max(1, cells) * 4 + noise;
    if (layout === 'center') return adj + 3 * edge / Math.max(1, cells) * 4 + noise;
    if (layout === 'room') { const w = warpRoom(game, pi, 3); return adj + 2 * w.none - 0.5 * w.room + noise; }
    return adj + noise;
  }

  // planArg：配置の方針を直接渡す（大会の「自動配置」（v12.14の後に「おまかせ配置」から改名）で、あなたの分をCPUと同じ考え方で置くとき）
  function setup(game, pi, planArg) {
    const rng = game.rng;
    const pol = policy[pi] || {};
    // 置き直し（自動配置を続けて押したとき）も、空の盤面から考える（置いた分で「置ける数」が減って見えないように）
    game.clearSetup(pi);
    let sizes = setupSizes(game, pi);
    const fits = (list) => { const need = {}; for (const x of list) need[x] = (need[x] || 0) + 1; return Object.keys(need).every((x) => need[x] <= game.stockLeft(pi, +x)); };
    // 大会：CPUが順位・残りのキューブから決めた方針（置けるキューブが足りなければ使わない）
    const plan = planArg || (game.setupPlan && game.setupPlan[pi]);
    let planned = false;
    if (plan && Array.isArray(plan.sizes) && plan.sizes.length && fits(plan.sizes)) { sizes = plan.sizes.slice(); planned = true; }
    // 実験用：置くマス数の組み合わせを指定
    if (Array.isArray(pol.sizes) && fits(pol.sizes)) sizes = pol.sizes.slice();
    if (!sizes.length) return false;
    // 置き方：方針があればそれ、なければ大会と同じ決め方（盤の80%以上を埋めるならくっつけ、少なければ離して外周に寄せる）
    const dense = sizes.reduce((a, b) => a + b, 0) >= 0.8 * game.N * game.N;
    const layout = pol.layout || (plan && plan.layout) || (dense ? 'cluster' : 'edge');
    // 大きい個体から置く（盤面を厚く埋めるときに置き切れるように）
    const order = sizes.slice().sort((a, b) => b - a);
    let best = null, bestScore = Infinity;
    for (let trial = 0; trial < 40; trial++) {
      if (!game.randomSetup(pi, order, rng)) continue;
      const score = layoutScore(game, pi, layout, rng);
      if (score < bestScore) { bestScore = score; best = game.players[pi].pieces.map((p) => ({ key: p.shape, t: p.t, r0: p.r0, c0: p.c0 })); }
    }
    game.clearSetup(pi);
    if (!best) {
      // 置き方が見つからなかったとき：1個ずつ減らして試す
      let ok = false;
      for (let k = sizes.length - 1; k >= 1 && !ok; k--) ok = game.randomSetup(pi, sizes.slice(0, k), rng);
      if (!ok) ok = game.randomSetup(pi, null, rng);
      if (ok) game.setTreasure(pi, chooseTreasureCell(game, pi));
      return ok;
    }
    for (const p of best) game.placePiece(pi, p.key, p.t, p.r0, p.c0);
    game.setTreasure(pi, chooseTreasureCell(game, pi));
    return true;
  }

  // ------------------------------------------------------------------
  // 大会の配置の方針：どのキューブを何個・どう置くか（性格・試合・残りのキューブから決める）
  //  ・何個・何マスを置くかは、性格ごとの確率の表 SETUP_PROB で抽選する（上の「置くキューブの決め方」）
  //  ・3・4マスは大会で合わせて7個しかない。予選で使うか決勝に残すかが性格の違いになる
  //  ・置き方：盤の80%以上を埋めるときは個体をくっつけ、それより少ないときは離して外周に寄せる（layout 'auto'）。
  //    3・3・4・4 は、くっつけて72%・離して64%（2・2・2・3・3 に対して）。2・2・3 をくっつけると28%（離せば55%）
  //  ・決勝の盤面が厚いと考える時間が延びる（7個体どうしで1試合平均3.5秒・1手番最大2.8秒、6個体どうしなら1.5秒・0.8秒）
  // ------------------------------------------------------------------
  // 置き方の抽選に使う乱数。rng を渡さなければ、その大会・その人・その試合で決まる（シミュレーター・見本・テストで再現できる）
  function planRng(T, id, kind) {
    const P = T.players[id] || {};
    let h = (Math.floor((P.lotto || 0) * 4294967296) >>> 0) ^ Math.imul((T.round | 0) + 7, 0x9E3779B1) ^ Math.imul(id + 3, 0x85EBCA77) ^ (kind === 'final' ? 0x27D4EB2F : 0x165667B1);
    return function () { h |= 0; h = h + 0x6D2B79F5 | 0; let t = Math.imul(h ^ h >>> 15, 1 | h); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  // その人・その試合の確率の表（性格の表に、実験用の上書き policy.tourSetup[id]・opt を重ねる）
  function setupSpec(T, id, kind, opt) {
    const persona = (E.Tour.persona ? E.Tour.persona(T, id) : null) || 'std';
    const base = SETUP_PROB[persona] || SETUP_PROB.std;
    const o = Object.assign({}, base, (policy.tourSetup && policy.tourSetup[id]) || {}, opt || {});
    if (kind === 'final') return o.final;
    return (o.prelimByRound && o.prelimByRound[T.round]) || o.prelim;
  }
  // rngArg：抽選に使う乱数（あなたの「自動配置」は押すたびに変えたいので Math.random を渡す）
  function tourSetupPlan(T, id, kind, opt, rngArg) {
    const rng = rngArg || planRng(T, id, kind);
    const P = T.players[id];
    const stock = Object.assign({}, P.stock);
    if (kind === 'final' && E.Tour.cubes(P) === 0) stock[2] = 1;   // 決勝で置けるキューブがなければ、2マスを1つ支給
    const N = kind === 'final' ? 5 : 4;
    const sizes = drawSizes(setupSpec(T, id, kind, opt), stock, SETUP_CAP[kind], rng);
    const layout = sizes.reduce((a, b) => a + b, 0) >= 0.8 * N * N ? 'cluster' : 'edge';
    return { sizes, layout, why: kind };
  }

  // トレジャーを置くマス。nearOf(個体, マス)＝そのマスにトレジャーがあるとき「ニア」と答えるマスの数（同じ個体＋上下左右）
  //  'weighted'（既定）：大きい個体ほど選ばれやすく（重み＝マス数の2乗）、その個体の中では同じ確率で
  //  'near'（v12.1まで）：いちばん小さい個体の、ニアの範囲がいちばん狭いマス。4×4では角が51.7%（どのマスも同じ確率なら27.7%）
  //  'uniform'：置いた個体のすべてのマスから同じ確率で／'small'：いちばん小さい個体の中で／'big'：いちばん大きい個体の中で
  //  測定（CPUどうし2000局、相手がトレジャーを見つける割合。CPUの探し方／置き場所のくせを知っている探し方）：
  //   4×4：near 77.2／78.7、small 76.4／75.8、uniform 70.5／71.5、big 69.0／69.8、weighted 69.5／70.5
  //   5×5：near 71.5／75.0、small 71.8／71.5、uniform 72.0／72.9、big 70.0／72.4、weighted 71.4／73.5
  //   小さい個体は早く撃破されてトレジャーの場所が分かりやすい。角に寄せるくせは、知られると見つかりやすい
  function nearOf(piece, c, N) {
    const rr = Math.floor(c / N), cc = c % N;
    let near = piece.size;
    for (const [x, y] of [[rr - 1, cc], [rr + 1, cc], [rr, cc - 1], [rr, cc + 1]]) if (x >= 0 && y >= 0 && x < N && y < N && !(piece.mask & bit(x * N + y))) near++;
    return near;
  }
  function chooseTreasureCell(game, pi) {
    const N = game.N, rng = game.rng;
    const mode = (policy[pi] && policy[pi].treasure) || 'weighted';
    const pieces = game.players[pi].pieces;
    if (mode === 'uniform') {
      const cells = pieces.flatMap((p) => p.cells);
      return cells[Math.floor(rng() * cells.length)];
    }
    if (mode === 'big') {
      const big = pieces.slice().sort((a, b) => b.size - a.size || rng() - 0.5)[0];
      return big.cells[Math.floor(rng() * big.cells.length)];
    }
    if (mode === 'weighted') {
      // 大きい個体のマスほど選ばれやすい（マスの重み＝その個体のマス数）
      let tot = 0; for (const p of pieces) tot += p.size * p.size;
      let r = rng() * tot;
      for (const p of pieces) { r -= p.size * p.size; if (r <= 0) return p.cells[Math.floor(rng() * p.cells.length)]; }
      return pieces[0].cells[0];
    }
    const ps = pieces.slice().sort((a, b) => a.size - b.size || rng() - 0.5);
    const tp = ps[0];
    if (mode === 'small') return tp.cells[Math.floor(rng() * tp.cells.length)];
    let bestCell = tp.cells[0], bestNear = Infinity;
    for (const c of tp.cells) {
      const s = nearOf(tp, c, N) + rng() * 0.9;
      if (s < bestNear) { bestNear = s; bestCell = c; }
    }
    return bestCell;
  }

  // ドラフト：決勝ルールのCPU同士の対戦で測った価値の順（片方だけ持たないと勝率がどれだけ下がるか）
  // v11（各1200局）：ワープ−14.8・サイズ−13.6・シェイプ−13.6・ノード−12.9・キューブ−10.7・ステルス−10.3・ペア−8.2・ライン−6.4・バズーカ±0
  // 前の順（ワープ・サイズ・キューブ・シェイプ・ノード・バズーカ・ステルス・ペア・ライン）との対戦で勝率54.8%（2000局）
  // v12.12：サーチラインが「個体数 / マス数」になり、決勝での価値（持たないときの勝率の下がり方）が−1.2→−13.7になったので、ノードの次へ
  const DRAFT_PRIORITY = ['warp', 'number', 'shape', 'node', 'line', 'cube', 'stealth', 'pair', 'bazooka'];
  // 手持ちにすでにある種類は、持っていない種類より後回しにする（大会の決勝は予選の残り＋ドラフト）
  function draftPick(game, pi) {
    const order = (policy[pi] && policy[pi].draft) || DRAFT_PRIORITY;
    const have = game.players[pi].items || {};
    let best = null, bestS = Infinity;
    for (const k of game.draft.pool) {
      const r = order.indexOf(k);
      const sc = (r < 0 ? 99 : r) + ((have[k] || 0) > 0 ? 4.5 : 0);
      if (sc < bestS) { bestS = sc; best = k; }
    }
    return best || game.draft.pool[0];
  }

  // ---------------- 大会 ----------------
  // アイテムの使い方（v12.5で購入を廃止し、9種類を2つずつ持って始める）
  //  'pace'（既定、v12.6）：試合ごとにバランスよく使う。1・2試合目は各種類1つ目だけを使い（2つ目は3試合目と決勝のために残す）、
  //    攻撃アイテムは1試合 budget 個まで（1試合目3個・2試合目4個・3試合目5個。ワープ・ステルスは数えない）。決勝は制限なし
  //  'keep'：keepList の種類を keepN 個残す（keepRounds の試合だけ）／'none'：制限なし（CPU-δ アイテム浪費型）
  //  測定（v12.5、温存なし＝1試合に約5個を予選で使い切る方針に対して）：ワープ・サイズ・シェイプ・ノードを1つずつ残すと優勝率 22.8%対27.3%、
  //   ワープ・ステルス・キューブを残すと 22.5%対27.5%。アイテムは予選で使った方が勝ちやすいが、決勝がアイテムの少ない戦いになり、
  //   どのCPUも2試合目までにほとんど使ってしまうので、v12.6でバランスよく使う方針を既定にし、使い切る方針はCPU-δの性格にした
  const TOUR_ITEMS = { mode: 'pace', keepList: ITEM_KEYS.slice(), keepN: 1, keepRounds: [0, 1], budget: { 0: 3, 1: 4, 2: 5 } };
  const PERSONA_ITEMS = { items: { mode: 'none' } };
  function tourItemKeep(T, id, kind, opt) {
    const persona = E.Tour.persona ? E.Tour.persona(T, id) : null;
    const o = Object.assign({}, TOUR_ITEMS, (persona && PERSONA_ITEMS[persona]) || {}, (policy.tourItems && policy.tourItems[id]) || {}, opt || {});
    if (kind === 'final' || o.mode === 'none') return null;
    const keep = {};
    if (!o.keepRounds || o.keepRounds.indexOf(T.round) >= 0) for (const k of o.keepList) keep[k] = o.keepN;
    if (o.mode === 'pace' && o.budget && o.budget[T.round] != null) keep._budget = o.budget[T.round];
    return keep;
  }
  // 予選1位の選択：'first'（先攻）か 'draft'（ドラフト先行権＝後攻）。CPUどうしの決勝では先攻の勝率が51.5%
  function tourChooseFirst(T, id) { return (policy.tour && policy.tour[id] && policy.tour[id].choose) || 'first'; }

  // CPUどうしの試合を最後まで進める（配置・ドラフトも）。onTurn(game) を手番ごとに呼ぶ
  function autoMatch(game, onTurn) {
    for (const pi of [0, 1]) if (!game.players[pi].setupDone) { setup(game, pi); game.finishSetup(pi); }
    while (game.phase === 'draft') { const pi = game.draftTurn(); game.draftPick(pi, draftPick(game, pi)); }
    let guard = 0;
    while (game.phase === 'play' && guard++ < 600) { playTurn(game, game.cur); if (onTurn) onTurn(game); }
    return game;
  }

  // CPUの1手番をまとめて実行する（シミュレーション用。画面側は段階的に呼ぶ）
  function playTurn(game, pi, onStep) {
    const step = (s) => { if (onStep) onStep(s); };
    const useItemNow = (stage) => {
      const it = chooseItem(game, pi, stage);
      if (!it) return 'none';
      const r = game.useItem(pi, it.key, it.params);
      step({ kind: 'item', it, r, stage });
      return game.phase !== 'play' ? 'over' : 'used';
    };
    const answerLoop = () => {
      for (let guard = 0; guard < 12 && game.sub === 'answer'; guard++) {
        const cells = chooseAnswer(game, pi);
        if (!cells) break;
        const r = game.answer(pi, cells);
        step({ kind: 'answer', cells, r });
        if (game.phase !== 'play') return 'over';
        if (game.sub === 'sacrifice') {
          game.sacrifice(pi, chooseSacrifice(game, pi));
          if (game.phase !== 'play') return 'over';
          break;
        }
      }
      return 'ok';
    };
    if (game.sub === 'item') {
      const r = useItemNow('pre');
      if (r === 'over') return 'over';
    }
    if ((game.sub === 'item' || game.sub === 'call') && !game.hasCallable(pi)) game.skipCall(pi);
    if (game.sub === 'item' || game.sub === 'call') {
      const c = chooseCall(game, pi);
      const r = game.call(pi, c);
      step({ kind: 'call', c, r });
      if (game.phase !== 'play') return 'over';
    }
    if (answerLoop() === 'over') return 'over';
    if (game.sub === 'answer' && !game.itemUsed) {
      const r = useItemNow('post');
      if (r === 'over') return 'over';
      if (r === 'used' && answerLoop() === 'over') return 'over';
    }
    if (game.sub === 'answer') game.endTurn(pi);
    if (game.sub === 'treasure' && game.cur === pi) {
      const c = chooseTreasure(game, pi);
      const r = game.treasureCall(pi, c);
      step({ kind: 'treasure', c, r });
    }
    return 'done';
  }

  // 画面用：自分が知り得た相手の現在の個体数（サーチオール未使用なら null）
  function knownCounts(kb, N) { return currentCounts(kb, N); }

  const api = { knownCounts, analyze, chooseCall, chooseAnswer, chooseTreasure, chooseItem, chooseSacrifice, setup, setupSizes, draftPick, playTurn, autoMatch, tourItemKeep, tourChooseFirst, tourSetupPlan, SETUP_PROB, SETUP_CAP, drawSizes, setupSpec, exposure, bestWarpTarget, bestAddCell, policy, _cubeOptions: cubeOptions };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SBAI = api;
})(typeof window !== 'undefined' ? window : globalThis);
