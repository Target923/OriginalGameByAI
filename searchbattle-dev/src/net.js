/* サーチバトル — オンライン対戦（P2P・ホスト権威）
 *
 * しくみ（くわしくは docs/online.md）
 *  ・部屋を作った人（ホスト）の端末が審判。本当の盤面を持ち、ルールのプログラム（engine.js）で判定する。
 *  ・相手（ゲスト）は操作を送るだけ。ホストは判定のたびに「ゲストが見てよい情報だけにしたスナップショット」を送り、
 *    ゲストはそれで画面を描く。だからゲストの端末には、ホストのキューブの位置がそもそも届かない。
 *  ・端末どうしは WebRTC で直接つながる。つながる前の「住所の交換」（シグナリング）だけ PeerJS の無料クラウドを使う。
 *
 * このファイルの中身
 *  ① 部屋のコード・名前の整え方
 *  ② 伏せる：redactFor（ゲスト向けのスナップショット）・fullSnap（決着後の全部）・restore（スナップショットから対戦を作り直す）
 *  ③ 届いた操作の中身を確かめる：cleanArgs・cleanSetup
 *  ④ ホストの役（Host）とゲストの役（Guest）：メッセージを受け取って処理する。通信のしかたには関わらない
 *     （テストでは、同じプログラムの中でメッセージを直接渡して動かす。test/net_sim.js）
 *  ⑤ PeerJS の部分：読み込み・部屋を作る（openRoom）・部屋に入る（joinRoom）・つながりの見張り（wrapConn）
 *
 * ブラウザでは window.SBNet、Node では module.exports として公開する（engine.js と同じ形）。
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.SBEngine;

  // ---------------- 定数 ----------------
  const APP = 'searchbattle';
  // 通信の約束ごと（メッセージの形）の版。形を変えたら上げる。ゲームの版（E.VERSION）と両方が同じ相手とだけ遊べる
  const NET_VERSION = 5;   // 2：v14.5 形の分類の名前が変わった（R型・L型・T型・Z型）／3：v15 ワープの作り直し（トリガーを送る・発動の演出 warpfire）／4：v15.1 ステルスの見破りがキューブごとに／5：v15.2 ワープの通知（full）と隠れたレティクル（late）
  const HOST_SEAT = 0, GUEST_SEAT = 1;   // ホストは0番の席、ゲストは1番の席
  // PeerJS のクラウドはみんなで使う場所なので、ほかのアプリの ID とぶつからないよう頭に付ける
  const PEER_PREFIX = 'searchbattle-';
  // 部屋のコードに使う文字（32文字）。読み間違えやすい 0・O・1・I は使わない。6文字で約10億通り
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const CODE_LEN = 6;
  const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js';
  // オンライン対戦を遊べるページ（GitHub Pages 版）。claude.ai の公開ページから案内する
  const PLAY_URL = 'https://target923.github.io/OriginalGameByAI/search_battle.html';
  // ゲストがホストに頼める操作（対戦中の操作だけ。配置は最後にまとめて setup で送る）
  const PLAY_ACTS = ['draftPick', 'call', 'useItem', 'answer', 'skipCall', 'endTurn', 'treasureCall', 'sacrifice'];
  // ホストが自分で実行したとき、ゲストに新しい状態を送る操作（配置の途中は送らない。送っても伏せる部分なので意味がない）
  const SYNC_ACTS = PLAY_ACTS.concat(['finishSetup']);
  const PING_MS = 4000;          // 「生きているよ」の合図を送る間隔
  const TIMEOUT_MS = 45000;      // これだけ何も届かなければ切れたとみなす（スマホでほかのアプリを少し開いても切れないよう長め）
  const JOIN_TIMEOUT_MS = 20000; // 部屋に入るとき、これだけ待ってもつながらなければあきらめる

  // ---------------- ① 部屋のコード・名前 ----------------
  // 0〜n-1 の乱数。できれば暗号用の乱数（予想されにくい）を使う。32は 2の32乗を割り切るので、余りで偏らない
  function randomInt(n) {
    const c = root.crypto;
    if (c && c.getRandomValues) { const a = new Uint32Array(1); c.getRandomValues(a); return a[0] % n; }
    return Math.floor(Math.random() * n);
  }
  function makeCode(rand) {
    rand = rand || randomInt;
    let s = '';
    for (let i = 0; i < CODE_LEN; i++) s += CODE_CHARS[rand(CODE_CHARS.length)];
    return s;
  }
  // 入力されたコードを整える。全角・小文字・空白・ハイフンは許す。使えない文字があるか長さが違えば null
  function normCode(s) {
    const t = String(s == null ? '' : s).normalize('NFKC').toUpperCase().replace(/[\s\-ー－]/g, '');
    if (t.length !== CODE_LEN) return null;
    for (const ch of t) if (CODE_CHARS.indexOf(ch) < 0) return null;
    return t;
  }
  // 名前を整える：相手の画面にそのまま出るので、HTML の記号と制御文字を取り除き、12文字までにする。
  //  「：」はログの「名前：〜」の区切りに使うので、名前には入れない（NFKC で全角の「：」も半角になる）
  function cleanName(s, fallback) {
    const t = String(s == null ? '' : s).normalize('NFKC').replace(/[\u0000-\u001f\u007f<>&"'`:]/g, '').trim();
    return Array.from(t).slice(0, 12).join('') || fallback;
  }

  // ---------------- ② 伏せる ----------------
  // 撃破された相手のキューブのうち、ゲストに送ってよい項目（撃破されたキューブは公開済み）。
  //  送らないもの：fromId（バズーカの破片の元のキューブ＝元の形が分かる）、stealth（どれをステルスにしたか）、placedAt など
  const DEAD_FIELDS = ['id', 'owner', 'shape', 'size', 'cat', 'isAdd', 'frag', 't', 'r0', 'c0', 'cells', 'mask', 'alive', 'hitMask', 'hitOrder', 'oonums', 'cause', 'deadAt'];

  // 対戦（Game）を、送れる形（ただのデータ）に写す。乱数の関数（rng）は送れないので外す。
  //  JSON にして戻すと、関数と undefined の項目が消え、元の対戦とつながりのない「写し」になる
  function plain(game, drop) {
    const o = Object.assign({}, game, { rng: undefined });
    for (const k of drop || []) o[k] = undefined;
    return JSON.parse(JSON.stringify(o));
  }

  // seat の人に送るスナップショット：相手（1 - seat）だけが知っている情報を取り除く。
  //  ここで消し忘れると、ゲストの端末に秘密が届いてしまう。消すものの一覧は docs/online.md の「5. ゲストに送らないもの」。
  //  消し忘れがないことは test/net_sim.js が、どの場面のスナップショットでも確かめる
  function redactFor(game, seat) {
    const hide = 1 - seat;
    // 操作の記録（actions）は配置の座標を含むので送らない。はじめの設定（initOpts）・CPUの方針も要らない
    const s = plain(game, ['actions', 'initOpts', 'setupPlan', 'itemKeep']);
    const H = s.players[hide], me = s.players[seat];
    // ① 相手のキューブ：撃破されたもの（公開済み）だけを残す。
    //    キューブの番号は置いた順に付いているので、そのままだと「何個置いたか」の手がかりになる。撃破された順に付け直す
    const dead = H.pieces.filter((p) => !p.alive).sort((a, b) => (a.deadAt - b.deadAt) || (a.id - b.id));
    const newId = {};
    H.pieces = dead.map((p, i) => {
      const q = {};
      for (const k of DEAD_FIELDS) if (p[k] !== undefined) q[k] = p[k];
      newId[p.id] = q.id = i + 1;
      return q;
    });
    // 自分から見た相手の盤（撃破したブロック）も、同じ番号に付け直す（どのブロックが同じキューブだったかは公開済み）
    for (const d of me.view.dead) if (d && newId[d.pieceId] != null) d.pieceId = newId[d.pieceId];
    H.treasure = null;     // トレジャーのブロック
    H.splitPieces = [];    // バズーカで分解された元のキューブの形
    H.nextId = 0;          // 次のキューブの番号（置いた数が分かる）
    // ② 先攻・後攻は、配置が終わるまで伏せる（ふつうの試合でも、配置のあとの「試合開始」で分かる）
    if (s.phase === 'setup') { s.first = null; s.cur = null; }
    // ③ 演出の記録：数と順番は変えない（ゲストの画面は「どこまで見せたか」を番号で覚えているため）
    for (const ev of s.events) {
      if (ev.actor === hide) delete ev.priv;          // 相手のワープのキューブ・トリガー・移動先、ステルスをかけたブロック
      if (ev.owner === hide) {
        delete ev.ownerPriv;                          // バズーカで分解された相手のキューブの、残りのブロック／ワープの移動前の全部のブロックと移動後（v15）
        if (ev.type === 'shield') delete ev.cells;    // ステルスが撃破を防いだ相手のキューブのブロック
      }
    }
    // ④ ログ：本人向けの詳しい文（priv。ワープの移動先など）は消す
    for (const e of s.log) if (e.actor === hide) e.priv = null;
    // ⑤ 直前の操作：相手のステルスの結果（ブロック）
    const la = s.lastAction;
    if (la && la.pi === hide && la.result) { delete la.result.cells; delete la.result.newCells; }
    return s;
  }

  // 決着のあとは全部見せる（答え合わせとリプレイのため。リプレイには操作の記録 actions が要る）
  function fullSnap(game) { return plain(game); }

  // スナップショット（ただのデータ）から、対戦（Game）を作り直す。
  //  Game のメソッド（isCallable など）が使えるように、Game の「型」（prototype）を付け直すだけ。
  //  公開ページの更新で対戦を引き継ぐとき（ui.js の restore）と同じ方法
  function restore(snap) {
    const g = Object.create(E.Game.prototype);
    Object.assign(g, snap);
    g.rng = Math.random;
    if (!Array.isArray(g.events)) g.events = [];
    if (!Array.isArray(g.log)) g.log = [];
    // 伏せたスナップショットには記録（actions）がない。null にしておくと、手元で配置する操作は記録しない
    if (!Array.isArray(g.actions)) g.actions = null;
    return g;
  }

  // ---------------- ③ 届いた操作の中身を確かめる ----------------
  // ルールのプログラムも確かめるが、改造したゲームから変な形のデータ（数の代わりに文字など）が届いても
  // おかしくならないよう、先に形をそろえる。合わなければ null（＝断る）
  const isInt = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
  function cleanArgs(name, args, g) {
    if (!Array.isArray(args)) return null;
    const N = g.N, cell = (x) => isInt(x, 0, g.NN - 1);
    switch (name) {
      case 'skipCall':
      case 'endTurn':
        return [];
      case 'call':
      case 'treasureCall':
        return cell(args[0]) ? [args[0]] : null;
      case 'sacrifice':
        return isInt(args[0], 1, 9999) ? [args[0]] : null;
      case 'draftPick':
        return E.ITEM_KEYS.indexOf(args[0]) >= 0 ? [args[0]] : null;
      case 'answer': {
        const cells = args[0];
        if (!Array.isArray(cells) || cells.length < 1 || cells.length > 5 || !cells.every(cell)) return null;
        return [cells.slice()];
      }
      case 'useItem': {
        const key = args[0], p = args[1];
        if (E.ITEM_KEYS.indexOf(key) < 0 || !p || typeof p !== 'object') return null;
        let q = null;
        switch (key) {
          case 'cube':
            if (p.kind === 'cat' && E.CATS.indexOf(p.value) >= 0) q = { kind: 'cat', value: p.value };
            else if (p.kind === 'size' && isInt(p.value, 1, 5)) q = { kind: 'size', value: p.value };
            break;
          case 'line':
            if ((p.line === 'row' || p.line === 'col') && isInt(p.index, 0, N - 1)) q = { line: p.line, index: p.index };
            break;
          case 'number': case 'shape': case 'node': case 'bazooka':
            if (cell(p.cell)) q = { cell: p.cell };
            break;
          case 'pair':
            if (cell(p.a) && cell(p.b)) q = { a: p.a, b: p.b };
            break;
          case 'warp':
            // v15：cell＝トリガーブロック。t・r0・c0＝移動先（向きと位置）
            if (isInt(p.pieceId, 1, 9999) && cell(p.cell) && isInt(p.t, 0, 7) && isInt(p.r0, 0, N - 1) && isInt(p.c0, 0, N - 1)) q = { pieceId: p.pieceId, cell: p.cell, t: p.t, r0: p.r0, c0: p.c0 };
            break;
          case 'stealth':
            if (isInt(p.pieceId, 1, 9999) && cell(p.cell)) q = { pieceId: p.pieceId, cell: p.cell };   // cell＝トリガーブロック（v14.2）
            break;
        }
        return q ? [key, q] : null;
      }
    }
    return null;
  }
  // 配置（形・向き・位置の並びと、トレジャーのブロック）の形をそろえる
  function cleanSetup(msg, g) {
    const list = msg && msg.pieces;
    if (!Array.isArray(list) || list.length < 1 || list.length > 20) return null;
    const pieces = [];
    for (const p of list) {
      if (!p || typeof p.key !== 'string' || p.key === 'A1' || !Object.prototype.hasOwnProperty.call(E.SHAPES, p.key)) return null;
      if (!isInt(p.t, 0, 7) || !isInt(p.r0, 0, g.N - 1) || !isInt(p.c0, 0, g.N - 1)) return null;
      pieces.push({ key: p.key, t: p.t, r0: p.r0, c0: p.c0, col: isInt(p.col, 1, 99) ? p.col : 0 });
    }
    if (!isInt(msg.treasure, 0, g.NN - 1)) return null;
    return { pieces, treasure: msg.treasure };
  }

  // ---------------- ④ ホストの役 ----------------
  // o.name：ホストの名前、o.send(msg)：ゲストへ送る、o.makeGame(names)：試合を作る（ルール・アイテムはホストの設定で）
  // o.on：画面への知らせ { guest(名前), match(対戦), change(操作の名前), bye(理由) }
  function Host(o) {
    this.name = cleanName(o.name, 'ホスト');
    this.send = o.send;
    this.makeGame = o.makeGame;
    this.on = o.on || {};
    this.game = null;       // 本当の対戦（ホストだけが持つ）
    this.guestName = null;
    this.ack = 0;           // 最後に処理したゲストの操作の番号（ゲストが「自分の操作の結果か」を見分けるため）
  }
  Host.prototype._emit = function (k, x) { if (this.on[k]) this.on[k](x); };
  // ゲストから届いたメッセージを、種類ごとに振り分ける
  Host.prototype.receive = function (msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') this._hello(msg);
    else if (msg.t === 'setup') this._setup(msg);
    else if (msg.t === 'act') this._act(msg);
    else if (msg.t === 'bye') this._emit('bye', typeof msg.reason === 'string' ? msg.reason : 'left');
  };
  Host.prototype._hello = function (msg) {
    // 同じゲームの同じ版どうしでないと、ルールや通信の形が食い違うので断る
    if (msg.app !== APP || msg.net !== NET_VERSION || msg.v !== E.VERSION) {
      this.send({ t: 'bye', reason: 'version' });
      this._emit('bye', 'version');
      return;
    }
    if (this.guestName != null) return;   // 2回目の hello は無視する
    let nm = cleanName(msg.name, 'ゲスト');
    if (nm === this.name) nm = Array.from(nm).slice(0, 11).join('') + '2';   // 同じ名前だと画面で見分けられないので
    this.guestName = nm;
    this._emit('guest', nm);
    this.newMatch();
  };
  // 新しい試合を作って、ゲストに知らせる（最初の試合と「もう一度」）
  Host.prototype.newMatch = function () {
    this.game = this.makeGame([this.name, this.guestName]);
    this.send({ t: 'welcome', seat: GUEST_SEAT, snap: redactFor(this.game, GUEST_SEAT), ack: this.ack });
    this._emit('match', this.game);
  };
  // ゲストの配置：ホストのルールのプログラムで1つずつ置き直して確かめる（置けない配置は断る）
  Host.prototype._setup = function (msg) {
    const g = this.game, pi = GUEST_SEAT;
    const open = () => g && g.phase === 'setup' && !g.players[pi].setupDone;
    const fail = (reason) => {
      if (open()) g.clearSetup(pi);
      this.send({ t: 'reject', what: 'setup', reason: reason || '配置が正しくありません' });
    };
    if (!open()) return fail('いまは配置を受け付けていません');
    const s = cleanSetup(msg, g);
    if (!s) return fail();
    g.clearSetup(pi);
    for (const p of s.pieces) {
      const r = g.placePiece(pi, p.key, p.t, p.r0, p.c0);
      if (!r.ok) return fail(r.reason);
      // 色・柄の番号は、ゲストの画面で付いたものを使う（外した番号が空いたままになるので、置き直すと詰まってしまう）
      if (p.col && !g.players[pi].pieces.some((q) => q !== r.piece && q.col === p.col)) r.piece.col = p.col;
    }
    const tr = g.setTreasure(pi, s.treasure);
    if (!tr.ok) return fail(tr.reason);
    const fr = g.finishSetup(pi);
    if (!fr.ok) return fail(fr.reason);
    this.sync();
    this._emit('change', 'setup');
  };
  // ゲストの対戦中の操作。いつでもゲストの席（1番）として実行するので、ホストの席の操作はできない。
  //  手番・アイテムの残り・ブロックの範囲などは、ルールのプログラム（engine.js）が確かめる
  Host.prototype._act = function (msg) {
    const g = this.game;
    const seq = isInt(msg.seq, 1, 1e9) ? msg.seq : 0;
    const args = g && PLAY_ACTS.indexOf(msg.name) >= 0 ? cleanArgs(msg.name, msg.args, g) : null;
    let r = null;
    if (args) {
      try { r = g[msg.name].apply(g, [GUEST_SEAT].concat(args)); } catch (e) { r = null; }
    }
    if (seq > this.ack) this.ack = seq;
    if (!r || r.ok === false) {
      this.send({ t: 'reject', what: 'act', seq, reason: (r && r.reason) || 'いまはその操作はできません' });
      return;
    }
    this.sync();
    this._emit('change', msg.name);
  };
  // ホスト自身の操作：その場で実行し、対戦の操作ならゲストに新しい状態を送る（args の先頭は席の番号）
  Host.prototype.run = function (name, args) {
    const g = this.game;
    const r = g[name].apply(g, args);
    if (SYNC_ACTS.indexOf(name) >= 0 && !(r && r.ok === false)) this.sync();
    return r;
  };
  // ゲストに今の状態を送る。決着したら伏せない全部（答え合わせとリプレイ用）
  Host.prototype.sync = function () {
    const g = this.game;
    if (!g) return;
    if (g.phase === 'over') this.send({ t: 'full', snap: fullSnap(g), ack: this.ack });
    else this.send({ t: 'state', snap: redactFor(g, GUEST_SEAT), ack: this.ack });
  };

  // ---------------- ④ ゲストの役 ----------------
  // o.name：ゲストの名前、o.send(msg)：ホストへ送る
  // o.on：画面への知らせ { welcome(対戦), state(対戦), foeReady(真偽), reject(メッセージ), bye(理由) }
  function Guest(o) {
    this.name = cleanName(o.name, 'ゲスト');
    this.send = o.send;
    this.on = o.on || {};
    this.seat = GUEST_SEAT;
    this.game = null;        // 画面に描く対戦（ホストから届いたスナップショット。配置の途中だけは手元で動かす）
    this.seq = 0;            // 送った操作の通し番号
    this.wait = 0;           // 結果を待っている操作の番号（0＝待っていない）
    this.setupSent = false;  // 配置を送って、ホストの確認を待っている
    this.foeReady = false;   // 相手（ホスト）が配置を終えたか
  }
  Guest.prototype._emit = Host.prototype._emit;
  Guest.prototype.hello = function () {
    this.send({ t: 'hello', app: APP, net: NET_VERSION, v: E.VERSION, name: this.name });
  };
  Guest.prototype.receive = function (msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'welcome': {
        // 新しい試合。届いた（伏せた）対戦を手元に置き、自分の席の配置はこの中で行う
        this.seat = GUEST_SEAT;
        this.game = restore(msg.snap);
        this.wait = 0;
        this.setupSent = false;
        this.foeReady = !!this.game.players[1 - this.seat].setupDone;
        this._emit('welcome', this.game);
        return;
      }
      case 'state':
      case 'full': {
        if (this.wait && msg.ack >= this.wait) this.wait = 0;   // 自分が送った操作の結果が届いた
        const g = restore(msg.snap);
        // 配置をまだ受け付けてもらっていないあいだは、手元で置いている途中の配置を消さないよう、盤面は差し替えない
        if (g.phase === 'setup' && !g.players[this.seat].setupDone && this.game && this.game.phase === 'setup') {
          this.foeReady = !!g.players[1 - this.seat].setupDone;
          this._emit('foeReady', this.foeReady);
          return;
        }
        this.game = g;
        this.setupSent = false;
        this.foeReady = !!g.players[1 - this.seat].setupDone;
        this._emit('state', g);
        return;
      }
      case 'reject':
        if (msg.what === 'setup') this.setupSent = false;
        else if (this.wait && msg.seq >= this.wait) this.wait = 0;
        this._emit('reject', msg);
        return;
      case 'bye':
        this._emit('bye', typeof msg.reason === 'string' ? msg.reason : 'left');
    }
  };
  // 対戦中の操作をホストに頼む（args に自分の席は入れない）。結果はあとで state として届く
  Guest.prototype.act = function (name, args) {
    if (this.wait) return { ok: false, reason: '前の操作の結果を待っています' };
    if (PLAY_ACTS.indexOf(name) < 0) return { ok: false, reason: 'できない操作です' };
    this.seq += 1;
    this.wait = this.seq;
    this.send({ t: 'act', name, args: args || [], seq: this.seq });
    return { ok: true, sent: true };
  };
  // 配置をまとめてホストに送る（形・向き・位置・色と柄の番号と、トレジャーのブロック）。置いた順に並べる（キューブの色が変わらないように）
  Guest.prototype.sendSetup = function () {
    const g = this.game, P = g && g.players[this.seat];
    if (!P || g.phase !== 'setup' || P.setupDone || this.setupSent) return { ok: false, reason: '配置の時間ではありません' };
    if (!P.pieces.length) return { ok: false, reason: '最低1キューブを置いてください' };
    if (!P.treasure) return { ok: false, reason: 'トレジャーをセットしてください' };
    const pieces = P.pieces.slice().sort((a, b) => a.id - b.id).map((p) => ({ key: p.shape, t: p.t, r0: p.r0, c0: p.c0, col: p.col }));
    this.setupSent = true;
    this.send({ t: 'setup', pieces, treasure: P.treasure.cell });
    return { ok: true, sent: true };
  };

  // ---------------- ⑤ PeerJS（端末どうしをつなぐ部分） ----------------
  // このページでオンライン対戦が使えるか。claude.ai の公開ページ（artifact）は、安全のために
  //  WebRTC とほかのサイトへの通信（PeerJS のクラウド）を止めているので使えない。
  //  公開ページの中では window.claude（ページの更新を引き継ぐしくみ）があるので、それで見分ける
  function supported() {
    return typeof root.RTCPeerConnection === 'function' && !root.claude;
  }
  // PeerJS はオンライン対戦を始めるときだけ読み込む（ふだんの対戦では通信しない）
  let peerjsLoading = null;
  function loadPeerJS() {
    if (root.Peer) return Promise.resolve(root.Peer);
    if (!peerjsLoading) {
      peerjsLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = PEERJS_URL;
        s.async = true;
        s.onload = () => (root.Peer ? resolve(root.Peer) : reject(new Error('Peer not found')));
        s.onerror = () => { peerjsLoading = null; reject(new Error('load failed')); };
        (document.head || document.documentElement).appendChild(s);
      });
    }
    return peerjsLoading;
  }
  // PeerJS の設定。ふだんは何も指定しない（＝PeerJS の無料クラウドと、PeerJS が用意している STUN・TURN を使う）。
  //  テスト用：URL に ?peer=localhost:9000 があれば、その PeerServer を使う（この環境からは外のクラウドに出られないため）
  function peerOptions() {
    const o = { debug: 0 };
    try {
      const m = /[?&]peer=([^&#]+)/.exec((root.location && root.location.search) || '');
      if (m) {
        const hp = decodeURIComponent(m[1]).split(':');
        Object.assign(o, { host: hp[0], port: +hp[1] || 9000, path: '/', secure: false, config: { iceServers: [] } });
      }
    } catch (e) { /* ふだんの設定のまま */ }
    return o;
  }
  const ERR_TEXT = {
    'browser-incompatible': 'このブラウザはオンライン対戦（WebRTC）に対応していません',
    network: '通信の仲介サーバーにつながりません。インターネットの接続を確かめてください',
    'server-error': '通信の仲介サーバーにつながりません。しばらくしてから試してください',
    'socket-error': '通信の仲介サーバーとの接続が切れました',
    'socket-closed': '通信の仲介サーバーとの接続が切れました',
    'unavailable-id': '部屋のコードが使えませんでした。もう一度作ってください',
    'peer-unavailable': 'その部屋は見つかりませんでした。コードを確かめてください',
    webrtc: '相手と直接つながれませんでした。別の回線（Wi-Fi とモバイル回線など）で試してください',
    'ssl-unavailable': '安全な接続（https）が使えません',
  };
  function errorText(err) { return ERR_TEXT[err && err.type] || '通信でエラーが起きました'; }

  // PeerJS のつながり（DataConnection）を、このゲームで使う「通信路」の形にまとめる。
  //  外に見せるのは send(msg)・onmessage・onclose・close() だけ（Host・Guest はこれだけを使う）。
  //  相手がタブを閉じたときに「切れた」の知らせが来ないことがあるので、合図（ping）を送り合い、
  //  しばらく何も届かなければ切れたとみなす
  function wrapConn(conn, peer) {
    // つながったあとは、仲介サーバー（クラウド）との接続が切れても、相手との直接のつながりはそのまま続く
    const link = { onmessage: null, onclose: null, closed: false };
    let lastSeen = Date.now();
    let timer = null;
    const end = (reason) => {
      if (link.closed) return;
      link.closed = true;
      clearInterval(timer);
      try { conn.close(); } catch (e) { /* もう閉じている */ }
      try { peer.destroy(); } catch (e) { /* もう閉じている */ }
      if (link.onclose) link.onclose(reason);
    };
    link.send = (msg) => {
      if (link.closed) return;
      try { conn.send(msg); } catch (e) { end('error'); }
    };
    // やめるとき：最後のメッセージ（bye）を送ってから、少し待って閉じる（すぐ閉じると届かないことがある）
    link.close = (lastMsg) => {
      if (link.closed) return;
      if (lastMsg) link.send(lastMsg);
      link.onclose = null;     // 自分でやめたときは「切れた」と知らせない
      link.onmessage = null;
      setTimeout(() => end('local'), 300);
    };
    timer = setInterval(() => {
      if (Date.now() - lastSeen > TIMEOUT_MS) end('timeout');
      else link.send({ t: 'ping' });
    }, PING_MS);
    conn.on('data', (msg) => {
      lastSeen = Date.now();
      if (msg && msg.t === 'ping') return;   // 合図は Host・Guest には渡さない
      if (link.onmessage) link.onmessage(msg);
    });
    conn.on('close', () => end('close'));
    conn.on('error', () => end('error'));
    return link;
  }

  // 部屋を作る：コードを決めて PeerJS のクラウドに「searchbattle-コード」で登録し、相手がつないでくるのを待つ。
  //  o.onOpen(code)：登録できた（コードを画面に出す）、o.onGuest(link)：相手とつながった、o.onError(文)：失敗。
  //  戻り値の close() でやめる
  function openRoom(o) {
    let peer = null, stopped = false, tries = 0, taken = false;
    const start = (Peer) => {
      if (stopped) return;
      const code = makeCode();
      const p = new Peer(PEER_PREFIX + code, peerOptions());
      peer = p;
      p.on('open', () => { if (!stopped && peer === p) o.onOpen(code); });
      p.on('connection', (conn) => {
        // 1つの部屋に入れるのは1人だけ。2人目には「満員」と伝えて閉じる
        if (taken) {
          // 相手が受け取る準備（つながった直後の処理）を終えるまで少し待ってから「満員」を送り、さらに待って閉じる
          conn.on('open', () => {
            setTimeout(() => { try { conn.send({ t: 'bye', reason: 'full' }); } catch (e) { /* 無視 */ } }, 400);
            setTimeout(() => conn.close(), 1500);
          });
          return;
        }
        taken = true;
        let opened = false;
        conn.on('open', () => { opened = true; if (!stopped) o.onGuest(wrapConn(conn, p)); });
        conn.on('close', () => { if (!opened) taken = false; });   // 開く前に切れたら、ほかの人を待てるように戻す
      });
      p.on('disconnected', () => { if (!stopped && !taken) try { p.reconnect(); } catch (e) { /* 次の error で知らせる */ } });
      p.on('error', (err) => {
        if (stopped || peer !== p || taken) return;
        // たまたま同じコードの部屋があれば、コードを変えて作り直す
        if (err && err.type === 'unavailable-id' && tries++ < 4) { try { p.destroy(); } catch (e) { /* 無視 */ } start(Peer); return; }
        stopped = true;
        try { p.destroy(); } catch (e) { /* 無視 */ }
        o.onError(errorText(err));
      });
    };
    loadPeerJS().then(start, () => { if (!stopped) { stopped = true; o.onError('通信の部品（PeerJS）を読み込めませんでした。インターネットの接続を確かめてください'); } });
    return { close() { stopped = true; if (peer && !taken) try { peer.destroy(); } catch (e) { /* 無視 */ } } };
  }

  // 部屋に入る：自分も PeerJS のクラウドに（名前なしで）登録し、「searchbattle-コード」の相手につなぐ。
  //  o.onLink(link)：つながった、o.onError(文)：失敗。戻り値の close() でやめる
  function joinRoom(code, o) {
    let peer = null, done = false;
    const fail = (text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (peer) peer.destroy(); } catch (e) { /* 無視 */ }
      o.onError(text);
    };
    const timer = setTimeout(() => fail('つながりませんでした。コードを確かめて、もう一度試してください'), JOIN_TIMEOUT_MS);
    loadPeerJS().then((Peer) => {
      if (done) return;
      peer = new Peer(peerOptions());   // 自分の ID はクラウドに決めてもらう
      peer.on('open', () => {
        if (done) return;
        // reliable：届く順番を保つ（state が前後すると古い盤面に戻ってしまうため）
        const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
        conn.on('open', () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          o.onLink(wrapConn(conn, peer));
        });
        conn.on('error', () => fail('つながりませんでした'));
      });
      peer.on('error', (err) => fail(errorText(err)));
    }, () => fail('通信の部品（PeerJS）を読み込めませんでした。インターネットの接続を確かめてください'));
    return { close() { if (!done) { done = true; clearTimeout(timer); try { if (peer) peer.destroy(); } catch (e) { /* 無視 */ } } } };
  }

  const api = {
    APP, NET_VERSION, HOST_SEAT, GUEST_SEAT, PEER_PREFIX, CODE_CHARS, CODE_LEN, PEERJS_URL, PLAY_ACTS, SYNC_ACTS, DEAD_FIELDS,
    makeCode, normCode, cleanName, redactFor, fullSnap, restore, cleanArgs, cleanSetup, Host, Guest,
    supported, loadPeerJS, peerOptions, errorText, openRoom, joinRoom, PLAY_URL,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SBNet = api;
})(typeof window !== 'undefined' ? window : globalThis);
