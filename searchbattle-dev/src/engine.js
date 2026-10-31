/* サーチバトル — ルールエンジン
 * 盤面・形状・コール・アンサー・トレジャー・アイテム・スコア・勝敗を処理する。
 * ブラウザでは window.SBEngine、Node では module.exports として公開する。
 */
(function (root) {
  'use strict';

  const COLS = 'ABCDE';
  const STOCK = { 2: 5, 3: 4, 4: 3, 5: 2 };
  // Z型（v12.17）：段違いの形。4ブロック・5ブロックに入れて、2×2キューブやL型・T型に化けられるようにした（5ブロックが弱かったため）
  const CATS = ['R型', 'L型', 'T型', 'Z型'];

  // base はインデックス順を保ったまま回転・反転する（トレジャー位置の追従に使う）
  const SHAPES = {
    A1: { size: 1, cat: 'R型', name: 'アッド', base: [[0, 0]] },
    D2: { size: 2, cat: 'R型', name: '1×2', base: [[0, 0], [0, 1]] },
    I3: { size: 3, cat: 'R型', name: '1×3', base: [[0, 0], [0, 1], [0, 2]] },
    L3: { size: 3, cat: 'L型', name: 'L型', base: [[0, 0], [1, 0], [1, 1]] },
    I4: { size: 4, cat: 'R型', name: '1×4', base: [[0, 0], [0, 1], [0, 2], [0, 3]] },
    O4: { size: 4, cat: 'R型', name: '2×2', base: [[0, 0], [0, 1], [1, 0], [1, 1]] },
    L4: { size: 4, cat: 'L型', name: 'L型', base: [[0, 0], [1, 0], [2, 0], [2, 1]] },
    T4: { size: 4, cat: 'T型', name: 'T型', base: [[0, 0], [0, 1], [0, 2], [1, 1]] },
    I5: { size: 5, cat: 'R型', name: '1×5', base: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]] },
    L5: { size: 5, cat: 'L型', name: 'L型(4+1)', base: [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1]] },
    V5: { size: 5, cat: 'L型', name: 'L型(3+3)', base: [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]] },
    T5: { size: 5, cat: 'T型', name: 'T型(3+2)', base: [[0, 0], [0, 1], [0, 2], [1, 1], [2, 1]] },
    Y5: { size: 5, cat: 'T型', name: 'T型(4+1)', base: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 1]] },
    // Z型（v12.17）。■■ / _■■ ・ ■■ / _■■■ ・ ■■ / _■ / _■■
    Z4: { size: 4, cat: 'Z型', name: 'Z型', base: [[0, 0], [0, 1], [1, 1], [1, 2]] },
    Z5: { size: 5, cat: 'Z型', name: 'Z型(2+3)', base: [[0, 0], [0, 1], [1, 1], [1, 2], [1, 3]] },
    S5: { size: 5, cat: 'Z型', name: 'Z型(2+1+2)', base: [[0, 0], [0, 1], [1, 1], [2, 1], [2, 2]] },
  };
  const SHAPES_BY_SIZE = { 1: ['A1'], 2: ['D2'], 3: ['I3', 'L3'], 4: ['I4', 'O4', 'L4', 'T4', 'Z4'], 5: ['I5', 'L5', 'V5', 'T5', 'Y5', 'Z5', 'S5'] };

  // 状態の形が変わったら上げる（公開ページの更新時に、古い対戦を新しいルールで再開しないため）
  // 20：v12.16 スピードペナルティ自滅点化＆アンサー失敗で手番即終了
  // 21：v12.17 Z型（Z4・Z5・S5）を追加
  // 22：v13 ステルスを作り直し（当たると「Stealth hit」。◎か○かを伏せる）
  // 23：v14 ステルスを作り直し（キューブを隠す。ステルスアンサーで見破る）
  // 24：v14.1 ×に撃ったステルスアンサーの外れは手番終了だけ（kb.probes。v14.2 で元に戻した）
  // 25：v14.2 ステルスのトリガーブロック（コールされると STEALTH HIT。すべてのステルスが見破られる）
  // 26：v14.5 用語の変更（形の分類の名前が R型・L型・T型・Z型に）
  // 27：v15 ワープを作り直し（トリガーと移動先を決めておき、トリガーをコールされるかアンサーで当てられると移動する）
  // 28：v15.1 ステルスの見破りをキューブごとに（トリガー・ぴったりのアンサー・ステルスアンサーで見破られるのは、そのキューブだけ）
  // 29：v15.2 ワープの通知（最後のコールがトリガーなら「自動撃破後、ワープ発動」）と、アンサーで逃げたキューブのトリガーのワープレティクル
  const VERSION = 29;
  const ITEM_KEYS = ['cube', 'line', 'number', 'shape', 'pair', 'node', 'bazooka', 'warp', 'stealth'];
  // アイテムの説明（v14.5 で短くした。空きブロックにはどのアイテムも NoData、とルール画面の見出しに1回だけ書く）
  const ITEMS = {
    cube: { name: 'サーチキューブ', desc: '選んだ形かブロック数のキューブが、いくつ残っているか分かる' },
    line: { name: 'サーチライン', desc: '選んだ1列（1行）にかかるキューブの数とブロックの数が分かる（例：2キューブ / 3ブロック）' },
    number: { name: 'サーチサイズ', desc: '選んだブロックのキューブが何ブロックか分かる' },
    shape: { name: 'サーチシェイプ', desc: '選んだブロックのキューブの形が分かる' },
    pair: { name: 'ペアショット', desc: '選んだ2ブロックが同じキューブか分かる' },
    node: { name: 'ノードショット', desc: '選んだブロックから、同じキューブが上下左右にいくつつながっているか分かる（0〜3）' },
    bazooka: { name: 'バズーカ', desc: '選んだブロックのキューブを1ブロックずつに分解する。当たっていたブロックはその場で撃破' },
    warp: { name: 'ワープ', desc: 'キューブにトリガーと移動先を決めておく。トリガーをコールされるか、アンサーで当てられると移動する' },
    stealth: { name: 'ステルス', desc: '自分のキューブを1つ隠す（コールは×、アイテムは効かない）。選んだ1ブロックが弱点で、撃たれるか、×のブロックでアンサーされるとばれる' },
  };

  function bit(c) { return 1 << c; }
  function popcount(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  function bitsOf(m) { const out = []; while (m) { const lb = m & -m; out.push(31 - Math.clz32(lb)); m ^= lb; } return out; }
  function maskOf(cells) { let m = 0; for (const c of cells) m |= bit(c); return m; }

  function normalize(cells) {
    let minR = Infinity, minC = Infinity;
    for (const [r, c] of cells) { if (r < minR) minR = r; if (c < minC) minC = c; }
    return cells.map(([r, c]) => [r - minR, c - minC]);
  }
  function sigOf(cells) { return cells.map(([r, c]) => r * 16 + c).sort((a, b) => a - b).join(','); }
  // t: 0..7 （下位2ビット=回転回数, 4以上=反転）
  function transform(base, t) {
    const out = base.map(([r, c]) => {
      let rr = r, cc = (t >> 2) ? -c : c;
      for (let k = 0; k < (t & 3); k++) { const tmp = rr; rr = cc; cc = -tmp; }
      return [rr, cc];
    });
    return normalize(out);
  }

  const ORIENT = {};
  for (const key in SHAPES) {
    ORIENT[key] = [];
    for (let t = 0; t < 8; t++) {
      const cells = transform(SHAPES[key].base, t);
      let h = 0, w = 0;
      for (const [r, c] of cells) { if (r + 1 > h) h = r + 1; if (c + 1 > w) w = c + 1; }
      ORIENT[key].push({ cells, h, w, sig: sigOf(cells) });
    }
  }

  // 向き t2 が、向き t1 を回しただけの形か（裏返していないか）。ワープの「回転だけ・反転なし」（v15）に使う。
  //  向きの番号は下位2ビットが回転の回数、4以上が裏返し。形が左右対称なら、裏返しても回転と同じ形になるので、形（sig）で比べる
  function rotationOf(key, t1, t2) {
    const sig = ORIENT[key][t2].sig;
    for (let r = 0; r < 4; r++) if (ORIENT[key][(t1 & 4) | r].sig === sig) return true;
    return false;
  }
  function cellsFor(key, t, r0, c0, N) {
    const o = ORIENT[key][t];
    if (r0 < 0 || c0 < 0 || r0 + o.h > N || c0 + o.w > N) return null;
    return o.cells.map(([r, c]) => (r + r0) * N + (c + c0));
  }

  const PLC_CACHE = {};
  // 形状ごとの重複なし配置一覧（CPUの推論用）
  function placements(N) {
    if (PLC_CACHE[N]) return PLC_CACHE[N];
    const out = {};
    for (const key in SHAPES) {
      const seen = new Set();
      const arr = [];
      for (let t = 0; t < 8; t++) {
        const o = ORIENT[key][t];
        for (let r0 = 0; r0 + o.h <= N; r0++) {
          for (let c0 = 0; c0 + o.w <= N; c0++) {
            const cells = o.cells.map(([r, c]) => (r + r0) * N + (c + c0));
            const mask = maskOf(cells);
            if (seen.has(mask)) continue;
            seen.add(mask);
            arr.push({ key, size: SHAPES[key].size, cat: SHAPES[key].cat, t, r0, c0, cells, mask });
          }
        }
      }
      out[key] = arr;
    }
    PLC_CACHE[N] = out;
    return out;
  }

  function identifyShape(cells, N) {
    if (!cells.length) return null;
    const sig = sigOf(normalize(cells.map((c) => [Math.floor(c / N), c % N])));
    for (const key in SHAPES) {
      if (SHAPES[key].size !== cells.length) continue;
      for (const o of ORIENT[key]) if (o.sig === sig) return key;
    }
    return null;
  }

  function coord(c, N) { return COLS[c % N] + '-' + (Math.floor(c / N) + 1); }
  // 配置画面でなぞって選んだブロックの組から、形・向き・置く位置を逆算する（配置できる形でなければ null）。
  // 1ブロック（アッド）は配置で使わないので除く
  function matchPlacement(cells, N) {
    if (!cells || cells.length < 2) return null;
    const rc = cells.map((c) => [Math.floor(c / N), c % N]);
    let r0 = Infinity, c0 = Infinity;
    for (const [r, c] of rc) { if (r < r0) r0 = r; if (c < c0) c0 = c; }
    const sig = sigOf(normalize(rc));
    for (const key of SHAPES_BY_SIZE[cells.length] || []) {
      if (key === 'A1') continue;
      for (let t = 0; t < 8; t++) if (ORIENT[key][t].sig === sig) return { key, t, r0, c0 };
    }
    return null;
  }
  // ログ用のキューブの呼び名（バズーカで分解されたものは「1ブロックのキューブ」）
  function pieceName(p) { return p.frag ? '1ブロックのキューブ' : p.isAdd ? 'アッド' : p.size + 'ブロックのキューブ'; }
  // ログ用：ブロックを読み順（A-1, B-1, …, A-2, …）に並べて「・」でつなぐ
  function coordList(cells, N) { return cells.slice().sort((a, b) => a - b).map((c) => coord(c, N)).join('・'); }
  function lineMask(line, index, N) {
    let m = 0;
    for (let k = 0; k < N; k++) m |= bit(line === 'row' ? index * N + k : k * N + index);
    return m;
  }
  function lineLabel(line, index) { return line === 'row' ? (index + 1) + '行' : COLS[index] + '列'; }
  // ノードショット：そのブロックで、同じキューブのブロックが上下左右にいくつつながっているか
  function nodeDegree(mask, c, N) {
    const r = Math.floor(c / N), col = c % N;
    let k = 0;
    if (r > 0 && (mask & bit(c - N))) k++;
    if (r < N - 1 && (mask & bit(c + N))) k++;
    if (col > 0 && (mask & bit(c - 1))) k++;
    if (col < N - 1 && (mask & bit(c + 1))) k++;
    return k;
  }
  // 2ブロックのブロック数（上下左右に何ブロック進むか）。どの形状でも、キューブの中を通る最短距離と一致する
  function blockDist(a, b, N) { return Math.abs(Math.floor(a / N) - Math.floor(b / N)) + Math.abs((a % N) - (b % N)); }

  // 盤面のルール：4×4（予選ルール）／5×5（決勝ルール）。ドラフトの有無はアイテムの設定（draftEach）で決める
  function makeRules(kind) {
    return kind === 'final'
      // lateTurn：終盤（BGMが激しくなる）のターン（v12.5のキューブの上限は、v12.6でなくした）
      ? { kind: 'final', label: '決勝', N: 5, lateTurn: 13, treasureMax: 5 }
      : { kind: 'prelim', label: '予選', N: 4, lateTurn: 9, treasureMax: 4 };
  }

  // ------------------------------------------------------------------
  // opts：
  //  rules 'prelim'（4×4）／'final'（5×5）、label 画面に出す試合名
  //  items この試合で使えるアイテムの種類、inventory [手持ち, 手持ち]（種類ごとの数。省略時は使える種類を1つずつ）
  //  draftEach ドラフトで1人が取る数（0＝ドラフトなし。ドラフトのときは手持ち0から始める）
  //  oncePerMatch 1試合で同じ種類のアイテムは1回まで（大会の予選）
  //  stocks [置けるキューブ, 置けるキューブ]（ブロック数ごとの数。大会では試合ごとに減る）
  //  setupPlan [席0の方針, 席1の方針]（CPUの配置の方針。大会で使う）
  //  itemKeep [席0, 席1]（CPUが温存するアイテムの数。大会の予選で使う）
  function Game(opts) {
    opts = opts || {};
    this.rules = makeRules(opts.rules);
    if (opts.label) this.rules.label = opts.label;
    this.N = this.rules.N;
    this.NN = this.N * this.N;
    this.rng = opts.rng || Math.random;
    this.mode = opts.mode || 'pvp';
    this.v = VERSION;
    // この試合で使えるアイテム
    const pick = Array.isArray(opts.items) ? ITEM_KEYS.filter((k) => opts.items.indexOf(k) >= 0) : [];
    this.itemKeys = pick.length ? pick : ITEM_KEYS.slice();
    this.draftEach = Math.max(0, Math.min(Math.floor(this.itemKeys.length / 2), opts.draftEach | 0));
    this.oncePerMatch = !!opts.oncePerMatch;
    // CPUの配置の方針（[席0, 席1]。大会で、CPUが順位・残りのキューブ・試合の残りから決めたもの。中身はCPUだけが読む）
    this.setupPlan = Array.isArray(opts.setupPlan) ? opts.setupPlan : null;
    // CPUがこの試合で使わずに残しておくアイテムの数（[席0, 席1]、種類ごと。大会の予選で使う。中身はCPUだけが読む）
    this.itemKeep = Array.isArray(opts.itemKeep) ? opts.itemKeep : null;
    // トレジャーの的中で増える点（大会は+3。単発の試合は点数なし＝0）。ログ・演出の表示に使う
    this.treasurePts = opts.treasurePts | 0;
    this.treasureSteal = !!opts.treasureSteal;   // 大会：トレジャー＝相手の宝石（見つけたら奪う）
    this.victoryPts = opts.victoryPts | 0;       // 大会：この試合の勝利点（表示用）
    this.speedBonus = !!opts.speedBonus;         // 大会の予選：スピードペナルティあり（v12.14。v12.15まではスピードボーナス。項目の名前は互換のためそのまま）
    this.clock = 0;
    this.turn = 1;
    this.first = opts.first != null ? opts.first : (this.rng() < 0.5 ? 0 : 1);
    this.cur = this.first;
    this.phase = 'setup';
    this.sub = null;
    this.itemUsed = false;
    this.pending = null;
    this.draft = null;
    this.log = [];
    this.result = null;
    this.lastAction = null;
    this.events = [];
    // リプレイ（v12.9）：この試合の操作の記録（メソッド名と引数の並び）と、はじめの設定。先攻（first）と合わせて、どの場面も再現できる
    this.actions = [];
    try { this.initOpts = JSON.parse(JSON.stringify(Object.assign({}, opts, { rng: undefined }))); } catch (e) { this.initOpts = null; }
    const names = opts.names || ['プレイヤー1', 'プレイヤー2'];
    const cpu = opts.cpu || [false, false];
    const stocks = opts.stocks || [];
    const inv = opts.inventory || [];
    this.players = [0, 1].map((i) => this._newPlayer(i, names[i], !!cpu[i], opts.wallet || 0, stocks[i], inv[i]));
    // 相手が置けるキューブの数（大会では公開情報）を推論に使う
    for (const i of [0, 1]) this.players[i].kb.stock = Object.assign({}, this.players[1 - i].stock);
  }

  Game.prototype._newPlayer = function (i, name, isCPU, wallet, stock, inv) {
    const NN = this.NN;
    const items = {};
    for (const k of ITEM_KEYS) {
      const inPlay = this.itemKeys.indexOf(k) >= 0;
      items[k] = !inPlay ? 0 : inv ? Math.max(0, inv[k] | 0) : this.draftEach ? 0 : 1;
    }
    const st = { 2: 0, 3: 0, 4: 0, 5: 0 };
    const src = stock || STOCK;
    for (const s of [2, 3, 4, 5]) st[s] = Math.max(0, src[s] | 0);
    return {
      idx: i, name, isCPU, stock: st,
      pieces: [], nextId: 1, treasure: null, setupDone: false,
      splitPieces: [],   // バズーカで分解された元のキューブ（大会では次の試合で元の形に戻す）
      items, used: {}, wallet, rebuys: 0,
      score: { attack: 0, survival: 0, treasure: 0, rebuy: 0, total: 0 },
      // 相手盤面についての自分の記録（予想盤面）
      view: {
        marks: new Array(NN).fill(null), dead: new Array(NN).fill(null), tlog: new Array(NN).fill(null),
        oo: 0, treasureFound: false, lastCall: -1,
      },
      // 推論用の事実ログ（相手盤面について自分が知り得たこと）
      kb: {
        N: this.N, stock: Object.assign({}, STOCK),
        calls: [], deads: [], warps: [], adds: [], empties: [], occs: [], counts: [],
        pairs: [], nodes: [], splits: [], stealths: [], tlogs: [], grays: [], failedAnswers: [],
        reveals: [],   // ステルスを見破った時刻と、見破ったキューブの数（v14）
        warpUses: [],  // 相手がワープを使った時刻（v15。使ったことだけが分かる。どのキューブか・移動先は伏せられる）
      },
    };
  };

  Game.prototype.foeOf = function (pi) { return this.players[1 - pi]; };
  Game.prototype.living = function (pi) { return this.players[pi].pieces.filter((p) => p.alive); };
  // 相手から見えるキューブ（v14）：隠れているステルスのキューブは、アイテムの対象にならない（空きブロックと同じに見える）
  Game.prototype._seenAt = function (pi, c) { const p = this.pieceAt(pi, c); return p && !p.stealth ? p : null; };
  Game.prototype.pieceAt = function (pi, c, includeDead) {
    for (const p of this.players[pi].pieces) {
      if (!includeDead && !p.alive) continue;
      if (p.mask & bit(c)) {
        if (p.alive) return p;
        if (includeDead) return p;
      }
    }
    return null;
  };
  Game.prototype.deadMask = function (pi) {
    let m = 0;
    for (const p of this.players[pi].pieces) if (!p.alive) m |= p.mask;
    return m;
  };
  Game.prototype.livingMask = function (pi, exceptId) {
    let m = 0;
    for (const p of this.players[pi].pieces) if (p.alive && p.id !== exceptId) m |= p.mask;
    return m;
  };
  Game.prototype.coord = function (c) { return coord(c, this.N); };
  Game.prototype._tick = function () { return ++this.clock; };
  // 演出用のイベント（公開情報と、当事者だけが見てよい情報を分けて持つ）
  Game.prototype._emit = function (ev) {
    ev.id = this.events.length;
    ev.turn = this.turn;
    this.events.push(ev);
  };
  // extra：表示に使う追加の情報（アンサーの cells＝宣言したブロック。ログにマウスを重ねたとき、盤の上で光らせる）
  Game.prototype._log = function (actor, text, priv, kind, key, extra) {
    this.log.push(Object.assign({ id: this.log.length, turn: this.turn, actor, text, priv: priv || null, kind: kind || 'info', key: key || null }, extra || {}));
  };

  // ---------------- 配置 ----------------
  Game.prototype.stockLeft = function (pi, size) {
    const P = this.players[pi];
    const used = P.pieces.filter((p) => !p.isAdd && p.size === size).length;
    return ((P.stock && P.stock[size]) || 0) - used;
  };
  Game.prototype.checkPlacement = function (pi, key, t, r0, c0) {
    const cells = cellsFor(key, t, r0, c0, this.N);
    if (!cells) return { ok: false, reason: '盤面からはみ出します' };
    const mask = maskOf(cells);
    if (mask & this.livingMask(pi)) return { ok: false, reason: 'ほかのキューブと重なります', cells, mask };
    return { ok: true, cells, mask };
  };
  Game.prototype.placePiece = function (pi, key, t, r0, c0) {
    const P = this.players[pi];
    if (this.phase !== 'setup' || P.setupDone) return { ok: false, reason: '配置フェーズではありません' };
    const sh = SHAPES[key];
    if (!sh || key === 'A1') return { ok: false, reason: '置けない形です' };
    if (this.stockLeft(pi, sh.size) <= 0) return { ok: false, reason: sh.size + 'ブロックのキューブは残っていません' };
    const chk = this.checkPlacement(pi, key, t, r0, c0);
    if (!chk.ok) return chk;
    const piece = this._makePiece(P, key, t, r0, c0, chk.cells);
    piece.col = this._freeCol(P);
    P.pieces.push(piece);
    return { ok: true, piece };
  };
  // キューブの色・柄の番号（col）：置いたときに、そのとき空いている中でいちばん小さい番号を付け、あとは変えない。
  //  途中のキューブを外しても、ほかのキューブの色・柄が変わらないようにするため（外した番号は、次に置くキューブが使う）。
  //  画面は col を 1〜8 の色・柄に当てはめる（ui.js の colorIndex）。バズーカの破片は元のキューブの番号を受け継ぐ
  Game.prototype._freeCol = function (P) {
    const used = new Set(P.pieces.filter((p) => !p.isAdd && !p.frag && p.col).map((p) => p.col));
    for (const sp of P.splitPieces || []) if (sp.col) used.add(sp.col);
    let k = 1;
    while (used.has(k)) k++;
    return k;
  };
  Game.prototype._makePiece = function (P, key, t, r0, c0, cells) {
    const sh = SHAPES[key];
    return {
      id: P.nextId++, owner: P.idx, shape: key, size: sh.size, cat: sh.cat, isAdd: key === 'A1',
      t, r0, c0, cells, mask: maskOf(cells), alive: true, hitMask: 0, hitOrder: [], oonums: [], cause: null,
      placedAt: this.clock, deadAt: null,
    };
  };
  Game.prototype.removePiece = function (pi, id) {
    const P = this.players[pi];
    if (this.phase !== 'setup' || P.setupDone) return { ok: false };
    P.pieces = P.pieces.filter((p) => p.id !== id);
    if (P.treasure && P.treasure.pieceId === id) P.treasure = null;
    return { ok: true };
  };
  Game.prototype.clearSetup = function (pi) {
    const P = this.players[pi];
    if (this.phase !== 'setup' || P.setupDone) return;
    P.pieces = []; P.treasure = null;
  };
  Game.prototype.setTreasure = function (pi, cell) {
    const P = this.players[pi];
    if (this.phase !== 'setup' || P.setupDone) return { ok: false };
    const p = this.pieceAt(pi, cell);
    if (!p) return { ok: false, reason: 'トレジャーはキューブのブロックに置きます' };
    P.treasure = { pieceId: p.id, idx: p.cells.indexOf(cell), cell };
    return { ok: true };
  };
  // sizes: 置くキューブのブロック数の配列。省略時はテンプレートから選ぶ
  Game.prototype.randomSetup = function (pi, sizes, rng) {
    rng = rng || this.rng;
    const N = this.N;
    const templates = N === 4
      ? [[2, 3, 4], [2, 3, 3], [3, 4], [2, 2, 3, 4], [2, 3, 5], [3, 3, 4]]
      : [[2, 3, 4, 5], [3, 4, 5], [2, 3, 4, 4], [2, 2, 3, 4, 5], [3, 3, 4, 5]];
    for (let attempt = 0; attempt < 60; attempt++) {
      this.clearSetup(pi);
      const list = sizes || templates[Math.floor(rng() * templates.length)];
      let ok = true;
      for (const size of list) {
        if (this.stockLeft(pi, size) <= 0) { ok = false; break; }
        const keys = SHAPES_BY_SIZE[size].filter((k) => placements(N)[k].length > 0);
        let placed = false;
        for (let k = 0; k < 80 && !placed; k++) {
          const key = keys[Math.floor(rng() * keys.length)];
          const t = Math.floor(rng() * 8);
          const o = ORIENT[key][t];
          if (o.h > N || o.w > N) continue;
          const r0 = Math.floor(rng() * (N - o.h + 1));
          const c0 = Math.floor(rng() * (N - o.w + 1));
          if (this.placePiece(pi, key, t, r0, c0).ok) placed = true;
        }
        if (!placed) { ok = false; break; }
      }
      if (!ok) continue;
      const ps = this.players[pi].pieces;
      const p = ps[Math.floor(rng() * ps.length)];
      this.setTreasure(pi, p.cells[Math.floor(rng() * p.cells.length)]);
      return true;
    }
    return false;
  };
  Game.prototype.finishSetup = function (pi) {
    const P = this.players[pi];
    if (this.phase !== 'setup' || P.setupDone) return { ok: false, reason: '配置フェーズではありません' };
    if (!P.pieces.length) return { ok: false, reason: '最低1キューブを置いてください' };
    if (!P.treasure) return { ok: false, reason: 'トレジャーをセットしてください' };
    P.setupDone = true;
    if (this.players.every((q) => q.setupDone)) {
      if (this.draftEach > 0) {
        // ドラフト：使えるアイテムの中から1人 draftEach 個ずつ、後攻から取る（大会の決勝は9種類から4つずつ）
        // 順番はトゥエ・モース順（i の2進数の1の個数が偶数なら後攻、奇数なら先攻：後先先後先後後先…）。
        // 最初と最後を同じプレイヤーが取らないよう、そうなるときは最後の2つを入れ替える
        // 4つずつ＝後先先後先後後先（v11.1で 後先先後後先後先 から変更。CPUどうしの先攻勝率 41.1%→50.1%）
        // 3つずつ＝後先先後後先、2つずつ＝後先後先（これらは前と同じ）
        const second = 1 - this.first;
        const pool = this.itemKeys.slice();
        const each = this.draftEach;
        const order = [];
        for (let i = 0; i < each * 2; i++) {
          let odd = 0;
          for (let x = i; x; x >>= 1) odd ^= x & 1;
          order.push(odd ? this.first : second);
        }
        const n = order.length;
        if (n >= 2 && order[n - 1] === order[0]) { const tmp = order[n - 1]; order[n - 1] = order[n - 2]; order[n - 2] = tmp; }
        if (!order.length) { this._startPlay(); return { ok: true }; }
        this.draft = { pool, order, step: 0, picks: [[], []], each };
        this.phase = 'draft';
      } else {
        this._startPlay();
      }
    }
    return { ok: true };
  };

  // ---------------- ドラフト ----------------
  Game.prototype.draftTurn = function () { return this.draft ? this.draft.order[this.draft.step] : -1; };
  Game.prototype.draftPick = function (pi, key) {
    const d = this.draft;
    if (this.phase !== 'draft' || !d) return { ok: false };
    if (d.order[d.step] !== pi) return { ok: false, reason: '相手の番です' };
    const i = d.pool.indexOf(key);
    if (i < 0) return { ok: false, reason: 'そのアイテムは残っていません' };
    d.pool.splice(i, 1);
    d.picks[pi].push(key);
    this.players[pi].items[key] += 1;
    this._log(pi, `${this.players[pi].name}：ドラフトで${ITEMS[key].name}を獲得`, null, 'draft', key);
    d.step++;
    if (d.step >= d.order.length || !d.pool.length) this._startPlay();
    return { ok: true };
  };

  Game.prototype._startPlay = function () {
    this.phase = 'play';
    this.turn = 1;
    this.cur = this.first;
    this.sub = 'item';
    this.itemUsed = false;
    this._log(-1, `試合開始。先攻は${this.players[this.first].name}`, null, 'system');
    this._emit({ type: 'start', first: this.first });
  };

  // ---------------- 手番 ----------------
  Game.prototype.isCallable = function (pi, c) {
    if (!Number.isInteger(c) || c < 0 || c >= this.NN) return false;   // 盤の外・ブロックの指定なしはコールできない
    const v = this.players[pi].view;
    if (v.dead[c]) return false;
    const m = v.marks[c];
    return !m || (m.r === 'x' && m.callable);
  };
  Game.prototype.isTreasureCallable = function (pi, c) {
    if (!Number.isInteger(c) || c < 0 || c >= this.NN) return false;
    const v = this.players[pi].view;
    if (v.treasureFound) return false;
    const tl = v.tlog[c];
    return !tl || tl.gray;
  };
  Game.prototype._myTurn = function (pi, subs) {
    return this.phase === 'play' && this.cur === pi && subs.indexOf(this.sub) >= 0;
  };

  Game.prototype.call = function (pi, c) {
    if (!this._myTurn(pi, ['item', 'call'])) return { ok: false, reason: 'コールできる状態ではありません' };
    if (!this.isCallable(pi, c)) return { ok: false, reason: 'そのブロックはコールできません' };
    const me = this.players[pi], foe = this.foeOf(pi);
    const v = me.view;
    const t = this._tick();
    const p = this.pieceAt(foe.idx, c);
    let res;
    if (!p) {
      v.marks[c] = { r: 'x', callable: false, t };
      me.kb.calls.push({ c, t, r: 'x' });
      res = { r: 'x' };
      this._log(pi, `${me.name}：${this.coord(c)}をコール → ×`, null, 'call');
      this._emit({ type: 'call', actor: pi, owner: foe.idx, c, r: 'x' });
    } else if (p.warpPlan && c === p.warpPlan.trigger) {
      // ワープのトリガーブロック（v15）：ここをコールされるとワープが発動する。
      //  当たったブロックはワープレティクルになり（演出）、キューブは決めておいた移動先へ。移動先にもワープレティクルが出る（相手のヒント）
      p.hitMask |= bit(c);
      (p.hitOrder || (p.hitOrder = [])).push(c);
      v.marks[c] = { r: 'wp', t };
      me.kb.calls.push({ c, t, r: 'wp' });   // 移動前の位置へのヒット。すぐ後のワープ（kb.warps）で「もういない」と説明がつく
      // full：トリガーが最後に残ったブロックだった（全ブロックに当たった）。撃破されるところでワープが発動したことを、通知とログで残す
      //  （v15.2。ユーザーの希望。当たっていたブロックがキューブの全部だと相手に分かる＝アンサーで逃げたときと同じ）
      const full = p.hitMask === p.mask;
      this._log(pi, `${me.name}：${this.coord(c)}をコール → ${full ? `${pieceName(p)}を自動撃破後、ワープ発動` : 'ワープ発動（トリガー）'}`, null, full ? 'kill' : 'hit');
      this._emit({ type: 'call', actor: pi, owner: foe.idx, c, r: 'wp', full });
      const fire = this._warpFire(p, 'trigger', pi, full);
      res = { r: 'wp', warp: true, reticle: fire.reticle, full };
      if (fire.destroyed) res.destroyed = fire.destroyed;
    } else {
      const first = p.hitMask === 0;
      p.hitMask |= bit(c);
      (p.hitOrder || (p.hitOrder = [])).push(c);
      if (p.stealth && c === p.stealthTrigger) {
        // トリガーブロック（v14.2）：隠れたキューブの弱点。ここをコールされると STEALTH HIT になり、
        // 見破られるのはこのキューブだけ（v15.1。ユーザーの指摘：v14.2 までは、ほかのステルスもまとめて見破られていた）
        // num：ステルスの番号（使った順。v14.3）。同じ番号の STEALTH HIT は同じキューブ
        v.marks[c] = { r: 'q', num: p.stealthNo, t, trigger: true };   // trigger：ここがトリガーブロックだった（画面で目の印を出す）
        me.kb.calls.push({ c, t, r: 'q', num: p.stealthNo });
        res = { r: 'q', num: p.stealthNo, trigger: true };
        this._log(pi, `${me.name}：${this.coord(c)}をコール → STEALTH HIT ${p.stealthNo}（トリガー）`, null, 'hit');
      } else if (p.stealth) {
        // ステルス（v14）：見破られるまでは、当たっても×に見せる（コールした側には空きブロックと同じに見える）。
        //  ヒットとしては数えておき、見破られたら STEALTH HIT に変わる。見破られるまでは全ブロック当たっても撃破されない（相手に見えないため）
        v.marks[c] = { r: 'x', callable: false, t };
        me.kb.calls.push({ c, t, r: 'x' });
        res = { r: 'x' };
        this._log(pi, `${me.name}：${this.coord(c)}をコール → ×`, null, 'call');
      } else if (p.stealthRevealed) {
        // 見破られたステルスのキューブ：ヒットは STEALTH HIT（◎の番号は使わない）
        v.marks[c] = { r: 'q', num: p.stealthNo, t };
        me.kb.calls.push({ c, t, r: 'q', num: p.stealthNo });
        res = { r: 'q', num: p.stealthNo };
        this._log(pi, `${me.name}：${this.coord(c)}をコール → STEALTH HIT ${p.stealthNo}`, null, 'hit');
      } else if (p.warpHidden && c === p.warpTrig) {
        // アンサーで逃げたキューブ（v15.2。ユーザーの希望）：移動先のトリガーにあたるブロックを見つけたら、ワープレティクルを出す
        //  （トリガーで発動したときに移動先へすぐ出るのと同じ印）。はじめてのヒットならグループの印（◎の代わり。番号は使わない）、
        //  もう◎があれば○の代わり（推論の記録は○）
        p.warpHidden = false;
        v.marks[c] = { r: 'wp', t };
        if (first) {
          me.kb.calls.push({ c, t, r: 'wp' });
          const w = me.kb.warps.find((x) => x.by === 'answer' && x.t === p.warpAt);
          if (w) { w.reticle = c; w.reticleT = t; }
        } else me.kb.calls.push({ c, t, r: 'o' });
        res = { r: 'wp', late: true };
        this._log(pi, `${me.name}：${this.coord(c)}をコール → ワープレティクル（ワープで逃げたキューブ）`, null, 'hit');
      } else if (first) {
        v.oo += 1;
        p.oonums.push(v.oo);
        v.marks[c] = { r: 'oo', num: v.oo, t };
        me.kb.calls.push({ c, t, r: 'oo', num: v.oo });
        res = { r: 'oo', num: v.oo };
        this._log(pi, `${me.name}：${this.coord(c)}をコール → ◎${v.oo}`, null, 'hit');
      } else {
        v.marks[c] = { r: 'o', t };
        me.kb.calls.push({ c, t, r: 'o' });
        res = { r: 'o' };
        this._log(pi, `${me.name}：${this.coord(c)}をコール → ○`, null, 'hit');
      }
      this._emit({ type: 'call', actor: pi, owner: foe.idx, c, r: res.r, num: res.num });
      if (res.trigger) this._revealAll(foe.idx, [p], pi);
      // 全ブロックに当たったら撃破（隠れているステルスのキューブは、見破られるまで撃破しない。見破りで撃破済みなら何もしない）
      if (p.alive && p.hitMask === p.mask && !p.stealth) {
        this._destroy(p, 'destroy');
        res.destroyed = { size: p.size, cells: p.cells.slice(), isAdd: p.isAdd };
        this._log(pi, `${me.name}：${pieceName(p)}を撃破（${coordList(p.cells, this.N)}）`, null, 'kill');
      }
    }
    v.lastCall = c;
    this.lastAction = { kind: 'call', pi, c, res };
    this.sub = 'answer';
    res.ended = this._checkEnd();
    return Object.assign({ ok: true }, res);
  };

  // コールできるブロックが1つもないとき（全ブロックをコール済みなど）は、コールを飛ばしてアンサーへ進める
  Game.prototype.hasCallable = function (pi) {
    for (let c = 0; c < this.NN; c++) if (this.isCallable(pi, c)) return true;
    return false;
  };
  Game.prototype.skipCall = function (pi) {
    if (!this._myTurn(pi, ['item', 'call']) || this.hasCallable(pi)) return { ok: false, reason: 'コールできるブロックがあります' };
    this.sub = 'answer';
    this._log(pi, `${this.players[pi].name}：コールできるブロックがないため、コールを飛ばした`, null, 'call');
    return { ok: true };
  };

  Game.prototype.answer = function (pi, cells) {
    if (!this._myTurn(pi, ['answer'])) return { ok: false, reason: 'アンサーできる状態ではありません' };
    cells = Array.from(new Set(cells)).sort((a, b) => a - b);
    const key = identifyShape(cells, this.N);
    if (!key) return { ok: false, reason: 'R型・L型・T型のいずれかの形で宣言してください' };
    const me = this.players[pi], foe = this.foeOf(pi);
    const mask = maskOf(cells);
    this._tick();
    const target = foe.pieces.find((p) => p.alive && p.mask === mask);
    const where = coordList(cells, this.N);
    const hidden = foe.pieces.filter((p) => p.alive && p.stealth);
    if (target && target.warpPlan) {
      // ワープを待っているキューブを当てた（v15）：撃破されずに、決めておいた移動先へ逃げる。移動先のヒント（レティクル）は出ない。
      //  アンサーは正しいので失敗ではなく（差し出しなし）、手番も続く（アンサー成功と同じ）
      this._emit({ type: 'answer', actor: pi, owner: foe.idx, cells, success: true, escaped: true });
      this._log(pi, `${me.name}：アンサー成功（${where}）→ ワープで逃げられた`, null, 'kill', null, { cells: cells.slice() });
      this._warpFire(target, 'answer', pi);
      this.lastAction = { kind: 'answer', pi, ok: true, escaped: true, cells };
      return { ok: true, success: true, escaped: true, ended: false };
    }
    if (target) {
      this._emit({ type: 'answer', actor: pi, owner: foe.idx, cells, success: true });
      // 隠れているステルスのキューブをぴったり当てたら、ふつうに撃破。ほかのステルスのキューブは隠れたまま（v15.1）
      if (target.stealth) this._revealAll(foe.idx, [], pi, null, target);
      this._destroy(target, 'answer');
      this._log(pi, `${me.name}：アンサー成功（${where}）`, null, 'kill', null, { cells: cells.slice() });
      this.lastAction = { kind: 'answer', pi, ok: true, cells };
      const ended = this._checkEnd();
      return { ok: true, success: true, size: target.size, ended };
    }
    // ステルスアンサー（v14）：宣言したブロックが全部、隠れているステルスのキューブのブロックならセーフ（失敗にならない）。
    //  見破られるのは、宣言したブロックを含むステルスのキューブだけ（×が STEALTH HIT に、アイテムの結果が本当の値に変わる。v15.1）。手番は続く（アンサー成功と同じ）。
    //  1ブロックでよい（何ブロックでもよいが、関係ないブロックが1つでも入れば、ふつうのアンサーとして失敗）
    let sMask = 0;
    for (const p of hidden) sMask |= p.mask;
    if (sMask && (mask & ~sMask) === 0) {
      this._emit({ type: 'answer', actor: pi, owner: foe.idx, cells, success: true, stealth: true });
      this._log(pi, `${me.name}：ステルスアンサー（${where}）→ ステルスを見破った`, null, 'kill', null, { cells: cells.slice() });
      this._revealAll(foe.idx, hidden.filter((p) => p.mask & mask), pi, cells);
      this.lastAction = { kind: 'answer', pi, ok: true, stealth: true, cells };
      const ended = this._checkEnd();
      return { ok: true, success: true, stealth: true, ended };
    }
    me.kb.failedAnswers.push({ mask, t: this.clock });
    this._emit({ type: 'answer', actor: pi, owner: foe.idx, cells, success: false });
    this._log(pi, `${me.name}：アンサー失敗（${where}）`, null, 'miss', null, { cells: cells.slice() });
    this.sub = 'sacrifice';
    this.pending = { kind: 'answerFail', who: pi };
    this.lastAction = { kind: 'answer', pi, ok: false, cells };
    return { ok: true, success: false };
  };

  Game.prototype.sacrifice = function (pi, pieceId) {
    if (!(this.phase === 'play' && this.sub === 'sacrifice' && this.pending && this.pending.who === pi)) return { ok: false };
    const p = this.players[pi].pieces.find((x) => x.id === pieceId && x.alive);
    if (!p) return { ok: false, reason: '生きている自分のキューブを選んでください' };
    // 隠れているステルスのキューブを差し出したら、そのキューブだけ公開する（ほかのステルスはそのまま）
    if (p.stealth) this._revealStealth(pi, [p]);
    // ワープを待っているキューブを差し出しても、ワープは発動しない（自分で差し出すので逃げられない。v15）
    p.warpPlan = null;
    this._destroy(p, 'answerFail');
    this._log(pi, `${this.players[pi].name}：ペナルティで${pieceName(p)}を公開・撃破（${coordList(p.cells, this.N)}）`, null, 'penalty');
    this.pending = null;
    const ended = this._checkEnd();
    if (!ended) {
      // アンサー失敗時はペナルティ後にその手番を即終了（v12.16）
      // 連続アンサーによる捨て身の総当たりを防ぐため、以降のアンサーやトレジャーコールはスキップし直ちに相手の手番へ移る
      this._advance();
    }
    return { ok: true, ended };
  };

  // トレジャーチャンスの残り回数（予選4回・決勝5回まで）
  Game.prototype.treasureLeft = function (pi) {
    const P = this.players[pi];
    if (P.view.treasureFound) return 0;
    return Math.max(0, (this.rules.treasureMax || 99) - P.kb.tlogs.length);
  };
  Game.prototype.endTurn = function (pi) {
    if (!this._myTurn(pi, ['answer'])) return { ok: false };
    if (this.turn % 2 === 0 && this.treasureLeft(pi) > 0) {
      this.sub = 'treasure';
      this._emit({ type: 'tchance', actor: pi, left: this.treasureLeft(pi), max: this.rules.treasureMax });
      return { ok: true, treasure: true };
    }
    this._advance();
    return { ok: true };
  };

  Game.prototype.treasureCall = function (pi, c) {
    if (!this._myTurn(pi, ['treasure'])) return { ok: false };
    if (!this.isTreasureCallable(pi, c)) return { ok: false, reason: 'そのブロックにはトレジャーコールできません' };
    const me = this.players[pi], foe = this.foeOf(pi);
    const t = this._tick();
    const T = foe.treasure.cell;
    const tp = foe.pieces.find((p) => p.id === foe.treasure.pieceId);
    const N = this.N;
    const adj = Math.abs(Math.floor(c / N) - Math.floor(T / N)) + Math.abs((c % N) - (T % N)) === 1;
    let r;
    if (c === T) r = 'H';
    else if (adj || (tp && (tp.mask & bit(c)))) r = 'N';
    else r = 'X';
    me.view.tlog[c] = { r, gray: false, t };
    me.kb.tlogs.push({ c, t, r });
    if (r === 'H') {
      me.view.treasureFound = true;
      me.kb.treasureFound = true;
      me.score.treasure += 10;
      me.kb.occs.push({ c, t, cat: null });
    }
    this._emit({ type: 'treasure', actor: pi, owner: foe.idx, c, r });
    const label = r === 'H' ? (this.treasureSteal ? `的中！（宝石を1つ奪う +${this.treasurePts}pt）` : this.treasurePts ? `的中！（+${this.treasurePts}pt）` : '的中！') : r === 'N' ? 'ニア' : '外れ';
    const left = this.treasureLeft(pi);
    this._log(pi, `${me.name}：${this.coord(c)}にトレジャーコール → ${label}${r === 'H' ? '' : `（残り${left}回）`}`, null, r === 'H' ? 'treasure' : 'tcall');
    if (r !== 'H' && left === 0) {
      this._log(pi, `${me.name}：トレジャーチャンスを使い切りました（トレジャー失敗）`, null, 'tcall');
      this._emit({ type: 'tfail', actor: pi });
    }
    this.lastAction = { kind: 'treasure', pi, c, r };
    this._advance();
    return { ok: true, r };
  };

  Game.prototype._advance = function () {
    this.cur = 1 - this.cur;
    if (this.cur === this.first) this.turn += 1;
    this.sub = 'item';
    this.itemUsed = false;
    this.pending = null;
    this._emit({ type: 'turn', cur: this.cur, turn: this.turn });
  };

  // ---------------- 撃破と終了 ----------------
  // ステルスを見破る（v14）：持ち主 owner の隠れているステルスのキューブ（pieces）を公開し、
  // 相手（見破った側）の記録を本当の姿に直す。
  //  ①ステルスの後にそのキューブのブロックへコールした×は STEALTH HIT に
  //  ②ステルスの後にそのキューブのブロックへ使ったアイテムの NoData は本当の結果に（サーチサイズ・シェイプ・ノード。バズーカはさかのぼって分解しない）
  //  ③ステルスの後のサーチキューブ・サーチラインの数に、そのキューブを足す
  //  ④ステルスの後のペアショットで、2ブロックともそのキューブなら「同じキューブ」に
  //  キューブの位置そのものは明かさない（分かるのは、×だったブロックが STEALTH HIT に変わることと、アイテムの結果だけ）。
  //  STEALTH HIT に変わったブロック（turned）と、画面の演出用に結果が変わったブロック（fixed）・数が変わったか（counts）を返す
  Game.prototype._revealStealth = function (owner, pieces) {
    const A = this.players[1 - owner];
    const v = A.view, kb = A.kb, N = this.N;
    const turned = [];
    // 画面の演出用：結果が変わったブロック（NoData→本当の値・ペアショット）と、数（サーチキューブ・ライン）が変わったか
    const fixed = [];
    let countsChanged = false;
    for (const p of pieces) {
      const ts = p.stealthAt;
      const inP = (c) => (p.mask & bit(c)) !== 0;
      // ステルスの後の×と、ステルスの前に当たっていた◎・○（v14.4。ユーザーの希望：ステルスマークの間に◎が残らないように）を、
      // どちらも番号つきの STEALTH HIT にそろえる（同じキューブのヒットが同じ印・同じ番号で並ぶ）
      //  ◎・○は、いまそのブロックに付いている印で、このキューブのヒット（hitMask）のものだけ（ワープ前の別のキューブの記録は変えない）
      const turnable = (c, m) => m && ((m.r === 'x' && m.t > ts) || ((m.r === 'oo' || m.r === 'o') && m.t <= ts && (p.hitMask & bit(c))));
      // 記録（kb.calls）：ステルスの後の×はすべて（ワープの後にもう一度コールした×も）、◎・○はいま付いている印と同じ時刻のもの
      for (const k of kb.calls) if (inP(k.c) && k.r === 'x' && k.t > ts) { k.r = 'q'; k.num = p.stealthNo; }
      for (const c of p.cells) {
        const m = v.marks[c];
        if (!turnable(c, m)) continue;
        if (m.r !== 'x') for (const k of kb.calls) if (k.c === c && k.t === m.t) { k.r = 'q'; k.num = p.stealthNo; }
        v.marks[c] = { r: 'q', num: p.stealthNo, t: m.t };
        turned.push(c);
      }
      const keep = [];
      for (const e of kb.empties) {
        if (!(e.t > ts && inP(e.c))) { keep.push(e); continue; }
        fixed.push(e.c);
        // rv：見破りで本当の値に直した記録（画面でゴールドにして、ステルスの影響があった情報だと分かるようにする。v14.5）
        if (e.src === 'number') kb.occs.push({ c: e.c, t: e.t, cat: null, size: p.size, turn: e.turn, src: 'number', rv: true });
        else if (e.src === 'shape') kb.occs.push({ c: e.c, t: e.t, cat: p.cat, turn: e.turn, src: 'shape', rv: true });
        else if (e.src === 'node') {
          const deg = nodeDegree(p.mask, e.c, N);
          kb.occs.push({ c: e.c, t: e.t, cat: null, deg, turn: e.turn, src: 'node', rv: true });
          const nd = kb.nodes.find((x) => x.t === e.t && x.c === e.c);
          if (nd) { nd.k = deg; nd.rv = true; }
        }
      }
      kb.empties = keep;
      kb.occs.sort((a, b) => a.t - b.t);
      for (const q of kb.counts) {
        if (q.t <= ts) continue;
        if (q.kind === 'line') {
          const lm = lineMask(q.line, q.index, N);
          if (p.mask & lm) { q.k += 1; q.n += popcount(p.mask & lm); countsChanged = true; q.rv = true; }
        } else if (q.kind === 'cat' ? p.cat === q.value : p.size === q.value) { q.n += 1; countsChanged = true; q.rv = true; }
      }
      for (const pr of kb.pairs) if (pr.t > ts && inP(pr.a) && inP(pr.b)) { pr.same = true; pr.rv = true; fixed.push(pr.a, pr.b); }
      p.stealth = false;
      p.stealthRevealed = true;
    }
    // nums：見破ったステルスの番号（STEALTH HIT の番号＝使った順。どのステルスがまだ隠れているかを CPU が知るため。v15.1）
    kb.reveals.push({ t: this.clock, n: pieces.length, nums: pieces.map((p) => p.stealthNo) });
    return { turned, fixed: Array.from(new Set(fixed)), counts: countsChanged };
  };
  // ステルスの見破り（トリガー・ステルスアンサー・ぴったりのアンサー）：pieces のキューブだけを見破る（v15.1）。全ブロック当たっていたキューブは撃破
  //  target：ぴったり当てて撃破するキューブ（このあと answer が撃破する）。×の付け替えとアイテムの結果の訂正だけして、ここでは撃破しない
  Game.prototype._revealAll = function (owner, pieces, actor, answered, target) {
    const all = target ? pieces.concat([target]) : pieces;
    if (!all.length) return;
    const me = this.players[actor];
    const fx = this._revealStealth(owner, all);
    const turned = fx.turned.sort((a, b) => a - b);
    // ステルスアンサーで宣言したブロックは、ステルスのキューブのブロックだと分かる（位置の事実として残す。ヒットではない）
    const t = this.clock;
    for (const c of answered || []) me.kb.occs.push({ c, t, cat: null, turn: this.turn, src: 'stealth' });
    this._emit({ type: 'reveal', actor, owner, cells: turned.slice(), fixed: fx.fixed, counts: fx.counts });
    this._log(actor, `${me.name}：ステルスを見破った（${turned.length ? `×→STEALTH HIT：${coordList(turned, this.N)}` : '隠れていたヒットはなし'}）`, null, 'kill');
    for (const p of pieces) {
      if (p.alive && p.hitMask === p.mask) {
        this._destroy(p, 'destroy');
        this._log(actor, `${me.name}：${pieceName(p)}を撃破（${coordList(p.cells, this.N)}）`, null, 'kill');
      }
    }
  };

  // ワープの発動（v15）：決めておいた移動先へキューブを移す。by：'trigger'（トリガーブロックをコールされた）／'answer'（アンサーで当てられた）。
  //  actor：コール・アンサーをした側（相手）。相手の記録（予想盤面と推論用の kb）を次のように直す：
  //  ①相手の×はすべて、もう一度コールできるようにする（キューブが×のブロックへ動いてきたかもしれないため）
  //  ②移動前の位置のうち、相手が知っているブロックだけを×（W付き）にする：
  //     トリガー → 当たっていたブロック（◎・○とトリガー）だけ。当たっていないブロックは伏せたまま（v15 で少し強く。v14 までは全部公開）
  //     アンサー → 宣言したブロック全部（相手はもう知っている）
  //  ③トリガーのときは、移動後のキューブの「トリガーにあたるブロック」にワープレティクルを出す（コール済み・1発目のヒットとして数える）
  //  ④トレジャーはキューブと一緒に動き、相手のトレジャーログはグレーになる（今までのワープと同じ）
  Game.prototype._warpFire = function (p, by, actor, full) {
    const owner = this.players[p.owner], A = this.players[actor];
    const v = A.view, kb = A.kb, N = this.N;
    const plan = p.warpPlan;
    p.warpPlan = null;
    const t = this._tick();
    const oldCells = p.cells.slice();
    const idx = oldCells.indexOf(plan.trigger);   // トリガーが、キューブの何番目のブロックか（向きを変えても番号は同じブロックを指す）
    const shown = by === 'answer' ? oldCells.slice() : oldCells.filter((c) => p.hitMask & bit(c));
    for (let c = 0; c < this.NN; c++) { const m = v.marks[c]; if (m && m.r === 'x') m.callable = true; }
    // wtrig：相手が当てたトリガーのブロック（画面でワープの印を出す。ステルスの trigger と同じ考え方）
    for (const c of shown) v.marks[c] = by === 'trigger' && c === plan.trigger ? { r: 'x', callable: false, t, warp: true, wtrig: true } : { r: 'x', callable: false, t, warp: true };
    // キューブを動かす（被弾はリセット）
    p.t = plan.t; p.r0 = plan.r0; p.c0 = plan.c0;
    p.cells = plan.cells.slice(); p.mask = plan.mask; p.hitMask = 0; p.hitOrder = [];
    // warpTrig：ワープしたあとのトリガーのブロック（トリガーを移動先へ運んだブロック）。発動したあとも、持ち主の画面・リプレイ・答え合わせで
    //  ワープの印を出し続ける（どこがトリガーだったか分かるように。ステルスの stealthTrigger と同じ。ユーザーの希望）
    p.warpTrig = p.cells[idx];
    const hadT = !!(owner.treasure && owner.treasure.pieceId === p.id);
    if (hadT) {
      owner.treasure.cell = p.cells[owner.treasure.idx];
      for (let c = 0; c < this.NN; c++) if (v.tlog[c]) v.tlog[c].gray = true;
      kb.grays.push(t);
    }
    // 推論用の記録：移動前の位置で分かっているブロック（oldMask）。形（key）は、アンサーのとき（全ブロックが分かっている）だけ。
    //  partial：移動前の位置の一部しか分からないワープ（トリガー）。trigger・reticle：移動前のトリガーと移動後のレティクルのブロック
    const w = { t, oldCells: shown.slice(), oldMask: maskOf(shown), key: null, size: null, cat: null, treasure: hadT && !v.treasureFound, by };
    if (by === 'answer') { w.key = p.shape; w.size = p.size; w.cat = p.cat; w.fullCells = oldCells.slice(); w.anyTrigger = true; }
    else { w.partial = true; w.trigger = plan.trigger; if (full) w.full = true; }
    // warpHidden：アンサーで逃げて、移動先のレティクルがまだ出ていない（v15.2）。warpAt：そのワープの時刻（相手も知っている）で、
    //  あとで隠れたレティクルを見つけたときに、相手の記録（kb.warps）のこのワープへつなぐ
    p.warpHidden = by === 'answer';
    p.warpAt = t;
    let reticle = -1;
    if (by === 'trigger') {
      reticle = p.cells[idx];
      const t2 = this._tick();
      p.hitMask = bit(reticle); p.hitOrder = [reticle];
      v.marks[reticle] = { r: 'wp', t: t2 };
      kb.calls.push({ c: reticle, t: t2, r: 'wp' });
      w.reticle = reticle; w.reticleT = t2;
    }
    kb.warps.push(w);
    this._emit({ type: 'warpfire', owner: p.owner, actor, by, full: !!full, size: full ? p.size : null, from: shown.slice(), trigger: by === 'trigger' ? plan.trigger : null, reticle, treasureMoved: hadT, ownerPriv: { oldCells, newCells: p.cells.slice() } });
    const tl = hadT ? '・トレジャーログがリセット' : '';
    const pubTxt = `${owner.name}：ワープ発動（移動前 ${coordList(shown, N)}${reticle >= 0 ? `・ワープレティクル ${this.coord(reticle)}` : '・移動先は不明'}）${tl}`;
    const privTxt = `${owner.name}：ワープ発動（移動前 ${coordList(oldCells, N)} → 移動後 ${coordList(p.cells, N)}）${tl}`;
    this._log(p.owner, pubTxt, privTxt, 'item', 'warp');
    // 1ブロックのキューブ（バズーカの破片）は、移動先のレティクルで全ブロックに当たったことになるので、そこで撃破
    let destroyed = null;
    if (p.hitMask === p.mask) {
      this._destroy(p, 'destroy');
      destroyed = { size: p.size, cells: p.cells.slice(), isAdd: p.isAdd };
      this._log(actor, `${A.name}：${pieceName(p)}を撃破（${coordList(p.cells, N)}）`, null, 'kill');
    }
    return { shown, reticle, destroyed };
  };

  Game.prototype._destroy = function (piece, cause) {
    piece.alive = false;
    piece.cause = cause;
    piece.deadAt = this._tick();
    const viewer = this.players[1 - piece.owner];
    for (const c of piece.cells) viewer.view.dead[c] = { pieceId: piece.id, size: piece.size, shape: piece.shape, cause, isAdd: piece.isAdd, frag: !!piece.frag };
    viewer.kb.deads.push({
      cells: piece.cells.slice(), mask: piece.mask, size: piece.size, cat: piece.cat, key: piece.shape,
      isAdd: piece.isAdd, frag: !!piece.frag, t: this.clock, cause,
    });
    if (!piece.isAdd) viewer.score.attack += piece.size;
    this._emit({ type: 'destroy', owner: piece.owner, cells: piece.cells.slice(), size: piece.size, isAdd: piece.isAdd, key: piece.shape, cause });
  };

  Game.prototype._checkEnd = function () {
    if (this.phase !== 'play') return this.phase === 'over';
    const a0 = this.living(0).length > 0, a1 = this.living(1).length > 0;
    if (a0 && a1) return false;
    this.phase = 'over';
    this.sub = null;
    this.pending = null;
    const winner = !a0 && !a1 ? -1 : (a0 ? 0 : 1);
    for (const P of this.players) {
      P.score.survival = P.pieces.filter((p) => p.alive && !p.isAdd).reduce((s, p) => s + p.size, 0);
      P.score.total = P.score.attack + P.score.survival + P.score.treasure - P.score.rebuy;
    }
    let tiebreak = -1;
    if (winner === -1) {
      const t0 = this.players[0].score.total, t1 = this.players[1].score.total;
      tiebreak = t0 === t1 ? -1 : (t0 > t1 ? 0 : 1);
    }
    this.result = { winner, draw: winner === -1, tiebreak };
    this._emit({ type: 'over', result: this.result });
    this._log(-1, winner === -1 ? '両者全滅で引き分け' : `${this.players[winner].name}の勝利`, null, 'system');
    return true;
  };

  // ---------------- アイテム ----------------
  Game.prototype.itemStatus = function (pi, key) {
    const P = this.players[pi];
    const inPlay = (this.itemKeys || ITEM_KEYS).indexOf(key) >= 0;
    const have = inPlay ? (P.items[key] || 0) : 0;
    // 大会の予選：1試合で同じ種類は1回まで（2つ持っていても、この試合ではもう使えない）
    const usedUp = !!(this.oncePerMatch && P.used[key]);
    const canRebuy = inPlay && !usedUp && have <= 0 && !!P.used[key] && P.wallet >= 3;
    const inPhase = this._myTurn(pi, ['item', 'answer']) && !this.itemUsed;
    return { inPlay, have, canRebuy, usedUp, usable: inPlay && inPhase && !usedUp && (have > 0 || canRebuy), rebuyNeeded: have <= 0 };
  };

  // ワープの移動先（v15）：キューブ p を、向き t・位置 (r0, c0) に置けるか。
  //  ・向きは、いまの向きを回したものだけ（裏返し＝反転はしない。ユーザーの決定）
  //  ・空きブロックだけ：ほかの生きているキューブ・撃破されたキューブのあったブロック・いまの自分の位置とは重ねない
  //  ・ほかのキューブがワープを待っている移動先とも重ねない（発動したとき、必ずその場所が空いているように）
  Game.prototype._warpDest = function (pi, p, t, r0, c0) {
    const N = this.N;
    if (!Number.isInteger(t) || t < 0 || t > 7) return { ok: false, reason: '向きが正しくありません' };
    if (!rotationOf(p.shape, p.t, t)) return { ok: false, reason: 'ワープは回転だけで、裏返し（反転）はできません' };
    // 左右対称な形は、裏返しの向きの番号でも回転と同じ形になる。形は同じでも、ブロックの順番（どのブロックがトリガーか）は
    //  裏返しの対応になってしまうので、回転の向きの番号に直してから置く（移動後のレティクル・トレジャーの位置が、回転で正しく対応するように）
    if ((t & 4) !== (p.t & 4)) { const sig = ORIENT[p.shape][t].sig; for (let r = 0; r < 4; r++) if (ORIENT[p.shape][(p.t & 4) | r].sig === sig) { t = (p.t & 4) | r; break; } }
    const cells = cellsFor(p.shape, t, r0, c0, N);
    if (!cells) return { ok: false, reason: '盤面からはみ出します' };
    const m = maskOf(cells);
    if (m & this.livingMask(pi, p.id)) return { ok: false, reason: 'ほかのキューブと重なります' };
    if (m & p.mask) return { ok: false, reason: '移動前の位置とは重ねられません' };
    if (m & this.deadMask(pi)) return { ok: false, reason: '撃破済みのキューブがあったブロックには置けません' };
    for (const q of this.players[pi].pieces) if (q.alive && q !== p && q.warpPlan && (q.warpPlan.mask & m)) return { ok: false, reason: 'ほかのキューブのワープ先と重なります' };
    return { ok: true, cells, mask: m, t };
  };
  // キューブ p の、いま選べるワープの移動先をすべて（向きと位置）。空なら、このキューブはワープできない
  Game.prototype.warpOptions = function (pi, p) {
    const out = [], N = this.N, seen = new Set();
    for (let t = 0; t < 8; t++) {
      const o = ORIENT[p.shape][t];
      for (let r0 = 0; r0 + o.h <= N; r0++) for (let c0 = 0; c0 + o.w <= N; c0++) {
        const d = this._warpDest(pi, p, t, r0, c0);
        if (!d.ok || seen.has(d.mask)) continue;   // 同じ形が重なる向き（R型の2×2など）は1つにまとめる
        seen.add(d.mask);
        out.push({ t: d.t, r0, c0, cells: d.cells, mask: d.mask });
      }
    }
    return out;
  };
  // いまワープを使えるキューブ（ステルス中・ワープ待ちでなく、まだ当たっていないブロックがあり、移動先が1つ以上ある）
  Game.prototype.warpable = function (pi) {
    return this.living(pi).filter((p) => !p.stealth && !p.warpPlan && p.hitMask !== p.mask && this.warpOptions(pi, p).length > 0);
  };

  Game.prototype.validateItem = function (pi, key, params) {
    const N = this.N, NN = this.NN;
    const me = this.players[pi];
    const v = me.view;
    params = params || {};
    const inRange = (c) => Number.isInteger(c) && c >= 0 && c < NN;
    switch (key) {
      case 'cube':
        if (params.kind === 'cat' && CATS.indexOf(params.value) >= 0) return { ok: true };
        if (params.kind === 'size' && [1, 2, 3, 4, 5].indexOf(params.value) >= 0) return { ok: true };
        return { ok: false, reason: '形状かブロック数を選んでください' };
      case 'line':
        if ((params.line === 'row' || params.line === 'col') && Number.isInteger(params.index) && params.index >= 0 && params.index < N) return { ok: true };
        return { ok: false, reason: '列か行を選んでください' };
      case 'number':
      case 'shape':
      case 'node':
        if (inRange(params.cell) && !v.dead[params.cell]) return { ok: true };
        return { ok: false, reason: '調べるブロックを選んでください' };
      case 'bazooka':
        if (inRange(params.cell) && !v.dead[params.cell]) return { ok: true };
        return { ok: false, reason: '撃ち込むブロックを選んでください（撃破済みのブロックは選べません）' };
      case 'pair':
        if (!inRange(params.a) || !inRange(params.b) || params.a === params.b) return { ok: false, reason: '違うブロックを2つ選んでください' };
        if (v.dead[params.a] || v.dead[params.b]) return { ok: false, reason: '撃破済みのブロックは選べません' };
        return { ok: true };
      case 'warp': {
        // ワープ（v15。ユーザーの案）：使うときは「どのキューブを・どのブロックをトリガーにして・どこへ移すか」を決めておくだけ。
        //  キューブが動くのは、トリガーブロックをコールされたときか、アンサーで当てられたとき（_warpFire）
        const p = me.pieces.find((x) => x.id === params.pieceId && x.alive);
        if (!p) return { ok: false, reason: 'ワープするキューブを選んでください' };
        // ステルス中のキューブはワープできない（v14）。ワープを待っているキューブにも重ねては使えない（1つのキューブに1つまで）
        if (p.stealth) return { ok: false, reason: 'ステルス中のキューブはワープできません' };
        if (p.warpPlan) return { ok: false, reason: 'そのキューブはすでにワープを待っています' };
        // トリガーブロック：そのキューブの、まだ当たっていない（コールされていない）ブロック
        if (!Number.isInteger(params.cell) || !(p.mask & bit(params.cell))) return { ok: false, reason: 'トリガーブロックにする、そのキューブのブロックを選んでください' };
        if (p.hitMask & bit(params.cell)) return { ok: false, reason: 'トリガーブロックは、まだ当たっていないブロックから選んでください' };
        const dest = this._warpDest(pi, p, params.t, params.r0, params.c0);
        if (!dest.ok) return dest;
        return { ok: true, cells: dest.cells, mask: dest.mask, t: dest.t, piece: p };
      }
      case 'stealth': {
        const p = me.pieces.find((x) => x.id === params.pieceId && x.alive);
        if (!p) return { ok: false, reason: 'ステルスにする自分のキューブを選んでください' };
        if (p.stealth) return { ok: false, reason: 'そのキューブはすでにステルス中です' };
        if (p.warpPlan) return { ok: false, reason: 'ワープを待っているキューブにはステルスを使えません' };   // v15：1つのキューブに防御アイテムは1つまで
        if (p.stealthRevealed) return { ok: false, reason: '見破られたキューブには使えません' };
        // トリガーブロック（v14.2）：隠すキューブのブロックを1つ選ぶ。まだ当たっていないブロックに限る（当たったブロックは二度とコールされず、弱点にならないため）
        if (!Number.isInteger(params.cell) || !(p.mask & bit(params.cell))) return { ok: false, reason: 'トリガーブロックにする、そのキューブのブロックを選んでください' };
        if (p.hitMask & bit(params.cell)) return { ok: false, reason: 'トリガーブロックは、まだ当たっていないブロックから選んでください' };
        return { ok: true, piece: p };
      }
    }
    return { ok: false, reason: '不明なアイテムです' };
  };

  Game.prototype.useItem = function (pi, key, params) {
    const st = this.itemStatus(pi, key);
    if (!st.usable) return { ok: false, reason: 'いまはアイテムを使えません' };
    const val = this.validateItem(pi, key, params);
    if (!val.ok) return val;
    const me = this.players[pi], foe = this.foeOf(pi);
    const fromSub = this.sub;
    if (st.rebuyNeeded) {
      me.wallet -= 3; me.score.rebuy += 3; me.rebuys += 1;
    } else {
      me.items[key] -= 1;
    }
    me.used[key] = true;
    this.itemUsed = true;
    const t = this._tick();
    const name = ITEMS[key].name;
    const tag = st.rebuyNeeded ? '（再購入）' : '';
    const N = this.N;
    let result = { ok: true, key };
    const livingFoe = this.living(foe.idx).filter((p) => !p.stealth);   // 隠れているステルスのキューブは数えない（v14）
    let emitted = false;
    switch (key) {
      case 'cube': {
        const n = livingFoe.filter((p) => (params.kind === 'cat' ? p.cat === params.value : p.size === params.value)).length;
        me.kb.counts.push({ t, turn: this.turn, kind: params.kind, value: params.value, n });
        result.n = n;
        const what = params.kind === 'cat' ? params.value : params.value + 'ブロック';
        this._log(pi, `${me.name}：${name}${tag}（${what}）→ 残り${n}キューブ`, null, 'item', key);
        break;
      }
      case 'line': {
        // その列・行にかかっている（1ブロックでも入っている）生きているキューブの数と、それらが占めているブロックの数（v12.12）。
        // バズーカの破片は1ブロックのキューブ1つずつとして数える
        const lm = lineMask(params.line, params.index, N);
        let occ = 0, k = 0;
        for (const p of livingFoe) { occ |= p.mask; if (p.mask & lm) k++; }
        const n = popcount(occ & lm);
        me.kb.counts.push({ t, turn: this.turn, kind: 'line', line: params.line, index: params.index, n, k });
        result.n = n;
        result.k = k;
        this._log(pi, `${me.name}：${name}${tag}（${lineLabel(params.line, params.index)}）→ 残り${k}キューブ / ${n}ブロック`, null, 'item', key);
        break;
      }
      case 'number': {
        const p = this._seenAt(foe.idx, params.cell);
        const size = p ? p.size : 0;
        if (size) me.kb.occs.push({ c: params.cell, t, cat: null, size, turn: this.turn, src: 'number' });
        else me.kb.empties.push({ c: params.cell, t, turn: this.turn, src: 'number' });
        result.size = size;
        this._log(pi, `${me.name}：${name}${tag}（${this.coord(params.cell)}）→ ${size ? size + 'ブロック' : 'NoData'}`, null, 'item', key);
        break;
      }
      case 'shape': {
        const p = this._seenAt(foe.idx, params.cell);
        const cat = p ? p.cat : null;
        if (cat) me.kb.occs.push({ c: params.cell, t, cat, turn: this.turn, src: 'shape' }); else me.kb.empties.push({ c: params.cell, t, turn: this.turn, src: 'shape' });
        result.cat = cat;
        this._log(pi, `${me.name}：${name}${tag}（${this.coord(params.cell)}）→ ${cat || 'NoData'}`, null, 'item', key);
        break;
      }
      case 'pair': {
        const pa = this._seenAt(foe.idx, params.a), pb = this._seenAt(foe.idx, params.b);
        const same = !!pa && pa === pb;
        me.kb.pairs.push({ t, turn: this.turn, a: params.a, b: params.b, same });
        result.same = same;
        this._log(pi, `${me.name}：${name}${tag}（${this.coord(params.a)}と${this.coord(params.b)}）→ ${same ? '同じキューブ' : '同じキューブではない'}`, null, 'item', key);
        break;
      }
      case 'node': {
        // そのブロックのキューブで、上下左右につながっている同じキューブのブロックの数（0〜3）。空きブロックは NoData
        const p = this._seenAt(foe.idx, params.cell);
        const k = p ? nodeDegree(p.mask, params.cell, N) : null;
        me.kb.nodes.push({ t, turn: this.turn, c: params.cell, k });
        if (k == null) me.kb.empties.push({ c: params.cell, t, turn: this.turn, src: 'node' });
        else me.kb.occs.push({ c: params.cell, t, cat: null, deg: k, turn: this.turn, src: 'node' });
        result.k = k;
        this._log(pi, `${me.name}：${name}${tag}（${this.coord(params.cell)}）→ ${k == null ? 'NoData' : 'つながり' + k}`, null, 'item', key);
        break;
      }
      case 'bazooka': {
        // そのブロックのキューブを1ブロックのキューブに分解する。ヒット済みのブロックはその場で撃破。空きブロックと、隠れているステルスのキューブは NoData
        const p = this._seenAt(foe.idx, params.cell);
        const ev = { type: 'item', actor: pi, key, rebuy: st.rebuyNeeded, cell: params.cell, owner: foe.idx, hit: !!p, killed: [] };
        if (!p) {
          me.kb.empties.push({ c: params.cell, t, turn: this.turn, src: 'bazooka' });
          result.hit = false;
          this._log(pi, `${me.name}：${name}${tag}（${this.coord(params.cell)}）→ NoData`, null, 'item', key);
          this._emit(ev);
          emitted = true;
          break;
        }
        ev.killed = p.cells.filter((c) => p.hitMask & bit(c));
        ev.ownerPriv = { frags: p.cells.filter((c) => !(p.hitMask & bit(c))) };
        this._emit(ev);
        emitted = true;
        // すでに1ブロックのキューブ（分解の破片）なら、形はそのまま（ステルスだけ解除）。撃った側には、ふつうの分解と同じに見える
        // （破片をもう一度分解すると、元のキューブの数え方（大会で失ったか・置いた数）がくずれるため）
        let sp;
        if (p.frag || p.size === 1) { p.stealth = false; p.stealthAt = null; sp = { killed: [], frags: [p.cells[0]] }; }
        else sp = this._split(p);
        me.kb.splits.push({ t, turn: this.turn, c: params.cell, killed: sp.killed.slice() });
        result.hit = true;
        result.killed = sp.killed;
        const kill = sp.killed.length ? `ヒット済みの${sp.killed.length}ブロックを撃破（${coordList(sp.killed, N)}）` : 'ヒット済みのブロックはなし';
        this._log(pi, `${me.name}：${name}${tag}（${this.coord(params.cell)}）→ キューブを1ブロックのキューブに分解・${kill}`, null, 'item', key);
        result.ended = this._checkEnd();
        break;
      }
      case 'warp': {
        // ワープ（v15）：ここでは決めておくだけ（キューブはまだ動かない）。使ったことは相手にも伝わるが、
        //  どのキューブか・トリガーブロック・移動先は伏せる。動くのは _warpFire（トリガーのコール・アンサーで当てられたとき）
        const p = val.piece;
        p.warpPlan = { at: t, trigger: params.cell, t: val.t, r0: params.r0, c0: params.c0, cells: val.cells.slice(), mask: val.mask };
        foe.kb.warpUses.push({ t });
        result.cells = p.cells.slice();
        this._log(pi, `${me.name}：${name}${tag}`, `${me.name}：${name}${tag}（${coordList(p.cells, N)} のキューブ・トリガー ${this.coord(params.cell)} → 移動先 ${coordList(val.cells, N)}）`, 'item', key);
        break;
      }
      case 'stealth': {
        // どのキューブにしたかは相手に伏せる（使ったことだけが伝わる）
        const p = val.piece;
        p.stealth = true;
        p.stealthAt = t;
        p.stealthTrigger = params.cell;
        // ステルスの番号（使った順に1・2…。見破られたら STEALTH HIT に添える。v14.3）
        me.stealthCount = (me.stealthCount || 0) + 1;
        p.stealthNo = me.stealthCount;
        foe.kb.stealths.push({ t, num: p.stealthNo });   // num：ステルスの番号（STEALTH HIT に出るので相手も知る）
        result.cells = p.cells.slice();
        this._log(pi, `${me.name}：${name}${tag}`, `${me.name}：${name}${tag}（${coordList(p.cells, N)} のキューブ）`, 'item', key);
        break;
      }
    }
    const pub = { type: 'item', actor: pi, key, rebuy: st.rebuyNeeded };
    if (key === 'cube' || key === 'line') { pub.n = result.n; }
    if (key === 'cube') { pub.kind = params.kind; pub.value = params.value; }
    if (key === 'line') { pub.line = params.line; pub.index = params.index; pub.k = result.k; }
    if (key === 'number') { pub.cell = params.cell; pub.size = result.size; }
    if (key === 'shape') { pub.cell = params.cell; pub.cat = result.cat; }
    if (key === 'pair') { pub.a = params.a; pub.b = params.b; pub.same = result.same; }
    if (key === 'node') { pub.cell = params.cell; pub.k = result.k; }
    // ワープ（v15）：本人の演出用に、キューブ・トリガー・移動先（相手には送らない。net.js の redactFor が priv を消す）
    if (key === 'warp') { pub.priv = { cells: result.cells, trigger: params.cell, dest: val.cells.slice() }; }
    if (key === 'stealth') { pub.priv = { cells: result.cells }; }
    if (!emitted) this._emit(pub);
    this.lastAction = { kind: 'item', pi, key, result };
    if (this.phase !== 'play') return result;   // バズーカで全滅させたとき
    this.sub = fromSub === 'answer' ? 'answer' : 'call';
    return result;
  };

  // ---------------- バズーカ（分解） ----------------
  // キューブを1ブロックのキューブに分解する。ヒット済みのブロックはその場で撃破（撃破ポイント1ブロック1pt）、ステルスは解除。
  // トレジャーは、そのブロックの1ブロックのキューブのものになる（ニアの「同じキューブ」はそのブロックだけ）。
  // 分解はその試合だけ：元のキューブは splitPieces に残し、大会では次の試合で元の形に戻す
  Game.prototype._split = function (piece) {
    const P = this.players[piece.owner];
    const N = this.N;
    P.pieces.splice(P.pieces.indexOf(piece), 1);
    P.splitPieces.push({ id: piece.id, shape: piece.shape, size: piece.size, cells: piece.cells.slice(), turn: this.turn, t: this.clock, col: piece.col });
    const frags = [];
    for (const c of piece.cells) {
      const f = this._makePiece(P, 'A1', 0, Math.floor(c / N), c % N, [c]);
      f.isAdd = false;
      f.frag = true;
      f.fromId = piece.id;
      f.col = piece.col;   // 破片は元のキューブの色・柄のまま
      if (piece.hitMask & bit(c)) { f.hitMask = f.mask; f.hitOrder = [c]; }
      P.pieces.push(f);
      frags.push(f);
    }
    if (P.treasure && P.treasure.pieceId === piece.id) {
      const f = frags.find((x) => x.cells[0] === P.treasure.cell);
      if (f) { P.treasure.pieceId = f.id; P.treasure.idx = 0; }
    }
    const killed = [];
    for (const f of frags) if (f.hitMask) { this._destroy(f, 'bazooka'); killed.push(f.cells[0]); }
    return { killed, frags: frags.filter((f) => f.alive).map((f) => f.cells[0]) };
  };

  // 試合のまとめ（大会の集計用）：得点、失ったキューブ（大会から消える）、残った手持ちのアイテム
  //  バズーカで分解されたキューブは、1ブロックのキューブが1つでも生き残っていれば失わない（次の試合で元のブロック数に戻る）
  Game.prototype.summary = function () {
    return this.players.map((P) => {
      const lost = [];
      for (const p of P.pieces) if (!p.frag && !p.isAdd && !p.alive) lost.push(p.size);
      for (const sp of P.splitPieces) if (!P.pieces.some((f) => f.frag && f.fromId === sp.id && f.alive)) lost.push(sp.size);
      const placed = P.pieces.filter((p) => !p.frag && !p.isAdd).map((p) => p.size).concat(P.splitPieces.map((sp) => sp.size));
      const used = Object.keys(P.used).filter((k) => P.used[k]);
      return {
        name: P.name, attack: P.score.attack, survival: P.score.survival, treasure: P.score.treasure,
        lost: lost.sort((a, b) => a - b), placed: placed.sort((a, b) => a - b), items: Object.assign({}, P.items), used,
        treasureFound: !!P.view.treasureFound,
      };
    });
  };

  // ---------------- リプレイ（v12.9） ----------------
  // 先攻の抽選のほかに運の要素がないので、操作（配置・トレジャー・ドラフト・アイテム・コール・アンサー・差し出し・
  // トレジャーコール・ターンエンドなど）を順に記録しておけば、同じ操作をやり直してどの場面でも同じ盤面を再現できる。
  // 操作の中から呼ばれる操作（おまかせ配置の中の配置など）は、外側だけを記録する。断られた操作（ok: false）は記録しない
  //  配置の途中の操作（試しに置いて外すなど。CPUは何十通りも試す）は、配置を終えたときに、決まった配置1つ（_setupState）にまとめる
  const REC_METHODS = ['placePiece', 'removePiece', 'clearSetup', 'setTreasure', 'finishSetup', 'draftPick', 'call', 'skipCall', 'answer', 'sacrifice', 'endTurn', 'treasureCall', 'useItem'];
  const SETUP_METHODS = { placePiece: 1, removePiece: 1, clearSetup: 1, setTreasure: 1 };
  let recDepth = 0;
  for (const m of REC_METHODS) {
    const f = Game.prototype[m];
    Game.prototype[m] = function () {
      if (recDepth || !this.actions) return f.apply(this, arguments);
      const args = JSON.parse(JSON.stringify(Array.prototype.slice.call(arguments)));
      let pre = null;
      if (m === 'finishSetup') { const P = this.players[args[0]]; if (P) pre = JSON.parse(JSON.stringify({ pieces: P.pieces, treasure: P.treasure, nextId: P.nextId })); }
      recDepth++;
      let r;
      try { r = f.apply(this, arguments); } finally { recDepth--; }
      if (r && r.ok === false) return r;
      if (m === 'finishSetup' && pre) {
        this.actions = this.actions.filter((a) => !(SETUP_METHODS[a[0]] && a[1] === args[0]));
        this.actions.push(['_setupState', args[0], pre]);
      }
      this.actions.push([m].concat(args));
      return r;
    };
  }
  // 配置を終えたときの、その人の配置（キューブの番号も含めてそのまま戻す）
  Game.prototype._setupState = function (pi, s) {
    const P = this.players[pi];
    P.pieces = JSON.parse(JSON.stringify(s.pieces));
    P.treasure = s.treasure ? Object.assign({}, s.treasure) : null;
    P.nextId = s.nextId;
    return { ok: true };
  };
  Game.prototype.replayRecord = function () {
    if (!this.actions || !this.initOpts) return null;
    return { v: VERSION, opts: this.initOpts, first: this.first, actions: this.actions.slice() };
  };
  // 記録のはじめの n 個の操作をやり直した対戦（n を省くと最後まで）
  function replayGame(rec, n) {
    const g = new Game(Object.assign({}, rec.opts, { first: rec.first, rng: () => 0.5 }));
    g.actions = null;   // やり直しの間は記録しない
    const k = n == null ? rec.actions.length : Math.min(n, rec.actions.length);
    for (let i = 0; i < k; i++) { const a = rec.actions[i]; g[a[0]].apply(g, a.slice(1)); }
    return g;
  }
  // リプレイの場面：対戦が始まった時点（配置とドラフトの後）を最初の場面にし、ターンエンドを除く操作ごとに1場面。
  //  n＝そこまでの操作の数、ev・log＝そこまでのイベント・ログの数、turn・actor＝その操作をしたターンと人、m・key＝操作（アイテムの種類）
  //  end＝その手番（ターンの中の1人分）の最後の場面
  function replayFrames(rec) {
    const g = replayGame(rec, 0);
    const frames = [];
    let started = false;
    for (let i = 0; i < rec.actions.length; i++) {
      const a = rec.actions[i], m = a[0];
      const turn = g.turn;
      g[m].apply(g, a.slice(1));
      if (!started) {
        if (g.phase === 'play' || g.phase === 'over') { started = true; frames.push({ n: i + 1, start: true, ev: g.events.length, log: g.log.length, turn: g.turn, actor: g.cur }); }
        continue;
      }
      if (m === 'endTurn') continue;
      frames.push({ n: i + 1, m, key: m === 'useItem' ? a[2] : null, actor: a[1], turn, ev: g.events.length, log: g.log.length });
    }
    for (let f = 0; f < frames.length; f++) {
      const x = frames[f], y = frames[f + 1];
      x.end = !y || x.start || y.turn !== x.turn || y.actor !== x.actor;
    }
    return { frames, final: g };
  }

  // ------------------------------------------------------------------
  // 大会：4人（あなた＋CPU3人）の総当たりの予選3試合 → 上位2名で決勝
  //  ・持ち点（v12.10）：80点＋宝石4つ（1つ5点）＝100点で始め、相手のキューブを撃破するとそのブロック数を相手から奪う（アンサー失敗で差し出したキューブ・バズーカで撃破したブロックも同じ）。
  //    勝者はさらに勝利点（予選1試合目5・2試合目10・3試合目15・決勝20）を奪う。トレジャーを見つけると相手の宝石を1つ奪う。1pt＝1万円
  //  ・予選の順位は持ち点の順。同点は勝ち数 → 撃破ブロック数（撃破で奪ったブロック数）→ 抽選の順（v12.8。それまではすぐ抽選）
  //  ・キューブは大会を通して 2ブロック×5・3ブロック×4・4ブロック×3・5ブロック×2。撃破・アンサー失敗で失ったキューブは大会から消える
  //  ・アイテムは9種類を2つずつ持って始める（購入はない）。予選は1試合で同じ種類は1回まで
  //  ・決勝は予選の残り＋ドラフト（9種類から4つずつ）。予選1位が「先攻」か「ドラフト先行権（後攻）」を選ぶ
  //  ・決勝は全滅させた側が優勝（持ち点は関係ない）。賞金は優勝者の持ち点×1万円
  // 状態はふつうのオブジェクト（JSONで保存できる）で持ち、ここの関数で動かす
  // 大会に出るCPU：4人の中から毎回3人（v12.6）。それぞれ性格（置き方・アイテムの使い方）がある
  const TOUR_CHARS = [
    { key: 'alpha', name: 'CPU-α', persona: 'mass' },
    { key: 'beta', name: 'CPU-β', persona: 'save' },
    { key: 'gamma', name: 'CPU-γ', persona: 'steady' },
    { key: 'delta', name: 'CPU-δ', persona: 'items' },
  ];
  // 持ち点（v12.10）：80点＋宝石4つ（20点）＝100点で始める。キューブ44ブロック・予選の勝利点30（5＋10＋15）・宝石20をすべて失っても94点なので、予選でマイナスにならない
  const TOUR_START = 80;
  // CPUの性格（大会での置き方・アイテムの使い方。中身の方針はCPUの側で持つ）。名前と説明は画面に出す
  const TOUR_PERSONAS = {
    mass: { name: '物量型', desc: '毎試合キューブを多く置き、盤面を埋める' },
    save: { name: 'キューブ温存型', desc: '序盤は2ブロックを少なく置き、3・4ブロックを3試合目と決勝に温存する' },
    steady: { name: '堅実型', desc: '3・4ブロックのキューブで毎試合厚く置く' },
    items: { name: 'アイテム浪費型', desc: 'アイテムを惜しまず使い、序盤から押し切る' },
  };
  // 宝石（v12.6の終わり）：1人4つ（1つ5点）持って始め、各試合1つをトレジャーとして置く。相手に見つけられたら、その宝石は相手のものになる
  const TOUR_GEMS = 4;
  const TOUR_GEM_PTS = 5;
  const TOUR_TREASURE = TOUR_GEM_PTS;
  // 勝者が負けた側から奪う勝利点：予選1試合目5・2試合目10・3試合目15・決勝20（v12.10。3試合目＝1・2試合目の合計で、最後まで逆転しやすい。宝石1つ＝1試合目の勝ち）
  const TOUR_VICTORY_BY = [5, 10, 15, 20];
  const TOUR_VICTORY = TOUR_VICTORY_BY[0];
  // スピードペナルティ（予選だけ。v12.15まではスピードボーナス）：早いターンで負けた側の持ち点を減らす。index＝決着したターン（1ターン＝両者の手番）。
  // v12.16：1ターン目24・2ターン目21・18・15・12・9・6・8ターン目3、9ターン目から0（3点ずつ下がる）。アンサー失敗で負けても同じ。
  // 減らした点は勝った側に渡さない（自滅点）。渡すと、わざと早く負けて特定の相手に点を与える動き（利敵行為）ができてしまうため。
  // ねらいは、大差でリードしているときに2ブロック1個だけ置いて即負けし、キューブを温存する動きを防ぐこと。
  // v12.15は 52・42・33・25・18・12・7・3 を、v12.14は 15・14・12・9・5 を、勝った側が負けた側から奪っていた
  const TOUR_SPEED = [0, 24, 21, 18, 15, 12, 9, 6, 3];
  function speedFor(turn) { return TOUR_SPEED[turn | 0] || 0; }
  function victoryFor(kind, round) { return kind === 'final' ? TOUR_VICTORY_BY[3] : TOUR_VICTORY_BY[Math.max(0, Math.min(2, round | 0))]; }
  function victorySteal() { return TOUR_VICTORY; }
  // 大会の初期アイテム：9種類を2つずつ（合計18個。v12.5で購入を廃止して1つずつ→2つずつ）
  const TOUR_ITEMS_EACH = 2;
  const Tour = {
    START: TOUR_START,
    TREASURE: TOUR_TREASURE,
    VICTORY: TOUR_VICTORY,
    VICTORY_BY: TOUR_VICTORY_BY,
    SPEED: TOUR_SPEED,
    speedFor,
    GEMS: TOUR_GEMS,
    GEM_PTS: TOUR_GEM_PTS,
    victoryFor,
    PERSONAS: TOUR_PERSONAS,
    CHARS: TOUR_CHARS,
    // その人の性格（CPUだけ。あなた・性格なしの大会は null）
    persona(T, id) { const k = T.personas && T.personas[id]; return k && TOUR_PERSONAS[k] ? k : null; },
    victorySteal,
    ITEMS_EACH: TOUR_ITEMS_EACH,
    create(opts) {
      opts = opts || {};
      const rng = opts.rng || Math.random;
      // 出場するCPU：opts.chars（キーの配列）か、4人からランダムに3人（並びはα・β・γ・δの順）
      let lineup = Array.isArray(opts.chars) ? opts.chars.slice(0, 3) : null;
      if (!lineup) {
        const keys = TOUR_CHARS.map((c) => c.key);
        const out = keys.splice(Math.floor(rng() * keys.length), 1);
        lineup = TOUR_CHARS.map((c) => c.key).filter((k) => k !== out[0]);
      }
      const charOf = (k) => TOUR_CHARS.find((c) => c.key === k);
      const names = opts.names || ['あなた'].concat(lineup.map((k) => charOf(k).name));
      const cpu = opts.cpu || [false, true, true, true];
      const each = opts.itemsEach != null ? opts.itemsEach : TOUR_ITEMS_EACH;
      const players = names.map((name, i) => {
        const inv = {};
        for (const k of ITEM_KEYS) inv[k] = each;
        return {
          id: i, name, cpu: !!cpu[i], char: i > 0 ? lineup[i - 1] : null, stock: Object.assign({}, STOCK), inv,
          // take＝撃破で奪った、taken＝撃破で奪われた、vicWon／vicLost＝勝利で奪った／奪われた。gems＝持っている宝石（1つ5点）
          pts: { start: TOUR_START, take: 0, taken: 0, vicWon: 0, vicLost: 0, spdWon: 0, spdLost: 0 }, gems: TOUR_GEMS, gemsWon: 0, gemsLost: 0, wins: 0, losses: 0, draws: 0,
          lotto: rng(),
        };
      });
      // 総当たり（3ラウンド）：あなた（0番）の相手の順はランダム。同じラウンドに残りの2人が対戦する
      const others = [1, 2, 3];
      for (let i = others.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = others[i]; others[i] = others[j]; others[j] = t; }
      const rounds = others.map((o) => [[0, o], [1, 2, 3].filter((x) => x !== o)]);
      // CPUの性格：出場するCPUの性格（opts.personas に null を渡すと性格なし＝CPUはみな標準の置き方）
      const personas = opts.personas !== undefined ? opts.personas : { 1: charOf(lineup[0]).persona, 2: charOf(lineup[1]).persona, 3: charOf(lineup[2]).persona };
      return { v: VERSION, players, rounds, round: 0, results: [], stage: 'intro', finalists: null, finalFirstBy: null, champion: null, log: [], personas };
    },
    // 持ち点の合計＝はじめ50＋撃破で奪った−奪われた＋勝利で奪った−奪われた＋宝石×5
    total(p) { const q = p.pts; return q.start + q.take - q.taken + q.vicWon - q.vicLost + (q.spdWon | 0) - (q.spdLost | 0) + (p.gems | 0) * TOUR_GEM_PTS; },
    cubes(p) { return [2, 3, 4, 5].reduce((s, k) => s + (p.stock[k] || 0), 0); },
    cells(p) { return [2, 3, 4, 5].reduce((s, k) => s + k * (p.stock[k] || 0), 0); },
    items(p) { return ITEM_KEYS.reduce((s, k) => s + (p.inv[k] || 0), 0); },
    // 順位（持ち点の多い順。同点は勝ち数 → 撃破ブロック数 → 抽選）
    standings(T) {
      const list = T.players.map((p) => ({ id: p.id, total: Tour.total(p), wins: p.wins | 0, take: p.pts.take | 0, lotto: p.lotto }));
      list.sort((a, b) => b.total - a.total || b.wins - a.wins || b.take - a.take || b.lotto - a.lotto);
      list.forEach((x, i) => { x.rank = i + 1; });
      return list;
    },
    rankOf(T, id) { return Tour.standings(T).find((x) => x.id === id).rank; },
    // 対戦の設定（Game の opts）
    matchOpts(T, a, b, kind, extra) {
      const pa = T.players[a], pb = T.players[b];
      const fin = kind === 'final';
      const stockFor = (p) => {
        const st = Object.assign({}, p.stock);
        // 決勝で置けるキューブが0なら、2ブロックを1つ支給する
        if (fin && Tour.cubes(p) === 0) st[2] = 1;
        return st;
      };
      return Object.assign({
        rules: fin ? 'final' : 'prelim',
        label: fin ? '決勝' : `予選 第${T.round + 1}試合`,
        names: [pa.name, pb.name], cpu: [pa.cpu, pb.cpu],
        stocks: [stockFor(pa), stockFor(pb)],
        inventory: [Object.assign({}, pa.inv), Object.assign({}, pb.inv)],
        oncePerMatch: !fin, draftEach: fin ? Math.floor(ITEM_KEYS.length / 2) : 0, treasurePts: TOUR_TREASURE, treasureSteal: true,
        victoryPts: victoryFor(kind, T.round), speedBonus: !fin,
      }, extra || {});
    },
    // 試合の結果を反映する（a, b は大会の番号。game の 0番が a、1番が b）
    // 1試合の持ち点の増減（席ごと）：take＝撃破で奪った、taken＝撃破で奪われた、victory＝勝利で奪った（＋）／奪われた（−）、
    // gems＝宝石の増減（相手のトレジャーを見つけたら+1、自分のトレジャーを見つけられたら−1）、treasure＝宝石の点（×5）
    matchPoints(game) {
      const sum = game.summary();
      const r = game.result || { winner: -1, draw: true };
      const vp = game.victoryPts || TOUR_VICTORY;
      return [0, 1].map((k) => {
        const s = sum[k], o = sum[1 - k];
        const win = !r.draw && r.winner === k, lose = !r.draw && r.winner === 1 - k;
        const victory = win ? vp : lose ? -vp : 0;
        const gems = (s.treasureFound ? 1 : 0) - (o.treasureFound ? 1 : 0);
        const treasure = gems * TOUR_GEM_PTS;
        // スピードペナルティ（予選だけ）：決着したターンで決まる点を、負けた側から減らすだけ（勝った側は増えない。v12.16）
        const sp = game.speedBonus && !r.draw ? speedFor(game.turn) : 0;
        const speed = lose ? -sp : 0;
        return { take: s.attack, taken: o.attack, victory, speed, gems, treasure, total: s.attack - o.attack + victory + speed + treasure, placed: s.placed.length };
      });
    },
    apply(T, a, b, game, kind) {
      const sum = game.summary();
      const r = game.result || { winner: -1, draw: true };
      const ids = [a, b];
      const pts = Tour.matchPoints(game);
      ids.forEach((id, k) => {
        const p = T.players[id], s = sum[k], d = pts[k];
        p.pts.take += d.take; p.pts.taken += d.taken;
        p.gems = (p.gems | 0) + d.gems;
        if (sum[k].treasureFound) p.gemsWon = (p.gemsWon | 0) + 1;
        if (sum[1 - k].treasureFound) p.gemsLost = (p.gemsLost | 0) + 1;
        if (d.victory > 0) p.pts.vicWon += d.victory; else p.pts.vicLost -= d.victory;
        // spdWon は v12.15 までの「奪った」分（v12.16 からはいつも0。項目は持ち点の式とそろえて残す）
        if (d.speed > 0) p.pts.spdWon = (p.pts.spdWon | 0) + d.speed; else if (d.speed < 0) p.pts.spdLost = (p.pts.spdLost | 0) - d.speed;
        for (const size of s.lost) p.stock[size] = Math.max(0, (p.stock[size] || 0) - 1);
        p.inv = Object.assign({}, s.items);
        if (r.draw) p.draws += 1; else if (r.winner === k) p.wins += 1; else p.losses += 1;
      });
      const res = {
        round: T.round, kind: kind || 'prelim', a, b, first: ids[game.first], turns: game.turn,
        winner: r.draw ? -1 : ids[r.winner], draw: !!r.draw,
        pts, placed: sum.map((s) => s.placed.length),
        lost: sum.map((s) => s.lost), used: sum.map((s) => s.used), treasure: sum.map((s) => s.treasureFound),
        replay: game.replayRecord ? game.replayRecord() : null,   // リプレイ（途中経過の画面からいつでも見られる）
      };
      T.results.push(res);
      return res;
    },
    finalists(T) { const s = Tour.standings(T); return [s[0].id, s[1].id]; },
  };

  const api = {
    VERSION, COLS, STOCK, CATS, SHAPES, SHAPES_BY_SIZE, ORIENT, ITEM_KEYS, ITEMS,
    bit, popcount, bitsOf, maskOf, cellsFor, rotationOf, placements, identifyShape, matchPlacement, coord, coordList, lineMask, lineLabel, blockDist, nodeDegree, makeRules, Game, Tour, replayGame, replayFrames,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SBEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
