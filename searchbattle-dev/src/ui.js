/* サーチバトル — 画面（サイバー空間版） */
(function () {
  'use strict';
  const E = window.SBEngine, AI = window.SBAI, NET = window.SBNet;
  const { ITEMS, ITEM_KEYS, SHAPES, SHAPES_BY_SIZE, ORIENT, COLS, CATS, cellsFor, identifyShape, bit } = E;
  // 攻撃アイテム＝相手フィールドに作用、防御アイテム＝自分フィールドに作用
  const ATK_ITEMS = ['cube', 'line', 'number', 'shape', 'pair', 'node', 'bazooka'];
  const DEF_ITEMS = ['warp', 'stealth'];
  const isDef = (k) => DEF_ITEMS.indexOf(k) >= 0;
  // この試合で使えるアイテムか
  function inPlay(k) { const g = G(); return !g || (g.itemKeys || ITEM_KEYS).indexOf(k) >= 0; }
  const root = document.getElementById('app');
  const fxLayer = document.getElementById('fx-layer');
  const replayEl = document.getElementById('replay');
  // サウンド（読み込めなかったときは何もしない代わりを使う）
  const SND = window.SBAudio || { setMode() {}, scene() {}, sfx() {}, result() {}, current() { return null; } };
  let denied = false;   // 直前の操作が断られたか（断られたら操作音を鳴らさない）

  const store = {
    get(k, d) { try { const v = localStorage.getItem('sb.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('sb.' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };

  // 設定：モード（cpu／pvp／online＝オンライン対戦）、ルール（prelim＝4×4／final＝5×5／tour＝大会）、
  //  アイテム（pick＝選ぶ／random＝ランダム randomN 種／draft＝ドラフト 1人 draftN 個）
  const DRAFT_MAX = Math.floor(ITEM_KEYS.length / 2);
  function migrateSettings(st) {
    if (st.items === 'all') { st.items = 'pick'; st.itemPick = ITEM_KEYS.slice(); }
    else if (st.items === 'r6') { st.items = 'random'; st.randomN = 6; }
    else if (st.items === 'r4') { st.items = 'random'; st.randomN = 4; }
    if (['pick', 'random', 'draft'].indexOf(st.items) < 0) st.items = 'pick';
    if (['prelim', 'final', 'tour'].indexOf(st.rules) < 0) st.rules = 'prelim';
    if (['cpu', 'pvp', 'online'].indexOf(st.mode) < 0) st.mode = 'cpu';
    if (typeof st.netName !== 'string') st.netName = '';   // オンライン対戦で相手に見せる名前
    st.randomN = Math.max(1, Math.min(ITEM_KEYS.length, (st.randomN | 0) || 6));
    st.draftN = Math.max(1, Math.min(DRAFT_MAX, (st.draftN | 0) || DRAFT_MAX));
    if (!Array.isArray(st.itemPick)) st.itemPick = ITEM_KEYS.slice();
    delete st.wallet;
    return st;
  }
  const app = {
    screen: 'title',
    settings: migrateSettings(Object.assign({ mode: 'cpu', rules: 'prelim', speed: 'normal', items: 'pick', itemPick: ITEM_KEYS.slice(), randomN: 6, draftN: DRAFT_MAX, sound: 'all' }, store.get('settings', {}))),
    game: null,
    tour: null,       // 大会の状態（engine の Tour で動かす）
    tourFx: null,     // 大会の画面の演出（一度きり）
    setup: null,
    ui: null,
    busy: false,
    modal: null,
    toast: null,
    hover: -1,
    fxSeen: 0,
    fxChain: Promise.resolve(),
    // オンライン対戦：lobby＝部屋を作る・入るまでの画面の状態、net＝相手とつながってからの状態
    //  net = { role: 'host'|'guest', seat: 自分の席（ホスト0・ゲスト1）, link: 通信路, host/guest: net.js の役, foe: 相手の名前, gone: 相手が抜けた }
    lobby: null,
    net: null,
  };
  SND.setMode(app.settings.sound);

  // ---------------- 小物 ----------------
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad2 = (n) => String(n).padStart(2, '0');
  // リプレイを開いている間は、リプレイで再現した対戦を描く（盤面・演出の関数はみな G() から読む）
  function G() { return app.replay ? app.replay.game : app.game; }
  // 大会の試合は「あなた（0番）対 CPU（1番）」
  function isCPUMode() { return app.tour ? true : app.settings.mode === 'cpu'; }
  // この端末で遊ぶのが1人だけか（CPU戦・大会・オンライン対戦）。「あなた」と呼ぶ・自分の席の側だけを見せる
  function oneSide() { return isCPUMode() || !!app.net; }
  // オンライン対戦のゲストなら、その役（net.js の Guest）
  function netGuest() { return app.net && app.net.role === 'guest' ? app.net.guest : null; }
  // ゲストが、送った操作の結果（ホストからの state）を待っているか
  function netWaiting() { const gu = netGuest(); return !!(gu && gu.wait); }
  function foeName() { const g = G(); return g ? g.players[1].name : 'CPU'; }
  function speedK() { return app.settings.speed === 'fast' ? 0.55 : 1; }
  function pause(mult) { return sleep(560 * speedK() * (mult || 1)); }
  function coord(c) { return E.coord(c, G().N); }

  function viewer() {
    if (app.replay) return 0;   // リプレイは常に 0番（左）の側から見る
    if (app.net) return app.net.seat;   // オンライン対戦：いつも自分の席から見る
    const g = G();
    if (!g) return 0;
    if (isCPUMode()) return 0;
    if (g.phase === 'setup') return app.setup ? app.setup.pi : 0;
    if (g.phase === 'draft') return Math.max(0, g.draftTurn());
    if (g.phase === 'play') return g.cur;
    return app.ui && app.ui.lastViewer != null ? app.ui.lastViewer : 0;
  }

  function effMode() {
    const g = G(), v = viewer();
    if (!g || g.phase !== 'play') return 'over';
    if (g.cur !== v || app.busy || netWaiting()) return 'wait';
    if (g.sub === 'sacrifice') return 'sacrifice';
    if (g.sub === 'treasure') return 'treasure';
    if (app.ui.mode) return app.ui.mode;
    if (g.sub === 'item') return 'item';
    if (g.sub === 'call') return 'call';
    if (g.sub === 'answer') return 'answer-phase';
    return 'wait';
  }

  function toast(text, kind, quiet) {
    if (!quiet && kind !== 'note') { denied = true; SND.sfx(kind === 'warn' ? 'error' : 'deny'); }
    app.toast = { text, kind: kind || 'info', id: Date.now() };
    renderToast();
    const id = app.toast.id;
    setTimeout(() => { if (app.toast && app.toast.id === id) { app.toast = null; renderToast(); } }, 2600);
  }
  function renderToast() {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
    el.className = 'toast' + (app.toast ? ' show ' + app.toast.kind : '');
    el.textContent = app.toast ? app.toast.text : '';
  }

  // ツールチップは本文の外（最前面の層）に出す
  const tipEl = document.createElement('div');
  tipEl.className = 'tipbox';
  tipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(tipEl);
  let tipTimer = 0;
  function showTip(el, touch) {
    const s = el.getAttribute('data-tip');
    if (!s) return;
    tipEl.textContent = s;
    tipEl.classList.add('show');
    const r = el.getBoundingClientRect();
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    const x = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
    let y = r.top - th - 8;
    if (y < 8) y = r.bottom + 8;
    tipEl.style.left = x + 'px';
    tipEl.style.top = y + 'px';
    clearTimeout(tipTimer);
    if (touch) tipTimer = setTimeout(hideTip, 2200);
  }
  function hideTip() { clearTimeout(tipTimer); tipEl.classList.remove('show'); }

  // 直前の出来事は記録の番号で持ち、表示する人の視点で文面を選ぶ（相手の非公開情報を出さない）
  function setBanner() {
    const g = G();
    if (g && g.log.length) app.ui.bannerIdx = g.log.length - 1;
  }
  function bannerFor(v) {
    const g = G();
    const i = app.ui.bannerIdx;
    if (i == null || !g.log[i]) return null;
    const e = g.log[i];
    return { text: e.actor === v && e.priv ? e.priv : e.text, kind: e.kind };
  }

  // ---------------- アイコンと記号 ----------------
  const ICON = {
    cube: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8 20 7.3v9.4L12 21.2 4 16.7V7.3z"/><path d="M4 7.3l8 4.5 8-4.5M12 11.8v9.4"/><path d="M8 5.1l8 4.5" opacity=".45"/></svg>',
    line: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="1.2"/><path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17"/><rect x="9.2" y="3.5" width="5.6" height="17" class="f" opacity=".4"/></svg>',
    number: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="2.6"/><path d="M10.4 7 9 17M15.2 7l-1.4 10M7.2 10.2h10M6.8 13.8h10"/></svg>',
    shape: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5"/><path d="M7.5 8.3h9v3.3h-3v4.9h-3v-4.9h-3z"/></svg>',
    pair: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6.5" cy="17.5" r="3"/><circle cx="17.5" cy="6.5" r="3"/><path d="M8.8 15.2l6.4-6.4" stroke-dasharray="2.2 2"/></svg>',
    node: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12.6" r="2.7" class="f"/><path d="M12 9.9V5.9M9.7 14l-3.5 2M14.3 14l3.5 2"/><circle cx="12" cy="4.2" r="1.8"/><circle cx="4.7" cy="16.9" r="1.8"/><circle cx="19.3" cy="16.9" r="1.8"/></svg>',
    warp: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.8" y="12.6" width="7.4" height="7.4" rx="1" stroke-dasharray="2.2 1.8"/><rect x="13.8" y="4" width="7.4" height="7.4" rx="1"/><path d="M6.6 11.2c.5-4.1 3.5-6 6.6-4.7"/><path d="M11.3 4.8l2 1.7-1.3 2.2"/></svg>',
    stealth: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.8 12s3.4-6.2 9.2-6.2 9.2 6.2 9.2 6.2-3.4 6.2-9.2 6.2S2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.7"/><path d="M4.2 20.2 19.8 3.8"/></svg>',
    bazooka: '<svg class="ic-bz" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.8 4.2c2.4-.6 4.4-.6 5 0s.6 2.6 0 5L12 17l-5-5z"/><circle cx="15.6" cy="8.4" r="1.4"/><path d="M8.2 13.2 4.6 14l2.4 2.4M10.8 15.8 10 19.4 7.6 17M3.4 20.6l3-3"/></svg>',
  };
  const MARK = {
    oo: '<svg class="mk" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="14"/><circle cx="20" cy="20" r="7.6"/><path d="M20 2.6v5M20 32.4v5M2.6 20h5M32.4 20h5"/></svg>',
    o: '<svg class="mk" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="12.6"/><circle cx="20" cy="20" r="2.3" class="dot"/></svg>',
    x: '<svg class="mk" viewBox="0 0 40 40" aria-hidden="true"><path d="M13 13 27 27M27 13 13 27"/></svg>',
    gem: '<svg class="gem" viewBox="0 0 40 40" aria-hidden="true"><path d="M20 4 33 15 20 36 7 15z"/><path class="facet" d="M7 15h26M14 15l6 21 6-21M14 15l6-11 6 11"/></svg>',
    add: '<svg class="mk mk-add" viewBox="0 0 40 40" aria-hidden="true"><path d="M20 13v14M13 20h14"/></svg>',
  };
  // 大会の宝石（順位表などに並べる小さな宝石）
  const GEM_ICON = '<svg class="gm" viewBox="0 0 40 40" aria-hidden="true"><path d="M20 4 33 15 20 36 7 15z"/><path class="facet" d="M7 15h26M14 15l6 21 6-21M14 15l6-11 6 11"/></svg>';
  // d：この試合で増えた（＋）・奪われた（−）数。増えた宝石は光らせ、奪われた宝石は点線で残す（順位表の演出のあいだ）
  const gemsHTML = (n, d) => {
    d = d | 0;
    let h = '';
    for (let i = 0; i < n; i++) h += i >= n - d ? GEM_ICON.replace('class="gm"', 'class="gm new"') : GEM_ICON;
    for (let i = 0; i < -d; i++) h += GEM_ICON.replace('class="gm"', 'class="gm lost"');
    const tip = `宝石${n}つ（1つ${E.Tour.GEM_PTS}点）${d > 0 ? `・この試合で${d}つ奪った` : d < 0 ? `・この試合で${-d}つ奪われた` : ''}`;
    return `<span class="st-gems" aria-label="${tip}" data-tip="${tip}">${h || '<em>宝石なし</em>'}</span>`;
  };
  // 試合の結果の「宝石」の欄：見つけて奪った宝石（＋）と、見つけられて奪われた宝石（−・点線）
  const gemCellHTML = (g, i) => {
    const got = !!g.players[i].view.treasureFound, lost = !!g.players[1 - i].view.treasureFound;
    const tip = got && lost ? '見つけて1つ奪い、見つけられて1つ奪われた' : got ? '見つけて1つ奪った' : lost ? '見つけられて1つ奪われた' : 'どちらも見つけられなかった';
    const html = (got ? `<span class="gx up">+${GEM_ICON}</span>` : '') + (lost ? `<span class="gx down">−${GEM_ICON.replace('class="gm"', 'class="gm lost"')}</span>` : '');
    return `<td class="gems" data-tip="${tip}" aria-label="${tip}">${html || '0'}</td>`;
  };
  // スピードペナルティの説明（予選だけ。負けた側の減点。v12.15まではスピードボーナス）
  const speedText = () => { const S = E.Tour.SPEED, n = S.length - 1; return `1ターン目に負けると${S[1]}点の減点、2〜${n}ターン目は${S.slice(2).join('・')}点、${n + 1}ターン目から0`; };
  const vicText = () => E.Tour.VICTORY_BY.slice(0, 3).join('・') + '・決勝' + E.Tour.VICTORY_BY[3];
  // ノードショットの答え（つながりの数）：ひし形の中の数字。ヒットしたマスでは左下の小さな札にする
  const nodeMark = (k) => `<svg class="mk" viewBox="0 0 40 40" aria-hidden="true"><path d="M20 5.5 34.5 20 20 34.5 5.5 20z"/><text x="20" y="21.3" class="ordn">${k}</text></svg>`;
  const LOCK_SVG = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="30"/><path d="M50 6v16M50 78v16M6 50h16M78 50h16"/><path d="M22 22l8 8M78 22l-8 8M22 78l8-8M78 78l-8-8" opacity=".6"/></svg>';
  const RETICLE_SVG = '<svg viewBox="0 0 100 100"><path d="M14 34V14h20M66 14h20v20M86 66v20H66M34 86H14V66"/><circle cx="50" cy="50" r="5"/></svg>';
  const TL = { H: 'H', N: 'N', X: '×' };
  const SHAPE_ABBR = { 'キューブ': 'C', 'L字': 'L', 'T字': 'T' };

  // ---------------- メモ（スクラッチ） ----------------
  // 相手フィールドの空いているマスに付ける自分用のしるし。ゲームには影響しない
  //  ×＝なさそう、●＝ありそう、★＝トレジャーがありそう。右クリック（スマホはメモのボタンを押してからタップ）で付け外し。
  //  メモのあるマスは、コール・トレジャーコールの手番に押してもメモが外れるだけ（うっかりコールを防ぐ）
  const MEMO = {
    x: '<span class="mm mm-x" aria-hidden="true"><svg viewBox="0 0 40 40"><path d="M13.5 13.5 26.5 26.5M26.5 13.5 13.5 26.5"/></svg></span>',
    o: '<span class="mm mm-o" aria-hidden="true"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="6.5"/></svg></span>',
    t: '<span class="mm mm-t" aria-hidden="true"><svg viewBox="0 0 40 40"><path d="M20 10.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L20 25.4l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9z"/></svg></span>',
  };
  const MEMO_NAME = { x: '×（なさそう）', o: '●（ありそう）', t: '★（トレジャーがありそう）' };
  const TOUCH = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  function memoOf(pi) {
    const ui = app.ui;
    if (!ui) return {};
    if (!ui.memo) ui.memo = {};
    return ui.memo[pi] || (ui.memo[pi] = {});
  }
  // メモを付ける／外す（コール済み・撃破済みのマスには付けない）
  function toggleMemo(c) {
    const g = G();
    if (!g || g.phase !== 'play' || !app.ui) return;
    const v = viewer(), P = g.players[v];
    const memo = memoOf(v);
    if (memo[c]) { delete memo[c]; SND.sfx('desel', 0, { n: 0, pan: 0.35 }); }
    else {
      if (P.view.marks[c] || P.view.dead[c]) { toast('コール済みのマスにはメモできません'); return; }
      memo[c] = app.ui.memoType || 'x';
      SND.sfx('sel', 0, { n: 1, pan: 0.35 });
    }
    render();
  }
  function memoBarHTML(v) {
    const ui = app.ui;
    const t = ui.memoType || 'x';
    const n = Object.keys(memoOf(v)).length;
    const btn = (k, sym) => `<button type="button" class="mb-btn mb-${k}${t === k ? ' cur' : ''}${t === k && ui.memoMode ? ' on' : ''}" data-act="memo-type" data-type="${k}" aria-pressed="${t === k && ui.memoMode}" data-tip="${esc(`メモ：${MEMO_NAME[k]}。右クリックで付けるしるしを${MEMO_NAME[k].slice(0, 1)}にします。押すと、タップでメモする状態になります（もう一度押すと戻る）`)}">${MEMO[k]}</button>`;
    return `<div class="memobar${ui.memoMode ? ' active' : ''}" role="group" aria-label="メモ">
      <span class="mb-cap">メモ</span>${btn('x')}${btn('o')}${btn('t')}
      <button type="button" class="mb-clear" data-act="memo-clear" ${n ? '' : 'disabled'}>全部消す</button>
      <span class="mb-hint">${ui.memoMode ? 'タップでメモ中（同じボタンでもどる）' : TOUCH ? 'しるしのボタンを押してから、マスをタップ' : '右クリックでメモ'}</span>
    </div>`;
  }

  // ---------------- 形の配置補助 ----------------
  function anchorFor(key, t, c, N) {
    const o = ORIENT[key][t];
    if (o.h > N || o.w > N) return null;
    const r = Math.floor(c / N), col = c % N;
    const cy = (o.h - 1) / 2, cx = (o.w - 1) / 2;
    let best = o.cells[0], bd = Infinity;
    for (const [rr, cc] of o.cells) { const d = (rr - cy) ** 2 + (cc - cx) ** 2; if (d < bd) { bd = d; best = [rr, cc]; } }
    let r0 = r - best[0], c0 = col - best[1];
    r0 = Math.max(0, Math.min(N - o.h, r0));
    c0 = Math.max(0, Math.min(N - o.w, c0));
    return { r0, c0 };
  }
  const rotT = (t) => (t & 4) | ((t + 1) & 3);
  const flipT = (t) => t ^ 4;
  function shapeMini(key, t) {
    const o = ORIENT[key][t || 0];
    const s = 9, gap = 1.5;
    const w = o.w * s + (o.w - 1) * gap, h = o.h * s + (o.h - 1) * gap;
    const rects = o.cells.map(([r, c]) => `<rect x="${c * (s + gap)}" y="${r * (s + gap)}" width="${s}" height="${s}" rx="1.2"/>`).join('');
    return `<svg class="mini" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${rects}</svg>`;
  }

  // ---------------- フィールド上の調査記録 ----------------
  // observer が fieldOwner のフィールドについて調べた結果（サーチ系・ペア・ディスタンス）
  function intelFor(observer, fieldOwner) {
    const g = G(), N = g.N;
    const kb = g.players[observer].kb;
    const view = g.players[observer].view;
    const warpedAfter = (t) => kb.warps.some((w) => w.t > t);
    const relocatedAfter = (t) => kb.warps.some((w) => w.t > t) || kb.adds.some((a) => a.t > t);
    // 個数の調査（サーチキューブ・サーチライン）は、アイテム欄の下にタグで並べる
    const tags = [];
    const latest = new Map();
    for (const q of kb.counts) latest.set(q.kind === 'line' ? 'line:' + q.line + q.index : q.kind + ':' + q.value, q);
    for (const q of latest.values()) {
      if (q.kind === 'line') {
        // サーチライン＝その列・行にかかっている個体の数と、そのマスの数（v12.12）。撃破されるたびに、その分を減らす。
        //  ワープの後は両方とも変わっているかもしれない（薄く出す）。
        //  バズーカの分解の後は、分解された個体がその列・行にかかっていたか分からず、破片の数だけ個体が増えるので、個体の数は目安（マスの数はそのまま正しい）
        const stale = relocatedAfter(q.t);
        const split = (kb.splits || []).some((sp) => sp.t > q.t);
        let n = q.n, k = q.k;
        if (!stale) {
          const lm = E.lineMask(q.line, q.index, N);
          for (const d of kb.deads) {
            if (d.t <= q.t || !(d.mask & lm)) continue;
            n -= E.popcount(d.mask & lm);
            if (k != null && !(split && d.frag)) k--;
          }
        }
        if (k != null) k = Math.max(0, k);
        const label = E.lineLabel(q.line, q.index);
        const kApx = k != null && split && !stale;
        tags.push({ key: 'line', label, pre: '残り', n, unit: 'マス', k, kApx, turn: q.turn, stale,
          tip: `サーチライン（T${pad2(q.turn)}）：${label}にかかっている（撃破されていない）個体の数 / そのマスの数。◎・○のマスも数に入ります。${stale ? 'その後ワープがあったため、今は変わっているかもしれません' : kApx ? '撃破されると自動で減ります。その後バズーカで分解した個体があり、破片は1つずつ数えるため、個体の数は目安です（マスの数は正しい）' : '撃破されると自動で減ります'}` });
        continue;
      }
      if (q.kind !== 'size' && q.kind !== 'cat') continue;
      // 調べた後に撃破された個体（分解の破片を除く）の分だけ減らす。
      // 調べた後にバズーカで分解された個体があると、その個体が数に入っていたかは分からない（分解された個体の形・マス数は伏せられる）ので、目安として薄く出す
      const split = (kb.splits || []).some((sp) => sp.t > q.t);
      let n = q.n;
      for (const d of kb.deads) if (d.t > q.t && !d.frag && !d.isAdd && (q.kind === 'size' ? d.size === q.value : d.cat === q.value)) n--;
      n = Math.max(0, n);
      const label = q.kind === 'size' ? q.value + 'マス' : q.value;
      tags.push({ key: 'cube', label, pre: '残り', n, unit: '体', turn: q.turn, stale: split,
        tip: `サーチキューブ（T${pad2(q.turn)}）：残っている（撃破されていない）個体の数。撃破で自動更新。${split ? 'その後バズーカで分解した個体があり、その個体が数に入っていたかは分からないため、目安です' : ''}` });
    }
    const cells = {};
    const put = (c, k, val) => { if (!view.dead[c]) cells[c] = Object.assign(cells[c] || {}, { [k]: val }); };
    // マスの調査（サーチシェイプ・サーチサイズ）は時刻順に、新しい結果で上書きする。
    // 空きマスだったとき（NoData）は、ディスタンスショットの NoData と同じ表示にする
    const facts = [];
    for (const o of kb.occs) if (o.src === 'shape' || o.src === 'number') facts.push({ c: o.c, t: o.t, turn: o.turn, src: o.src, v: o.src === 'shape' ? o.cat : o.size, stale: warpedAfter(o.t) });
    for (const e of kb.empties) if (e.src === 'shape' || e.src === 'number' || e.src === 'node' || e.src === 'bazooka') facts.push({ c: e.c, t: e.t, turn: e.turn, src: e.src, nd: true, stale: relocatedAfter(e.t) });
    // バズーカで分解した：撃ち込んだマスがヒット済みでなければ、そこには1マスキューブ（C1）が残る
    for (const sp of (kb.splits || [])) {
      if (sp.killed.indexOf(sp.c) >= 0) continue;
      const gone = kb.warps.some((w) => w.t > sp.t && (w.oldMask & bit(sp.c)));
      facts.push({ c: sp.c, t: sp.t, turn: sp.turn, src: 'shape', v: 'キューブ', stale: gone });
      facts.push({ c: sp.c, t: sp.t, turn: sp.turn, src: 'number', v: 1, stale: gone });
    }
    facts.sort((a, b) => a.t - b.t);
    for (const f of facts) {
      if (f.nd) { put(f.c, 'nd', { t: f.t, turn: f.turn, src: f.src, stale: f.stale }); put(f.c, 'shape', null); put(f.c, 'size', null); continue; }
      put(f.c, f.src === 'shape' ? 'shape' : 'size', { v: f.v, stale: f.stale, turn: f.turn });
      put(f.c, 'nd', null);
    }
    // ノードショット：そのマスの最新の答え（つながりの数）。その個体がワープするか、バズーカで分解されると変わりうる（薄く表示）
    const leftAfter = (c, t) => kb.warps.some((w) => w.t > t && (w.oldMask & bit(c)));
    const splitAfter = (t) => (kb.splits || []).some((sp) => sp.t > t);
    for (const D of (kb.nodes || [])) {
      if (D.k == null) continue;
      put(D.c, 'node', { v: D.k, t: D.t, turn: D.turn, left: leftAfter(D.c, D.t), stale: warpedAfter(D.t) || splitAfter(D.t) });
    }
    const pairs = [];
    const pairLatest = new Map();
    for (const p of kb.pairs) pairLatest.set(Math.min(p.a, p.b) + ':' + Math.max(p.a, p.b), p);
    for (const p of pairLatest.values()) {
      if (view.dead[p.a] || view.dead[p.b]) continue;
      pairs.push({ a: p.a, b: p.b, same: p.same, stale: warpedAfter(p.t), turn: p.turn });
    }
    return { tags, cells, pairs, observer, fieldOwner };
  }

  function intelTagsHTML(intel, mine) {
    if (!intel || !intel.tags.length) return '';
    return `<div class="intel ${mine ? 'mine' : 'enemy'}" aria-label="調査の記録">` + intel.tags.map((t) =>
      `<span class="itag${t.stale ? ' stale' : ''}" data-tip="${esc(t.tip)}">${ICON[t.key]}${esc(t.label)}${t.pre ? `<i>${esc(t.pre)}</i>` : ''}${t.k != null ? `<b class="${t.kApx ? 'apx' : ''}">${t.k}</b>個体<em class="sl">/</em>` : ''}<b>${t.n}</b>${t.unit}<small>T${pad2(t.turn)}</small></span>`
    ).join('') + '</div>';
  }
  // マスの左上に「形状＋マス数」（例：L4、C3、#2）。空きマスだったときは、マスの中央に NoData を出す（cellMarkHTML）
  function cellTagHTML(intel, c) {
    if (!intel || !intel.cells[c]) return '';
    const a = intel.cells[c];
    if (!a.shape && !a.size) return '';
    let s = '';
    if (a.shape) s += SHAPE_ABBR[a.shape.v] || a.shape.v;
    if (a.size) s += (a.shape ? '' : '#') + a.size.v;
    const stale = (a.shape && a.shape.stale) || (a.size && a.size.stale);
    const title = [a.shape ? `サーチシェイプ：${a.shape.v}` : '', a.size ? `サーチサイズ：${a.size.v}マス` : ''].filter(Boolean).join(' / ');
    return `<span class="ctag${stale ? ' stale' : ''}" title="${esc(title)}">${esc(s)}</span>`;
  }
  // ノードショット・NoData の表示。NoData（サーチサイズ・サーチシェイプ・ノードショット・バズーカで空きマスだった）は
  // マスの中央に出す。ノードショットの数字は、まだ印のないマスなら中央のひし形、ヒットしたマスなら左下の小さな札
  const NODATA_HTML = (stale) => `<span class="mkw nodata${stale ? ' stale' : ''}"><b>NoData</b></span>`;
  const ND_NAME = { number: 'サーチサイズ', shape: 'サーチシェイプ', node: 'ノードショット', bazooka: 'バズーカ' };
  const ndAt = (intel, c) => (intel && intel.cells[c] && intel.cells[c].nd) || null;
  const nodeAt = (intel, c) => { const a = intel && intel.cells[c]; return a && a.node && !a.node.left ? a.node : null; };
  function cellMarkHTML(m, intel, c) {
    const nd = ndAt(intel, c), nn = nodeAt(intel, c);
    // 新しいほうの調査結果を使う
    const info = nd && (!nn || nd.t > nn.t) ? { nd: true, t: nd.t, stale: nd.stale } : nn ? { v: nn.v, t: nn.t, stale: nn.stale } : null;
    if (!info) return markHTML(m);
    if (m && m.r === 'x' && (!m.callable || m.t > info.t)) return markHTML(m);
    if (info.nd) return m ? markHTML(m) : NODATA_HTML(info.stale);
    if (m && m.r !== 'x') return markHTML(m) + `<span class="nbadge${info.stale ? ' stale' : ''}" aria-hidden="true">${info.v}</span>`;
    return `<span class="mkw ink-n${info.stale ? ' stale' : ''}">${nodeMark(info.v)}</span>`;
  }
  function probeLabel(intel, c, m) {
    const nd = ndAt(intel, c), nn = nodeAt(intel, c);
    if (nd && (!nn || nd.t > nn.t)) return m && m.r === 'x' ? '' : ` ${ND_NAME[nd.src] || ''} NoData`;
    if (nn) return m && m.r === 'x' && (!m.callable || m.t > nn.t) ? '' : ` つながり${nn.v}`;
    return '';
  }
  function pairsSVG(intel, N) {
    if (!intel || !intel.pairs.length) return '';
    const pt = (c) => [(c % N) + 0.5, Math.floor(c / N) + 0.5];
    const body = intel.pairs.map((p) => {
      const [x1, y1] = pt(p.a), [x2, y2] = pt(p.b);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      // ＝・≠ は文字ではなく線で描く（文字だとフォントによって円の中心からずれる）
      const f = (n) => +n.toFixed(3);
      const bar = (dy) => `M${f(mx - 0.075)} ${f(my + dy)}H${f(mx + 0.075)}`;
      const sym = bar(-0.036) + bar(0.036) + (p.same ? '' : `M${f(mx + 0.045)} ${f(my - 0.095)}L${f(mx - 0.045)} ${f(my + 0.095)}`);
      return `<g class="${p.same ? 'same' : 'diff'}${p.stale ? ' stale' : ''}"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><circle cx="${mx}" cy="${my}" r="0.17"/><path class="sym" d="${sym}"/></g>`;
    }).join('');
    return `<svg class="pairs" viewBox="0 0 ${N} ${N}" preserveAspectRatio="none" aria-hidden="true">${body}</svg>`;
  }

  // ---------------- 盤面 ----------------
  // 個体の色：配置した個体の並び（id順）で決める。バズーカの破片は元の個体の色のまま
  function colorIndex(P, piece) {
    if (piece.isAdd) return 0;
    const id = piece.frag ? piece.fromId : piece.id;
    const ids = P.pieces.filter((p) => !p.isAdd && !p.frag).map((p) => p.id).concat((P.splitPieces || []).map((p) => p.id)).sort((a, b) => a - b);
    return (Math.max(0, ids.indexOf(id)) % 8) + 1;
  }
  function edgeClasses(mask, c, N) {
    const r = Math.floor(c / N), col = c % N;
    let s = '';
    if (r === 0 || !(mask & bit(c - N))) s += ' et';
    if (r === N - 1 || !(mask & bit(c + N))) s += ' eb';
    if (col === 0 || !(mask & bit(c - 1))) s += ' el';
    if (col === N - 1 || !(mask & bit(c + 1))) s += ' er';
    return s;
  }
  // bo: { pickLine, overlay }
  function boardFrame(N, kind, cellsHTML, extraCls, bo) {
    bo = bo || {};
    let cols = '', rows = '';
    for (let i = 0; i < N; i++) {
      if (bo.pickLine) {
        cols += `<span><button type="button" class="axbtn" data-act="pick-line" data-line="col" data-index="${i}" aria-label="${COLS[i]}列を調べる">${COLS[i]}</button></span>`;
        rows += `<span><button type="button" class="axbtn" data-act="pick-line" data-line="row" data-index="${i}" aria-label="${i + 1}行を調べる">${i + 1}</button></span>`;
      } else {
        cols += `<span>${COLS[i]}</span>`;
        rows += `<span>${i + 1}</span>`;
      }
    }
    return `<div class="board ${extraCls || ''}${bo.pickLine ? ' picking' : ''}" style="--n:${N}" data-board="${kind}">
      <div class="ax ax-c">${cols}</div>
      <div class="ax ax-r">${rows}</div>
      <div class="cells" role="grid">${cellsHTML}${bo.overlay || ''}</div>
    </div>`;
  }
  function cellBase(c, N) {
    let cls = 'cell';
    if (c % N === N - 1) cls += ' lc';
    if (Math.floor(c / N) === N - 1) cls += ' lr';
    return cls;
  }
  // ×：再コールできるものは薄く、ワープで空いたマス（移動前の位置）は W を添える
  function markHTML(m) {
    if (!m) return '';
    if (m.r === 'x') {
      if (m.callable) return `<span class="mkw ink-x stale">${MARK.x}</span>`;
      return `<span class="mkw ink-x">${MARK.x}</span>${m.warp ? '<span class="wtag" aria-hidden="true">W</span>' : ''}`;
    }
    let s = `<span class="mkw ink-${m.r}">${MARK[m.r]}</span>`;
    if (m.r === 'oo' && m.num != null) s += `<span class="num">${m.num}</span>`;
    return s;
  }

  // 自分フィールド
  // opts.kind：盤の種類（'own'＝自分フィールド。リプレイの右の盤は 'pred' として描き、演出の位置合わせに使う）、opts.overlay：盤に重ねるもの
  function ownBoard(pi, opts) {
    opts = opts || {};
    const kind = opts.kind || 'own';
    const g = G(), N = g.N, P = g.players[pi], foe = g.players[1 - pi];
    const fv = foe.view;
    const inSetup = g.phase === 'setup';
    const intel = opts.intel;
    let html = '';
    for (let c = 0; c < g.NN; c++) {
      let cls = cellBase(c, N);
      let inner = '', style = '';
      const p = g.pieceAt(pi, c, true);
      const m = inSetup ? null : fv.marks[c];
      if (p) {
        cls += ' pc' + edgeClasses(p.mask, c, N);
        if (p.isAdd) cls += ' addpc';
        if (p.frag) cls += ' frag';
        if (!p.alive) cls += ' dead';
        else if (m && m.r !== 'x') cls += ' hitc';
        style += `--pcc:var(--pc${colorIndex(P, p)});`;
        if (opts.pick && p.alive) cls += ' pickable';
        if (opts.selectedPiece === p.id) cls += ' picked';
        if (p.stealth && p.alive) {
          cls += ' stealth';
          // 読み順で最初のマスにだけ印を付ける
          if (c === Math.min.apply(null, p.cells)) inner += `<span class="stl" aria-hidden="true">${ICON.stealth}</span>`;
        }
      }
      inner += cellMarkHTML(m, intel, c);
      if (P.treasure && P.treasure.cell === c) inner += MARK.gem;
      const tl = inSetup ? null : fv.tlog[c];
      if (tl) inner += `<span class="tl tl-${tl.r}${tl.gray ? ' gray' : ''}">${TL[tl.r]}</span>`;
      inner += cellTagHTML(intel, c);
      if (!inSetup && fv.lastCall === c && opts.flash) cls += ' last';
      if (opts.clickable && opts.clickable(c)) cls += ' click';
      const label = coord(c) + (p ? (p.alive ? ` ${p.size}マスのキューブ${p.stealth ? '（ステルス）' : ''}` : ' 撃破済み') : '') + probeLabel(intel, c, m);
      html += `<div class="${cls}" style="${style}" data-act="cell" data-board="${kind}" data-cell="${c}" role="gridcell" aria-label="${esc(label)}">${inner}</div>`;
    }
    return boardFrame(N, kind, html, opts.cls, { overlay: pairsSVG(intel, N) + (opts.overlay || '') });
  }

  // サーチキューブの選択メニュー（相手フィールド上に出す）
  function cubeMenuHTML() {
    const cats = [['キューブ', 'O4'], ['L字', 'L4'], ['T字', 'T4']];
    return `<div class="cube-menu" role="group" aria-label="サーチキューブの対象">
      <p>SEARCH CUBE ─ 形状</p>
      <div class="cm-grid">${cats.map(([c, k]) => `<button type="button" class="cm-btn" data-act="cube" data-kind="cat" data-value="${esc(c)}">${shapeMini(k, 0)}<span>${esc(c)}</span></button>`).join('')}</div>
      <p>マス数</p>
      <div class="cm-grid sizes">${[2, 3, 4, 5].map((s) => `<button type="button" class="cm-btn" data-act="cube" data-kind="size" data-value="${s}" aria-label="${s}マス"><b>${s}</b></button>`).join('')}</div>
    </div>`;
  }

  // 相手フィールド（予想盤面）
  function predBoard(pi, opts) {
    opts = opts || {};
    const g = G(), N = g.N, P = g.players[pi], v = P.view, foe = g.players[1 - pi];
    const sel = new Set(opts.sel || []);
    const intel = opts.intel;
    const deadMaskById = {};
    for (let c = 0; c < g.NN; c++) { const d = v.dead[c]; if (d) deadMaskById[d.pieceId] = (deadMaskById[d.pieceId] || 0) | bit(c); }
    const memo = memoOf(pi);
    let html = '';
    for (let c = 0; c < g.NN; c++) {
      let cls = cellBase(c, N);
      let inner = '', style = '';
      const d = v.dead[c];
      if (d) {
        cls += ' pc revealed' + edgeClasses(deadMaskById[d.pieceId], c, N);
        if (d.cause === 'bazooka') cls += ' bz';
      } else if (opts.reveal) {
        const tp = g.pieceAt(foe.idx, c);
        if (tp) { cls += ' ghost' + edgeClasses(tp.mask, c, N); style += `--pcc:var(--pc${colorIndex(foe, tp)});`; }
      }
      inner += cellMarkHTML(v.marks[c], intel, c);
      if (opts.reveal && foe.treasure && foe.treasure.cell === c) inner += MARK.gem;
      const tl = v.tlog[c];
      if (tl) inner += `<span class="tl tl-${tl.r}${tl.gray ? ' gray' : ''}">${TL[tl.r]}</span>`;
      inner += cellTagHTML(intel, c);
      const mo = memo[c];
      if (mo && !v.marks[c] && !d && !opts.reveal) { inner += MEMO[mo]; cls += ' memo'; }
      if (sel.has(c)) cls += ' sel';
      if (v.lastCall === c && opts.flash) cls += ' last';
      if (opts.clickable && opts.clickable(c)) cls += ' click';
      const m = v.marks[c];
      let label = coord(c);
      if (m) label += m.r === 'x' ? (m.callable ? ' ×（再コールできる）' : m.warp ? ' ×（ワープ前の位置）' : ' ×') : m.r === 'oo' ? ` ◎${m.num}` : ' ○';
      label += probeLabel(intel, c, m);
      if (d) label += ' 撃破済み';
      if (mo && !m && !d) label += `（メモ：${MEMO_NAME[mo]}）`;
      html += `<div class="${cls}" style="${style}" data-act="cell" data-board="pred" data-cell="${c}" role="gridcell" aria-label="${esc(label)}">${inner}</div>`;
    }
    const overlay = pairsSVG(intel, N) + (opts.cubeMenu ? cubeMenuHTML() : '');
    return boardFrame(N, 'pred', html, opts.cls, { pickLine: opts.pickLine, overlay });
  }

  // ---------------- アイテム欄（フィールド上部） ----------------
  function chipHTML(pi, k, interactive) {
    const g = G(), P = g.players[pi];
    const st = g.itemStatus(pi, k);
    const phaseOK = interactive && g.phase === 'play' && g.cur === pi && (g.sub === 'item' || g.sub === 'answer') && !g.itemUsed && !app.busy && !netWaiting();
    let cls = k === 'bazooka' ? 'ichip bz' : 'ichip', bd = '', state;
    if (st.usedUp) { cls += ' spent'; bd = st.have > 0 ? '×' + st.have : ''; state = st.have > 0 ? `この試合では使用済み（次の試合用に残り${st.have}）` : 'この試合では使用済み'; }
    else if (st.have > 0) { bd = st.have > 1 ? '×' + st.have : ''; state = `残り${st.have}`; }
    else if (interactive && P.used[k] && P.wallet >= 3) { cls += ' rebuy'; bd = '3pt'; state = '使用済み・3ptで再購入できる'; }
    else { cls += ' spent'; state = P.used[k] ? (P.wallet >= 3 ? '使用済み（3ptで再購入できる）' : '使用済み') : 'なし'; }
    const usable = phaseOK && st.usable;
    if (usable) cls += ' usable';
    if (interactive && app.ui && app.ui.item === k) cls += ' active';
    const who = !app.replay && oneSide() ? (pi === viewer() ? 'あなた' : P.name) : P.name;
    const active = interactive && app.ui && app.ui.item === k;
    const tip = `${who}の${isDef(k) ? '防御' : '攻撃'}アイテム「${ITEMS[k].name}」：${ITEMS[k].desc}（${active ? '選択中。もう一度押すとやめる' : state}）`;
    const badge = bd ? `<span class="bd">${esc(bd)}</span>` : '';
    if (interactive) return `<button type="button" class="${cls}" data-act="item" data-key="${k}" aria-disabled="${usable ? 'false' : 'true'}" data-tip="${esc(tip)}" aria-label="${esc(tip)}">${ICON[k]}${badge}</button>`;
    return `<span class="${cls}" role="listitem" data-tip="${esc(tip)}" aria-label="${esc(tip)}">${ICON[k]}${badge}</span>`;
  }
  function chipGroup(pi, keys, interactive, side, cap, tone) {
    keys = keys.filter(inPlay);
    if (!keys.length) return '';
    return `<div class="chipgrp ${side}"><span class="cap">${esc(cap)}</span><div class="chips ${tone || (interactive ? 'mine' : 'enemy')}" role="list">${keys.map((k) => chipHTML(pi, k, interactive)).join('')}</div></div>`;
  }
  // 各フィールドには、そのフィールドに作用するアイテムを並べる（左＝攻撃、右＝防御）
  function fieldChips(fieldOwner, v) {
    const foe = 1 - v;
    if (fieldOwner === v) return `<div class="chiprow">${chipGroup(foe, ATK_ITEMS, false, 'atk', '相手の攻撃')}${chipGroup(v, DEF_ITEMS, true, 'def', '自分の防御')}</div>`;
    return `<div class="chiprow">${chipGroup(v, ATK_ITEMS, true, 'atk', '自分の攻撃')}${chipGroup(foe, DEF_ITEMS, false, 'def', '相手の防御')}</div>`;
  }

  // ---------------- ログ ----------------
  const CALL_KINDS = new Set(['call', 'hit', 'kill', 'miss', 'tcall', 'treasure']);
  const stripName = (s) => s.replace(/^[^：]{1,14}：/, '');
  function sideEntries(v) {
    const g = G(), f = 1 - v;
    const used = (e) => e.kind === 'item' && e.key;
    // 自分フィールド：相手の攻撃アイテム＋自分の防御アイテム／相手フィールド：自分の攻撃アイテム＋相手の防御アイテム
    const myFieldItems = g.log.filter((e) => used(e) && ((e.actor === f && !isDef(e.key)) || (e.actor === v && isDef(e.key))));
    const foeFieldItems = g.log.filter((e) => used(e) && ((e.actor === v && !isDef(e.key)) || (e.actor === f && isDef(e.key))));
    const calls = (a, b) => g.log.filter((e) => (e.actor === a && CALL_KINDS.has(e.kind)) || (e.actor === b && e.kind === 'penalty'));
    return { myItems: myFieldItems, foeItems: foeFieldItems, defCalls: calls(f, v), atkCalls: calls(v, f) };
  }
  function itemLogHTML(entries, v, empty) {
    if (!entries.length) return `<ol class="loglist"><li class="none"><span class="t">—</span><span class="x">${esc(empty)}</span></li></ol>`;
    return '<ol class="loglist">' + entries.slice().reverse().map((e) => {
      const txt = e.actor === v && e.priv ? e.priv : e.text;
      const side = e.actor === v ? 'mine' : 'enemy';
      return `<li class="k-item wicon ${side}"><span class="t">T${pad2(e.turn)}</span><span class="li-ic ${side}">${ICON[e.key] || ''}</span><span class="x">${esc(txt)}</span></li>`;
    }).join('') + '</ol>';
  }
  // アンサーのログ：宣言したマス（新しいログは cells、古いログは文字の座標から）
  function answerCells(e, N) {
    if (Array.isArray(e.cells)) return e.cells;
    const m = /アンサー(成功|失敗)（([^）]*)）/.exec(e.text || '');
    if (!m) return null;
    const out = [];
    for (const x of m[2].matchAll(/([A-Z])-(\d+)/g)) { const c = x[1].charCodeAt(0) - 65, r = +x[2] - 1; if (c >= 0 && c < N && r >= 0 && r < N) out.push(r * N + c); }
    return out.length ? out : null;
  }
  // ログの行にマウスを重ねたとき光らせる盤：アンサーした人（actor）の相手の盤。me＝自分の席（自分の相手の盤が pred）
  function hlAttrs(e, me, N) {
    const cells = (e.kind === 'kill' || e.kind === 'miss') && e.actor != null ? answerCells(e, N) : null;
    if (!cells) return '';
    return ` data-hl="${cells.join(',')}" data-hl-to="${e.actor === me ? 'pred' : 'own'}" data-hl-k="${e.kind}"`;
  }
  function callLogHTML(entries, v, empty) {
    if (!entries.length) return `<ol class="loglist"><li class="none"><span class="t">—</span><span class="x">${esc(empty)}</span></li></ol>`;
    const N = G().N;
    return '<ol class="loglist">' + entries.slice().reverse().map((e) => {
      const txt = stripName(e.actor === v && e.priv ? e.priv : e.text);
      return `<li class="k-${esc(e.kind)}"${hlAttrs(e, v, N)}><span class="t">T${pad2(e.turn)}</span><span class="x">${esc(txt)}</span></li>`;
    }).join('') + '</ol>';
  }

  // ログのアンサーにマウスを重ねると、宣言したマスを盤の上で枠で囲んで光らせる（成功＝金、失敗＝赤の点線）
  function hlAnswer(el, on) {
    const scope = el.closest('#replay') ? replayEl : root;
    scope.querySelectorAll('.hl-layer').forEach((x) => x.remove());
    if (!on) return;
    const cellsEl = scope.querySelector(`.board[data-board="${el.dataset.hlTo}"] .cells`);
    if (!cellsEl) return;
    const N = Math.round(Math.sqrt(cellsEl.querySelectorAll('.cell[data-cell]').length));
    const set = new Set((el.dataset.hl || '').split(',').filter((x) => x !== '').map(Number));
    // 盤の上に重ねる（撃破済みのマスは暗くする効果がかかっているので、マスの中に置くと枠まで暗くなる）
    const layer = document.createElement('div');
    layer.className = 'hl-layer' + (el.dataset.hlK === 'miss' ? ' miss' : '');
    let h = '';
    for (const c of set) {
      const t = !set.has(c - N), b = !set.has(c + N), l = c % N === 0 || !set.has(c - 1), r = c % N === N - 1 || !set.has(c + 1);
      h += `<i style="left:${(c % N) / N * 100}%;top:${Math.floor(c / N) / N * 100}%;width:${100 / N}%;height:${100 / N}%;border-width:${t ? 3 : 0}px ${r ? 3 : 0}px ${b ? 3 : 0}px ${l ? 3 : 0}px"></i>`;
    }
    layer.innerHTML = h;
    cellsEl.appendChild(layer);
  }
  document.addEventListener('mouseover', (ev) => { const el = ev.target.closest && ev.target.closest('[data-hl]'); if (el) hlAnswer(el, true); });
  document.addEventListener('mouseout', (ev) => { const el = ev.target.closest && ev.target.closest('[data-hl]'); if (el && !(ev.relatedTarget && el.contains(ev.relatedTarget))) hlAnswer(el, false); });

  // ---------------- 操作ブロック ----------------
  function phaseText(mode) {
    const g = G(), v = viewer();
    const who = oneSide() ? '' : g.players[v].name + '：';
    switch (mode) {
      case 'item': return who + (g.hasCallable(v) ? 'アイテムを使うか、相手フィールドをタップしてコール' : 'コールできるマスがありません。コールを飛ばしてください');
      case 'call': return who + '相手フィールドをタップしてコール';
      case 'answer-phase': return who + (g.itemUsed ? 'アンサーするか、ターンエンドしてください' : 'アンサー・アイテム・ターンエンドから選んでください');
      case 'answer': return who + '相手フィールドで、個体の全マスを選んでください';
      case 'treasure': return who + `トレジャーコール（残り${g.treasureLeft(v)}回）：相手フィールドのマスを1つ選んでください`;
      case 'stealth-pick': return who + 'ステルス：守る自分のキューブを選んでください';
      case 'sacrifice': return who + 'アンサー失敗！手番が終了します。差し出す自分のキューブを選んでください';
      case 'line': return who + 'サーチライン：相手フィールドの列か行のラベルをタップ';
      case 'number': return who + 'サーチサイズ：相手フィールドで調べるマスを選んでください';
      case 'node': return who + 'ノードショット：相手フィールドで調べるマスを選んでください';
      case 'bazooka': return who + 'バズーカ：相手フィールドで撃ち込むマスを選んでください';
      case 'pair': return who + 'ペアショット：相手フィールドでマスを2つ選んでください';
      case 'cube': return who + 'サーチキューブ：相手フィールドのメニューから選んでください';
      case 'wait':
        if (app.net) return netWaiting() ? '送信しています…' : `${g.players[g.cur].name}の番です。相手の操作を待っています…`;
        return isCPUMode() ? `${foeName()}が解析しています…` : '';
      case 'over': return '試合終了';
      default: return who + (ITEMS[app.ui.item] ? ITEMS[app.ui.item].name + 'の対象を選んでください' : '');
    }
  }

  function itemHead(k, extra) {
    const g = G(), v = viewer();
    const rebuy = g.itemStatus(v, k).rebuyNeeded ? `<p class="note warn">手持ちがないため、3ptで再購入して使います（残り ${g.players[v].wallet}pt）。</p>` : '';
    return `<div class="itemhead"><span class="ichip active${k === 'bazooka' ? ' bz' : ''}">${ICON[k]}</span><div><b>${esc(ITEMS[k].name)}</b><p class="note ih-desc">${esc(extra || ITEMS[k].desc)}</p>${rebuy}</div></div>`;
  }

  // 進行表示ブロック：上の段に直前の出来事、下の段に説明（左）とボタン（右）。
  // フィールドの上に置くので、どの状態でも高さがほぼ変わらないように中身を短くそろえる
  function dockHTML(mode) {
    const g = G(), v = viewer(), ui = app.ui;
    const cancel = '<button class="btn ghost" data-act="cancel">やめる</button>';
    let main = '', acts = '';
    switch (mode) {
      case 'item':
        if (g.hasCallable(v)) main = '<p class="note">アイテムはコールの前か後のどちらかで、1ターンに1つまで。選んだアイコンをもう一度押すとやめられます。</p>';
        else {
          main = '<p class="dock-msg">コールできるマスが残っていません。コールを飛ばして、アンサーかターンエンドに進みます。</p>';
          acts = '<button class="btn primary" data-act="skip-call">コールを飛ばす</button>';
        }
        break;
      case 'call':
        main = '<p class="note">相手フィールドのマスをタップしてコールします。</p>';
        break;
      case 'answer-phase':
        main = `<p class="note">${g.itemUsed ? 'アンサーで個体の全マスを宣言するか、ターンエンドします。' : 'このターンはまだアイテムを使えます（フィールド上部のアイコン）。'}</p>`;
        acts = '<button class="btn primary" data-act="answer-start">アンサー</button><button class="btn" data-act="end-turn">ターンエンド</button>';
        break;
      case 'answer': {
        const key = ui.sel.length ? identifyShape(ui.sel, g.N) : null;
        const shapeTxt = !ui.sel.length ? 'マスを選択' : key ? `${SHAPES[key].cat}（${SHAPES[key].size}マス）` : '形になっていません';
        main = '<p class="dock-msg">個体の<b>全マス</b>を選んで宣言します。失敗すると自分のキューブを1つ差し出し、<b>手番が終了</b>します。</p>';
        acts = `<span class="chip ${key ? 'ok' : ''}">${esc(shapeTxt)}</span><button class="btn primary" data-act="answer-submit" ${key ? '' : 'disabled'}>宣言する</button>${cancel}`;
        break;
      }
      case 'cube':
        main = itemHead('cube', '相手フィールドに出たメニューから、調べる形かマス数を選んでください。');
        acts = cancel;
        break;
      case 'line':
        main = itemHead('line', '相手フィールドの列（A〜）か行（1〜）のラベルをタップ。そこにかかっている（撃破されていない）個体の数と、そのマスの数（例：2個体 / 3マス）が分かり、アイテム欄の下に記録されます。');
        acts = cancel;
        break;
      case 'number':
        main = itemHead('number', '調べるマスを選んでください。そこにある個体のマス数が分かります（空きマスなら NoData）。');
        acts = cancel;
        break;
      case 'shape':
        main = itemHead('shape', '調べるマスを選んでください。そこにある個体の形が分かります（空きマスなら NoData）。');
        acts = cancel;
        break;
      case 'pair':
        main = itemHead('pair', `調べるマスを2つ選んでください（${ui.sel.length}/2）。同じ個体かどうかが分かります。撃破済み以外ならどこでも選べます。`);
        acts = cancel;
        break;
      case 'node':
        main = itemHead('node', '調べるマスを選んでください。同じ個体のマスが上下左右にいくつつながっているか（0〜3）が分かります。1＝端、2＝途中か角、3＝T字の分かれ目。空きマスなら NoData。');
        acts = cancel;
        break;
      case 'bazooka':
        main = itemHead('bazooka', '撃ち込むマスを選んでください。そこにある個体を1マスキューブに分解し、ヒット済みのマスはその場で撃破します（ステルスも解除）。空きマスなら NoData。');
        acts = cancel;
        break;
      case 'warp-pick':
        main = itemHead('warp', '自分フィールドで、移動するキューブを選んでください。');
        acts = cancel;
        break;
      case 'warp-place':
        main = itemHead('warp', '移動先をタップ。移動前の位置は相手に公開されます。');
        acts = `<button class="btn" data-act="warp-rotate" title="R キー">↻ 回転</button><button class="btn" data-act="warp-flip" title="F キー">⇋ 反転</button><button class="btn ghost" data-act="warp-repick">選び直す</button>${cancel}`;
        break;
      case 'stealth-pick':
        main = itemHead('stealth', '守る自分のキューブを選んでください。全マスに当たっても撃破されず、アンサーでしか倒せません。どれにしたかは相手に伝わりません。');
        acts = cancel;
        break;
      case 'treasure':
        main = `<p class="dock-msg">トレジャーコール（残り${g.treasureLeft(v)}回／全${g.rules.treasureMax}回）：相手フィールドのマスを1つ。H＝的中、N＝上下左右か同じ個体、×＝外れ。</p>`;
        break;
      case 'sacrifice':
        main = `<p class="dock-msg warn">${esc(phaseText(mode))}</p>`;
        break;
      case 'wait':
        main = `<p class="dock-msg wait"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>${esc(phaseText(mode))}</p>`;
        break;
      case 'over':
        main = '<p class="dock-msg">試合終了</p>';
        acts = app.tour
          ? '<button class="btn primary" data-act="show-result">結果を見る</button><button class="btn" data-act="tour-back">大会の画面へ</button>'
          : '<button class="btn primary" data-act="show-result">結果を見る</button><button class="btn" data-act="restart">もう一度</button><button class="btn ghost" data-act="to-title">設定に戻る</button>';
        break;
    }
    const bn = bannerFor(v);
    const banner = bn ? `<p class="banner k-${esc(bn.kind)}" title="${esc(bn.text)}">${esc(bn.text)}</p>` : '<p class="banner empty" aria-hidden="true">&nbsp;</p>';
    return `<section class="panel dock" aria-live="polite">${banner}<div class="dock-main"><div class="dock-body">${main}</div>${acts ? `<div class="dock-acts">${acts}</div>` : ''}</div></section>`;
  }

  function scoreHTML(v) {
    const g = G();
    const me = g.players[v], foe = g.players[1 - v];
    const myLive = me.pieces.filter((p) => p.alive);
    const myCells = myLive.filter((p) => !p.isAdd).reduce((s, p) => s + p.size, 0);
    const foeLeft = '<span class="unk" title="相手の残り個体数は分かりません">？</span>';
    const T = app.tour;
    const tre = (P) => {
      if (P.view.treasureFound) return T ? '宝石+1' : '発見';
      const left = g.treasureLeft(P.idx);
      return left > 0 ? `<small>あと${left}回</small>` : '<small>失敗</small>';
    };
    // 大会：席→大会の番号。持ち点は、この試合の前の点＋ここまでの撃破とトレジャー（勝利点は試合の終わりに）
    const seatId = (i) => (i === 0 ? 0 : (g.rules.kind === 'final' ? (T.finalists[0] === 0 ? T.finalists[1] : T.finalists[0]) : tourOpponent(T)));
    const live = (P) => {
      const F = g.players[1 - P.idx];
      const d = P.score.attack - F.score.attack + ((P.view.treasureFound ? 1 : 0) - (F.view.treasureFound ? 1 : 0)) * E.Tour.GEM_PTS;
      return `${E.Tour.total(T.players[seatId(P.idx)]) + d}<small>${d > 0 ? '+' + d : d < 0 ? '−' + -d : '±0'}</small>`;
    };
    const hideSplitOf = (P) => P.idx !== v && g.phase !== 'over';
    const row = (P, left) => `<tr><th scope="row">${esc(P.name)}${g.first === P.idx ? '<small>先攻</small>' : ''}</th>
      ${T ? `<td class="live">${live(P)}</td>` : ''}<td>${P.score.attack}<small>マス</small></td><td>${tre(P)}</td><td>${left}</td>${T ? `<td class="held-td">${heldCubes(P, hideSplitOf(P))}</td>` : ''}</tr>
      ${T ? `<tr class="held-row"><td colspan="5"><span class="hr-cap">所持キューブ</span>${heldCubes(P, hideSplitOf(P))}</td></tr>` : ''}`;
    const tourNote = T ? '持ち点は、この試合の前の点に、ここまでの撃破（奪った・奪われたマス数）とトレジャーを足したもの（勝利点は試合の終わりに）。所持キューブは大会の持ち数（◆持っている・◇失った）。相手の個体をバズーカで分解したときは、その個体を失ったかどうかは試合終了まで非公開。' : '';
    return `<section class="panel scorebar${T ? ' tour' : ''}" aria-label="スコア">
      <table>
        <thead><tr><th></th>${T ? '<th>持ち点</th>' : ''}<th>撃破</th><th>トレジャー</th><th>残り個体</th>${T ? '<th>所持キューブ</th>' : ''}</tr></thead>
        <tbody>
          ${row(me, `${myLive.length}<small>体・${myCells}マス</small>`)}
          ${row(foe, foeLeft)}
        </tbody>
      </table>
      <p class="note">相手の残り個体数は分かりません。${tourNote}</p>
    </section>`;
  }

  // サウンドの切り替え（BGMと効果音 → 効果音だけ → 音なし）
  const SND_ORDER = ['all', 'sfx', 'off'];
  const SND_TEXT = { all: ['BGM・SE', 'BGMと効果音'], sfx: ['SEのみ', '効果音だけ'], off: ['OFF', '音なし'] };
  const SPEAKER = '<path class="spk" d="M3.5 9.4h3.6L12 5.5v13l-4.9-3.9H3.5z"/>';
  const SND_ICON = {
    all: `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}<path d="M15.6 9.3a3.8 3.8 0 0 1 0 5.4M18.4 6.6a7.6 7.6 0 0 1 0 10.8"/></svg>`,
    sfx: `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}<path d="M15.6 9.3a3.8 3.8 0 0 1 0 5.4"/></svg>`,
    off: `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}<path d="M16 9.6l4.8 4.8M20.8 9.6 16 14.4"/></svg>`,
  };
  function soundMode() { return SND_ORDER.indexOf(app.settings.sound) >= 0 ? app.settings.sound : 'all'; }
  function soundBtnHTML() {
    const m = soundMode(), t = SND_TEXT[m];
    return `<button class="btn ghost sndbtn ${m}" data-act="sound" aria-label="サウンド：${t[1]}（押すと切り替え）" data-tip="サウンド：${t[1]}。押すたびに BGMと効果音 → 効果音だけ → 音なし と切り替わります">${SND_ICON[m]}<span>${t[0]}</span></button>`;
  }
  function setSound(m) {
    app.settings.sound = m;
    store.set('settings', app.settings);
    SND.setMode(m, true);
    if (m !== 'off') SND.sfx('tick');
    toast(m === 'all' ? 'BGMと効果音をオンにしました' : m === 'sfx' ? 'BGMを止めました（効果音だけ鳴ります）' : '音をすべてオフにしました', 'note');
  }

  function hudHTML(stats, back) {
    return `<header class="hud">
      <div><div class="logo">サーチバトル</div><div class="logo-sub">SEARCH BATTLE</div></div>
      <div class="hud-mid">${stats || ''}</div>
      <div class="row">${soundBtnHTML()}<button class="btn ghost" data-act="rules">ルール</button>${back || '<button class="btn ghost" data-act="to-title">やめる</button>'}</div>
    </header>`;
  }

  // ---------------- 画面：タイトル ----------------
  function demoBoard() {
    const pieces = [{ cells: [1, 2], col: 1 }, { cells: [8, 12, 13], col: 3 }, { cells: [7, 11, 15], col: 4 }];
    const marks = { 2: ['oo', 1], 1: ['o'], 5: ['x'], 10: ['x'], 15: ['o'] };
    let html = '';
    for (let c = 0; c < 16; c++) {
      let cls = cellBase(c, 4), style = '', inner = '';
      const p = pieces.find((x) => x.cells.indexOf(c) >= 0);
      if (p) {
        const mask = p.cells.reduce((m, x) => m | bit(x), 0);
        cls += ' pc' + edgeClasses(mask, c, 4) + (marks[c] && marks[c][0] !== 'x' ? ' hitc' : '');
        style = `--pcc:var(--pc${p.col});`;
      }
      const m = marks[c];
      if (m) inner += markHTML({ r: m[0], num: m[1] });
      if (c === 13) inner += MARK.gem;
      if (c === 14) inner += '<span class="tl tl-N">N</span>';
      html += `<div class="${cls}" style="${style}">${inner}</div>`;
    }
    let cols = '', rows = '';
    for (let i = 0; i < 4; i++) { cols += `<span>${COLS[i]}</span>`; rows += `<span>${i + 1}</span>`; }
    return `<div class="board" style="--n:4" aria-hidden="true"><div class="ax ax-c">${cols}</div><div class="ax ax-r">${rows}</div><div class="cells">${html}</div></div>`;
  }

  function seg(name, value, options) {
    return `<div class="seg" role="radiogroup" aria-label="${esc(name)}">` + options.map(([val, label, sub], i) => {
      const id = `opt-${name}-${i}`;
      return `<input type="radio" id="${id}" name="${name}" value="${esc(val)}" data-setting="${name}" ${String(val) === String(value) ? 'checked' : ''}><label for="${id}"><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</label>`;
    }).join('') + '</div>';
  }

  // 使えるアイテムの設定（今後アイテムが増えても、この一覧に並ぶ）
  function pickedItems() {
    const list = (app.settings.itemPick || []).filter((k) => ITEM_KEYS.indexOf(k) >= 0);
    return list.length ? list : ITEM_KEYS.slice();
  }
  function itemsForMatch() {
    const mode = app.settings.items;
    if (mode === 'pick') return pickedItems();
    if (mode === 'draft') return ITEM_KEYS.slice();
    const n = app.settings.randomN | 0;
    if (!n || n >= ITEM_KEYS.length) return ITEM_KEYS.slice();
    const pool = ITEM_KEYS.slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    const chosen = pool.slice(0, n);
    return ITEM_KEYS.filter((k) => chosen.indexOf(k) >= 0);
  }
  function itemPickHTML() {
    const on = pickedItems();
    return `<div class="item-pick" role="group" aria-label="使うアイテムを選ぶ">${ITEM_KEYS.map((k) => {
      const id = 'pick-' + k;
      return `<input type="checkbox" id="${id}" data-pick="${k}" ${on.indexOf(k) >= 0 ? 'checked' : ''}><label for="${id}" title="${esc(ITEMS[k].desc)}">${ICON[k]}<span>${esc(ITEMS[k].name)}</span></label>`;
    }).join('')}<p class="note" id="pick-count">${on.length}種を使います。</p></div>`;
  }
  // 個数の指定（ランダム＝何種類使うか、ドラフト＝1人が何個取るか）
  function stepperHTML(key, value, min, max, unit, note) {
    return `<div class="stepper" role="group" aria-label="${esc(note)}">
      <button type="button" class="btn ghost sq" data-act="step" data-key="${key}" data-d="-1" ${value <= min ? 'disabled' : ''} aria-label="減らす">−</button>
      <output id="step-${key}">${value}<small>${esc(unit)}</small></output>
      <button type="button" class="btn ghost sq" data-act="step" data-key="${key}" data-d="1" ${value >= max ? 'disabled' : ''} aria-label="増やす">＋</button>
      <span class="note">${esc(note)}</span>
    </div>`;
  }

  function renderTitle() {
    const s = app.settings;
    const tour = s.rules === 'tour';
    const online = !tour && s.mode === 'online';
    root.innerHTML = `
      <div class="wrap title-screen">
        <header class="hud">
          <p class="eyebrow">Tactical search battle</p>
          <div class="row">${soundBtnHTML()}<button class="btn ghost" data-act="sim-open">シミュレーター</button><button class="btn ghost" data-act="rules">ルールを見る</button></div>
        </header>
        <section class="hero">
          <div>
            <h1 class="logo">サーチバトル</h1>
            <div class="logo-sub">SEARCH BATTLE</div>
            <p class="tagline">座標を当てるのではない。敵の構造を透視し、自らの情報を対価に勝利を買い取れ。</p>
            <p class="lede">サイバー空間に浮かぶ相手フィールドから、メタリックなキューブを探り当てます。◎は新しい個体を捉えた合図。形が読めたらアンサーで一気に撃破します。</p>
            <ul class="legend" aria-label="記号の意味">
              <li><span class="lg ink-oo">${MARK.oo}</span>ファーストヒット</li>
              <li><span class="lg ink-o">${MARK.o}</span>ヒット</li>
              <li><span class="lg ink-x">${MARK.x}</span>ノットヒット</li>
              <li><span class="tlg">N</span>トレジャーのニア</li>
            </ul>
          </div>
          <div class="visual" aria-hidden="true">
            <div class="cube3d"><i></i><i></i><i></i><i></i><i></i><i></i></div>
            <div class="beamv"></div>
            ${demoBoard()}
          </div>
        </section>
        <section class="panel settings" aria-label="対戦の設定">
          <div class="set-row"><h2>モード</h2>${tour
            ? '<p class="set-fixed">大会は <b>あなた＋CPU3人</b> の4人で戦います</p>'
            : seg('mode', s.mode, [['cpu', 'CPU戦', '最強CPUが相手'], ['pvp', 'プレイヤーバトル', '1台で2人が交代'], ['online', 'オンライン対戦', '別の端末の人と']])}</div>
          <div class="set-row"><h2>ルール</h2>${seg('rules', s.rules, [['prelim', '4×4', 'トレジャー4回'], ['final', '5×5', 'トレジャー5回'], ['tour', '大会', '予選3試合＋決勝']])}</div>
          <div class="set-row"><h2>使えるアイテム</h2>${tour
            ? `<p class="set-fixed">9種を<b>2つずつ（18個）</b>持って始め、予選3試合と決勝で使い分けます。予選は1試合で同じ種類は1回まで。決勝は予選の残り＋ドラフト（4つずつ）。持ち点<b>${E.Tour.START}</b>から、撃破と勝利で相手の点を奪い合います。</p>`
            : seg('items', s.items, [['pick', '選ぶ', pickedItems().length + '種を指定'], ['random', 'ランダム', s.randomN + '種を毎試合'], ['draft', 'ドラフト', `1人${s.draftN}個ずつ`]])}</div>
          ${!tour && s.items === 'pick' ? `<div class="set-row"><span aria-hidden="true"></span>${itemPickHTML()}</div>` : ''}
          ${!tour && s.items === 'random' ? `<div class="set-row"><span aria-hidden="true"></span>${stepperHTML('randomN', s.randomN, 1, ITEM_KEYS.length, '種', `${ITEM_KEYS.length}種類の中から、試合ごとにランダムに選びます`)}</div>` : ''}
          ${!tour && s.items === 'draft' ? `<div class="set-row"><span aria-hidden="true"></span>${stepperHTML('draftN', s.draftN, 1, DRAFT_MAX, '個', `${ITEM_KEYS.length}種類から、1人がこの数ずつドラフトで取ります（後攻から）`)}</div>` : ''}
          <div class="set-row"><h2>演出とCPUの速さ</h2>${seg('speed', s.speed, [['normal', 'ふつう', ''], ['fast', 'はやい', '']])}</div>
          <div class="set-row"><h2>サウンド</h2>${seg('sound', soundMode(), [['all', 'BGMと効果音', ''], ['sfx', '効果音だけ', ''], ['off', 'なし', '']])}</div>
          <div class="start-row">
            <button class="btn primary big" data-act="start">${tour ? '大会を始める' : online ? 'オンライン対戦の部屋へ' : '対戦を始める'}</button>
            <p class="note">${tour ? '総当たりの予選3試合（4×4）の上位2名が、決勝（5×5）に進みます。' : online ? (NET.supported() ? '部屋を作った人のルールとアイテムの設定で対戦します。部屋に入る人の設定は使いません。' : 'このページではオンライン対戦を使えません（次の画面に、遊べるページへのリンクがあります）。') : '先攻・後攻はランダムで決まります。'}音は最初に画面を操作したときから鳴ります。</p>
          </div>
        </section>
      </div>`;
  }

  // ---------------- キューブの◆◇ ----------------
  // マス数 size のキューブを、大会全体の数（2マス×5・3マス×4・4マス×3・5マス×2）の◆◇で表す
  //  n.on＝持っている（使える）、n.placed＝この試合で置いた、n.gone＝この試合で失った。残りは大会で失った分（◇）
  function cubePips(size, n) {
    const full = E.STOCK[size];
    const on = n.on || 0, placed = n.placed || 0, gone = n.gone || 0;
    let pips = '';
    for (let i = 0; i < full; i++) {
      const k = i < on ? 'on' : i < on + placed ? 'placed' : i < on + placed + gone ? 'gone' : '';
      pips += `<i class="${k}"></i>`;
    }
    const lost = Math.max(0, full - on - placed - gone);
    const tip = `${size}マスのキューブ：${n.label || '残り'}${on}${placed ? `・置いた${placed}` : ''}${gone ? `・この試合で失った${gone}` : ''}${lost ? `・大会で失った${lost}` : ''}（大会の最初は${full}）`;
    return `<span class="cb" data-tip="${esc(tip)}" aria-label="${esc(tip)}"><b>${size}</b>${pips}</span>`;
  }
  // 試合中の「所持キューブ」：大会の持ち数から、この試合で失った分（撃破・差し出し。分解は全部撃破されたとき）を引く
  //  hideSplit：相手の分。バズーカで分解された個体を失ったかどうかは、試合が終わるまで伏せる
  //  （破片は1マスキューブとして撃破を知らせるだけ。元の個体を倒しきったこと・そのマス数は、試合の結果で分かる）
  function heldCubes(P, hideSplit) {
    const lostNow = { 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const p of P.pieces) if (!p.frag && !p.isAdd && !p.alive) lostNow[p.size]++;
    if (!hideSplit) for (const sp of P.splitPieces || []) if (!P.pieces.some((f) => f.frag && f.fromId === sp.id && f.alive)) lostNow[sp.size]++;
    return `<div class="st-cubes held">${[2, 3, 4, 5].map((s) => cubePips(s, { on: Math.max(0, (P.stock[s] || 0) - lostNow[s]), gone: lostNow[s], label: '持っている' })).join('')}</div>`;
  }

  // ---------------- 画面：配置 ----------------
  function renderSetup() {
    const g = G(), S = app.setup, pi = S.pi, P = g.players[pi], N = g.N;
    const PL = E.placements(N);
    const totalCells = P.pieces.reduce((s, p) => s + p.size, 0);
    const who = oneSide() ? 'あなた' : P.name;
    // オンライン対戦：配置を終えた（ゲストは送った）あとは、相手を待つあいだ動かせない
    const locked = netSetupLocked();
    const lockDis = (off) => (off || locked ? 'disabled' : '');
    let palette = '';
    for (const size of [2, 3, 4, 5]) {
      const left = g.stockLeft(pi, size);
      const placed = Math.max(0, (P.stock[size] || 0) - left);
      palette += `<div class="pal-row"><div class="pal-h"><b>${size}マス</b>${cubePips(size, { on: left, placed, label: '置ける' })}</div><div class="pal-shapes">`;
      for (const k of SHAPES_BY_SIZE[size]) {
        const fits = PL[k].length > 0;
        const dis = left <= 0 || !fits;
        const on = S.key === k && !S.treasureMode;
        palette += `<button class="shape-btn${on ? ' on' : ''}" data-act="shape" data-key="${k}" ${dis || locked ? 'disabled' : ''} aria-pressed="${on}" title="${esc(SHAPES[k].cat + ' ' + SHAPES[k].name)}">${shapeMini(k, on ? S.t : 0)}<span>${!fits ? '5×5のみ' : esc(SHAPES[k].cat)}</span></button>`;
      }
      palette += '</div></div>';
    }
    const ready = P.pieces.length > 0 && !!P.treasure;
    const hint = locked
      ? '配置を送りました。相手の配置が終わると対戦が始まります。'
      : S.treasureMode
      ? 'トレジャーを置くキューブのマスをタップしてください。'
      : (S.key ? 'フィールドをタップして配置。置いたキューブをタップすると外せます。R：回転 / F：反転' : 'キューブの一覧から形を選んでください。');
    // 左：単発の試合は「この試合のアイテム」、大会は自分と相手の残りアイテム（個数つき）
    const itemRows = (P2, enemy) => `<ul class="su-ilist${enemy ? ' enemy' : ''}">${g.itemKeys.map((k) => {
      const n = P2 ? (P2.items[k] || 0) : null;
      return `<li class="${n === 0 ? 'zero' : ''}" data-tip="${esc(ITEMS[k].name + '：' + ITEMS[k].desc)}"><span class="ic">${ICON[k]}</span><b>${esc(ITEMS[k].name)}</b>${n != null ? `<em>×${n}</em>` : ''}</li>`;
    }).join('')}</ul>`;
    const foe = g.players[1 - pi];
    const itemsHTML = app.tour
      ? `<h2 class="ptitle">${esc(who)}の残りアイテム<small>YOUR ITEMS</small></h2>${itemRows(P, false)}
         <h2 class="ptitle su-foe">${esc(foe.name)}の残りアイテム<small>RIVAL ITEMS</small></h2>${itemRows(foe, true)}`
      : `<h2 class="ptitle">この試合のアイテム<small>ITEMS</small></h2>${itemRows(null, false)}`;
    root.innerHTML = `
      <div class="wrap">
        ${hudHTML(`<span class="stat">${esc(g.rules.label)}<b>${N}×${N}</b></span><span class="stat me">DEPLOY<b>${esc(who)}</b></span>`)}
        <p class="phase">${esc(who)}のキューブを配置してください</p>
        <div class="setup3">
          <section class="panel su-items">${itemsHTML}</section>
          <section class="panel su-board">
            <div class="fhead"><b>${oneSide() ? '自分フィールド' : esc(who) + 'のフィールド'}</b><small>${P.pieces.length} UNITS / ${totalCells} CELLS</small></div>
            ${ownBoard(pi, { cls: 'large' })}
            <p class="hint">${esc(hint)}</p>
            <div class="su-ctrl">
              <div class="su-ctrl-main">
                <button class="btn" data-act="rotate" ${lockDis(!S.key)}>↻ 回転</button>
                <button class="btn" data-act="flip" ${lockDis(!S.key)}>⇋ 反転</button>
                <button class="btn${S.treasureMode ? ' primary' : ''}" data-act="treasure-mode" ${lockDis(!P.pieces.length)} aria-pressed="${S.treasureMode}">◆ トレジャー${P.treasure ? '（済）' : ''}</button>
              </div>
              <div class="su-ctrl-sub">
                <button class="btn ghost" data-act="random" ${lockDis(false)}>自動配置</button>
                <button class="btn ghost" data-act="clear" ${lockDis(!P.pieces.length)}>リセット</button>
              </div>
            </div>
          </section>
          <section class="panel su-done">
            ${locked
              ? '<p class="prompt net-wait">相手の配置を待っています</p>'
              : `<button class="btn primary big su-donebtn" data-act="setup-done" ${ready ? '' : 'disabled'}>配置完了</button>
            <span class="note su-donenote">${ready ? '準備ができました' : (P.pieces.length ? 'トレジャーをセットしてください' : 'キューブを置いてください')}</span>`}
            ${app.net ? `<span class="note net-foe">${esc(app.net.foe || '相手')}：${netFoeReady() ? '<b>配置完了</b>' : '配置中…'}</span>` : ''}
          </section>
          <section class="panel su-parts">
            <h2 class="ptitle">キューブ<small>CUBES</small></h2>
            <div class="palette">${palette}</div>
            <p class="note">最低1個体。詰め込んでも、1個体だけで隠れても構いません。${app.tour ? '大会では、撃破されると個体のマス数ぶんの点を相手に奪われます。' : ''}配置したら、どれか1マスにトレジャーをセットします。${app.tour ? '<b class="warn-t">大会：撃破された（アンサー失敗で差し出した）キューブは、次の試合から使えません。</b>' : ''}</p>
          </section>
        </div>
      </div>`;
  }

  // ---------------- 画面：ドラフト ----------------
  function renderDraft() {
    const g = G(), d = g.draft;
    const turn = g.draftTurn();
    const second = 1 - g.first;
    // この端末の人が選ぶ番か（オンライン対戦は自分の席の番だけ。送った結果を待つあいだは選べない）
    const humanTurn = app.net ? turn === app.net.seat && !netWaiting() : !(isCPUMode() && turn === 1);
    const picks = (pi) => d.picks[pi].map((k) => `<li>${esc(ITEMS[k].name)}</li>`).join('') || '<li class="none">まだありません</li>';
    // 大会の決勝：ドラフトの前から持っているアイテム（予選の残り）
    const held = (pi) => {
      if (!app.tour) return '';
      const P = g.players[pi];
      const base = {};
      for (const k of ITEM_KEYS) base[k] = (P.items[k] || 0) - d.picks[pi].filter((x) => x === k).length;
      const list = ITEM_KEYS.filter((k) => base[k] > 0).map((k) => `${esc(ITEMS[k].name)}${base[k] > 1 ? '×' + base[k] : ''}`);
      return `<p class="note held">手持ち（予選の残り）：${list.length ? list.join('・') : 'なし'}</p>`;
    };
    root.innerHTML = `
      <div class="wrap">
        ${hudHTML(`<span class="stat">決勝<b>DRAFT</b></span><span class="stat me">PICK<b>${esc(g.players[turn].name)}</b></span>`)}
        <section class="panel draft">
          <h2 class="ptitle">アイテムドラフト<small>ITEM DRAFT</small></h2>
          <p class="note">この試合の${g.itemKeys.length}種類から、${d.each || Math.floor(g.itemKeys.length / 2)}つずつ取ります。順番は ${d.order.map((p) => (p === g.first ? '先' : '後')).join('')}（後＝${esc(g.players[second].name)}）。偏りが出にくい「トゥエ・モース順」で、最初と最後は別の人が取ります。取ったアイテムは手持ちに1回ぶん追加されます。</p>
          <p class="prompt">${esc(g.players[turn].name)}の番です${humanTurn ? '。アイテムを選んでください' : '…'}</p>
          <div class="draft-pool">
            ${d.pool.map((k) => `<button class="item-card" data-act="draft-pick" data-key="${k}" ${humanTurn && !app.busy ? '' : 'disabled'}>${ICON[k]}<b>${esc(ITEMS[k].name)}</b><span>${esc(ITEMS[k].desc)}</span></button>`).join('')}
          </div>
          <div class="draft-picks">
            ${[g.first, second].map((pi) => `<div><h3>${esc(g.players[pi].name)}（${pi === g.first ? '先攻' : '後攻'}）</h3>${held(pi)}<ul>${picks(pi)}</ul></div>`).join('')}
          </div>
        </section>
      </div>`;
  }

  // ---------------- 画面：対戦 ----------------
  function renderBattle() {
    const g = G();
    const v = viewer();
    if (app.ui) app.ui.lastViewer = v;
    const mode = effMode();
    const P = g.players[v];
    const ui = app.ui;
    const N = g.N;

    let predClick = null, ownClick = null, ownPick = false;
    if (mode === 'item' || mode === 'call') predClick = (c) => g.isCallable(v, c);
    else if (mode === 'treasure') predClick = (c) => g.isTreasureCallable(v, c);
    else if (mode === 'answer' || mode === 'shape' || mode === 'number' || mode === 'node' || mode === 'bazooka') predClick = (c) => !P.view.dead[c];
    else if (mode === 'pair') predClick = (c) => !P.view.dead[c];
    if (mode === 'warp-pick' || mode === 'sacrifice') { ownPick = true; ownClick = (c) => !!g.pieceAt(v, c); }
    else if (mode === 'stealth-pick') { ownPick = true; ownClick = (c) => { const p = g.pieceAt(v, c); return !!p && !p.stealth; }; }
    else if (mode === 'warp-place') ownClick = () => true;
    const predActive = !!predClick || mode === 'line' || mode === 'cube';

    const reveal = g.phase === 'over' && ui.reveal;
    const tLeft = g.treasureLeft(v);
    const tStat = P.view.treasureFound ? 'GET' : tLeft > 0 ? `あと${tLeft}回` : '失敗';
    const stats = g.phase === 'play'
      ? `<span class="stat">TURN<b>${pad2(g.turn)}</b></span><span class="stat">${esc(g.rules.label)}<b>${N}×${N}</b></span><span class="stat treasure">TREASURE<b>${tStat}</b></span><span class="stat${g.cur === v ? ' me' : ' hot'}">手番<b>${esc(g.players[g.cur].name)}</b></span>`
      : `<span class="stat">GAME<b>OVER</b></span>`;
    const L = sideEntries(v);
    const myIntel = intelFor(1 - v, v);     // 相手が自分フィールドを調べた結果
    const foeIntel = intelFor(v, 1 - v);    // 自分が相手フィールドを調べた結果

    root.innerHTML = `
      <div class="wrap">
        ${hudHTML(stats)}
        <p class="phase${mode === 'wait' ? ' wait' : ''}">${esc(phaseText(mode))}</p>
        <div class="arena">
          <section class="center" aria-label="フィールド">
            ${dockHTML(mode)}
            <div class="fields">
              <section class="panel own${ownClick ? ' active' : ''}">
                <div class="fhead"><b>自分フィールド</b><small>MY FIELD</small></div>
                ${fieldChips(v, v)}
                ${intelTagsHTML(myIntel, false)}
                ${ownBoard(v, { clickable: ownClick, pick: ownPick, selectedPiece: ui.warp ? ui.warp.pieceId : null, flash: true, intel: myIntel })}
              </section>
              <section class="panel enemy${predActive ? ' active' : ''}${mode === 'treasure' ? ' treasure-active' : ''}${mode === 'answer' ? ' answer-mode' : ''}">
                <div class="fhead"><b>${reveal ? '相手フィールド（答え合わせ）' : '相手フィールド'}</b><small>ENEMY FIELD</small></div>
                ${fieldChips(1 - v, v)}
                ${intelTagsHTML(foeIntel, true)}
                ${predBoard(v, { clickable: predClick, sel: ui.sel, flash: true, reveal, intel: foeIntel, pickLine: mode === 'line', cubeMenu: mode === 'cube' })}
                ${g.phase === 'play' ? memoBarHTML(v) : ''}
              </section>
            </div>
            ${scoreHTML(v)}
          </section>
          <div class="logs">
            <aside class="logcol col-def" aria-label="自分フィールドの記録">
              <section class="panel itemlog"><h2 class="ptitle">自分フィールドのアイテム<small>MY FIELD</small></h2>${itemLogHTML(L.myItems, v, 'まだ使われていません')}</section>
              <section class="panel calllog"><h2 class="ptitle">防御ログ<small>DEFENSE</small></h2>${callLogHTML(L.defCalls, v, 'まだ攻撃を受けていません')}</section>
            </aside>
            <aside class="logcol col-atk" aria-label="相手フィールドの記録">
              <section class="panel enemy itemlog"><h2 class="ptitle">相手フィールドのアイテム<small>ENEMY FIELD</small></h2>${itemLogHTML(L.foeItems, v, 'まだ使われていません')}</section>
              <section class="panel enemy calllog"><h2 class="ptitle">攻撃ログ<small>ATTACK</small></h2>${callLogHTML(L.atkCalls, v, 'まだコールしていません')}</section>
            </aside>
          </div>
        </div>
      </div>
      ${g.phase === 'over' && ui.showResult ? resultHTML() : ''}`;
  }

  function resultHTML() {
    const g = G(), r = g.result;
    let verdict, cls = '', sub;
    const me = viewer();   // この端末の人の席（CPU戦・大会は0、オンライン対戦は自分の席）
    if (r.draw) { verdict = 'DRAW'; cls = 'draw'; sub = '両者全滅で引き分け'; }
    else if (oneSide()) { verdict = r.winner === me ? 'VICTORY' : 'DEFEAT'; cls = r.winner === me ? '' : 'lose'; sub = r.winner === me ? 'あなたの勝ち！' : `${g.players[r.winner].name}の勝ち`; }
    else { verdict = 'WINNER'; sub = `${g.players[r.winner].name}の勝ち！`; }
    const note = r.draw ? '両者全滅で引き分けです。' : '相手の個体をすべて撃破しました。';
    let table, foot;
    if (app.tour) {
      // 大会：撃破で奪う・勝利で奪う・トレジャーで増える。試合の結果はまだ大会に反映していないので、持ち点は今の点＋増減
      const T = app.tour;
      const ids = [0, g.rules.kind === 'final' ? (T.finalists[0] === 0 ? T.finalists[1] : T.finalists[0]) : tourOpponent(T)];
      const mp = TourE.matchPoints(g);
      const sg = (n) => (n > 0 ? '+' + n : n < 0 ? '−' + -n : '0');
      const rows = [0, 1].map((i) => {
        const d = mp[i];
        const after = TourE.total(T.players[ids[i]]) + d.total;
        return `<tr><th scope="row">${esc(g.players[i].name)}</th><td>${sg(d.take)}</td><td>${sg(-d.taken)}</td><td class="${d.victory > 0 ? 'vp' : ''}">${sg(d.victory)}</td>${g.speedBonus ? `<td class="${d.speed > 0 ? 'vp' : ''}">${sg(d.speed)}</td>` : ''}${gemCellHTML(g, i)}<td class="tot">${sg(d.total)}<small>pt</small></td><td>${after}<small>pt</small></td></tr>`;
      }).join('');
      table = `<div class="tablewrap"><table class="score">
          <thead><tr><th></th><th>撃破</th><th>被撃破</th><th>勝利</th>${g.speedBonus ? '<th>スピード</th>' : ''}<th>宝石</th><th>増減</th><th>持ち点</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`;
      const loser = r.draw ? -1 : 1 - r.winner;
      foot = `<p class="note">撃破＝撃破した個体のマス数を相手から奪った分、被撃破＝撃破されて奪われた分。${loser >= 0 ? `勝者は負けた側から勝利点${g.victoryPts || TourE.VICTORY}ptを奪います（予選1試合目から ${vicText()}）。` : ''}${g.speedBonus ? `スピード＝予選で早いターンに負けたときの減点（スピードペナルティ。${speedText()}。減った点は相手に渡りません）。${loser >= 0 && TourE.speedFor(g.turn) ? `${g.turn}ターン目に決着したので、負けた側は${TourE.speedFor(g.turn)}pt減点です。` : ''}` : ''}宝石＝トレジャーを見つけて相手から奪った宝石（1つ${TourE.GEM_PTS}pt）。1pt＝1万円。</p>`;
    } else {
      // 単発の試合は勝ち負けだけ（点数は出さない）
      const rows = [0, 1].map((i) => {
        const P = g.players[i], F = g.players[1 - i];
        const killed = F.pieces.filter((p) => !p.alive && !p.frag && !p.isAdd).length + F.splitPieces.filter((sp) => !F.pieces.some((f) => f.frag && f.fromId === sp.id && f.alive)).length;
        const alive = P.pieces.filter((p) => p.alive).length;
        return `<tr><th scope="row">${esc(P.name)}</th><td>${killed}個体</td><td>${P.view.treasureFound ? '発見' : '—'}</td><td>${alive}個体</td></tr>`;
      }).join('');
      table = `<div class="tablewrap"><table class="score">
          <thead><tr><th></th><th>撃破</th><th>トレジャー</th><th>残った個体</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`;
      foot = '';
    }
    const view = '<button class="btn" data-act="replay-open" data-src="game">リプレイ</button><button class="btn" data-act="reveal">フィールドで答え合わせ</button>';
    // オンライン対戦の「もう一度」は審判のホストが始める（ゲストは待つ）
    const netAgain = !app.net ? '' : app.net.gone
      ? `<p class="note warn net-note">${esc(app.net.foe || '相手')}が退出しました。</p>`
      : app.net.role === 'host' ? '<button class="btn primary" data-act="restart">もう一度</button>' : '<p class="note net-note">もう一度対戦するときは、部屋を作った人が始めます。</p>';
    const acts = app.tour
      ? `<button class="btn primary" data-act="tour-back">${g.rules.kind === 'final' ? '大会の結果へ' : '大会の途中経過へ'}</button>${view}`
      : app.net
        ? `${netAgain}${view}<button class="btn ghost" data-act="to-title">退出する</button>`
        : `<button class="btn primary" data-act="restart">もう一度</button>${view}<button class="btn ghost" data-act="to-title">設定に戻る</button>`;
    return `<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="result-h">
      <div class="panel dialog">
        <p class="eyebrow">${esc(g.rules.label)} / ${g.turn} turns</p>
        <h2 id="result-h" class="verdict ${cls}">${verdict}</h2>
        <p class="verdict-sub">${esc(sub)}</p>
        <p class="note">${esc(note)}</p>
        ${table}
        ${foot}
        <div class="row">${acts}</div>
      </div>
    </div>`;
  }

  function quitModal() {
    return `<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="quit-h">
      <div class="panel dialog">
        <h2 id="quit-h" class="verdict-sub">大会をやめますか？</h2>
        <p class="note">ここまでの成績は残りません。</p>
        <div class="row"><button class="btn fire" data-act="quit-tour">やめる</button><button class="btn" data-act="close-modal">続ける</button></div>
      </div>
    </div>`;
  }

  function rulesModal() {
    const li = (k) => `<li>${ICON[k]}<div><b>${esc(ITEMS[k].name)}</b><span>${esc(ITEMS[k].desc)}</span></div></li>`;
    return `<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="rules-h">
      <div class="panel dialog rules">
        <h2 id="rules-h">RULES</h2>
        <ol class="flow">
          <li><b>コール</b>（必須）：相手フィールドのマスを1つ指定</li>
          <li><b>アンサー</b>（任意・何度でも）：個体の全マスを宣言して撃破。失敗すると自分の個体を1つ公開して差し出し、<b>手番が終了</b>する</li>
          <li><b>トレジャーコール</b>（偶数ターンのみ）：H＝的中（大会では相手の宝石を1つ奪う）、N＝上下左右か同じ個体、×＝外れ</li>
        </ol>
        <p><b>アイテム</b>：コールの前か後のどちらかで、1ターンに1つまで。</p>
        <p><b>回答</b>：◎＝その個体への最初のヒット（番号付き）、○＝2回目以降のヒット、×＝何もない。全マスをコールされた個体は撃破されます。</p>
        <p><b>勝敗</b>：相手を全滅させたら勝ち（単発の試合は勝ち負けだけで、点数はありません）。<b>トレジャーチャンス</b>は4×4で4回・5×5で5回まで。</p>
        <p><b>大会</b>：あなた＋CPU3人の総当たりで予選3試合（4×4）、持ち点の上位2名が決勝（5×5）。キューブ（2マス×5・3マス×4・4マス×3・5マス×2）は大会を通して持ち越し、撃破されたものは失います。アイテムは9種を2つずつ（18個）持って始め、予選3試合と決勝で使い分けます（予選は1試合で同じ種類は1回まで。アイテムの購入はありません）。<b>持ち点</b>は${E.Tour.START + E.Tour.GEMS * E.Tour.GEM_PTS}点（${E.Tour.START}点と宝石${E.Tour.GEMS}つ。1つ${E.Tour.GEM_PTS}点）から始め、撃破した個体のマス数を相手から奪います（アンサー失敗で差し出した個体も）。勝者はさらに勝利点（予選1試合目から ${vicText()}）を奪います。予選では、早いターンで負けると<b>スピードペナルティ</b>で持ち点が減ります（${speedText()}。2マス1個だけ置いて即負けし、キューブを温存する動きを防ぎます。減った点は勝った側に渡らない自滅点なので、わざと負けて特定の相手に点を与えることはできません。アンサー失敗で負けても同じ）。宝石は各試合1つをトレジャーとして置き、見つけられると相手に奪われます。決勝は予選の残り＋ドラフト（4つずつ）で、全滅させた側が優勝。賞金は優勝者の持ち点×1万円です。CPUは4人（${E.Tour.CHARS.map((c) => `${c.name}＝${E.Tour.PERSONAS[c.persona].name}：${E.Tour.PERSONAS[c.persona].desc}`).join('、')}）の中から、毎回3人が出場します。アイテム浪費型以外のCPUは、アイテムを試合ごとにバランスよく使います（1・2試合目は各種類1つ目まで、攻撃アイテムは1試合3〜5個まで）。</p>
        <h3 class="legend-h">攻撃アイテム（相手フィールドに作用）</h3>
        <ul class="icon-legend">${ATK_ITEMS.map(li).join('')}</ul>
        <h3 class="legend-h">防御アイテム（自分フィールドに作用）</h3>
        <ul class="icon-legend">${DEF_ITEMS.map(li).join('')}</ul>
        <p class="note">ワープすると移動前の位置が×（W付き）で公開され、それ以外の×は薄くなって再コールできるようになります。ステルスにしたキューブは、全マスに当たっても撃破されず、アンサーでしか撃破できません（どのキューブかは相手に伝わりません）。ペアショットは撃破済み以外のどの2マスにも使えます。マスの調査結果は C＝キューブ、L＝L字、T＝T字、数字＝マス数（左上の札）、ひし形の数字＝ノードショットのつながりの数（1＝端、2＝途中か角、3＝T字の分かれ目、0＝1マスキューブ）。空きマスだったときは NoData。バズーカで分解された個体は、その試合のあいだ1マスキューブ（1マス1pt）になり、1回のヒットで撃破されます。分解された個体にトレジャーがあれば、ニアの「同じ個体」はそのマスだけになります。</p>
        <div class="row"><button class="btn primary" data-act="close-modal">閉じる</button></div>
      </div>
    </div>`;
  }

  // ================= 大会 =================
  const TourE = E.Tour;
  const ROUNDS = 3;
  // アイコン：あなたは YOU、CPUは出場したキャラクター（α・β・γ・δ。毎回4人から3人）の文字と色
  const AV_GLYPH = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ' };
  const avatar = (id) => {
    const p = app.tour && app.tour.players[id];
    const ch = p && p.char;
    if (!ch) return `<span class="av av0" aria-hidden="true"><i>YOU</i></span>`;
    return `<span class="av av-${ch}" aria-hidden="true"><i>${AV_GLYPH[ch] || '?'}</i></span>`;
  };
  const tname = (id) => esc(app.tour.players[id].name);

  // 表に並べる順：予選中はポイント順。予選が終わったら予選の順位で固定し、決勝のあとは優勝・準優勝を上にする
  function displayList(T) {
    const row = (id, i) => ({ id, total: TourE.total(T.players[id]), rank: i + 1 });
    if (T.stage === 'done' && T.champion != null && T.prelimOrder) {
      const ru = T.finalists.find((id) => id !== T.champion);
      return [T.champion, ru].concat(T.prelimOrder.filter((id) => id !== T.champion && id !== ru)).map(row);
    }
    if ((T.stage === 'final-hub' || T.stage === 'final' || T.stage === 'qualify') && T.prelimOrder) return T.prelimOrder.map(row);
    return TourE.standings(T);
  }
  function tourRanks(T) {
    const out = { ranks: {}, totals: {}, gems: {} };
    for (const x of displayList(T)) { out.ranks[x.id] = x.rank; out.totals[x.id] = x.total; out.gems[x.id] = T.players[x.id].gems | 0; }
    return out;
  }
  function tourOpponent(T) {
    const pair = T.rounds[T.round].find((m) => m.indexOf(0) >= 0);
    return pair[0] === 0 ? pair[1] : pair[0];
  }
  // CPUの配置の方針：ラウンドのはじめに、その時点の順位・残りのキューブで、CPU全員の分を決めておく
  // （同じラウンドのCPUどうしの試合も、あなたの試合の結果を知らずに置く）
  function tourMakePlans(T, kind) {
    const by = {};
    for (const p of T.players) if (p.cpu) by[p.id] = AI.tourSetupPlan(T, p.id, kind);
    T.plans = { round: T.round, kind, by };
  }
  function tourPlanOf(T, id, kind) {
    if (!T.players[id].cpu) return null;
    const P = T.plans;
    if (P && P.round === T.round && P.kind === kind && P.by && P.by[id]) return P.by[id];
    return AI.tourSetupPlan(T, id, kind);
  }

  function startTour() {
    app.tour = TourE.create({});
    app.tourFx = { kind: 'intro' };
    app.game = null; app.ui = null; app.modal = null; app.busy = false;
    app.screen = 'tour';
    render(); window.scrollTo(0, 0);
    SND.sfx('tourStart');
  }

  // 自分の試合を始める（予選は今のラウンドの相手、決勝は決勝の相手）
  function tourStartMatch() {
    const T = app.tour;
    if (!T) return;
    if (T.stage === 'final-hub') {
      if (!T.finalChoice) { toast('先攻かドラフト先行権を選んでください', 'warn'); return; }
      const [f1, f2] = T.finalists;
      const opp = f1 === 0 ? f2 : f1;
      // 予選1位が「先攻」なら1位が先攻、「ドラフト先行権」なら1位が後攻（ドラフトは後攻から）
      const firstId = T.finalChoice === 'first' ? f1 : f2;
      T.stage = 'final';
      tourMakePlans(T, 'final');
      app.game = new E.Game(TourE.matchOpts(T, 0, opp, 'final', { mode: 'cpu', first: firstId === 0 ? 0 : 1, setupPlan: [null, tourPlanOf(T, opp, 'final')] }));
      beginMatchUI();
      vsSplash(0, opp, 'GRAND FINAL ・ 決勝');
      return;
    }
    const o = tourOpponent(T);
    T.stage = 'match';
    tourMakePlans(T, 'prelim');
    app.game = new E.Game(TourE.matchOpts(T, 0, o, 'prelim', { mode: 'cpu', setupPlan: [null, tourPlanOf(T, o, 'prelim')], itemKeep: [null, AI.tourItemKeep(T, o, 'prelim')] }));
    beginMatchUI();
    vsSplash(0, o, `PRELIMINARY ${T.round + 1} ・ 予選 第${T.round + 1}試合`);
  }

  // 試合の前の「VS」の幕（画面の描き直しに巻き込まれないよう body に置き、少しで消える）
  function vsSplash(a, b, label) {
    const old = document.querySelector('.vs-splash');
    if (old) old.remove();
    const el = document.createElement('div');
    el.className = 'vs-splash';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<div class="vs-band"><p class="eyebrow">${esc(label)}</p><div class="vs-row"><span class="vs-p l">${avatar(a)}<b>${tname(a)}</b></span><span class="vs-x">VS</span><span class="vs-p r"><b>${tname(b)}</b>${avatar(b)}</span></div></div>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2100);
    SND.sfx('start');
  }

  // CPUどうしの決勝（あなたが予選で敗退したとき）
  // 決勝の盤面は厚く、CPUどうしの1試合に数秒かかることがあるので、手番ごとに画面へ制御を返しながら進める
  async function tourSimFinal(T, onTurn) {
    const [f1, f2] = T.finalists;
    T.finalChoice = AI.tourChooseFirst(T, f1);
    const g = new E.Game(TourE.matchOpts(T, f1, f2, 'final', { first: T.finalChoice === 'first' ? 0 : 1, setupPlan: [tourPlanOf(T, f1, 'final'), tourPlanOf(T, f2, 'final')] }));
    for (const pi of [0, 1]) if (!g.players[pi].setupDone) { AI.setup(g, pi); g.finishSetup(pi); }
    while (g.phase === 'draft') { const pi = g.draftTurn(); g.draftPick(pi, AI.draftPick(g, pi)); }
    let guard = 0;
    while (g.phase === 'play' && guard++ < 600) {
      AI.playTurn(g, g.cur);
      if (onTurn) onTurn(g);
      await new Promise((r) => setTimeout(r, 0));
    }
    const res = TourE.apply(T, f1, f2, g, 'final');
    T.champion = res.winner >= 0 ? res.winner : (TourE.total(T.players[f1]) >= TourE.total(T.players[f2]) ? f1 : f2);
    return res;
  }

  // 自分の試合が終わったあと：結果を反映し、同じラウンドのCPUどうしの試合を進めて、大会の画面へ
  function tourAfterMatch() {
    const T = app.tour, g = G();
    if (!T || !g || g.phase !== 'over') return;
    const prev = tourRanks(T);
    if (T.stage === 'final') {
      const opp = T.finalists[0] === 0 ? T.finalists[1] : T.finalists[0];
      const res = TourE.apply(T, 0, opp, g, 'final');
      T.champion = res.winner >= 0 ? res.winner : (TourE.total(T.players[0]) >= TourE.total(T.players[opp]) ? 0 : opp);
      T.stage = 'done';
      app.tourFx = { kind: 'done', prev, results: [res] };
    } else if (T.stage === 'match') {
      const o = tourOpponent(T);
      const resH = TourE.apply(T, 0, o, g, 'prelim');
      const other = T.rounds[T.round].find((m) => m.indexOf(0) < 0);
      const sg = new E.Game(TourE.matchOpts(T, other[0], other[1], 'prelim', {
        setupPlan: [tourPlanOf(T, other[0], 'prelim'), tourPlanOf(T, other[1], 'prelim')],
        itemKeep: [AI.tourItemKeep(T, other[0], 'prelim'), AI.tourItemKeep(T, other[1], 'prelim')],
      }));
      AI.autoMatch(sg);
      const resC = TourE.apply(T, other[0], other[1], sg, 'prelim');
      if (T.round < ROUNDS - 1) {
        T.round += 1;
        T.stage = 'hub';
      } else {
        T.round = ROUNDS;
        T.prelimOrder = TourE.standings(T).map((x) => x.id);
        T.finalists = T.prelimOrder.slice(0, 2);
        T.stage = 'qualify';
      }
      app.tourFx = { kind: 'round', prev, results: [resH, resC] };
    } else return;
    app.game = null; app.ui = null;
    app.screen = 'tour';
    render(); window.scrollTo(0, 0);
  }

  // 予選で敗退したとき：CPUどうしの決勝を見届ける
  async function tourWatchFinal() {
    const T = app.tour;
    if (!T || app.busy) return;
    const prev = tourRanks(T);
    app.busy = true;
    app.tourSim = { turn: 0 };
    render();
    const btn = () => root.querySelector('[data-act="tour-next"]');
    const res = await tourSimFinal(T, (g) => { app.tourSim.turn = g.turn; const b = btn(); if (b) b.textContent = `決勝をシミュレーション中…（${g.turn}ターン目）`; });
    if (app.tour !== T) { app.tourSim = null; return; }   // 途中でやめたとき
    app.busy = false;
    app.tourSim = null;
    T.stage = 'done';
    app.tourFx = { kind: 'done', prev, results: [res] };
    render(); window.scrollTo(0, 0);
  }

  function tourEnterFinalHub() {
    const T = app.tour;
    const [f1, f2] = T.finalists;
    T.finalChoice = f1 === 0 ? null : AI.tourChooseFirst(T, f1);
    T.stage = 'final-hub';
    app.tourFx = { kind: 'final-hub' };
    render(); window.scrollTo(0, 0);
  }

  // ---- 表示 ----
  function stepsHTML(T) {
    const st = T.stage;
    const steps = [0, 1, 2].map((r) => {
      const done = T.results.some((x) => x.kind === 'prelim' && x.round === r && (x.a === 0 || x.b === 0));
      const cur = !done && T.round === r && (st === 'hub' || st === 'intro' || st === 'match');
      return `<li class="${done ? 'done' : cur ? 'cur' : ''}"><b>R${r + 1}</b><span>予選 第${r + 1}試合</span></li>`;
    });
    const fdone = st === 'done';
    const fcur = st === 'final-hub' || st === 'final';
    steps.push(`<li class="fin ${fdone ? 'done' : fcur ? 'cur' : ''}"><b>FINAL</b><span>決勝</span></li>`);
    return `<ol class="tour-steps">${steps.join('')}</ol>`;
  }

  function cubesHTML(p) {
    return `<div class="st-cubes" aria-label="残りのキューブ">${[2, 3, 4, 5].map((s) => cubePips(s, { on: p.stock[s] || 0 })).join('')}</div>`;
  }
  function itemsHTML(p) {
    return `<div class="st-items" aria-label="残りのアイテム">${ITEM_KEYS.map((k) => {
      const n = p.inv[k] || 0;
      return `<span class="si${n ? '' : ' none'}${k === 'bazooka' ? ' bz' : ''}" data-tip="${esc(ITEMS[k].name)}：${n ? `所持${n}` : '未所持'}">${ICON[k]}${n > 1 ? `<em>${n}</em>` : ''}</span>`;
    }).join('')}</div>`;
  }

  function standingsHTML(T, fx, opts) {
    opts = opts || {};
    const fresh = !T.results.length;
    const list = fresh ? T.players.map((p) => ({ id: p.id, total: TourE.total(p), rank: '—' })) : displayList(T);
    const prev = fx && fx.prev;
    const showLine = !fresh && (T.stage === 'hub' || T.stage === 'qualify');
    // 持ち点が同じ人と並んだときの決め手（勝ち数 → 撃破マス数 → 抽選）。大会の後は、優勝・準優勝の2人は決勝の結果で並ぶので比べない
    const comparable = (i, j) => !(T.stage === 'done' && (i < 2 || j < 2));
    const crit = (a, b) => { const pa = T.players[a], pb = T.players[b]; return pa.wins !== pb.wins ? '勝ち数' : pa.pts.take !== pb.pts.take ? '撃破マス数' : '抽選'; };
    const tieTag = (i) => {
      if (fresh) return '';
      const x = list[i];
      const notes = [i - 1, i + 1].filter((j) => list[j] && list[j].total === x.total && comparable(i, j))
        .map((j) => `${T.players[list[j].id].name}と同点・${crit(x.id, list[j].id)}で${j > i ? '上' : '下'}`);
      return notes.length ? `<span class="tie" data-tip="${esc(notes.join('／'))}">同点</span>` : '';
    };
    const rows = list.map((x, i) => {
      const p = T.players[x.id];
      const old = prev ? prev.ranks[x.id] : x.rank;
      const from = prev ? prev.totals[x.id] : x.total;
      const gain = x.total - from;
      const chg = old - x.rank;
      const isFin = T.finalists && T.finalists.indexOf(x.id) >= 0;
      const champ = T.champion === x.id;
      const rec = `${p.wins}勝${p.losses}敗${p.draws ? p.draws + '分' : ''}`;
      const q = p.pts;
      const bk = `はじめ${q.start}・撃破で奪った+${q.take}・奪われた−${q.taken}・勝利で奪った+${q.vicWon}・奪われた−${q.vicLost}${(q.spdWon | 0) ? `・スピードで奪った+${q.spdWon | 0}` : ''}${(q.spdLost | 0) ? `・スピードペナルティ−${q.spdLost | 0}` : ''}・宝石${p.gems | 0}つ（${(p.gems | 0) * TourE.GEM_PTS}点）`;
      const line = showLine && i === 2 ? '<div class="st-line" aria-hidden="true"><span>決勝ライン</span></div>' : '';
      return `${line}<div class="st-row${x.id === 0 ? ' me' : ''}${isFin ? ' fin' : ''}${champ ? ' champ' : ''}" style="--i:${i};--shift:${prev ? old - x.rank : 0}" data-id="${x.id}">
        <div class="st-rank"><b${prev && old !== x.rank ? ` data-rk="${x.rank}"` : ''}>${prev ? old : x.rank}</b>${prev && chg ? `<i class="chg ${chg > 0 ? 'up' : 'down'}">${chg > 0 ? '▲' : '▼'}${Math.abs(chg)}</i>` : ''}</div>
        <div class="st-name">${avatar(x.id)}<div><b>${esc(p.name)}</b><small>${TourE.persona(T, x.id) ? `${esc(TourE.PERSONAS[TourE.persona(T, x.id)].name)}・` : ''}${rec}${champ ? '・<span class="gold">優勝</span>' : isFin ? '・決勝' : ''}</small></div></div>
        <div class="st-pts" data-tip="${esc(bk)}"><b data-from="${from}" data-to="${x.total}">${prev ? from : x.total}</b><small>pt</small>${tieTag(i)}${prev && gain ? `<span class="gain ${gain > 0 ? 'up' : 'down'}">${gain > 0 ? '+' : ''}${gain}</span>` : ''}${gemsHTML(p.gems | 0, prev && prev.gems ? (p.gems | 0) - prev.gems[x.id] : 0)}</div>
        ${cubesHTML(p)}
        ${itemsHTML(p)}
      </div>`;
    }).join('');
    return `<section class="panel standings" aria-label="大会の順位">
      <h3 class="ptitle">順位表<small>STANDINGS</small></h3>
      <div class="st-head" aria-hidden="true"><span>順位</span><span>名前</span><span>持ち点</span><span>キューブ</span><span>アイテム</span></div>
      <div class="st-body">${rows}</div>
      <p class="note">持ち点は${TourE.START + TourE.GEMS * TourE.GEM_PTS}点（宝石${TourE.GEMS}つ・1つ${TourE.GEM_PTS}点を含む）で始め、撃破したマス数・勝利点（${vicText()}）・宝石（トレジャー）を相手から奪い合います。予選で早いターンに負けると、スピードペナルティ（${speedText()}）で減点されます（1pt＝1万円）。アイテムの数字は所持数。${T.stage === 'done' ? '順位は決勝の結果（優勝・準優勝）と予選の順位。' : T.stage === 'final-hub' ? '順位は予選の結果。' : '同点は勝ち数 → 撃破マス数 → 抽選の順。上位2名が決勝へ。'}</p>
    </section>`;
  }

  function matchCardHTML(T, r, sim) {
    const [pa, pb] = [r.a, r.b];
    const side = (id, k) => {
      const win = r.winner === id;
      const pt = r.pts[k];
      const sg = (n) => (n > 0 ? '+' + n : n < 0 ? '−' + -n : '±0');
      return `<div class="mc-p${win ? ' win' : ''}${id === 0 ? ' me' : ''}">${avatar(id)}<b>${tname(id)}</b><span class="mc-pt${pt.total < 0 ? ' minus' : ''}" data-tip="${esc(`撃破で奪った${sg(pt.take)}・奪われた${sg(-pt.taken)}・勝利${sg(pt.victory)}${pt.speed ? `・スピード${sg(pt.speed)}` : ''}・宝石${pt.gems ? sg(pt.gems) + 'つ' : '±0'}`)}">${sg(pt.total)}<small>pt</small></span>${win ? `<em>WIN${pt.victory ? ` +${pt.victory}` : ''}</em>` : ''}</div>`;
    };
    const label = r.kind === 'final' ? '決勝' : `予選 第${r.round + 1}試合`;
    const lost = (k) => r.lost[k].length ? `${r.lost[k].join('・')}マスを失う` : '失った個体なし';
    const sub = r.draw ? '引き分け' : `${tname(r.winner)}の勝ち・${r.turns}ターン`;
    return `<article class="mcard${sim ? ' sim' : ''}${r.a === 0 || r.b === 0 ? ' mine' : ''}">
      <p class="mc-h">${label}${sim ? '<span class="mc-tag">CPU同士・シミュレーション</span>' : ''}</p>
      <div class="mc-vs">${side(pa, 0)}<span class="vs">VS</span>${side(pb, 1)}</div>
      <p class="mc-sub">${esc(sub)}</p>
      <p class="mc-lost">${tname(pa)}：${lost(0)}／${tname(pb)}：${lost(1)}</p>
      ${r.replay ? `<button type="button" class="btn ghost mc-rp" data-act="replay-open" data-res="${T.results.indexOf(r)}">▶ リプレイ</button>` : ''}
      ${sim ? `<div class="mc-scan" aria-hidden="true"><span class="bar"></span><span class="tt">SIMULATING <b class="tturn" data-to="${r.turns}">T00</b></span></div>` : ''}
    </article>`;
  }

  // 試合の記録：大会のすべての試合（CPUどうしも）を、途中経過の画面からいつでもリプレイで見られる
  function historyHTML(T) {
    if (!T.results.length) return '';
    const rows = T.results.map((r, i) => {
      const lab = r.kind === 'final' ? '決勝' : `予選${r.round + 1}`;
      const res = r.draw ? '引き分け' : `${tname(r.winner)}の勝ち`;
      return `<li${r.a === 0 || r.b === 0 ? ' class="mine"' : ''}><span class="hl-r">${lab}</span><span class="hl-m">${tname(r.a)} vs ${tname(r.b)}</span><span class="hl-w">${res}・${r.turns}ターン</span>${r.replay ? `<button type="button" class="btn ghost hl-btn" data-act="replay-open" data-res="${i}">▶ リプレイ</button>` : '<span class="hl-w">—</span>'}</li>`;
    }).join('');
    return `<section class="panel history" aria-label="試合の記録"><h3 class="ptitle">試合の記録<small>REPLAY</small></h3><ol class="hl">${rows}</ol></section>`;
  }

  function renderTour() {
    const T = app.tour;
    const fx = app.tourFx && !app.tourFx.played ? app.tourFx : null;
    const fxAny = app.tourFx;
    const me = T.players[0];
    const myRank = TourE.rankOf(T, 0);
    let hero = '', results = '', extra = '', next = '';
    const lastRound = (r) => T.results.filter((x) => x.kind === 'prelim' && x.round === r);
    if (T.stage === 'intro') {
      hero = `<p class="eyebrow">SEARCH BATTLE TOURNAMENT</p>
        <h2 class="tour-title glitch-in">大会スタート</h2>
        <p class="tour-lede">4人の総当たりで予選を3試合（4×4）。持ち点の上位2名が決勝（5×5）へ進みます。持ち点は<b>${TourE.START + TourE.GEMS * TourE.GEM_PTS}点</b>（宝石${TourE.GEMS}つ・1つ${TourE.GEM_PTS}点を含む）から。撃破したキューブのマス数を相手から奪い、勝てばさらに <b>${vicText()}点</b>を奪います。予選で${TourE.SPEED.length - 1}ターン目までに負けると（トレジャーチャンスを使い切る前）、<b>スピードペナルティ</b>（1ターン目${TourE.SPEED[1]}点〜${TourE.SPEED.length - 1}ターン目${TourE.SPEED[TourE.SPEED.length - 1]}点）で持ち点が減ります（相手には渡りません）。トレジャーを見つけると相手の宝石を1つ奪えます。</p>
        <div class="entrants">${T.players.map((p, i) => {
          const pk = TourE.persona(T, p.id), ps = pk && TourE.PERSONAS[pk];
          return `<div class="ent" style="--i:${i}">${avatar(p.id)}<b>${esc(p.name)}</b>${ps ? `<em class="persona">${esc(ps.name)}</em><small>${esc(ps.desc)}</small>` : `<small>${p.cpu ? 'CPU' : 'プレイヤー'}</small>`}</div>`;
        }).join('')}</div>
        <ol class="schedule">${T.rounds.map((m, r) => `<li><b>第${r + 1}試合</b><span>${m.map(([a, b]) => `${tname(a)} vs ${tname(b)}`).join('　／　')}</span></li>`).join('')}</ol>`;
      next = `<button class="btn primary big" data-act="tour-next">第1試合へ（vs ${tname(tourOpponent(T))}）</button>`;
    } else if (T.stage === 'hub') {
      hero = `<p class="eyebrow">PRELIMINARY ${T.round} / ${ROUNDS} CLEAR</p>
        <h2 class="tour-title">予選 第${T.round}試合 終了</h2>
        <p class="tour-lede">いま <b class="rk">${myRank}位</b>（${TourE.total(me)}pt）。次は第${T.round + 1}試合、相手は <b>${tname(tourOpponent(T))}</b> です。</p>`;
      results = `<div class="mcards">${lastRound(T.round - 1).map((r) => matchCardHTML(T, r, r.a !== 0 && r.b !== 0)).join('')}</div>`;
      next = `<button class="btn primary big" data-act="tour-next">第${T.round + 1}試合へ（vs ${tname(tourOpponent(T))}）</button>`;
    } else if (T.stage === 'qualify') {
      const q = T.finalists.indexOf(0) >= 0;
      hero = q
        ? `<p class="eyebrow">QUALIFIED</p><h2 class="tour-title big-banner win">${myRank}位通過！</h2>
           <p class="tour-lede">決勝の相手は <b>${tname(T.finalists[0] === 0 ? T.finalists[1] : T.finalists[0])}</b>。${myRank === 1 ? '予選1位なので、先攻かドラフト先行権を選べます。' : '先攻・後攻は予選1位が選びます。'}</p>`
        : `<p class="eyebrow">ELIMINATED</p><h2 class="tour-title big-banner lose">${myRank}位で予選敗退…</h2>
           <p class="tour-lede">決勝は ${tname(T.finalists[0])} と ${tname(T.finalists[1])}。CPUどうしの決勝を見届けます。</p>`;
      results = `<div class="mcards">${lastRound(ROUNDS - 1).map((r) => matchCardHTML(T, r, r.a !== 0 && r.b !== 0)).join('')}</div>`;
      next = q
        ? '<button class="btn primary big" data-act="tour-next">決勝へ進む</button>'
        : (app.tourSim
          ? `<button class="btn primary big" data-act="tour-next" disabled>決勝をシミュレーション中…（${app.tourSim.turn}ターン目）</button>`
          : '<button class="btn primary big" data-act="tour-next">決勝を見届ける</button><button class="btn ghost" data-act="tour-end">メイン画面へ</button>');
    } else if (T.stage === 'final-hub') {
      const [f1, f2] = T.finalists;
      const opp = f1 === 0 ? f2 : f1;
      let choice;
      if (f1 === 0) {
        choice = `<div class="choice-btns" role="radiogroup" aria-label="決勝の先攻・後攻">
          <button type="button" class="choice${T.finalChoice === 'first' ? ' on' : ''}" data-act="tour-choose" data-v="first" aria-pressed="${T.finalChoice === 'first'}"><b>先攻</b><small>先にコールする</small></button>
          <button type="button" class="choice${T.finalChoice === 'draft' ? ' on' : ''}" data-act="tour-choose" data-v="draft" aria-pressed="${T.finalChoice === 'draft'}"><b>ドラフト先行権</b><small>後攻になり、ドラフトを先に取る</small></button>
        </div>`;
      } else {
        choice = `<p class="tour-lede">${tname(f1)}（予選1位）は<b>${T.finalChoice === 'first' ? '先攻' : 'ドラフト先行権'}</b>を選びました。あなたは${T.finalChoice === 'first' ? '後攻で、ドラフトを先に取ります' : '先攻です'}。</p>`;
      }
      hero = `<p class="eyebrow">GRAND FINAL</p><h2 class="tour-title">決勝 ${avatar(0)} あなた vs ${avatar(opp)} ${tname(opp)}</h2>
        <p class="tour-lede">5×5。予選の残りのアイテム＋ドラフト（9種類から4つずつ、後攻から）。全滅させた側が優勝し、賞金は優勝者の持ち点×1万円です。</p>
        ${choice}`;
      next = `<button class="btn primary big" data-act="tour-next" ${T.finalChoice ? '' : 'disabled'}>決勝を始める</button>`;
    } else if (T.stage === 'done') {
      const won = T.champion === 0;
      const inFinal = T.finalists.indexOf(0) >= 0;
      const prize = TourE.total(T.players[T.champion]);
      const place = displayList(T).find((x) => x.id === 0).rank;
      if (won) hero = `<p class="eyebrow">CHAMPION</p><h2 class="tour-title big-banner gold">優勝！</h2><p class="prize">賞金 <b data-from="0" data-to="${prize}">${fx ? 0 : prize}</b>万円</p>`;
      else if (inFinal) hero = `<p class="eyebrow">RUNNER-UP</p><h2 class="tour-title big-banner silver">準優勝</h2><p class="tour-lede">優勝は ${tname(T.champion)}（賞金 ${prize}万円）。</p>`;
      else hero = `<p class="eyebrow">CHAMPION</p><h2 class="tour-title big-banner gold" style="--bd:${fx ? '1.9s' : '0s'}">${avatar(T.champion)}${tname(T.champion)} 優勝</h2>
        <p class="tour-lede">賞金 ${prize}万円（持ち点×1万円）。あなたは ${place}位 でした。</p>`;
      const fr = T.results.find((x) => x.kind === 'final');
      results = fr ? `<div class="mcards one">${matchCardHTML(T, fr, !inFinal)}</div>` : '';
      next = '<button class="btn primary big" data-act="tour-end">メイン画面へ</button>';
    }
    const stats = `<span class="stat">大会<b>${T.stage === 'final-hub' || T.stage === 'final' || T.stage === 'done' ? 'FINAL' : `R${Math.min(T.round + 1, ROUNDS)}/${ROUNDS}`}</b></span><span class="stat me">あなた<b>${T.results.length ? myRank + '位・' : ''}${TourE.total(me)}pt</b></span>`;
    root.innerHTML = `
      <div class="wrap tour-screen${fx ? ' fx' : ''}">
        ${hudHTML(stats)}
        <section class="panel tour-hero">${hero}${stepsHTML(T)}</section>
        ${results}
        <div class="tour-grid${extra && T.stage !== 'qualify' ? '' : ' solo'}">
          ${standingsHTML(T, fx)}
          ${extra ? `<div class="tour-side">${extra}</div>` : ''}
        </div>
        ${historyHTML(T)}
        <div class="tour-next">${next}</div>
      </div>`;
    if (fx) { fx.played = true; tourAnimate(fx, T); }
  }

  // 数字を数え上げる・順位の入れ替わりを見せる・CPUどうしの試合を走らせる・決着の音
  function tourAnimate(fx, T) {
    const scr = root.querySelector('.tour-screen');
    if (!scr) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const sims = scr.querySelectorAll('.mcard.sim');
    const simMs = reduce ? 0 : 1700;
    sims.forEach((el) => {
      const tt = el.querySelector('.tturn');
      const to = tt ? +tt.dataset.to : 0;
      const t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / Math.max(1, simMs));
        if (tt) tt.textContent = 'T' + String(Math.round(to * k)).padStart(2, '0');
        if (k < 1) requestAnimationFrame(step); else el.classList.add('done');
      };
      requestAnimationFrame(step);
      if (!reduce) { let n = 0; const iv = setInterval(() => { if (n++ > 7 || !document.body.contains(el)) { clearInterval(iv); return; } SND.sfx('tick'); }, 200); }
    });
    const delay = sims.length ? simMs + 250 : 300;
    setTimeout(() => {
      if (!document.body.contains(scr)) return;
      scr.classList.add('counted');
      scr.querySelectorAll('[data-to]').forEach((b) => {
        if (b.classList.contains('tturn')) return;
        const from = +b.dataset.from, to = +b.dataset.to;
        if (from === to) return;
        const t0 = performance.now(), dur = reduce ? 0 : 900;
        const step = (now) => {
          const k = Math.min(1, (now - t0) / Math.max(1, dur));
          b.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
          if (k < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      // 点数を数え終わってから、順位を新しい並びへスライドする（v12.14の後。それまではスライドが先で、点数の増減が後だった）
      setTimeout(() => {
        if (!document.body.contains(scr)) return;
        scr.classList.add('slid');
        scr.querySelectorAll('.st-rank b[data-rk]').forEach((b) => { b.textContent = b.dataset.rk; });
        if (fx.kind === 'round' && T.stage === 'qualify') SND.sfx(T.finalists.indexOf(0) >= 0 ? 'qualify' : 'eliminated');
        else if (fx.kind === 'done') SND.sfx(T.champion === 0 ? 'champion' : T.finalists.indexOf(0) >= 0 ? 'eliminated' : 'rankUp');
        else if (fx.kind === 'round') SND.sfx('rankUp');
      }, reduce ? 0 : 1100);
    }, delay);
  }

  // ---------------- 描画 ----------------
  // タイトルの立方体から伸びる光を、傾けた4×4の盤の中心に当てる（盤は3Dで傾けているので、マスの見た目の位置から中心を求める）
  function aimTitleBeam() {
    const v = document.querySelector('.visual'); if (!v) return;
    const beam = v.querySelector('.beamv'), cube = v.querySelector('.cube3d'), cells = v.querySelectorAll('.cells .cell');
    if (!beam || !cube || !cells.length) return;
    const vr = v.getBoundingClientRect();
    let x = 0, y = 0;
    for (const c of cells) { const r = c.getBoundingClientRect(); x += r.left + r.width / 2; y += r.top + r.height / 2; }
    // 画面全体を拡大・縮小しているとき（fitScreen）、測った位置は拡大後の値なので、拡大前の値に直してから使う
    const z = parseFloat(root.style.zoom) || 1;
    x = (x / cells.length - vr.left) / z; y = (y / cells.length - vr.top) / z;
    const top = cube.offsetTop + cube.offsetHeight + 6;
    cube.style.left = x + 'px';
    beam.style.left = x + 'px'; beam.style.top = top + 'px'; beam.style.height = Math.max(0, y - top) + 'px';
  }
  // 画面全体の縦の大きさを、ウインドウの高さにぎりぎり収まるように拡大・縮小する（幅900px以上。スマホは今までどおりスクロール）。
  // 画面が変わったときとウインドウの大きさが変わったときに測り直す（同じ画面の中では大きさを保ち、手番ごとに伸び縮みしないように）。
  // シミュレーターは長い表の画面なので、縮めずにスクロールする
  const FIT_MIN = 0.55, FIT_MAX = 1.4;
  let fitKey = '';
  function fitScreen(force) {
    const T = app.tour;
    const on = window.innerWidth >= 900 && app.screen !== 'sim';
    document.documentElement.classList.toggle('fit', on);
    if (!on) { root.style.zoom = ''; fitKey = ''; return; }
    // 試合の決着（phase の変化）では測り直さない（決着した瞬間に画面の大きさが変わっていた）
    const key = [app.replay ? 'replay' : app.screen, T ? T.stage + T.round : '', app.tourFx ? app.tourFx.kind : '', window.innerWidth, window.innerHeight].join(':');
    if (!force && key === fitKey) return;
    fitKey = key;
    let z = 1;
    root.style.zoom = '1';
    for (let i = 0; i < 6; i++) {
      const h = root.getBoundingClientRect().height / z;
      let nz = Math.max(FIT_MIN, Math.min(FIT_MAX, (window.innerHeight - 4) / h));
      if (Math.abs(nz - z) < 0.004) break;
      z = nz; root.style.zoom = String(z);
      // 横にはみ出すなら少し戻す
      if (document.documentElement.scrollWidth > window.innerWidth + 1) { z = Math.max(FIT_MIN, z * window.innerWidth / document.documentElement.scrollWidth); root.style.zoom = String(z); }
    }
  }
  function afterRender() {
    fitScreen(false);
    if (app.screen === 'title' && !app.replay) aimTitleBeam();
  }
  window.addEventListener('resize', () => { fitScreen(true); if (app.screen === 'title') aimTitleBeam(); });
  function render() {
    hideTip();
    if (app.replay) { renderReplay(); afterRender(); return; }
    if (app.screen === 'title') renderTitle();
    else if (app.screen === 'setup') renderSetup();
    else if (app.screen === 'draft') renderDraft();
    else if (app.screen === 'battle') renderBattle();
    else if (app.screen === 'tour') renderTour();
    else if (app.screen === 'sim') renderSim();
    else if (app.screen === 'lobby') renderLobby();
    if (app.modal === 'rules') root.insertAdjacentHTML('beforeend', rulesModal());
    if (app.modal === 'quit') root.insertAdjacentHTML('beforeend', quitModal());
    if (app.modal === 'net-quit') root.insertAdjacentHTML('beforeend', netQuitModal());
    applyPreview();
    syncMusic();
    afterRender();
  }

  // BGM：タイトル〜配置〜ドラフトは静かな曲、対戦中は対戦曲（終盤は激しくなる）。
  // 決着したら、最後の演出で勝敗のジングルを鳴らしてから静かな曲に戻る。
  // 曲の変化は公開された情報（ターン数）だけで決める（残り個体数などが音で漏れないように）
  function syncMusic() {
    const g = G();
    if (app.screen === 'battle' && g) {
      if (g.phase === 'play') SND.scene('battle', g.turn >= g.rules.lateTurn ? 2 : 1);
      else if (SND.current() !== 'battle') SND.scene('result');
      return;
    }
    SND.scene('title');
  }

  function previewCells() {
    const g = G();
    if (!g || app.hover < 0) return null;
    const N = g.N;
    if (app.screen === 'setup') {
      const S = app.setup;
      if (!S.key || S.treasureMode) return null;
      if (g.pieceAt(S.pi, app.hover)) return null;
      const a = anchorFor(S.key, S.t, app.hover, N);
      if (!a) return null;
      const chk = g.checkPlacement(S.pi, S.key, S.t, a.r0, a.c0);
      const cells = chk.cells || cellsFor(S.key, S.t, a.r0, a.c0, N);
      return { cells: cells || [], ok: chk.ok && g.stockLeft(S.pi, SHAPES[S.key].size) > 0 };
    }
    if (app.screen === 'battle' && effMode() === 'warp-place') {
      const w = app.ui.warp;
      const p = g.players[viewer()].pieces.find((x) => x.id === w.pieceId);
      if (!p) return null;
      const a = anchorFor(p.shape, w.t, app.hover, N);
      if (!a) return null;
      const val = g.validateItem(viewer(), 'warp', { pieceId: p.id, t: w.t, r0: a.r0, c0: a.c0 });
      return { cells: cellsFor(p.shape, w.t, a.r0, a.c0, N) || [], ok: val.ok };
    }
    return null;
  }
  function applyPreview() {
    root.querySelectorAll('.cell.pv-ok, .cell.pv-bad').forEach((el) => el.classList.remove('pv-ok', 'pv-bad'));
    const pv = previewCells();
    if (!pv) return;
    for (const c of pv.cells) {
      const el = root.querySelector(`[data-board="own"] .cell[data-cell="${c}"]`);
      if (el) el.classList.add(pv.ok ? 'pv-ok' : 'pv-bad');
    }
  }
  // サーチラインの列・行ラベルに触れたら、その列・行を光らせる
  function highlightLine(btn) {
    root.querySelectorAll('.cell.line-hl').forEach((el) => el.classList.remove('line-hl'));
    if (!btn || !G()) return;
    const N = G().N, i = +btn.dataset.index, line = btn.dataset.line;
    for (let k = 0; k < N; k++) {
      const c = line === 'row' ? i * N + k : k * N + i;
      const el = root.querySelector(`[data-board="pred"] .cell[data-cell="${c}"]`);
      if (el) el.classList.add('line-hl');
    }
  }

  // ---------------- 演出 ----------------
  const FX = (function () {
    const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const CY = '#4FE3FF', MG = '#FF3F8F', OR = '#FF7A3D', AM = '#FFC14A', ST = '#A3AEC0', WH = '#FFFFFF';
    const METAL = ['#F3F7FC', '#B8C3D4', '#6E7A8F', '#D3DCE8'];
    let cv = null, cx = null, dpr = 1, raf = 0;
    const parts = [];
    const rnd = (a, b) => a + Math.random() * (b - a);

    function canvas() {
      if (cv) return;
      cv = document.createElement('canvas');
      cv.className = 'fx-canvas';
      cv.setAttribute('aria-hidden', 'true');
      document.body.appendChild(cv);
      cx = cv.getContext('2d');
      size();
      window.addEventListener('resize', size);
    }
    // 描画用の画素数は画面の拡大率に合わせ、表示する大きさは常にウィンドウと同じにする
    // （大きさを指定しないと、高解像度や拡大表示でキャンバスが倍の大きさで表示され、演出が右下にずれる）
    function size() {
      if (!cv) return;
      dpr = Math.min(3, window.devicePixelRatio || 1);
      cv.style.width = window.innerWidth + 'px';
      cv.style.height = window.innerHeight + 'px';
      cv.width = Math.round(window.innerWidth * dpr);
      cv.height = Math.round(window.innerHeight * dpr);
    }
    function spawn(p) {
      if (reduce) return;
      canvas();
      p.t0 = performance.now() + (p.delay || 0);
      parts.push(p);
      if (!raf) raf = requestAnimationFrame(tick);
    }
    function tick(now) {
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      cx.globalCompositeOperation = 'lighter';
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        const el = now - p.t0;
        if (el < 0) continue;
        const t = el / p.life;
        if (t >= 1) { parts.splice(i, 1); continue; }
        draw(p, t, el / 1000);
      }
      cx.globalCompositeOperation = 'source-over';
      cx.globalAlpha = 1;
      raf = parts.length ? requestAnimationFrame(tick) : 0;
      if (!raf) cx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
    function draw(p, t, s) {
      const a = 1 - t;
      switch (p.k) {
        case 'spark': {
          const x = p.x + p.vx * s, y = p.y + p.vy * s + 300 * (p.g || 0) * s * s;
          cx.globalAlpha = a; cx.strokeStyle = p.c; cx.lineWidth = p.w;
          cx.beginPath(); cx.moveTo(x, y); cx.lineTo(x - p.vx * 0.045, y - p.vy * 0.045); cx.stroke();
          break;
        }
        case 'shard': {
          const x = p.x + p.vx * s, y = p.y + p.vy * s + 560 * s * s;
          cx.save(); cx.translate(x, y); cx.rotate(p.r + p.vr * s);
          cx.globalAlpha = a; cx.fillStyle = p.c;
          cx.beginPath(); cx.moveTo(-p.z, -p.z * 0.6); cx.lineTo(p.z, -p.z * 0.2); cx.lineTo(-p.z * 0.2, p.z); cx.closePath(); cx.fill();
          cx.restore();
          break;
        }
        case 'pixel': {
          cx.globalAlpha = a; cx.fillStyle = p.c;
          cx.fillRect(p.x + p.vx * s, p.y + p.vy * s, p.z, p.z);
          break;
        }
        case 'ring': {
          const e = 1 - Math.pow(1 - t, 3);
          cx.globalAlpha = a; cx.strokeStyle = p.c; cx.lineWidth = Math.max(0.5, p.w * (1 - t * 0.6));
          cx.beginPath(); cx.arc(p.x, p.y, p.r0 + (p.r1 - p.r0) * e, 0, Math.PI * 2); cx.stroke();
          break;
        }
        case 'beam': {
          const grow = Math.min(1, t * 3.2);
          const ex = p.x + (p.x2 - p.x) * grow, ey = p.y + (p.y2 - p.y) * grow;
          const al = t < 0.7 ? 1 : (1 - t) / 0.3;
          cx.lineCap = 'round'; cx.strokeStyle = p.c;
          const seg = (x1, y1, x2, y2) => {
            cx.globalAlpha = al * 0.22; cx.lineWidth = 9; cx.beginPath(); cx.moveTo(x1, y1); cx.lineTo(x2, y2); cx.stroke();
            cx.globalAlpha = al; cx.lineWidth = 2.6; cx.beginPath(); cx.moveTo(x1, y1); cx.lineTo(x2, y2); cx.stroke();
          };
          if (p.broken && grow >= 1) {
            const mx = (p.x + p.x2) / 2, my = (p.y + p.y2) / 2, dx = (p.x2 - p.x) * 0.09, dy = (p.y2 - p.y) * 0.09;
            const jit = (Math.random() - 0.5) * 3;
            seg(p.x, p.y, mx - dx + jit, my - dy - jit);
            seg(mx + dx - jit, my + dy + jit, p.x2, p.y2);
          } else seg(p.x, p.y, ex, ey);
          break;
        }
        case 'streak': {
          const kk = Math.min(1, t / 0.6);
          const hx = p.x + (p.x2 - p.x) * kk, hy = p.y + (p.y2 - p.y) * kk;
          const tl = Math.max(0, kk - 0.3);
          const tx = p.x + (p.x2 - p.x) * tl, ty = p.y + (p.y2 - p.y) * tl;
          const al = kk < 1 ? 1 : a * 2;
          const gr = cx.createLinearGradient(tx, ty, hx, hy);
          gr.addColorStop(0, 'rgba(255,63,143,0)'); gr.addColorStop(1, p.c);
          cx.globalAlpha = Math.min(1, al); cx.strokeStyle = gr; cx.lineWidth = 6; cx.lineCap = 'round';
          cx.beginPath(); cx.moveTo(tx, ty); cx.lineTo(hx, hy); cx.stroke();
          cx.fillStyle = WH; cx.beginPath(); cx.arc(hx, hy, 6, 0, Math.PI * 2); cx.fill();
          break;
        }
        case 'glyph': {
          cx.globalAlpha = a; cx.fillStyle = p.c;
          cx.font = `700 ${p.z}px "Share Tech Mono", monospace`;
          cx.fillText(p.ch, p.x, p.y + p.vy * s);
          break;
        }
      }
    }
    function sparks(x, y, c, n, sp, g, delay) {
      for (let i = 0; i < n; i++) {
        const an = Math.random() * Math.PI * 2, v = rnd(70, 280) * (sp || 1);
        spawn({ k: 'spark', x, y, vx: Math.cos(an) * v, vy: Math.sin(an) * v, c, life: rnd(380, 720), w: rnd(1, 2.4), g: g || 0, delay });
      }
    }
    function shards(x, y, cols, n, spread, delay) {
      for (let i = 0; i < n; i++) {
        const an = rnd(-Math.PI, 0) + rnd(-0.4, 0.4), v = rnd(120, 430);
        spawn({ k: 'shard', x: x + rnd(-spread, spread), y: y + rnd(-spread, spread), vx: Math.cos(an) * v, vy: Math.sin(an) * v - 80,
          r: rnd(0, 6), vr: rnd(-14, 14), z: rnd(3, 8), c: cols[i % cols.length], life: rnd(750, 1250), delay });
      }
    }
    function pixels(r, c, n) {
      for (let i = 0; i < n; i++) spawn({ k: 'pixel', x: r.left + Math.random() * r.width, y: r.top + Math.random() * r.height, vx: rnd(-24, 24), vy: rnd(-150, -40), z: rnd(2, 4.5), c, life: rnd(500, 1050) });
    }
    function ring(x, y, c, r0, r1, life, w, delay) { spawn({ k: 'ring', x, y, c, r0, r1, life, w: w || 2, delay }); }
    function beam(x, y, x2, y2, c, life, broken, delay) { spawn({ k: 'beam', x, y, x2, y2, c, life, broken, delay }); }
    function streak(x, y, x2, y2, c, life) { spawn({ k: 'streak', x, y, x2, y2, c, life }); }
    function glyphs(x, y, list, c) {
      for (let i = 0; i < 16; i++) spawn({ k: 'glyph', x: x + rnd(-46, 40), y: y - rnd(10, 70), vy: rnd(40, 120), z: rnd(10, 15), ch: list[i % list.length], c, life: rnd(700, 1200), delay: rnd(0, 250) });
    }

    // 音の左右：自分フィールドは左、相手フィールドは右
    function panOf(owner, v) { return owner === v ? -0.35 : 0.35; }
    const fxRoot = () => (app.replay ? replayEl : root);
    function boardOf(owner) {
      const v = viewer();
      return fxRoot().querySelector(`.board[data-board="${owner === v ? 'own' : 'pred'}"] .cells`);
    }
    function cellOf(owner, c) {
      const v = viewer();
      return fxRoot().querySelector(`.board[data-board="${owner === v ? 'own' : 'pred'}"] .cell[data-cell="${c}"]`);
    }
    function ctr(el) { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, r }; }
    function over(el, cls, html, ms) {
      if (!el) return null;
      const d = document.createElement('div');
      d.className = 'fxo ' + cls;
      if (html) d.innerHTML = html;
      el.appendChild(d);
      setTimeout(() => d.remove(), ms);
      return d;
    }
    function bover(el, cls, html, ms, vars) {
      if (!el) return null;
      const d = document.createElement('div');
      d.className = 'fxb ' + cls;
      if (html) d.innerHTML = html;
      if (vars) for (const k in vars) d.style.setProperty(k, vars[k]);
      el.appendChild(d);
      setTimeout(() => d.remove(), ms);
      return d;
    }
    function text(x, y, s, cls, ms) {
      if (!fxLayer) return;
      const d = document.createElement('div');
      d.className = 'fx-text ' + (cls || '');
      d.textContent = s;
      d.style.left = Math.max(60, Math.min(window.innerWidth - 60, x)) + 'px';
      d.style.top = Math.max(30, y) + 'px';
      fxLayer.appendChild(d);
      setTimeout(() => d.remove(), ms || 1700);
    }
    function banner(big, small, cls, ms) {
      if (!fxLayer) return;
      const d = document.createElement('div');
      d.className = 'fx-banner ' + (cls || '');
      d.innerHTML = `<b>${esc(big)}</b>${small ? `<span>${esc(small)}</span>` : ''}`;
      fxLayer.appendChild(d);
      setTimeout(() => d.remove(), ms || 1150);
    }
    function shake(n) {
      if (reduce) return;
      const el = fxRoot();
      el.classList.remove('shake-1', 'shake-2');
      void el.offsetWidth;
      el.classList.add('shake-' + n);
      setTimeout(() => el.classList.remove('shake-' + n), 650);
    }

    function playItem(ev, v, k) {
      const g = G();
      const mine = ev.actor === v;
      const c = mine ? CY : MG;
      const ecls = mine ? '' : ' enemy';
      const target = 1 - ev.actor;
      const tb = boardOf(target), ab = boardOf(ev.actor);
      const tbc = tb ? ctr(tb) : null;
      const selfItem = isDef(ev.key);
      const pan = { pan: panOf(selfItem ? ev.actor : target, v) };
      const anchor = selfItem ? (ab ? ctr(ab) : null) : tbc;
      if (anchor) text(anchor.x, anchor.r.top - 12, `${mine ? '' : g.players[ev.actor].name + '：'}${ITEMS[ev.key].name}`, 'item' + ecls, 1500);
      switch (ev.key) {
        case 'cube': {
          SND.sfx('i-cube', 0, pan);
          SND.sfx(ev.n ? 'readout' : 'none', 0.7 * k, Object.assign({ n: ev.n }, pan));
          if (!tb) return 0;
          // 面の距離（立方体の半分）は CSS のコンテナ単位で決める（画面全体を拡大・縮小していても面がずれない）
          bover(tb, 'holo' + ecls, '<div class="holo-cube"><i></i><i></i><i></i><i></i><i></i><i></i></div>', 1550);
          const what = ev.kind === 'cat' ? ev.value : ev.value + 'マス';
          setTimeout(() => text(tbc.x, tbc.y + tbc.h * 0.32, `${what}：残り ${ev.n} 体`, 'count' + ecls, 1600), 700 * k);
          return 1650 * k;
        }
        case 'line': {
          SND.sfx('i-line', 0, pan);
          SND.sfx(ev.n ? 'readout' : 'none', 0.64 * k, Object.assign({ n: ev.n }, pan));
          if (!tb) return 0;
          bover(tb, `scan ${ev.line}${ecls}`, '<div class="bar"></div>', 1200, { '--i': ev.index, '--n': g.N });
          const pos = (ev.index + 0.5) / g.N;
          const x = ev.line === 'col' ? tbc.r.left + tbc.w * pos : tbc.x;
          const y = ev.line === 'row' ? tbc.r.top + tbc.h * pos : tbc.y;
          setTimeout(() => text(x, y, `${E.lineLabel(ev.line, ev.index)}：残り ${ev.k != null ? ev.k + ' 個体 / ' : ''}${ev.n} マス`, 'count' + ecls, 1500), 640 * k);
          return 1500 * k;
        }
        case 'shape': {
          SND.sfx('i-target', 0, pan);
          SND.sfx(ev.cat ? 'found' : 'none', 0.48 * k, pan);
          const el = cellOf(target, ev.cell);
          if (!el) return 0;
          const p = ctr(el);
          over(el, 'reticle' + ecls, RETICLE_SVG, 950);
          ring(p.x, p.y, c, p.w * 1.1, p.w * 0.25, 650, 2);
          setTimeout(() => text(p.x, p.y - p.h * 0.62, ev.cat || 'NoData', ev.cat ? 'count' + ecls : 'miss', 1400), 480 * k);
          return 1200 * k;
        }
        case 'number': {
          SND.sfx('i-target', 0, pan);
          SND.sfx(ev.size ? 'readout' : 'none', 0.48 * k, Object.assign({ n: ev.size }, pan));
          const el = cellOf(target, ev.cell);
          if (!el) return 0;
          const p = ctr(el);
          over(el, 'reticle' + ecls, RETICLE_SVG, 950);
          ring(p.x, p.y, c, p.w * 0.25, p.w * 1.2, 700, 2);
          ring(p.x, p.y, c, p.w * 0.25, p.w * 0.9, 600, 1.5, 180);
          glyphs(p.x, p.y, ev.size ? [String(ev.size), '#'] : ['N', 'D', '0'], c);
          setTimeout(() => text(p.x, p.y - p.h * 0.62, ev.size ? `${ev.size}マス` : 'NoData', ev.size ? 'count' + ecls : 'miss', 1400), 480 * k);
          return 1250 * k;
        }
        case 'pair': {
          SND.sfx('i-pair', 0, pan);
          SND.sfx(ev.same ? 'same' : 'notsame', 0.52 * k, pan);
          const a = cellOf(target, ev.a), b = cellOf(target, ev.b);
          if (!a || !b) return 0;
          const pa = ctr(a), pb = ctr(b);
          over(a, 'reticle' + ecls, RETICLE_SVG, 950);
          over(b, 'reticle' + ecls, RETICLE_SVG, 950);
          beam(pa.x, pa.y, pb.x, pb.y, ev.same ? c : MG, 1150, !ev.same, 220);
          if (!ev.same) sparks((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, MG, 16, 0.9, 0, 520);
          setTimeout(() => text((pa.x + pb.x) / 2, (pa.y + pb.y) / 2 - 20, ev.same ? 'SAME' : 'NOT SAME', ev.same ? 'count' + ecls : 'bad', 1400), 520 * k);
          return 1350 * k;
        }
        case 'node': {
          SND.sfx('i-node', 0, Object.assign({ n: ev.k }, pan));
          SND.sfx(ev.k == null ? 'none' : 'readout', 0.6 * k, Object.assign({ n: ev.k || 1 }, pan));
          const el = cellOf(target, ev.cell);
          if (!el) return 0;
          const p = ctr(el);
          over(el, 'reticle' + ecls, RETICLE_SVG, 950);
          // 上下左右へ走査の線をのばす
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) beam(p.x, p.y, p.x + dx * p.w * 1.15, p.y + dy * p.h * 1.15, c, 700, false, 120);
          ring(p.x, p.y, c, p.w * 0.2, p.w * 0.9, 640, 1.5, 200);
          setTimeout(() => text(p.x, p.y - p.h * 0.62, ev.k == null ? 'NoData' : `つながり ${ev.k}`, ev.k == null ? 'miss' : 'count' + ecls, 1500), 560 * k);
          return 1300 * k;
        }
        case 'bazooka': {
          // 発射 → 着弾 → ヒット済みのマスが砕ける。持ち主には、分解された破片のひび割れも見せる
          SND.sfx('i-bazooka', 0, Object.assign({ hit: ev.hit, n: (ev.killed || []).length }, pan));
          const el = cellOf(target, ev.cell);
          if (!el) return 0;
          const p = ctr(el);
          const from = ab ? ctr(ab) : null;
          if (from) streak(from.x, from.y, p.x, p.y, AM, 620);
          setTimeout(() => {
            over(el, 'impact', '', 520);
            ring(p.x, p.y, WH, 6, p.w * 1.6, 800, 4);
            ring(p.x, p.y, AM, 6, p.w * 1.1, 700, 3, 90);
            sparks(p.x, p.y, AM, 30, 1.6, 0.4);
            if (!ev.hit) { text(p.x, p.y - p.h * 0.62, 'NoData', 'miss', 1400); return; }
            shake(2);
            text(p.x, p.y - p.h * 0.62, 'BREAK', 'kill', 1500);
            for (const cc of (ev.killed || [])) {
              const ce = cellOf(target, cc);
              if (!ce) continue;
              const q = ctr(ce);
              over(ce, 'flash', '', 520);
              shards(q.x, q.y, [METAL[0], METAL[1], METAL[2], AM], 10, q.w * 0.3);
            }
            if (ev.killed && ev.killed.length) setTimeout(() => text(p.x, p.y + p.h * 0.1, `ヒット済み ${ev.killed.length}マス撃破`, 'sub', 1500), 200);
            if (ev.owner === v && ev.ownerPriv) for (const cc of ev.ownerPriv.frags) { const ce = cellOf(target, cc); if (ce) over(ce, 'crack', '', 900); }
          }, 560 * k);
          return 1650 * k;
        }
        case 'warp': {
          SND.sfx('i-warp', 0, pan);
          const owner = ev.actor;
          let sx = 0, sy = 0, n = 0;
          for (const cc of ev.oldCells) {
            const el = cellOf(owner, cc);
            if (!el) continue;
            const p = ctr(el);
            sx += p.x; sy += p.y; n++;
            over(el, 'dissolve', '', 950);
            pixels(p.r, c, 24);
          }
          if (n) { ring(sx / n, sy / n, c, 6, 80, 820, 3); text(sx / n, sy / n, 'WARP', 'count' + ecls, 1300); }
          if ((mine || app.replay) && ev.priv) {
            for (const cc of ev.priv.newCells) {
              const el = cellOf(owner, cc);
              if (!el) continue;
              el.classList.add('materialize');
              const p = ctr(el);
              sparks(p.x, p.y, CY, 8, 0.8, 0, 380);
            }
          }
          return 1300 * k;
        }
        case 'stealth': {
          SND.sfx('i-stealth', 0, pan);
          const owner = ev.actor;
          const b = boardOf(owner);
          if (!b) return 0;
          const bc = ctr(b);
          if (mine && ev.priv) {
            // 自分のキューブに光学迷彩をかける
            for (const cc of ev.priv.cells) { const el = cellOf(owner, cc); if (el) { over(el, 'cloak', '', 1200); const p = ctr(el); pixels(p.r, CY, 10); } }
          } else {
            // 相手には場所を見せない
            bover(b, 'cloakfield', '', 1200);
          }
          text(bc.x, bc.r.top + 22, 'STEALTH', 'count' + ecls, 1400);
          return 1200 * k;
        }
      }
      return 0;
    }

    function play(ev) {
      const g = G();
      if (!g || (app.screen !== 'battle' && !app.replay)) return 0;
      const v = viewer();
      const k = speedK();
      const mine = ev.actor === v;
      // あなた対相手の見せ方（YOUR TURN・VICTORY など）：CPU戦・大会・オンライン対戦。リプレイでは、0番があなたで1番がCPUの試合だけ。
      //  me＝あなたの席（オンライン対戦のゲストは1。ほかは0）
      const vsCPU = app.replay ? (!g.players[0].isCPU && g.players[1].isCPU) : oneSide();
      const me = v;
      const col = (who) => (who === v ? CY : MG);
      switch (ev.type) {
        case 'start':
          SND.sfx('start');
          banner('BATTLE START', `先攻：${g.players[ev.first].name}`, '', 1300);
          return 1000 * k;
        case 'turn': {
          if (g.phase !== 'play') return 0;
          SND.sfx(vsCPU && ev.cur !== me ? 'turnFoe' : 'turnMine', 0, { alt: !vsCPU && ev.cur === 1 });
          // ターン数も出す（例：YOUR TURN 05・5ターン目）
          const tn = ev.turn != null ? ev.turn : g.turn;
          if (vsCPU) banner(`${ev.cur === me ? 'YOUR TURN' : 'ENEMY TURN'} ${pad2(tn)}`, `${tn}ターン目・${ev.cur === me ? 'あなたの手番' : `${g.players[ev.cur].name}の手番`}`, ev.cur === me ? '' : 'enemy', 1050);
          else banner(`P${ev.cur + 1} TURN ${pad2(tn)}`, `${tn}ターン目・${g.players[ev.cur].name}の手番`, ev.cur === 0 ? '' : 'enemy', 1050);
          return 760 * k;
        }
        case 'tchance': {
          if (g.phase !== 'play') return 0;
          SND.sfx('tchance');
          const cnt = ev.max ? `（残り${ev.left}回／全${ev.max}回）` : '';
          const sub = mine && !app.replay ? `相手フィールドのマスを1つ選んでください${cnt}` : `${g.players[ev.actor].name}のトレジャーチャンス${cnt}`;
          banner('TREASURE CHANCE', sub, 'treasure', 1250);
          return 900 * k;
        }
        case 'tfail': {
          SND.sfx('tfail', 0, { pan: panOf(1 - ev.actor, v) });
          const b = boardOf(1 - ev.actor);
          if (!b) return 0;
          const bc = ctr(b);
          text(bc.x, bc.y, mine ? 'TREASURE 失敗' : `${g.players[ev.actor].name}：TREASURE 失敗`, 'miss', 1500);
          return 700 * k;
        }
        case 'shield': {
          // ステルスが自動撃破を防いだ。持ち主にだけ見せる（攻めた側には何も伝えない）
          if (ev.owner !== v) return 0;
          SND.sfx('shield', 0, { pan: panOf(ev.owner, v) });
          const els = ev.cells.map((c) => cellOf(ev.owner, c)).filter(Boolean);
          if (!els.length) return 0;
          let sx = 0, sy = 0;
          for (const el of els) { const p = ctr(el); sx += p.x; sy += p.y; over(el, 'cloak', '', 1100); }
          ring(sx / els.length, sy / els.length, CY, 8, 70 + els.length * 18, 900, 3);
          text(sx / els.length, sy / els.length, 'STEALTH GUARD', 'count', 1500);
          return 1000 * k;
        }
        case 'call': {
          SND.sfx(ev.r === 'x' ? 'miss' : ev.r === 'o' ? 'hit' : 'first', 0, { pan: panOf(ev.owner, v) });
          const el = cellOf(ev.owner, ev.c);
          if (!el) return 0;
          const p = ctr(el);
          if (ev.r === 'x') {
            over(el, 'ripple', '', 800);
            sparks(p.x, p.y, ST, 5, 0.5);
            text(p.x, p.y - p.h * 0.55, 'NO HIT', 'miss', 1200);
            return 650 * k;
          }
          if (ev.r === 'o') {
            over(el, 'impact', '', 520);
            sparks(p.x, p.y, OR, 18, 1.1, 0.6);
            ring(p.x, p.y, OR, p.w * 0.2, p.w * 0.95, 540, 2);
            text(p.x, p.y - p.h * 0.6, 'HIT', 'hit');
            shake(1);
            return 760 * k;
          }
          over(el, 'lock', LOCK_SVG, 900);
          ring(p.x, p.y, MG, p.w * 0.1, p.w * 1.4, 760, 3);
          ring(p.x, p.y, MG, p.w * 0.1, p.w * 1.0, 640, 1.5, 160);
          sparks(p.x, p.y, MG, 24, 1.2, 0.3);
          text(p.x, p.y - p.h * 0.62, `FIRST HIT ◎${ev.num}`, 'first', 1500);
          shake(1);
          return 950 * k;
        }
        case 'destroy': {
          // バズーカで砕けたヒット済みのマスは、バズーカの演出でまとめて見せる
          if (ev.cause === 'bazooka') return 0;
          SND.sfx('destroy', 0, { pan: panOf(ev.owner, v), big: ev.size >= 4, penalty: ev.cause === 'answerFail' });
          const els = ev.cells.map((c) => cellOf(ev.owner, c)).filter(Boolean);
          if (!els.length) return 0;
          const tint = ev.owner === v ? CY : MG;
          let sx = 0, sy = 0;
          els.forEach((el, i) => {
            const p = ctr(el);
            sx += p.x; sy += p.y;
            over(el, 'flash', '', 520);
            shards(p.x, p.y, [METAL[0], METAL[1], METAL[2], tint], 10, p.w * 0.3, i * 45);
            sparks(p.x, p.y, WH, 8, 1.4, 0.5, i * 45);
          });
          const mx = sx / els.length, my = sy / els.length;
          ring(mx, my, tint, 8, 60 + els.length * 26, 900, 4);
          ring(mx, my, WH, 4, 40 + els.length * 18, 600, 2, 120);
          const label = ev.cause === 'answerFail' ? 'PENALTY' : 'DESTROYED';
          text(mx, my, label, 'kill', 1600);
          text(mx, my + 34, ev.size === 1 ? '1マスキューブ撃破' : `${ev.size}マス撃破`, 'sub', 1600);
          shake(ev.size >= 4 ? 2 : 1);
          return 1250 * k;
        }
        case 'answer': {
          SND.sfx(ev.success ? 'answerOK' : 'answerNG', 0, { pan: panOf(ev.owner, v), n: ev.cells.length });
          const els = ev.cells.map((c) => cellOf(ev.owner, c)).filter(Boolean);
          if (!els.length) return 0;
          const b = boardOf(ev.owner);
          const bc = b ? ctr(b) : null;
          if (ev.success) {
            els.forEach((el, i) => {
              const p = ctr(el);
              if (bc) beam(bc.r.left + bc.w / 2, bc.r.top - 24, p.x, p.y, col(ev.actor), 560, false, i * 50);
              over(el, 'reticle' + (mine ? '' : ' enemy'), RETICLE_SVG, 750);
            });
            if (bc) text(bc.x, bc.r.top + 22, 'ANSWER!', 'count' + (mine ? '' : ' enemy'), 1200);
            return 650 * k;
          }
          els.forEach((el) => over(el, 'glitch', '', 950));
          if (bc) text(bc.x, bc.y, 'ANSWER FAILED', 'bad', 1500);
          shake(1);
          return 1000 * k;
        }
        case 'treasure': {
          SND.sfx(ev.r === 'H' ? 'tH' : ev.r === 'N' ? 'tN' : 'tX', 0, { pan: panOf(ev.owner, v) });
          const el = cellOf(ev.owner, ev.c);
          if (!el) return 0;
          const p = ctr(el);
          if (ev.r === 'H') {
            sparks(p.x, p.y, AM, 40, 1.6, 0.2);
            ring(p.x, p.y, AM, 4, p.w * 2.2, 1000, 4);
            ring(p.x, p.y, WH, 4, p.w * 1.2, 600, 2, 150);
            text(p.x, p.y - p.h * 0.6, G().treasurePts ? `TREASURE +${G().treasurePts}` : 'TREASURE', 'gold', 1800);
            return 1200 * k;
          }
          if (ev.r === 'N') {
            ring(p.x, p.y, CY, 4, p.w * 1.6, 800, 2);
            ring(p.x, p.y, CY, 4, p.w * 1.6, 800, 2, 220);
            text(p.x, p.y - p.h * 0.6, 'NEAR', 'near');
            return 800 * k;
          }
          sparks(p.x, p.y, ST, 4, 0.4);
          text(p.x, p.y - p.h * 0.6, 'NO TREASURE', 'miss', 1200);
          return 600 * k;
        }
        case 'item':
          return playItem(ev, v, k);
        case 'over': {
          const r = ev.result;
          let big, small, cls = '';
          if (r.draw) { big = 'DRAW'; small = '両者全滅'; }
          else if (vsCPU) { big = r.winner === me ? 'VICTORY' : 'DEFEAT'; small = r.winner === me ? 'あなたの勝ち' : `${g.players[r.winner].name}の勝ち`; cls = r.winner === me ? '' : 'enemy'; }
          else { big = 'WINNER'; small = `${g.players[r.winner].name}の勝ち`; }
          SND.result(r.draw ? 'draw' : vsCPU && r.winner !== me ? 'lose' : 'win');
          banner(big, small, cls, 1700);
          if (!cls) { const w = window.innerWidth / 2, h = window.innerHeight * 0.38; sparks(w, h, CY, 50, 2.2, 0.3); sparks(w, h, AM, 30, 1.8, 0.4); }
          return 1500 * k;
        }
      }
      return 0;
    }
    return { play };
  })();

  // 新しいイベントの演出を順番に再生する
  function playFx() {
    app.fxChain = app.fxChain.then(async () => {
      const g = G();
      if (!g) return;
      const evs = g.events.slice(app.fxSeen);
      app.fxSeen = g.events.length;
      for (const ev of evs) {
        let d = 0;
        try { d = FX.play(ev); } catch (e) { d = 0; }
        if (d) await sleep(d);
      }
    }).catch(() => {});
    return app.fxChain;
  }

  // ---------------- リプレイ（v12.9） ----------------
  // 試合の操作の記録をやり直して、どの場面の盤面も再現する。両者の個体をすべて見せ、
  // 個体ごとに「相手がその時点の情報で置き方を言い当てられる確率」（CPUの推理と同じ計算。目安）を添える
  const rpRng = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  function openReplay(rec, title) {
    if (!rec || rec.v !== E.VERSION || !rec.actions) { toast('この試合のリプレイは、今のバージョンでは再生できません'); return; }
    let tl;
    try { tl = E.replayFrames(rec); } catch (e) { console.warn('replay failed', e); toast('リプレイを再生できませんでした'); return; }
    if (!tl.frames.length) { toast('リプレイの記録がありません'); return; }
    // ログの行 → その行が出た場面
    const logFrame = tl.final.log.map((e, i) => { let f = 0; while (f < tl.frames.length - 1 && tl.frames[f].log <= i) f++; return f; });
    hideTip();
    app.replay = { rec, title, frames: tl.frames, logFrame, pos: 0, game: E.replayGame(rec, tl.frames[0].n), prob: {}, unit: 'act', playing: false, animating: false, token: 0 };
    document.body.classList.add('replaying');
    replayEl.hidden = false;
    replayEl.innerHTML = replaySkeleton();
    replayEl.scrollTop = 0;
    replayStartWorker(app.replay);
    renderReplay();
    const pb = replayEl.querySelector('[data-act="rp-play"]');
    if (pb) pb.focus();
  }
  function closeReplay() {
    const R = app.replay;
    if (!R) return;
    R.playing = false; R.token++;
    if (R.worker) { try { R.worker.terminate(); } catch (e) { /* なにもしない */ } R.worker = null; }
    app.replay = null;
    replayEl.hidden = true;
    replayEl.innerHTML = '';
    document.body.classList.remove('replaying');
    render();
  }
  function replaySkeleton() {
    const R = app.replay;
    return `<div class="panel rp" role="dialog" aria-modal="true" aria-labelledby="rp-h">
      <div class="rp-head">
        <div><p class="eyebrow">REPLAY</p><h2 id="rp-h">${esc(R.title)}</h2></div>
        <button type="button" class="btn ghost rp-close" data-act="rp-close" aria-label="リプレイを閉じる">✕</button>
      </div>
      <p class="rp-now" id="rp-now" aria-live="polite"></p>
      <div class="rp-main">
        <div class="rp-logwrap rp-side0"><h3 class="rp-lh" id="rp-lh0"></h3><div class="rp-logbox"><ol class="rp-log" id="rp-log0" aria-label="ログ"></ol></div></div>
        <div class="fields rp-fields" id="rp-stage"></div>
        <div class="rp-logwrap rp-side1 foe"><h3 class="rp-lh" id="rp-lh1"></h3><div class="rp-logbox"><ol class="rp-log" id="rp-log1" aria-label="ログ"></ol></div></div>
      </div>
      <p class="note" id="rp-note"></p>
      <div class="rp-ctrl">
        <button type="button" class="btn ghost" data-act="rp-first" aria-label="最初の場面へ">⏮</button>
        <button type="button" class="btn ghost" data-act="rp-prev" aria-label="戻る">◀</button>
        <button type="button" class="btn primary" data-act="rp-play">▶ 自動再生</button>
        <button type="button" class="btn ghost" data-act="rp-next" aria-label="進む">▶</button>
        <button type="button" class="btn ghost" data-act="rp-last" aria-label="最後の場面へ">⏭</button>
        <span class="rp-unit" role="group" aria-label="進め方"><button type="button" data-act="rp-unit" data-v="act">1手</button><button type="button" data-act="rp-unit" data-v="turn">手番</button></span>
        <input class="rp-range" type="range" min="0" max="${R.frames.length - 1}" value="0" step="1" aria-label="場面">
        <span class="rp-count" id="rp-count"></span>
      </div>
    </div>`;
  }
  // 個体ごとの「言い当てられる確率」：相手（攻める側）の推論で、その個体の本当の置き方の重み。確定なら1、◎のない個体は0
  // 引数だけで動く（Web Worker でも、この関数の文字列をそのまま使う）。mkRng()：場面ごとに決まった乱数を作る
  function replayProbsCore(g, AI, mkRng) {
    return [0, 1].map((k) => {
      const m = {};
      let A = null;
      try { A = AI.analyze(g.players[1 - k].kb, g.N, mkRng()); } catch (e) { A = null; }
      const sure = new Set(A ? A.certain.map((c) => c.cand.mask) : []);
      for (const p of g.players[k].pieces) {
        if (!p.alive) continue;
        if (!A) { m[p.id] = 0; continue; }
        if (sure.has(p.mask)) { m[p.id] = 1; continue; }
        let val = 0;
        A.ctx.groups.forEach((gr, i) => {
          if (p.cells.indexOf(gr.c) < 0) return;
          let tot = 0, hit = 0;
          gr.cands.forEach((cd, j) => { const w = A.joint.total > 0 ? A.joint.candW[i][j] : cd.w; tot += w; if (cd.mask === p.mask) hit += w; });
          if (tot > 0) val = Math.max(val, hit / tot);
        });
        m[p.id] = val;
      }
      return m;
    });
  }  function replayProbs(g) { return replayProbsCore(g, AI, () => rpRng(4099 + g.clock)); }
  // 全場面の確率を、別のスレッド（Web Worker）で先に計算しておく（画面や演出を止めずに、「…」をなるべく出さないように）。
  // いまの場面から先へ、次に前へと、まだ計算していない場面を1つずつ頼む（場面を移ったら、その近くから）。作れなければ、これまでどおりこの画面で計算する
  let rpWorkerURL = null;
  function rpMakeWorkerURL() {
    if (rpWorkerURL) return rpWorkerURL;
    const code = ['src-engine', 'src-ai'].map((id) => document.getElementById(id).textContent).join('\n;\n') + `
;var rpRng = ${rpRng.toString()};
var probsCore = ${replayProbsCore.toString()};
var REC = null;
self.onmessage = function (e) {
  var d = e.data;
  if (d.rec) { REC = d.rec; return; }
  var p = null;
  try { var g = SBEngine.replayGame(REC, d.n); p = probsCore(g, SBAI, function () { return rpRng(4099 + g.clock); }); } catch (err) { p = null; }
  self.postMessage({ f: d.f, p: p });
};`;
    rpWorkerURL = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    return rpWorkerURL;
  }
  function rpNextMissing(R) {
    const ok = (f) => !R.prob[f] && !(R.probFail && R.probFail[f]);
    for (let f = R.pos; f < R.frames.length; f++) if (ok(f)) return f;
    for (let f = R.pos - 1; f >= 0; f--) if (ok(f)) return f;
    return -1;
  }
  function replayStartWorker(R) {
    let url = null, w = null;
    try { url = rpMakeWorkerURL(); w = new Worker(url); } catch (e) { w = null; }
    if (!w) return;
    R.worker = w; R.probFail = {};
    const feed = () => {
      if (app.replay !== R || R.worker !== w) return;
      const f = rpNextMissing(R);
      if (f < 0) { w.terminate(); R.worker = null; return; }
      w.postMessage({ f, n: R.frames[f].n });
    };
    w.onmessage = (ev) => {
      const d = ev.data;
      if (app.replay !== R || R.worker !== w) return;
      if (d.p) { if (!R.prob[d.f]) R.prob[d.f] = d.p; } else R.probFail[d.f] = true;
      if (d.f === R.pos) replayUpdatePcts();
      feed();
    };
    w.onerror = (ev) => {
      if (ev && ev.preventDefault) ev.preventDefault();
      try { w.terminate(); } catch (e) { /* なにもしない */ }
      if (R.worker === w) { R.worker = null; if (app.replay === R && !R.animating) renderReplay(); }
    };
    w.postMessage({ rec: R.rec });
    feed();
  }
  // いまの場面の確率。まだなら、いちばん近い場面の値を薄く出す（stale）
  function rpProbFor(R) {
    if (R.prob[R.pos]) return { prob: R.prob[R.pos], stale: false };
    for (let d = 1; d < R.frames.length; d++) {
      if (R.prob[R.pos - d]) return { prob: R.prob[R.pos - d], stale: true };
      if (R.prob[R.pos + d]) return { prob: R.prob[R.pos + d], stale: true };
    }
    return { prob: null, stale: false };
  }
  // 確率のラベルだけを描き直す（演出の途中でも、盤や演出を消さずに）
  function replayUpdatePcts() {
    const R = app.replay;
    if (!R) return;
    const { prob, stale } = rpProbFor(R);
    document.querySelectorAll('#rp-stage .rp-field').forEach((fe, k) => {
      const el = fe.querySelector('.rp-pcts');
      if (el) el.outerHTML = pctOverlay(R.game, k, prob && prob[k], stale);
    });
  }

  // 確率のラベル：個体の重心（重心が個体の外なら、いちばん近いマスの中心）
  function pctOverlay(g, k, m, stale) {
    const N = g.N;
    let h = '';
    for (const p of g.players[k].pieces) {
      if (!p.alive) continue;
      let x = 0, y = 0;
      for (const c of p.cells) { x += (c % N) + 0.5; y += Math.floor(c / N) + 0.5; }
      x /= p.cells.length; y /= p.cells.length;
      if (p.cells.indexOf(Math.min(N - 1, Math.floor(y)) * N + Math.min(N - 1, Math.floor(x))) < 0) {
        let bd = Infinity;
        for (const c of p.cells) { const cx = (c % N) + 0.5, cy = Math.floor(c / N) + 0.5, d = (cx - x) ** 2 + (cy - y) ** 2; if (d < bd) { bd = d; x = cx; y = cy; } }
      }
      const v = m ? m[p.id] : null;
      const sure = v != null && v >= 0.9995;
      const txt = v == null ? '…' : sure ? '確定' : `${(v * 100).toFixed(1)}%`;
      h += `<span class="rp-pct${sure ? ' sure' : ''}${v == null || stale ? ' wait' : ''}" style="left:${(x / N * 100).toFixed(2)}%;top:${(y / N * 100).toFixed(2)}%">${txt}</span>`;
    }
    return `<div class="rp-pcts" aria-hidden="true">${h}</div>`;
  }
  // ワープした場面：移動前の位置を点線で残す（どこへ移ったかは演出で見せる）
  function warpOverlay(g, fr, prevEv) {
    if (fr.start || fr.m !== 'useItem' || fr.key !== 'warp') return null;
    const ev = g.events.slice(prevEv, fr.ev).find((e) => e.type === 'item' && e.key === 'warp');
    if (!ev || !ev.oldCells || !ev.priv) return null;
    const N = g.N;
    const rects = ev.oldCells.map((c) => `<rect x="${(c % N) + 0.06}" y="${Math.floor(c / N) + 0.06}" width=".88" height=".88" rx=".06"/>`).join('');
    return { owner: ev.actor, svg: `<svg class="rp-warp" viewBox="0 0 ${N} ${N}" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>` };
  }
  function renderReplay() {
    const R = app.replay;
    if (!R) return;
    if (!replayEl.querySelector('.rp')) replayEl.innerHTML = replaySkeleton();
    const g = R.game, fr = R.frames[R.pos];
    const { prob, stale } = rpProbFor(R);
    const prevEv = R.pos > 0 ? R.frames[R.pos - 1].ev : 0;
    const prevLog = R.pos > 0 ? R.frames[R.pos - 1].log : Math.max(0, fr.log - 1);
    // いまの場面（その操作で出たログ）
    const lines = g.log.slice(prevLog, fr.log).map((e) => esc(e.priv || e.text));
    const nowEl = document.getElementById('rp-now');
    nowEl.className = 'rp-now' + (!fr.start && fr.actor === 1 ? ' foe' : '');
    nowEl.innerHTML = `<b>${fr.start ? '開始' : `${fr.turn}ターン目`}</b>${lines.join('<br>') || '&nbsp;'}`;
    // 盤面：左＝0番のフィールド、右＝1番のフィールド。コールした場面は、コールされたマスを光らせる
    const warp = warpOverlay(g, fr, prevEv);
    const target = !fr.start && fr.m === 'call' ? 1 - fr.actor : -1;
    const field = (k) => {
      const ov = pctOverlay(g, k, prob && prob[k], stale) + (warp && warp.owner === k ? warp.svg : '');
      const intel = intelFor(1 - k, k);
      const board = ownBoard(k, { kind: k === 0 ? 'own' : 'pred', intel, flash: target === k, overlay: ov });
      const atk = g.players[1 - k].name, def = g.players[k].name;
      const tone = (pi) => (pi === 0 ? 'mine' : 'enemy');
      const chips = `<div class="chiprow">${chipGroup(1 - k, ATK_ITEMS, false, 'atk', `${atk}の攻撃`, tone(1 - k))}${chipGroup(k, DEF_ITEMS, false, 'def', `${def}の防御`, tone(k))}</div>`;
      const cubes = `<div class="rp-cubes"><span class="hr-cap">所持キューブ</span>${heldCubes(g.players[k], false)}</div>`;
      return `<section class="panel ${k === 0 ? 'own' : 'enemy'} rp-field"><div class="fhead"><b>${esc(def)}のフィールド</b><span class="rp-left">残り${g.living(k).length}体</span></div>${chips}${intelTagsHTML(intel, k === 1)}${board}${cubes}</section>`;
    };
    document.getElementById('rp-stage').innerHTML = field(0) + field(1);
    document.getElementById('rp-note').textContent = '数字＝相手がこの時点の情報で、そのキューブの置き方を言い当てられる確率（目安。◎のないキューブは0%）。';
    // ログ：いまの場面まで。対戦画面と同じく、左＝相手（1番）、右＝あなた（0番）のアクションに分ける（誰のでもない行は両方に薄く出す）。いまの場面の行を強調
    for (const k of [0, 1]) {
      document.getElementById('rp-lh' + k).textContent = `${g.players[k].name}のアクション`;
      const logEl = document.getElementById('rp-log' + k);
      // 新しいアクションを上に（対戦画面と同じ）。表示している場面までのログなので、いまの場面の行がいちばん上に来る
      logEl.innerHTML = g.log.map((e, i) => [e, i]).reverse().map(([e, i]) => {
        if (e.actor != null && e.actor !== k) return '';
        const cls = [R.logFrame[i] === R.pos ? 'cur' : '', e.actor == null ? 'sys' : ''].filter(Boolean).join(' ');
        return `<li data-act="rp-jump" data-f="${R.logFrame[i]}"${cls ? ` class="${cls}"` : ''}${hlAttrs(e, 0, g.N)}><span class="t">T${e.turn}</span>${esc(e.priv || e.text)}</li>`;
      }).join('') || '<li class="none">まだありません</li>';
      const cur = logEl.querySelector('li.cur');
      logEl.scrollTop = cur ? Math.max(0, cur.offsetTop - 6) : 0;
    }
    // 操作の欄
    const range = replayEl.querySelector('.rp-range');
    if (range && +range.value !== R.pos) range.value = R.pos;
    document.getElementById('rp-count').textContent = `${R.pos + 1} / ${R.frames.length}`;
    const pb = replayEl.querySelector('[data-act="rp-play"]');
    if (pb) pb.textContent = R.playing ? '❚❚ 停止' : '▶ 自動再生';
    replayEl.querySelectorAll('[data-act="rp-unit"]').forEach((b) => { b.classList.toggle('on', b.dataset.v === R.unit); b.setAttribute('aria-pressed', b.dataset.v === R.unit); });
    if (!R.prob[R.pos] && !R.animating && !R.worker) replayScheduleProb(R.pos);
  }
  function replayScheduleProb(pos) {
    const R = app.replay;
    if (!R || R.prob[pos] || R.pendingProb === pos) return;
    R.pendingProb = pos;
    nextPaint().then(() => {
      if (app.replay !== R) return;
      R.pendingProb = null;
      if (R.pos !== pos || R.prob[pos] || R.animating) return;
      R.prob[pos] = replayProbs(R.game);
      renderReplay();
    });
  }
  const rpTurnNext = (R) => { for (let f = R.pos + 1; f < R.frames.length; f++) if (R.frames[f].end) return f; return R.frames.length - 1; };
  const rpTurnPrev = (R) => { for (let f = R.pos - 1; f > 0; f--) if (R.frames[f].end) return f; return 0; };
  const rpTurnPrevFrom = (R, at) => { for (let f = at - 1; f > 0; f--) if (R.frames[f].end) return f; return 0; };
  // 場面を移る。進むとき（animate）は1場面ずつ、盤面を出してからその操作の演出を流す
  async function replayGo(target, animate) {
    const R = app.replay;
    if (!R) return;
    target = Math.max(0, Math.min(R.frames.length - 1, target));
    // 戻るときも演出を見せる：1つ前の区切り（1手なら1つ前の場面、手番なら前の手番の区切り）へ移ってから、target まで進めて見せる
    if (animate && target < R.pos) {
      const start = target <= 0 ? -1 : R.unit === 'turn' ? rpTurnPrevFrom(R, target) : target - 1;
      if (start < 0) animate = false;
      else { R.token++; R.animating = false; R.pos = start; R.game = E.replayGame(R.rec, R.frames[start].n); }
    }
    if (!animate || target <= R.pos) {
      R.token++; R.animating = false;
      R.pos = target;
      R.game = E.replayGame(R.rec, R.frames[target].n);
      renderReplay();
      return;
    }
    const token = ++R.token;
    while (R.pos < target && app.replay === R && R.token === token) {
      const from = R.frames[R.pos];
      R.pos++;
      R.game = E.replayGame(R.rec, R.frames[R.pos].n);
      R.animating = true;
      renderReplay();
      const evs = R.game.events.slice(from.ev, R.frames[R.pos].ev);
      for (const ev of evs) {
        if (app.replay !== R || R.token !== token) break;
        let d = 0;
        try { d = FX.play(ev); } catch (e) { d = 0; }
        if (d) await sleep(d);
      }
      if (app.replay !== R) return;
      R.animating = false;
      if (R.token !== token) return;
      if (!R.prob[R.pos] && !R.worker) { await nextPaint(); if (app.replay !== R || R.token !== token) return; R.prob[R.pos] = replayProbs(R.game); }
      renderReplay();
    }
  }
  async function replayAutoplay() {
    const R = app.replay;
    if (!R) return;
    if (R.playing) { R.playing = false; R.token++; R.animating = false; renderReplay(); return; }
    if (R.pos >= R.frames.length - 1) await replayGo(0, false);
    R.playing = true;
    renderReplay();
    while (R.playing && app.replay === R && R.pos < R.frames.length - 1) {
      await replayGo(R.unit === 'turn' ? rpTurnNext(R) : R.pos + 1, true);
      if (!R.playing || app.replay !== R) break;
      await pause(0.6);
    }
    R.playing = false;
    if (app.replay === R) renderReplay();
  }
  function replayAct(act, el) {
    const R = app.replay;
    if (!R) return;
    if (act === 'rp-close') { closeReplay(); SND.sfx('close'); return; }
    if (act === 'rp-play') { SND.sfx('ui'); replayAutoplay(); return; }
    if (act === 'rp-unit') { R.unit = el.dataset.v === 'turn' ? 'turn' : 'act'; renderReplay(); SND.sfx('tick'); return; }
    if (R.playing) { R.playing = false; R.token++; }
    if (act === 'rp-first') replayGo(0, false);
    else if (act === 'rp-last') replayGo(R.frames.length - 1, false);
    else if (act === 'rp-prev') replayGo(R.unit === 'turn' ? rpTurnPrev(R) : R.pos - 1, true);
    else if (act === 'rp-next') replayGo(R.unit === 'turn' ? rpTurnNext(R) : R.pos + 1, true);
    else if (act === 'rp-jump') replayGo(+el.dataset.f, false);
  }
  replayEl.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || !replayEl.contains(el) || el.disabled || !app.replay) return;
    if (el.dataset.act.indexOf('rp-') !== 0) return;   // 盤のマスなど、リプレイの操作でないものは何もしない
    replayAct(el.dataset.act, el);
  });
  replayEl.addEventListener('input', (ev) => {
    const R = app.replay;
    if (!R || !ev.target.classList.contains('rp-range')) return;
    if (R.playing) R.playing = false;
    replayGo(+ev.target.value, false);
  });
  replayEl.addEventListener('pointerover', (ev) => { const t = ev.target.closest('[data-tip]'); if (t) showTip(t, ev.pointerType === 'touch'); });
  replayEl.addEventListener('pointerout', (ev) => { const t = ev.target.closest('[data-tip]'); if (t && !(ev.relatedTarget && t.contains(ev.relatedTarget)) && ev.pointerType !== 'touch') hideTip(); });

  // ---------------- 進行 ----------------
  // memo：プレイヤーごとの相手フィールドのメモ（{ マス: 'x'|'o'|'t' }）。memoType＝右クリックで付ける種類、memoMode＝タップでメモする状態
  function freshUI() { return { mode: null, item: null, sel: [], warp: null, bannerIdx: null, showResult: false, showResultDone: false, reveal: false, lastViewer: 0, memo: {}, memoType: 'x', memoMode: false }; }

  function startGame() {
    const s = app.settings;
    if (s.rules === 'tour') { startTour(); return; }
    if (s.mode === 'online') { openLobby(); return; }   // オンライン対戦は、部屋を作る・入る画面から
    app.tour = null;
    const cpu = s.mode === 'cpu';
    app.game = new E.Game({
      rules: s.rules, mode: s.mode, label: 'バトル', names: cpu ? ['あなた', 'CPU'] : ['プレイヤー1', 'プレイヤー2'], cpu: [false, cpu],
      items: itemsForMatch(), draftEach: s.items === 'draft' ? s.draftN : 0,
    });
    beginMatchUI();
  }
  // 試合の画面（配置から）を始める。CPUの配置はすぐ済ませる
  // 配置の最初に選んでおく形（置けるキューブのうち、いちばん小さいもの）
  function firstShape(pi) {
    const g = G();
    for (const size of [2, 3, 4, 5]) if (g.stockLeft(pi, size) > 0) { const k = SHAPES_BY_SIZE[size].find((x) => E.placements(g.N)[x].length > 0); if (k) return k; }
    return null;
  }
  function beginMatchUI() {
    app.ui = freshUI();
    const pi = app.net ? app.net.seat : 0;   // オンライン対戦のゲストは1番の席に置く
    app.setup = { pi, key: firstShape(pi), t: 0, treasureMode: false };
    app.busy = false;
    app.hover = -1;
    app.fxSeen = 0;
    app.fxChain = Promise.resolve();
    if (isCPUMode()) { AI.setup(app.game, 1); app.game.finishSetup(1); }
    app.screen = 'setup';
    render();
    window.scrollTo(0, 0);
  }

  function enterAfterSetup() {
    const g = G();
    if (g.phase === 'draft') { app.screen = 'draft'; render(); runDraftCPU(); return; }
    if (g.phase === 'play') enterBattle();
  }
  function enterBattle() {
    app.screen = 'battle';
    app.ui = freshUI();
    setBanner();
    render();
    window.scrollTo(0, 0);
    playFx();
    kick();
  }

  // スネーク順ではCPUが続けて取ることがあるので、CPUの番が続くあいだ取り続ける
  async function runDraftCPU() {
    const g = G();
    if (!isCPUMode() || g.phase !== 'draft' || app.busy) return;
    if (g.draftTurn() !== 1) return;
    app.busy = true; render();
    while (g.phase === 'draft' && g.draftTurn() === 1 && app.game === g) {
      await pause();
      g.draftPick(1, AI.draftPick(g, 1));
      SND.sfx('pickFoe');
      if (g.phase === 'draft') render();
    }
    app.busy = false;
    if (app.game !== g) return;
    if (g.phase === 'play') { enterBattle(); return; }
    render();
  }

  // CPUの手番を、演出を見せながら段階的に進める
  async function cpuRun() {
    const g = G();
    if (!isCPUMode() || app.busy || g.phase !== 'play' || g.cur !== 1) return;
    app.busy = true;
    resetMode();
    render();
    const cpu = 1;
    const step = async (mult) => { setBanner(); render(); await playFx(); await pause(mult); };
    const useItemStage = async (stage) => {
      const it = AI.chooseItem(g, cpu, stage);
      if (!it) return 'none';
      const r = g.useItem(cpu, it.key, it.params);
      if (r.ok) await step(0.5);
      return 'used';
    };
    const answers = async () => {
      let guard = 0;
      while (g.sub === 'answer' && guard++ < 10) {
        const cells = AI.chooseAnswer(g, cpu);
        if (!cells) break;
        g.answer(cpu, cells);
        await step(0.5);
        if (g.phase !== 'play') return;
        if (g.sub === 'sacrifice') { g.sacrifice(cpu, AI.chooseSacrifice(g, cpu)); await step(0.5); return; }
      }
    };
    try {
      await app.fxChain;
      await pause(0.45);
      while (g.phase === 'play' && g.cur === cpu && app.game === g) {
        const sig = `${g.clock}/${g.sub}/${g.turn}/${g.cur}`;
        if (g.sub === 'sacrifice' && g.pending && g.pending.who === cpu) {
          g.sacrifice(cpu, AI.chooseSacrifice(g, cpu));
          await step(0.5);
          continue;
        }
        if (g.sub === 'item') {
          await useItemStage('pre');
          if (g.phase !== 'play') break;
        }
        if ((g.sub === 'item' || g.sub === 'call') && !g.hasCallable(cpu)) { g.skipCall(cpu); await step(0.3); }
        if (g.sub === 'item' || g.sub === 'call') {
          g.call(cpu, AI.chooseCall(g, cpu));
          await step(0.5);
          if (g.phase !== 'play') break;
        }
        await answers();
        if (g.phase !== 'play') break;
        if (g.sub === 'answer' && !g.itemUsed) {
          const r = await useItemStage('post');
          if (g.phase !== 'play') break;
          if (r === 'used') { await answers(); if (g.phase !== 'play') break; }
        }
        if (g.sub === 'answer') g.endTurn(cpu);
        if (g.sub === 'treasure' && g.cur === cpu) {
          await step(0.3);
          g.treasureCall(cpu, AI.chooseTreasure(g, cpu));
          await step(0.4);
        }
        // 進まない状態に入ったら抜ける（画面側で人の操作を待つ）
        if (sig === `${g.clock}/${g.sub}/${g.turn}/${g.cur}`) { console.warn('CPU: no progress in', g.sub); break; }
      }
    } catch (e) {
      console.error(e);
      toast('CPUの処理でエラーが起きました', 'warn');
    }
    if (app.game !== g) return;
    app.busy = false;
    setBanner();
    render();
    playFx();
    if (g.phase === 'over') onGameOver();
  }

  function kick() {
    const g = G();
    if (g && g.phase === 'play' && isCPUMode() && g.cur === 1 && !app.busy) cpuRun();
    if (g && g.phase === 'over') onGameOver();
  }

  // 演出が終わってから結果を出す
  function onGameOver() {
    if (app.ui.showResultDone) return;
    app.ui.showResultDone = true;
    resetMode();
    app.toast = null; renderToast();
    const g = G();
    app.fxChain.then(() => sleep(350)).then(() => {
      if (app.game !== g || app.screen !== 'battle') return;
      app.ui.showResult = true;
      render();
    });
  }

  // 操作の窓口：人の操作で盤面を変えるときは、ルールのプログラム（engine）を直接呼ばずに、すべてここを通す。
  //  ・ふつうの試合・大会：その場で実行する（今までと同じ）
  //  ・オンライン対戦のホスト：実行してから、ゲストに新しい状態を送る（net.js の Host.run）
  //  ・オンライン対戦のゲスト：配置はこの端末の中だけで行い、対戦中の操作はホストに送る。
  //    結果はあとで state として届くので、ここでは「送った」（{ ok: true, sent: true }）を返す
  //  args の先頭は操作する人の席（g.call(v, c) なら act('call', v, c)）
  function act(name, ...args) {
    const g = G(), N = app.net;
    if (N && N.role === 'host') return N.host.run(name, args);
    if (N && N.role === 'guest' && NET.PLAY_ACTS.indexOf(name) >= 0) {
      const pre = guestPrecheck(g, name, args);
      if (!pre.ok) return pre;
      const r = N.guest.act(name, args.slice(1));   // 席の番号は送らない（ホストがゲストの席として実行する）
      if (r.sent) render();   // 「送信しています…」を出して、結果が届くまで操作できないようにする
      return r;
    }
    return g[name].apply(g, args);
  }
  // ゲストの手元でも確かめられること（自分の盤と自分の記録だけで決まること）は、送る前に確かめる。
  //  通信を待たずにすぐ知らせるため（ワープの置き場所など）。最後に確かめるのはホスト
  function guestPrecheck(g, name, args) {
    const v = args[0];
    if (name === 'useItem') {
      if (!g.itemStatus(v, args[1]).usable) return { ok: false, reason: 'いまはアイテムを使えません' };
      return g.validateItem(v, args[1], args[2]);
    }
    if (name === 'answer' && !E.identifyShape(Array.from(new Set(args[1])).sort((a, b) => a - b), g.N)) {
      return { ok: false, reason: 'キューブ・L字・T字のいずれかの形で宣言してください' };
    }
    return { ok: true };
  }

  function afterHuman() {
    const g = G();
    setBanner();
    render();
    playFx();
    if (g.phase === 'over') onGameOver();
    kick();
  }

  function resetMode() { if (app.ui) { app.ui.mode = null; app.ui.item = null; app.ui.sel = []; app.ui.warp = null; } }

  // ---------------- アイテム ----------------
  function startItem(key) {
    const g = G(), v = viewer();
    // 選択中のアイテムをもう一度押したら、選択をやめる
    if (app.ui && app.ui.item === key && app.ui.mode) { resetMode(); render(); SND.sfx('cancel'); return; }
    const st = g.itemStatus(v, key);
    const m = effMode();
    const inItemWindow = m === 'item' || m === 'answer-phase' || m === 'answer' || (app.ui.mode && app.ui.item);
    if (!inItemWindow || g.cur !== v) { toast('アイテムは自分のターンの、コールの前か後に使えます'); return; }
    if (g.itemUsed) { toast('このターンはもうアイテムを使いました'); return; }
    if (!st.usable) {
      if (st.usedUp) toast('予選では、同じ種類のアイテムは1試合1回までです');
      else if (st.have <= 0 && g.players[v].used[key]) toast('このアイテムは使い切りました');
      else toast('このアイテムは持っていません');
      return;
    }
    resetMode();
    app.ui.item = key;
    const modeOf = { cube: 'cube', line: 'line', number: 'number', shape: 'shape', pair: 'pair', node: 'node', bazooka: 'bazooka', warp: 'warp-pick', stealth: 'stealth-pick' };
    app.ui.mode = modeOf[key];
    render();
    SND.sfx('select');
  }

  function useItem(key, params) {
    const v = viewer();
    const r = act('useItem', v, key, params);
    if (!r.ok) { toast(r.reason || '使えません', 'warn'); return r; }
    resetMode();
    afterHuman();
    return r;
  }

  // ---------------- 操作 ----------------
  const ACT_SOUND = {
    rules: 'open', 'close-modal': 'close', start: 'confirm', 'to-title': 'cancel', restart: 'confirm',
    'show-result': 'open', 'replay-open': 'open', reveal: 'ui', shape: 'ui', rotate: 'rotate', flip: 'rotate', 'treasure-mode': 'ui',
    random: 'shuffle', clear: 'remove', 'setup-done': 'confirm', 'draft-pick': 'pick', cancel: 'cancel',
    'answer-start': 'select', 'end-turn': 'ui', 'skip-call': 'ui', 'warp-rotate': 'rotate', 'warp-flip': 'rotate', 'warp-repick': 'cancel',
    step: 'tick', 'memo-type': 'ui', 'memo-clear': 'remove', 'tour-next': 'confirm', 'tour-choose': 'select', 'tour-end': 'ui', 'tour-back': 'confirm', 'quit-tour': 'cancel',
    'net-create': 'confirm', 'net-join': 'confirm', 'net-cancel': 'cancel', 'net-copy': 'ui', 'net-quit': 'cancel',
    'sim-open': 'open', 'sim-back': 'cancel', 'sim-run': 'confirm', 'sim-stop': 'cancel', 'sim-refinal': 'confirm', 'sim-pin': 'pick', 'sim-reset': 'ui', 'sim-rm': 'remove',
  };
  const handlers = {
    rules() { app.modal = 'rules'; render(); },
    // リプレイを開く：結果の画面（いまの試合）か、大会の試合の記録（results の番号）
    'replay-open'(el) {
      if (el.dataset.src === 'game') {
        const g = app.game;
        if (!g || g.phase !== 'over') return;
        openReplay(g.replayRecord ? g.replayRecord() : null, `${g.rules.label}　${g.players[0].name} vs ${g.players[1].name}`);
        return;
      }
      const T = app.tour, r = T && T.results[+el.dataset.res];
      if (!r) return;
      openReplay(r.replay, `${r.kind === 'final' ? '決勝' : `予選 第${r.round + 1}試合`}　${T.players[r.a].name} vs ${T.players[r.b].name}`);
    },
    'close-modal'() { app.modal = null; render(); },
    start() { store.set('settings', app.settings); startGame(); },
    'to-title'() {
      // オンライン対戦：試合の途中なら、やめてよいか確かめる。ロビー・決着のあとは、そのまま部屋を出る
      if (app.net || app.lobby) {
        const g = app.game;
        if (app.net && !app.net.gone && g && g.phase !== 'over' && app.screen !== 'lobby') { app.modal = 'net-quit'; render(); return; }
        netLeave();
        return;
      }
      // 大会の途中なら、やめてよいか確かめる
      const T = app.tour;
      if (T && T.stage !== 'done' && !(T.stage === 'qualify' && T.finalists && T.finalists.indexOf(0) < 0)) { app.modal = 'quit'; render(); return; }
      // ここまで来たら大会は終わっている
      app.busy = false;
      app.tour = null; app.tourFx = null;
      app.screen = 'title'; app.game = null; app.modal = null;
      render(); window.scrollTo(0, 0);
    },
    'quit-tour'() {
      app.busy = false; app.modal = null;
      app.tour = null; app.tourFx = null; app.game = null;
      app.screen = 'title';
      render(); window.scrollTo(0, 0);
    },
    step(el) {
      const k = el.dataset.key, d = +el.dataset.d;
      const max = k === 'draftN' ? DRAFT_MAX : ITEM_KEYS.length;
      app.settings[k] = Math.max(1, Math.min(max, (app.settings[k] | 0) + d));
      store.set('settings', app.settings);
      render();
      const f = root.querySelector(`[data-act="step"][data-key="${k}"][data-d="${d}"]`);
      if (f && !f.disabled) f.focus();
    },
    'tour-next'() {
      const T = app.tour;
      if (!T || app.busy) return;
      if (T.stage === 'intro' || T.stage === 'hub' || T.stage === 'final-hub') tourStartMatch();
      else if (T.stage === 'qualify' && T.finalists.indexOf(0) >= 0) tourEnterFinalHub();
      else if (T.stage === 'qualify') tourWatchFinal();
    },
    'tour-choose'(el) {
      const T = app.tour;
      if (!T || T.stage !== 'final-hub' || T.finalists[0] !== 0) return;
      T.finalChoice = el.dataset.v === 'draft' ? 'draft' : 'first';
      render();
    },
    'tour-back'() { tourAfterMatch(); },
    'memo-type'(el) {
      const ui = app.ui;
      if (!ui) return;
      const k = el.dataset.type;
      if (ui.memoMode && ui.memoType === k) ui.memoMode = false;
      else { ui.memoType = k; ui.memoMode = true; }
      render();
    },
    'memo-clear'() {
      const g = G();
      if (!g || !app.ui) return;
      app.ui.memo[viewer()] = {};
      render();
    },
    'tour-end'() {
      app.tour = null; app.tourFx = null; app.game = null; app.modal = null;
      app.screen = 'title';
      render(); window.scrollTo(0, 0);
    },
    restart() {
      // オンライン対戦の「もう一度」：ホストが同じ相手と新しい試合を作る
      if (app.net) { if (app.net.role === 'host' && !app.net.gone) app.net.host.newMatch(); return; }
      startGame();
    },
    'net-create'() { lobbyCreate(); },
    'net-join'() { lobbyJoin(); },
    'net-cancel'() { lobbyCancel(); },
    'net-copy'() { netCopyCode(); },
    'net-quit'() { app.modal = null; netLeave(); },
    'show-result'() { app.ui.showResult = true; render(); },
    reveal() { app.ui.reveal = true; app.ui.showResult = false; render(); },

    shape(el) { const S = app.setup; if (S.key !== el.dataset.key) S.t = 0; S.key = el.dataset.key; S.treasureMode = false; render(); },
    rotate() { const S = app.setup; if (S.key) { S.t = rotT(S.t); render(); } },
    flip() { const S = app.setup; if (S.key) { S.t = flipT(S.t); render(); } },
    'treasure-mode'() { const S = app.setup; S.treasureMode = !S.treasureMode; render(); },
    random() {
      const g = G(), pi = app.setup.pi;
      if (netSetupLocked()) return;
      if (app.tour) {
        // 大会：CPUと同じ考え方（残りのキューブ・予選か決勝か）で置く。トレジャーもCPUと同じ選び方
        const plan = AI.tourSetupPlan(app.tour, 0, g.rules.kind === 'final' ? 'final' : 'prelim', null, Math.random);
        if (!AI.setup(g, pi, plan)) { denied = true; toast('自動配置で置けませんでした。手で置いてください', 'warn'); return; }
        const ps = g.players[pi].pieces;
        toast(`CPUと同じ考え方で置きました（${ps.length}個体・${ps.reduce((a, q) => a + q.size, 0)}マス）`, 'note');
      } else if (!act('randomSetup', pi, AI.setupSizes(g, pi)) && !act('randomSetup', pi)) { denied = true; toast('自動配置で置けませんでした。手で置いてください', 'warn'); return; }
      app.setup.treasureMode = false; render();
    },
    clear() { if (netSetupLocked()) return; act('clearSetup', app.setup.pi); render(); },
    'setup-done'() {
      const g = G(), S = app.setup;
      if (netSetupLocked()) return;
      // オンライン対戦のゲスト：配置をホストに送って、確かめてもらう（結果は state で届く）
      const gu = netGuest();
      if (gu) { const r = gu.sendSetup(); if (!r.ok) toast(r.reason, 'warn'); render(); return; }
      const r = act('finishSetup', S.pi);
      if (!r.ok) { toast(r.reason, 'warn'); return; }
      if (app.net && g.phase === 'setup') { render(); return; }   // オンライン対戦のホスト：相手の配置を待つ
      if (!isCPUMode() && S.pi === 0 && !g.players[1].setupDone) {
        app.setup = { pi: 1, key: firstShape(1), t: 0, treasureMode: false };
        render(); window.scrollTo(0, 0);
        toast('プレイヤー2の配置です', 'note');
        return;
      }
      enterAfterSetup();
    },

    'draft-pick'(el) {
      const g = G();
      const pi = g.draftTurn();
      if (isCPUMode() && pi === 1) return;
      if (app.net && (pi !== app.net.seat || netWaiting())) return;
      const r = act('draftPick', pi, el.dataset.key);
      if (!r.ok) { toast(r.reason || '選べません'); return; }
      if (r.sent) { render(); return; }   // ゲスト：結果はホストから届く
      if (g.phase === 'play') { enterBattle(); return; }
      render();
      runDraftCPU();
    },

    item(el) { startItem(el.dataset.key); },
    sound() {
      const m = SND_ORDER[(SND_ORDER.indexOf(soundMode()) + 1) % SND_ORDER.length];
      setSound(m);
      render();
      const b = root.querySelector('[data-act="sound"]');
      if (b) b.focus();
    },
    cube(el) { const kind = el.dataset.kind; useItem('cube', { kind, value: kind === 'size' ? +el.dataset.value : el.dataset.value }); },
    'pick-line'(el) { useItem('line', { line: el.dataset.line, index: +el.dataset.index }); },
    cancel() { resetMode(); render(); },
    'answer-start'() { resetMode(); app.ui.mode = 'answer'; render(); },
    'answer-submit'() {
      const g = G(), v = viewer();
      const r = act('answer', v, app.ui.sel.slice());
      if (!r.ok) { toast(r.reason || 'アンサーできません', 'warn'); return; }
      resetMode();
      // ゲストは結果がまだ分からない（失敗のときは、届いた state を見て知らせる）
      if (!r.sent && !r.success) toast('アンサー失敗！手番が終了します。差し出すキューブを選んでください', 'warn', true);
      afterHuman();
    },
    'skip-call'() {
      const g = G(), v = viewer();
      const r = act('skipCall', v);
      if (!r.ok) { toast(r.reason || 'コールできるマスがあります'); return; }
      resetMode();
      afterHuman();
    },
    'end-turn'() {
      const g = G(), v = viewer();
      act('endTurn', v);
      resetMode();
      afterHuman();
    },
    'warp-rotate'() { if (app.ui.warp) { app.ui.warp.t = rotT(app.ui.warp.t); render(); } },
    'warp-flip'() { if (app.ui.warp) { app.ui.warp.t = flipT(app.ui.warp.t); render(); } },
    'warp-repick'() { app.ui.warp = null; app.ui.mode = 'warp-pick'; render(); },

    cell(el) {
      const c = +el.dataset.cell;
      if (app.screen === 'setup') return setupCell(c);
      if (app.screen !== 'battle') return;
      if (el.dataset.board === 'pred') predCell(c); else ownCell(c);
    },
  };

  function setupCell(c) {
    const g = G(), S = app.setup, pi = S.pi;
    if (netSetupLocked()) return;   // 配置を送ったあとは動かせない
    const p = g.pieceAt(pi, c);
    if (S.treasureMode) {
      const r = act('setTreasure', pi, c);
      if (!r.ok) { toast(r.reason, 'warn'); return; }
      S.treasureMode = false;
      render();
      SND.sfx('gem');
      return;
    }
    if (p) { act('removePiece', pi, p.id); render(); SND.sfx('remove'); return; }
    if (!S.key) { toast('先に形を選んでください'); return; }
    const a = anchorFor(S.key, S.t, c, g.N);
    if (!a) { toast('このフィールドには入らない形です', 'warn'); return; }
    const r = act('placePiece', pi, S.key, S.t, a.r0, a.c0);
    if (!r.ok) { toast(r.reason, 'warn'); return; }
    SND.sfx('place');
    const size = SHAPES[S.key].size;
    if (g.stockLeft(pi, size) <= 0) {
      const next = [2, 3, 4, 5].find((s) => g.stockLeft(pi, s) > 0);
      S.key = next ? SHAPES_BY_SIZE[next][0] : null;
      S.t = 0;
    }
    if (!g.players[pi].treasure) toast('◆トレジャーのセットも忘れずに', 'note');
    render();
  }

  function predCell(c) {
    const g = G(), v = viewer(), mode = effMode(), ui = app.ui;
    if (ui && ui.memoMode && g.phase === 'play') { toggleMemo(c); return; }
    if (app.busy || netWaiting()) return;
    const P = g.players[v];
    if ((mode === 'item' || mode === 'call' || mode === 'treasure') && memoOf(v)[c]) {
      delete memoOf(v)[c];
      SND.sfx('desel', 0, { n: 0, pan: 0.35 });
      toast('メモを外しました（もう一度押すと' + (mode === 'treasure' ? 'トレジャーコール' : 'コール') + '）', 'note', true);
      render();
      return;
    }
    switch (mode) {
      case 'item':
      case 'call': {
        if (!g.isCallable(v, c)) { toast('そのマスはコールできません'); return; }
        const r = act('call', v, c);
        if (!r.ok) { toast(r.reason, 'warn'); return; }
        resetMode();
        afterHuman();
        return;
      }
      case 'answer': {
        // 直前のポインター操作（pointerdown/ドラッグ）ですでに処理されている場合は重複発火を防止
        if (skipNextAnswerClick) { skipNextAnswerClick = false; return; }
        if (P.view.dead[c]) return;
        const i = ui.sel.indexOf(c);
        if (i >= 0) { ui.sel.splice(i, 1); SND.sfx('desel', 0, { n: ui.sel.length, pan: 0.35 }); }
        else if (ui.sel.length < 5) { ui.sel.push(c); SND.sfx('sel', 0, { n: ui.sel.length, pan: 0.35 }); }
        else toast('選べるのは5マスまでです');
        render();
        return;
      }
      case 'treasure': {
        if (!g.isTreasureCallable(v, c)) { toast('そのマスにはトレジャーコールできません'); return; }
        act('treasureCall', v, c);
        resetMode();
        afterHuman();
        return;
      }
      case 'shape': useItem('shape', { cell: c }); return;
      case 'number': useItem('number', { cell: c }); return;
      case 'node':
      case 'bazooka':
        if (P.view.dead[c]) { toast('撃破済みのマスには使えません'); return; }
        useItem(mode, { cell: c });
        return;
      case 'line': toast('列（アルファベット）か行（数字）のラベルをタップしてください'); return;
      case 'cube': return;
      case 'pair': {
        if (P.view.dead[c]) { toast('撃破済みのマスは選べません'); return; }
        const i = ui.sel.indexOf(c);
        if (i >= 0) { ui.sel.splice(i, 1); render(); SND.sfx('desel', 0, { n: 0, pan: 0.35 }); return; }
        ui.sel.push(c);
        if (ui.sel.length === 2) { useItem('pair', { a: ui.sel[0], b: ui.sel[1] }); return; }
        render();
        SND.sfx('sel', 0, { n: 1, pan: 0.35 });
        return;
      }
      default:
        if (mode === 'answer-phase') toast('このターンのコールは済んでいます。アンサーするかターンエンドしてください');
    }
  }

  function ownCell(c) {
    const g = G(), v = viewer(), mode = effMode(), ui = app.ui;
    if (app.busy || netWaiting()) return;
    switch (mode) {
      case 'warp-pick': {
        const p = g.pieceAt(v, c);
        if (!p) { toast('移動する自分のキューブを選んでください'); return; }
        ui.warp = { pieceId: p.id, t: p.t };
        ui.mode = 'warp-place';
        render();
        SND.sfx('sel', 0, { n: 1, pan: -0.35 });
        return;
      }
      case 'warp-place': {
        const p = g.players[v].pieces.find((x) => x.id === ui.warp.pieceId);
        const a = anchorFor(p.shape, ui.warp.t, c, g.N);
        if (!a) { toast('フィールドに入りません', 'warn'); return; }
        useItem('warp', { pieceId: p.id, t: ui.warp.t, r0: a.r0, c0: a.c0 });
        return;
      }
      case 'stealth-pick': {
        const p = g.pieceAt(v, c);
        if (!p) { toast('ステルスにする自分のキューブを選んでください'); return; }
        if (p.stealth) { toast('そのキューブはすでにステルス中です'); return; }
        useItem('stealth', { pieceId: p.id });
        return;
      }
      case 'sacrifice': {
        const p = g.pieceAt(v, c);
        if (!p) { toast('差し出す自分のキューブを選んでください'); return; }
        act('sacrifice', v, p.id);
        afterHuman();
        return;
      }
      default:
        if (mode === 'item') toast('コールは相手フィールドで行います');
    }
  }

  root.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || !root.contains(el) || el.disabled) return;
    const act = el.dataset.act;
    const fn = handlers[act];
    if (!fn) return;
    denied = false;
    fn(el, ev);
    if (ACT_SOUND[act] && !denied) SND.sfx(ACT_SOUND[act]);
  });
  // 右クリック（スマホは長押し）で相手フィールドにメモ
  root.addEventListener('contextmenu', (ev) => {
    const el = ev.target.closest('.cell[data-board="pred"]');
    if (!el || app.screen !== 'battle') return;
    ev.preventDefault();
    hideTip();
    toggleMemo(+el.dataset.cell);
  });
  root.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el && el.dataset && el.dataset.setting) {
      const k = el.dataset.setting;
      if (k === 'sound') { setSound(el.value); render(); const f = document.getElementById(el.id); if (f) f.focus(); return; }
      app.settings[k] = el.value;
      store.set('settings', app.settings);
      SND.sfx('tick');
      if (k === 'items' || k === 'rules' || k === 'mode') { render(); const f = document.getElementById(el.id); if (f) f.focus(); }
    }
    if (el && el.dataset && el.dataset.pick) {
      let list = pickedItems().slice();
      const k = el.dataset.pick;
      if (el.checked) { if (list.indexOf(k) < 0) list.push(k); }
      else list = list.filter((x) => x !== k);
      if (!list.length) { el.checked = true; toast('アイテムは1種類以上選んでください'); return; }
      app.settings.itemPick = ITEM_KEYS.filter((x) => list.indexOf(x) >= 0);
      store.set('settings', app.settings);
      SND.sfx('tick');
      const cnt = document.getElementById('pick-count');
      if (cnt) cnt.textContent = `${list.length}種を使います。`;
      const lab = root.querySelector('label[for="opt-items-0"] small');
      if (lab) lab.textContent = list.length + '種を指定';
    }
  });
  root.addEventListener('pointerover', (ev) => {
    const tipT = ev.target.closest('[data-tip]');
    if (tipT) showTip(tipT, ev.pointerType === 'touch');
    const ax = ev.target.closest('.axbtn');
    highlightLine(ax);
    const el = ev.target.closest('.cell[data-board="own"]');
    const c = el ? +el.dataset.cell : -1;
    if (c !== app.hover) { app.hover = c; applyPreview(); }
  });
  root.addEventListener('pointerout', (ev) => {
    const tipT = ev.target.closest('[data-tip]');
    if (tipT && !(ev.relatedTarget && tipT.contains(ev.relatedTarget)) && ev.pointerType !== 'touch') hideTip();
  });
  root.addEventListener('pointerleave', () => { app.hover = -1; applyPreview(); hideTip(); }, true);

  // アンサー時のマス選択：クリックに加え、ドラッグ（なぞり操作）でも選択・解除できるようにする
  let answerDrag = null;
  let skipNextAnswerClick = false;

  function handleAnswerPointerDown(ev, el) {
    if (effMode() !== 'answer') return;
    if (ev.button != null && ev.button !== 0) return;
    const c = +el.dataset.cell;
    const g = G(), v = viewer(), P = g.players[v], ui = app.ui;
    if (P.view.dead[c]) return;

    const idx = ui.sel.indexOf(c);
    const adding = idx < 0;
    if (adding) {
      if (ui.sel.length < 5) {
        ui.sel.push(c);
        SND.sfx('sel', 0, { n: ui.sel.length, pan: 0.35 });
        render();
      } else {
        toast('選べるのは5マスまでです');
      }
    } else {
      ui.sel.splice(idx, 1);
      SND.sfx('desel', 0, { n: ui.sel.length, pan: 0.35 });
      render();
    }
    skipNextAnswerClick = true;
    setTimeout(() => { skipNextAnswerClick = false; }, 350);
    answerDrag = { adding, visited: new Set([c]) };
  }

  function handleAnswerPointerMove(ev) {
    if (!answerDrag || effMode() !== 'answer') return;
    if (ev.pointerType === 'mouse' && (ev.buttons & 1) === 0) {
      answerDrag = null;
      return;
    }
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const cellEl = target && target.closest('.cell[data-board="pred"]');
    if (!cellEl) return;
    const c = +cellEl.dataset.cell;
    if (answerDrag.visited.has(c)) return;
    answerDrag.visited.add(c);

    const g = G(), v = viewer(), P = g.players[v], ui = app.ui;
    if (P.view.dead[c]) return;

    const idx = ui.sel.indexOf(c);
    if (answerDrag.adding) {
      if (idx < 0) {
        if (ui.sel.length < 5) {
          ui.sel.push(c);
          SND.sfx('sel', 0, { n: ui.sel.length, pan: 0.35 });
          render();
        } else {
          toast('選べるのは5マスまでです');
        }
      }
    } else {
      if (idx >= 0) {
        ui.sel.splice(idx, 1);
        SND.sfx('desel', 0, { n: ui.sel.length, pan: 0.35 });
        render();
      }
    }
  }

  function handleAnswerPointerUp() {
    answerDrag = null;
  }

  root.addEventListener('pointerdown', (ev) => {
    const el = ev.target.closest && ev.target.closest('.cell[data-board="pred"]');
    if (el && effMode() === 'answer') handleAnswerPointerDown(ev, el);
  });
  window.addEventListener('pointermove', handleAnswerPointerMove, { passive: true });
  window.addEventListener('pointerup', handleAnswerPointerUp);
  window.addEventListener('pointercancel', handleAnswerPointerUp);
  window.addEventListener('scroll', hideTip, { passive: true });
  document.addEventListener('keydown', (ev) => {
    if (app.replay) {
      const k = ev.key.toLowerCase();
      if (k === 'escape') { ev.preventDefault(); replayAct('rp-close'); return; }
      if (ev.target && /input|textarea|select/i.test(ev.target.tagName)) return;
      const map = { arrowright: 'rp-next', arrowleft: 'rp-prev', home: 'rp-first', end: 'rp-last', ' ': 'rp-play' };
      if (map[k] && !(k === ' ' && ev.target && ev.target.tagName === 'BUTTON')) { ev.preventDefault(); replayAct(map[k]); }
      return;
    }
    if (ev.target && /input|textarea|select/i.test(ev.target.tagName)) return;
    const k = ev.key.toLowerCase();
    if (k === 'escape') {
      hideTip();
      if (app.modal) { app.modal = null; render(); return; }
      if (app.screen === 'battle' && app.ui && app.ui.showResult) { app.ui.showResult = false; render(); return; }
      if (app.screen === 'battle' && app.ui && app.ui.memoMode) { app.ui.memoMode = false; render(); SND.sfx('cancel'); return; }
      if (app.screen === 'battle' && app.ui && app.ui.mode) { resetMode(); render(); SND.sfx('cancel'); }
      return;
    }
    if (app.screen === 'setup' && app.setup.key) {
      if (k === 'r') { app.setup.t = rotT(app.setup.t); render(); SND.sfx('rotate'); }
      if (k === 'f') { app.setup.t = flipT(app.setup.t); render(); SND.sfx('rotate'); }
    }
    if (app.screen === 'battle' && app.ui && app.ui.warp && effMode() === 'warp-place') {
      if (k === 'r') { app.ui.warp.t = rotT(app.ui.warp.t); render(); SND.sfx('rotate'); }
      if (k === 'f') { app.ui.warp.t = flipT(app.ui.warp.t); render(); SND.sfx('rotate'); }
    }
  });

  // ---------------- シミュレーター（タイトルから開く計算の画面） ----------------
  // CPUだけの大会を端末の中で回し（Web Worker で並列に）、点数のルールを変えると同じ試合結果で数え直す。
  // 計算の中身は sim.js（開発用のコマンド tools/sim.js も同じもの）
  const SIM = window.SBSim;
  const simClone = (o) => JSON.parse(JSON.stringify(o));
  const simStore = {
    get(k) { try { const v = localStorage.getItem('sbsim:' + k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('sbsim:' + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };
  const spc = (x) => (x == null ? '—' : x.toFixed(1) + '%');
  const sn1 = (x) => (x == null ? '—' : x.toFixed(1));
  const sn0 = (x) => (x == null ? '—' : String(Math.round(x)));
  const simKey = (r) => [r.start, r.gems, r.gemPts].concat(r.vic).join(',');
  const $s = (id) => document.getElementById(id);
  function simInit() {
    if (app.sim) return app.sim;
    const S = app.sim = { recs: [], source: null, rules: simClone(SIM.DEFAULT_RULES), compare: [], run: null, refinal: null, tours: 300, withFinal: true, runNote: '' };
    const saved = simStore.get('last');
    const sample = window.SB_SIM_SAMPLE;
    if (saved && saved.v === E.VERSION && Array.isArray(saved.recs) && saved.recs.length) {
      S.recs = saved.recs; S.source = { kind: 'saved', tours: saved.recs.length, made: saved.made };
    } else if (sample && Array.isArray(sample.recs)) {
      S.recs = sample.recs; S.source = { kind: 'sample', tours: sample.recs.length, made: sample.made, stale: sample.v !== E.VERSION, v: sample.v };
    }
    const rl = simStore.get('rules'); if (rl) S.rules = SIM.normRules(rl);
    const cmp = simStore.get('compare'); if (Array.isArray(cmp)) S.compare = cmp.map(SIM.normRules);
    return S;
  }
  // 計算の並列実行：同じページのルールエンジン・CPU・計算の中身から Web Worker を作る（作れなければこの画面の中で順に）
  let simWorkerURL = null;
  function simMakeWorkerURL() {
    if (simWorkerURL) return simWorkerURL;
    const code = ['src-engine', 'src-ai', 'src-sim'].map((id) => document.getElementById(id).textContent).join('\n;\n') + `
;self.onmessage = function (e) {
  var d = e.data;
  try {
    if (d.cmd === 'run') { for (var i = 0; i < d.seeds.length; i++) self.postMessage({ type: 'rec', rec: SBSim.runTour(d.seeds[i], d.rules, d.withFinal) }); }
    else if (d.cmd === 'final') { for (var j = 0; j < d.jobs.length; j++) { var x = d.jobs[j]; self.postMessage({ type: 'final', i: x.i, key: x.f1 + '-' + x.f2, m: SBSim.playFinal(x.post, x.f1, x.f2, x.seed) }); } }
  } catch (err) { self.postMessage({ type: 'error', message: String(err && err.message || err) }); }
  self.postMessage({ type: 'done' });
};`;
    simWorkerURL = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    return simWorkerURL;
  }
  // Worker が作れない・読み込めない（ページの制限など）ときは、残りをこの画面の中で順に計算する
  function simPool(tasks, onEach, onDone, onMode) {
    const job = { stopped: false, workers: [], parallel: 0, stop() { this.stopped = true; this.workers.forEach((w) => w.terminate()); this.workers = []; } };
    let next = 0, finished = false, local = false;
    const retry = [];
    const take = () => (retry.length ? retry.shift() : next < tasks.length ? tasks[next++] : null);
    const finish = () => { if (!finished && !job.stopped && !job.workers.length && !local) { finished = true; onDone(); } };
    const runLocal = () => {
      if (local) return;
      local = true;
      if (onMode) onMode('main');
      (async () => {
        let t;
        while (!job.stopped && (t = take())) {
          await sleep(0);
          if (job.stopped) return;
          if (t.cmd === 'run') for (const seed of t.seeds) onEach({ type: 'rec', rec: SIM.runTour(seed, t.rules, t.withFinal) });
          else for (const x of t.jobs) onEach({ type: 'final', i: x.i, key: x.f1 + '-' + x.f2, m: SIM.playFinal(x.post, x.f1, x.f2, x.seed) });
        }
        local = false;
        finish();
      })();
    };
    const drop = (w) => { w.terminate(); job.workers = job.workers.filter((x) => x !== w); };
    const feed = (w) => {
      if (job.stopped) return;
      const t = take();
      if (!t) { drop(w); finish(); return; }
      w.cur = t;
      w.postMessage(t);
    };
    let url = null;
    try { url = simMakeWorkerURL(); } catch (e) { url = null; }
    const n = Math.min(Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)), tasks.length);
    if (url) {
      for (let i = 0; i < n; i++) {
        let w;
        try { w = new Worker(url); } catch (e) { break; }
        w.onmessage = (ev) => {
          const d = ev.data;
          if (d.type === 'done') feed(w);
          else if (d.type === 'error') console.warn('sim worker', d.message);
          else { w.cur = null; onEach(d); }
        };
        // 読み込めなかった Worker の仕事は、ほかの Worker か、この画面に回す
        w.onerror = (ev) => {
          if (ev && ev.preventDefault) ev.preventDefault();
          if (job.stopped) return;
          if (w.cur) retry.push(w.cur);
          w.cur = null;
          drop(w);
          job.parallel = job.workers.length;
          if (!job.workers.length) runLocal();
        };
        job.workers.push(w);
        feed(w);
      }
    }
    job.parallel = job.workers.length;
    if (!job.workers.length) runLocal();
    return job;
  }
  function simMainMode() {
    const S = app.sim;
    if (S.run) S.run.main = true;
    S.runNote = 'この画面の中で順に計算しています（並列の計算が使えませんでした）。計算の間は画面の動きが重くなります。';
    const el = $s('sim-runnote');
    if (el) el.textContent = S.runNote;
  }
  const simTime = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 90 ? `約${Math.round(s / 60)}分` : `${s}秒`; };
  function simStart() {
    const S = simInit();
    if (S.run || S.refinal) return;
    const n = S.tours, withFinal = S.withFinal, rules = simClone(S.rules);
    const seed0 = (Date.now() % 1e9) | 0;
    const R = { n, withFinal, recs: [], t0: performance.now() };
    S.run = R;
    S.runNote = '計算しています。タイトルに戻っても、裏で計算を続けます。';
    R.job = simPool(Array.from({ length: n }, (_, k) => ({ cmd: 'run', seeds: [seed0 + k], rules, withFinal })), (d) => { if (d.type === 'rec') { R.recs.push(d.rec); simProgress(); } }, () => simFinish(false), simMainMode);
    if (R.job.parallel > 1 && !R.main) S.runNote = `${R.job.parallel}つ並列で計算しています。タイトルに戻っても、裏で計算を続けます。`;
    if (app.screen === 'sim') renderSim();
  }
  function simProgress() {
    const S = app.sim, R = S && (S.run || S.refinal);
    if (!R || app.screen !== 'sim') return;
    const done = R.recs ? R.recs.length : R.done, n = R.n, el = performance.now() - R.t0;
    const bar = $s('sim-progbar'), tx = $s('sim-progtext');
    if (bar) bar.style.width = (100 * done / Math.max(1, n)).toFixed(1) + '%';
    if (tx) tx.textContent = `${done} / ${n}${done ? `・残り${simTime(el / done * (n - done))}` : ''}`;
  }
  function simFinish(stopped) {
    const S = app.sim, R = S && S.run;
    if (!R) return;
    S.run = null;
    if (!R.recs.length) { S.runNote = '止めました（まだ結果がありません）。'; if (app.screen === 'sim') renderSim(); return; }
    R.recs.sort((a, b) => a.seed - b.seed);
    S.recs = R.recs;
    const d = new Date(), pad = (x) => String(x).padStart(2, '0');
    const made = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    S.source = { kind: 'run', tours: R.recs.length, made, partial: stopped, sec: Math.round((performance.now() - R.t0) / 1000) };
    const ok = simStore.set('last', { v: E.VERSION, made, withFinal: R.withFinal, recs: R.recs.map(SIM.slim) });
    S.runNote = `${stopped ? '途中で止めました。' : ''}${R.recs.length}回を${simTime(performance.now() - R.t0)}で計算しました。${ok ? '結果はこの端末に残ります。' : ''}`;
    if (app.screen === 'sim') renderSim();
    else toast(`シミュレーター：${R.recs.length}回の計算が終わりました`, 'note');
  }
  function simStop() {
    const S = app.sim;
    if (!S) return;
    if (S.run) { S.run.job.stop(); simFinish(true); }
    if (S.refinal) { S.refinal.job.stop(); S.refinal = null; renderSim(); }
  }
  function simRefinal() {
    const S = simInit();
    if (S.run || S.refinal) return;
    const jobs = SIM.missingFinals(S.recs, S.rules).map((j) => ({ i: j.i, f1: j.f1, f2: j.f2, post: S.recs[j.i].post, seed: S.recs[j.i].seed }));
    if (!jobs.length) return;
    const F = { n: jobs.length, done: 0, t0: performance.now() };
    F.job = simPool(jobs.map((j) => ({ cmd: 'final', jobs: [j] })), (d) => { if (d.type === 'final') { S.recs[d.i].finals[d.key] = d.m; F.done++; simProgress(); } },
      () => { S.refinal = null; if (app.screen === 'sim') renderSim(); }, simMainMode);
    S.refinal = F;
    renderSim();
  }
  // 点数のルールの入力（打っている間は結果だけを描き直す）
  function simReadRules() {
    const S = simInit();
    const num = (id, d) => { const el = $s(id); const v = el ? parseFloat(el.value) : NaN; return isFinite(v) ? v : d; };
    const r = S.rules;
    S.rules = SIM.normRules({ start: num('sim-start', r.start), gems: Math.max(0, Math.min(9, Math.round(num('sim-gems', r.gems)))), gemPts: num('sim-gemPts', r.gemPts), vic: [0, 1, 2, 3].map((i) => num('sim-v' + i, r.vic[i])), speed: r.speed.map((v, i) => (i ? num('sim-s' + i, v) : 0)) });
    simStore.set('rules', S.rules);
  }
  const skpi = (k, v, s) => `<div class="sim-kpi"><span class="k">${esc(k)}</span><span class="v">${v}</span>${s ? `<span class="s">${s}</span>` : ''}</div>`;
  const sbig = (x) => (x == null ? '—' : `${x.toFixed(1)}<small>%</small>`);
  const scell = (x, cls) => (x == null ? '—' : `<span class="sim-cellbar"><i class="${cls || ''}" style="width:${(Math.max(2, Math.min(100, x)) * 0.6).toFixed(0)}px"></i>${x.toFixed(1)}%</span>`);
  function simHist(list) {
    if (!list.length) return '<p class="sim-note">決勝の結果がありません。</p>';
    const lo = Math.floor(Math.min(...list) / 10) * 10, hi = Math.ceil((Math.max(...list) + 1) / 10) * 10;
    const bins = [];
    for (let x = lo; x < hi; x += 10) bins.push({ x, n: 0 });
    for (const v of list) bins[Math.min(bins.length - 1, Math.floor((v - lo) / 10))].n++;
    const W = 560, H = 150, padL = 26, padB = 22, bw = (W - padL) / bins.length, max = Math.max(...bins.map((b) => b.n));
    let g = `<line x1="${padL}" y1="${H - padB}" x2="${W}" y2="${H - padB}"/>`;
    bins.forEach((b, i) => {
      const h = max ? (H - padB - 10) * b.n / max : 0, x = padL + i * bw;
      g += `<rect class="b" x="${(x + 2).toFixed(1)}" y="${(H - padB - h).toFixed(1)}" width="${Math.max(1, bw - 4).toFixed(1)}" height="${h.toFixed(1)}"><title>${b.x}〜${b.x + 9}点：${b.n}回</title></rect>`;
      if (bins.length <= 16 || i % 2 === 0) g += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${b.x}</text>`;
    });
    g += `<text x="${padL - 4}" y="16" text-anchor="end">${max}</text>`;
    return `<svg class="sim-hist" viewBox="0 0 ${W} ${H}" role="img" aria-label="優勝者の持ち点の分布">${g}</svg>`;
  }
  // 結果（右側）と、ルールに合わせて変わる左側の表示
  function simOutHTML() {
    const S = app.sim;
    if (!S.recs.length) return '<p class="sim-note">データがありません。▶ 実行で回してください。</p>';
    const sm = SIM.summarize(S.recs, S.rules);
    S.lastSummary = sm;
    const cb = sm.comeback, gm = sm.gems, pz = sm.prize, ti = sm.ties, pl = sm.play;
    const fin = sm.finals < sm.tours ? `・決勝あり ${sm.finals}/${sm.tours}回` : '';
    let h = `<section class="sim-kpis" aria-label="主な数字">
      ${skpi('3試合目で決勝の2人が入れ替わる', sbig(cb.r3change), '最後まで逆転できるか')}
      ${skpi('1勝で決勝へ', sbig(cb.byWins[1].qual), `2勝で決勝へ ${spc(cb.byWins[2].qual)}`)}
      ${skpi('先攻の勝率', `${sn1(sm.first.prelim)}<small>%</small>`, `予選。決勝は ${spc(sm.first.final)}`)}
      ${skpi('優勝者の持ち点（賞金）', `${sn1(pz.mean)}<small>点</small>`, `最低 ${sn0(pz.min)}・最高 ${sn0(pz.max)}${fin}`)}
      ${skpi('予選でいちばん低い持ち点', `${sn0(sm.low.prelim)}<small>点</small>`, sm.low.prelim < 0 ? `マイナスになる人 ${spc(sm.low.negativeShare)}` : 'マイナスなし')}
      ${skpi('トレジャーで決勝の2人が変わる', sbig(gm.changesFinalists), '宝石の点が0のときと比べて')}
    </section>`;
    h += `<section class="panel"><h3 class="ptitle">性格ごと<small>PERSONAS</small></h3><div class="sim-tw"><table class="sim-table">
      <thead><tr><th>性格</th><th>出場</th><th>予選通過</th><th>優勝</th><th>決勝の勝率</th><th>予選後の持ち点</th><th>1試合に置いた個体</th><th>1試合に使ったアイテム</th></tr></thead><tbody>
      ${sm.persona.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.n}</td><td>${scell(p.qual)}</td><td>${scell(p.champ, 'mg')}</td><td>${spc(p.finWin)}</td><td>${sn1(p.pts)}</td><td>${sn1(p.placed)}</td><td>${sn1(p.items)}</td></tr>`).join('')}
      </tbody></table></div><p class="sim-note">標準＝あなたの席に座ったCPU（性格なし。大会の自動配置と同じ考え方）。ほかの3席に、4つの性格から毎回3つが出場します。</p></section>`;
    h += `<div class="sim-grid2">
      <section class="panel"><h3 class="ptitle">逆転<small>COMEBACK</small></h3><dl class="sim-kv">
        <dt>3試合目で決勝の2人が入れ替わる</dt><dd>${spc(cb.r3change)}</dd>
        <dt>2試合目の後に4位でも決勝へ</dt><dd>${spc(cb.last2in)}</dd>
        <dt>1試合目の後の1位が予選落ち</dt><dd>${spc(cb.lead1out)}</dd>
        ${cb.byWins.map((w) => `<dt>予選${w.wins}勝で決勝へ（${w.n}人）</dt><dd>${spc(w.qual)}</dd>`).join('')}
        <dt>1試合目に勝った人の予選通過</dt><dd>${spc(cb.wonR1)}</dd>
        <dt>1試合目に負けた人の予選通過</dt><dd>${spc(cb.lostR1)}</dd>
        <dt>3試合目に勝った人の予選通過</dt><dd>${spc(cb.wonR3)}</dd>
      </dl></section>
      <section class="panel"><h3 class="ptitle">宝石（トレジャー）<small>GEMS</small></h3><dl class="sim-kv">
        <dt>トレジャーを見つけられる割合（予選・決勝）</dt><dd>${spc(gm.foundPrelim)}・${spc(gm.foundFinal)}</dd>
        <dt>予選1試合で、両方が奪う（差し引き0）</dt><dd>${spc(gm.both)}</dd>
        <dt>片方だけ奪う</dt><dd>${spc(gm.one)}</dd>
        <dt>どちらも奪えない</dt><dd>${spc(gm.none)}</dd>
        <dt>トレジャーで決勝の2人が変わる</dt><dd>${spc(gm.changesFinalists)}</dd>
      </dl><p class="sim-lab" style="margin:10px 0 0">予選のあとの宝石の数</p><div class="sim-dist">${gm.dist.map((d) => `<div><span>${d.gems}つ</span><div class="sim-bar"><i style="width:${(d.share || 0).toFixed(1)}%"></i></div><b>${spc(d.share)}</b></div>`).join('')}</div></section>
    </div>`;
    h += `<div class="sim-grid2">
      <section class="panel"><h3 class="ptitle">賞金（優勝者の持ち点）<small>PRIZE</small></h3>${simHist(pz.list)}<dl class="sim-kv" style="margin-top:8px">
        <dt>平均・中央</dt><dd>${sn1(pz.mean)}・${sn0(pz.p50)}点</dd>
        <dt>下位10%・上位10%</dt><dd>${sn0(pz.p10)}・${sn0(pz.p90)}点</dd>
        <dt>準優勝の方が持ち点が多い</dt><dd>${spc(pz.runnerAbove)}</dd>
        <dt>大会の最後にいちばん低い持ち点</dt><dd>${sn0(sm.low.all)}点</dd>
      </dl></section>
      <section class="panel"><h3 class="ptitle">同点と試合<small>TIES / PLAY</small></h3><dl class="sim-kv">
        <dt>決勝ライン（2位と3位）が同点</dt><dd>${spc(ti.line)}</dd>
        <dt>　勝ち数で決まる・撃破マス数で決まる</dt><dd>${spc(ti.byWins)}・${spc(ti.byTake)}</dd>
        <dt>　抽選まで</dt><dd>${spc(ti.lotto)}</dd>
        <dt>予選1位が同点</dt><dd>${spc(ti.top)}</dd>
        <dt>ターン数（予選・決勝）</dt><dd>${sn1(pl.turnsPrelim)}・${sn1(pl.turnsFinal)}</dd>
        <dt>置いた個体（予選・決勝）</dt><dd>${sn1(pl.placedPrelim)}・${sn1(pl.placedFinal)}</dd>
        <dt>使ったアイテム（予選・決勝）</dt><dd>${sn1(pl.itemsPrelim)}・${sn1(pl.itemsFinal)}</dd>
        <dt>1試合に失った個体（予選）</dt><dd>${sn1(pl.lostPrelim)}</dd>
      </dl></section>
    </div>`;
    const rows = [{ r: S.rules, cur: true }].concat(S.compare.filter((r) => simKey(r) !== simKey(S.rules)).map((r) => ({ r })));
    h += `<section class="panel sim-cmp"><h3 class="ptitle">比較表<small>COMPARE</small></h3>${S.compare.length ? '' : '<p class="sim-note">点数のルールを変えて「比較表に追加」を押すと、同じ試合結果での違いをここに並べます。</p>'}
      <div class="sim-tw"><table class="sim-table"><thead><tr><th>点数のルール</th><th>3試合目で入れ替わる</th><th>2試合目の後4位→決勝</th><th>1勝で決勝</th><th>1試合目に勝った人の通過</th><th>トレジャーで決勝が変わる</th><th>2位3位が同点</th><th>優勝者の持ち点（平均・最高）</th><th>予選の最低</th><th></th></tr></thead><tbody>
      ${rows.map(({ r, cur }) => { const s = cur ? sm : SIM.summarize(S.recs, r); return `<tr class="${cur ? 'cur' : ''}"><td class="lab">${cur ? '<b>いま</b>　' : ''}勝利 ${esc(r.vic.join('/'))}<small>宝石${r.gems}×${r.gemPts}・はじめ${r.start + r.gems * r.gemPts}・スピード${SIM.speedLabel(r)}</small></td><td>${spc(s.comeback.r3change)}</td><td>${spc(s.comeback.last2in)}</td><td>${spc(s.comeback.byWins[1].qual)}</td><td>${spc(s.comeback.wonR1)}</td><td>${spc(s.gems.changesFinalists)}</td><td>${spc(s.ties.line)}</td><td>${sn1(s.prize.mean)}・${sn0(s.prize.max)}${s.finals < s.tours ? `<small>（${s.finals}回）</small>` : ''}</td><td>${sn0(s.low.prelim)}</td><td>${cur ? '' : `<button type="button" class="sim-x" data-act="sim-rm" data-k="${esc(simKey(r))}" aria-label="比較表から外す">✕</button>`}</td></tr>`; }).join('')}
      </tbody></table></div></section>`;
    return h;
  }
  // ルールに合わせて変わるところ（結果・はじめの持ち点・決勝の回し直し）だけを描き直す
  function simRefresh() {
    const S = app.sim;
    if (!S || app.screen !== 'sim') return;
    const out = $s('sim-out');
    if (out) out.innerHTML = simOutHTML();
    const tot = $s('sim-tot');
    if (tot) tot.innerHTML = `はじめの持ち点 <b>${SIM.startTotal(S.rules)}</b>（${S.rules.start}＋宝石${S.rules.gems}×${S.rules.gemPts}）`;
    const fn = $s('sim-finnote');
    if (fn) fn.outerHTML = simFinNoteHTML();
  }
  function simFinNoteHTML() {
    const S = app.sim, sm = S.lastSummary;
    if (!sm || !sm.missingFinal) return '<div id="sim-finnote"></div>';
    const canRe = SIM.missingFinals(S.recs, S.rules).length;
    return `<div id="sim-finnote"><p class="sim-note warn">この点数だと決勝の顔ぶれが変わる大会が${sm.missingFinal}回あります。その大会は決勝の結果がないので、優勝・賞金・決勝の数字から除いています。${canRe ? '' : '（見本・保存した記録には予選の後の状態がないので、回し直すには ▶ 実行 してください）'}</p>${canRe && !S.run && !S.refinal ? `<div class="row" style="margin-top:6px"><button class="btn" data-act="sim-refinal">決勝を回し直す（${canRe}試合）</button></div>` : ''}</div>`;
  }
  function renderSim() {
    const S = simInit();
    const src = S.source;
    const srcText = !src ? 'データがありません。▶ 実行で回してください。'
      : src.kind === 'sample' ? `見本のデータ：CPUだけの大会 <b>${src.tours}</b>回（${esc(src.made || '')}）${src.stale ? `・ルールのバージョン${src.v}の記録です。実行し直してください` : ''}。▶ 実行で、この端末で新しく回せます。`
        : src.kind === 'saved' ? `前回この端末で回した記録：<b>${src.tours}</b>回（${esc(src.made || '')}）`
          : `いま回した記録：<b>${src.tours}</b>回${src.partial ? '（途中まで）' : ''}・${src.sec}秒`;
    const R = S.run || S.refinal;
    const out = simOutHTML();
    const r = S.rules;
    root.innerHTML = `
      <div class="wrap sim-screen">
        ${hudHTML('<span class="stat">SIMULATOR<b>CPUだけの大会</b></span>', '<button class="btn ghost" data-act="sim-back">タイトルへ</button>')}
        <div class="sim-head"><h2><small>SEARCH BATTLE SIMULATOR</small>シミュレーター</h2><p class="sim-src">${srcText}</p></div>
        <div class="sim-layout">
          <aside class="sim-side">
            <section class="panel" aria-labelledby="sim-run-h">
              <h3 class="ptitle" id="sim-run-h">大会を回す<small>RUN</small></h3>
              <div class="sim-field"><label for="sim-tours">大会の数（CPUだけ。4人のうち3人は性格つき）</label>
                <select id="sim-tours" class="sim-num" data-sim="tours">${[50, 100, 300, 1000].map((n) => `<option${n === S.tours ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
              <label class="sim-check"><input type="checkbox" id="sim-final" data-sim="final"${S.withFinal ? ' checked' : ''}> 決勝まで回す（時間は約2倍）</label>
              <div class="row" style="margin-top:10px">${R ? '<button class="btn" data-act="sim-stop">■ 止める</button>' : '<button class="btn primary" data-act="sim-run">▶ 実行</button>'}</div>
              ${R ? `<div class="sim-prog"><div class="sim-bar"><i id="sim-progbar"></i></div><span id="sim-progtext"></span></div>` : ''}
              <p class="sim-note" id="sim-runnote">${esc(S.runNote || '大会の数を選んで実行すると、この端末で計算します（パソコンなら300回で数分）。')}</p>
            </section>
            <section class="panel" aria-labelledby="sim-rule-h">
              <h3 class="ptitle" id="sim-rule-h">点数のルール<small>RULES</small></h3>
              <div class="sim-trio">
                <div class="sim-field"><label for="sim-start">はじめ</label><input class="sim-num" id="sim-start" data-sim="rule" type="number" step="1" value="${r.start}"></div>
                <div class="sim-field"><label for="sim-gems">宝石の数</label><input class="sim-num" id="sim-gems" data-sim="rule" type="number" min="0" max="9" step="1" value="${r.gems}"></div>
                <div class="sim-field"><label for="sim-gemPts">宝石1つ</label><input class="sim-num" id="sim-gemPts" data-sim="rule" type="number" min="0" step="1" value="${r.gemPts}"></div>
              </div>
              <span class="sim-lab">勝利点</span>
              <div class="sim-vic">${['予選1', '予選2', '予選3', '決勝'].map((lab, i) => `<div><input class="sim-num" id="sim-v${i}" data-sim="rule" type="number" step="1" value="${r.vic[i]}" aria-label="${lab}の勝利点"><span>${lab}</span></div>`).join('')}</div>
              <span class="sim-lab">スピードペナルティ（予選・負けた側の減点・決着したターン）</span>
              <div class="sim-vic sim-spd">${r.speed.slice(1).map((v, k) => k + 1).map((t) => `<div><input class="sim-num" id="sim-s${t}" data-sim="rule" type="number" min="0" step="1" value="${r.speed[t]}" aria-label="${t}ターン目に負けたときのスピードペナルティ"><span>${t}T</span></div>`).join('')}</div>
              <p class="sim-total" id="sim-tot">はじめの持ち点 <b>${SIM.startTotal(r)}</b>（${r.start}＋宝石${r.gems}×${r.gemPts}）</p>
              <div class="row"><button class="btn" data-act="sim-pin">比較表に追加</button><button class="btn ghost" data-act="sim-reset">ゲームの値に戻す</button></div>
              <p class="sim-note">試合の結果はそのままで、点数だけを当てはめ直します（CPUは持ち点を見ないので、試合の中身は変わりません）。</p>
              ${simFinNoteHTML()}
            </section>
          </aside>
          <main class="sim-main" id="sim-out" aria-live="polite">${out}</main>
        </div>
        <p class="sim-note">しくみ：ゲームと同じルールとCPUで、CPUだけの大会をこの端末の中で回します（端末のCPUを並列で使います）。点数のルールを変えると、記録した同じ試合結果で順位・決勝の顔ぶれ・賞金を数え直します。決勝の顔ぶれが変わった大会は、予選の後の状態から決勝だけを回し直せます。</p>
      </div>`;
    simProgress();
  }
  Object.assign(handlers, {
    'sim-open'() { simInit(); app.screen = 'sim'; app.modal = null; render(); window.scrollTo(0, 0); },
    // 計算の途中でも戻れる（計算は裏で続け、終わったら知らせる）
    'sim-back'() { app.screen = 'title'; app.modal = null; render(); window.scrollTo(0, 0); },
    'sim-run'() { simStart(); },
    'sim-stop'() { simStop(); },
    'sim-refinal'() { simRefinal(); },
    'sim-pin'() { const S = simInit(); if (!S.compare.some((r) => simKey(r) === simKey(S.rules))) S.compare.push(simClone(S.rules)); simStore.set('compare', S.compare); simRefresh(); },
    'sim-reset'() { const S = simInit(); S.rules = simClone(SIM.DEFAULT_RULES); simStore.set('rules', S.rules); renderSim(); },
    'sim-rm'(el) { const S = simInit(); S.compare = S.compare.filter((r) => simKey(r) !== el.dataset.k); simStore.set('compare', S.compare); simRefresh(); },
  });
  let simInputTimer = 0;
  root.addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el || !el.dataset || el.dataset.sim !== 'rule' || app.screen !== 'sim') return;
    simReadRules();
    clearTimeout(simInputTimer);
    simInputTimer = setTimeout(simRefresh, 120);
  });
  root.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!el || !el.dataset || app.screen !== 'sim') return;
    const S = simInit();
    if (el.dataset.sim === 'tours') S.tours = +el.value || 300;
    if (el.dataset.sim === 'final') S.withFinal = !!el.checked;
  });

  // ---------------- オンライン対戦（P2P・ホスト権威。しくみは net.js と docs/online.md） ----------------
  // 画面の流れ：タイトル（モード「オンライン対戦」）→ ロビー（部屋を作る／コードで入る）→ つながる → 配置 → 対戦 → 結果。
  //  ホストの端末：本当の対戦（app.game）を持ち、ゲストの操作は net.js の Host が実行して、画面は netRefresh で描き直す。
  //  ゲストの端末：app.game は、ホストから届いた（伏せた）スナップショット。届くたびに差し替えて netGuestState で描く。

  // 配置を終えた（ゲストは送った）ので、相手を待っているあいだか
  function netSetupLocked() {
    const g = G();
    if (!app.net || !g || g.phase !== 'setup') return false;
    const gu = netGuest();
    return g.players[app.net.seat].setupDone || !!(gu && gu.setupSent);
  }
  // 相手が配置を終えたか（ゲストには相手の盤面が届かないので、net.js の Guest が覚えている）
  function netFoeReady() {
    const g = G(), gu = netGuest();
    if (!app.net || !g) return false;
    return gu ? gu.foeReady : g.players[1 - app.net.seat].setupDone;
  }
  function openLobby() {
    app.tour = null; app.game = null; app.ui = null; app.modal = null;
    app.lobby = { st: 'idle' };
    app.screen = 'lobby';
    render(); window.scrollTo(0, 0);
  }
  // 名前の入力欄の中身を設定に残す（次に開いたときも同じ名前）
  function lobbyName() {
    const el = document.getElementById('net-name');
    if (el) { app.settings.netName = el.value; store.set('settings', app.settings); }
    return app.settings.netName;
  }
  // ホスト：部屋を作る。コードが決まったら画面に出し、相手がつないでくるのを待つ
  //  （L＝この試みの状態。やめたあとに古い知らせが届いても無視できるよう、app.lobby と同じものかを確かめる）
  function lobbyCreate() {
    if (!app.lobby || app.lobby.st !== 'idle') return;
    const name = lobbyName();
    const L = app.lobby = { st: 'opening' };
    render();
    L.room = NET.openRoom({
      onOpen(code) { if (app.lobby !== L) return; L.st = 'hosting'; L.code = code; render(); },
      onGuest(link) { if (app.lobby !== L) { link.close({ t: 'bye' }); return; } netStartHost(link, name); },
      onError(text) { if (app.lobby !== L) return; app.lobby = { st: 'idle', err: text }; render(); },
    });
  }
  // ゲスト：コードを入れて部屋に入る
  function lobbyJoin() {
    if (!app.lobby || app.lobby.st !== 'idle') return;
    const name = lobbyName();
    const el = document.getElementById('net-code');
    const code = NET.normCode(el ? el.value : '');
    if (!code) { toast(`部屋のコード（${NET.CODE_LEN}文字の英数字）を入れてください`, 'warn'); if (el) el.focus(); return; }
    const L = app.lobby = { st: 'joining', code };
    render();
    L.join = NET.joinRoom(code, {
      onLink(link) { if (app.lobby !== L) { link.close({ t: 'bye' }); return; } netStartGuest(link, name); },
      onError(text) { if (app.lobby !== L) return; app.lobby = { st: 'idle', err: text, code }; render(); },
    });
  }
  function lobbyCancel() {
    const L = app.lobby;
    if (L && L.room) L.room.close();
    if (L && L.join) L.join.close();
    app.lobby = { st: 'idle', code: L && L.st === 'joining' ? L.code : undefined };
    render();
  }
  function netCopyCode() {
    const L = app.lobby;
    if (!L || !L.code) return;
    const ng = () => toast('コピーできませんでした。コードを書き写してください', 'warn');
    try { navigator.clipboard.writeText(L.code).then(() => toast('コードをコピーしました', 'note'), ng); } catch (e) { ng(); }
  }

  // 相手がつながった（ホスト）：審判の役（Host）を作り、届いたメッセージを渡す。
  //  試合はホストの設定（ルール・アイテム）で作る。ゲストの hello が届くと、Host が最初の試合を作って welcome を送る
  function netStartHost(link, name) {
    const N = app.net = { role: 'host', seat: NET.HOST_SEAT, link, foe: null, gone: false };
    app.lobby.st = 'linked';
    N.host = new NET.Host({
      name,
      send: (m) => link.send(m),
      makeGame: (names) => {
        const s = app.settings;
        return new E.Game({
          rules: s.rules === 'final' ? 'final' : 'prelim', mode: 'online', label: 'オンライン', names, cpu: [false, false],
          items: itemsForMatch(), draftEach: s.items === 'draft' ? s.draftN : 0,
        });
      },
      on: {
        guest(nm) { N.foe = nm; toast(`${nm}が入りました`, 'note', true); },
        match(g) { if (app.replay) closeReplay(); app.game = g; beginMatchUI(); },
        change() { if (app.net === N) netRefresh(); },
        bye(reason) { netGone(reason); },
      },
    });
    link.onmessage = (m) => { if (app.net === N) N.host.receive(m); };
    link.onclose = (reason) => { if (app.net === N) netGone(reason); };
    render();
  }
  // 部屋に入れた（ゲスト）：ゲストの役（Guest）を作り、hello を送る（ホストが試合を作って welcome を返す）
  function netStartGuest(link, name) {
    const N = app.net = { role: 'guest', seat: NET.GUEST_SEAT, link, foe: null, gone: false };
    app.lobby.st = 'linked';
    N.guest = new NET.Guest({
      name,
      send: (m) => link.send(m),
      on: {
        welcome(g) { N.foe = g.players[1 - N.seat].name; netGuestWelcome(g); },
        state(g) { netGuestState(g); },
        foeReady() { if (app.screen === 'setup') render(); },
        reject(m) { toast(m.reason || 'その操作はできませんでした', 'warn'); render(); },
        bye(reason) { netGone(reason); },
      },
    });
    link.onmessage = (m) => { if (app.net === N) N.guest.receive(m); };
    link.onclose = (reason) => { if (app.net === N) netGone(reason); };
    N.guest.hello();
    render();
  }
  // ゲスト：新しい試合が届いた（最初の試合と「もう一度」）。配置は手元の対戦の中で行う
  function netGuestWelcome(g) {
    if (app.replay) closeReplay();
    const again = !!app.game;
    app.game = g;
    beginMatchUI();
    if (again) toast(`${app.net.foe}が次の試合を始めました`, 'note', true);
  }
  // ゲスト：ホストから新しい状態が届いた。手元の対戦を差し替えて、新しい演出だけを見せる
  //  （演出は「どこまで見せたか」を番号 app.fxSeen で覚えているので、届いた記録の続きから再生される）
  function netGuestState(g) {
    const prev = app.game;
    app.game = g;
    if (app.screen === 'setup') { if (g.phase === 'setup') render(); else enterAfterSetup(); return; }
    if (app.screen === 'draft') { if (g.phase === 'play') enterBattle(); else render(); return; }
    if (app.screen !== 'battle') { render(); return; }
    const me = app.net.seat;
    if (g.phase === 'play' && g.sub === 'sacrifice' && g.pending && g.pending.who === me && !(prev && prev.sub === 'sacrifice')) {
      toast('アンサー失敗！手番が終了します。差し出すキューブを選んでください', 'warn', true);
    }
    afterHuman();
  }
  // ホスト：ゲストの操作（配置・ドラフト・対戦）を実行したあと、画面を描き直す
  function netRefresh() {
    const g = app.game;
    if (!g) return;
    if (app.screen === 'setup') { if (g.phase === 'setup') render(); else enterAfterSetup(); return; }
    if (app.screen === 'draft') { if (g.phase === 'play') enterBattle(); else render(); return; }
    if (app.screen === 'battle') afterHuman(); else render();
  }
  const BYE_TEXT = {
    version: '相手とゲームの版が違います。両方ともページを読み込み直してから、もう一度つないでください',
    full: 'その部屋はもう対戦中です',
    timeout: '相手との通信が途切れました',
    left: '相手が退出しました',
  };
  // 相手が抜けた・通信が切れた
  function netGone(reason) {
    const N = app.net;
    if (!N || N.gone) return;
    N.gone = true;
    N.link.close();
    const text = BYE_TEXT[reason] || '相手との接続が切れました';
    const g = app.game;
    // 決着のあとなら、結果・リプレイ・答え合わせはそのまま見られるようにする
    if (g && g.phase === 'over' && app.screen === 'battle') { toast(text, 'warn', true); render(); return; }
    netLeave(text, !g);   // 試合が始まる前なら、ロビーに戻る
  }
  // 部屋を出る（自分でやめたとき・相手が抜けたとき）。相手にはまだつながっていれば bye を送る
  function netLeave(text, toLobby) {
    const N = app.net, L = app.lobby;
    app.net = null;
    if (N && N.link) N.link.close(N.gone ? null : { t: 'bye' });
    if (L && L.room) L.room.close();
    if (L && L.join) L.join.close();
    if (app.replay) closeReplay();
    app.lobby = null; app.game = null; app.ui = null; app.modal = null; app.busy = false;
    if (toLobby) { openLobby(); app.lobby.err = text || null; render(); return; }
    app.screen = 'title';
    render(); window.scrollTo(0, 0);
    if (text) toast(text, 'warn', true);
  }
  function netQuitModal() {
    return `<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="nquit-h">
      <div class="panel dialog">
        <h2 id="nquit-h" class="verdict-sub">対戦をやめて部屋を出ますか？</h2>
        <p class="note">相手との接続が切れ、この試合は終わります。</p>
        <div class="row"><button class="btn fire" data-act="net-quit">部屋を出る</button><button class="btn" data-act="close-modal">続ける</button></div>
      </div>
    </div>`;
  }
  // ロビーの画面
  function renderLobby() {
    const s = app.settings, L = app.lobby || { st: 'idle' }, N = app.net;
    const rulesTxt = `${s.rules === 'final' ? '5×5（トレジャー5回）' : '4×4（トレジャー4回）'}・アイテム：${s.items === 'draft' ? `ドラフト（1人${s.draftN}個）` : s.items === 'random' ? `ランダム（毎試合${s.randomN}種）` : `${pickedItems().length}種`}`;
    let body;
    if (!NET.supported()) {
      // claude.ai の公開ページなど、通信が止められているページでは、遊べるページ（GitHub Pages 版）を案内する
      body = `<div class="lob-wait lob-blocked">
          <p class="note warn lob-err">このページではオンライン対戦を使えません。claude.ai の公開ページは、安全のため端末どうしの通信が止められています。</p>
          <p class="note">GitHub Pages 版のサーチバトルを開いて、2人ともそちらで遊んでください。</p>
          <a class="btn primary" href="${esc(NET.PLAY_URL)}" target="_blank" rel="noopener">GitHub Pages 版を開く</a>
          <p class="note lob-url">${esc(NET.PLAY_URL)}</p>
        </div>`;
    } else if (N) {
      const t = N.role === 'host' ? (N.foe ? `${esc(N.foe)}が入りました。準備しています` : '相手とつながりました。準備しています') : '部屋に入りました。準備しています';
      body = `<div class="lob-wait"><p class="prompt net-wait">${t}</p></div>`;
    } else if (L.st === 'opening') {
      body = '<div class="lob-wait"><p class="prompt net-wait">部屋を作っています</p><button class="btn ghost" data-act="net-cancel">やめる</button></div>';
    } else if (L.st === 'hosting') {
      body = `<div class="lob-wait">
          <p class="note">このコードを相手に伝えてください（LINE など）。相手が「部屋に入る」に入力すると、つながります。</p>
          <div class="room-code" aria-label="部屋のコード ${esc(L.code.split('').join(' '))}">${esc(L.code)}</div>
          <div class="row"><button class="btn" data-act="net-copy">コードをコピー</button><button class="btn ghost" data-act="net-cancel">部屋を閉じる</button></div>
          <p class="prompt net-wait">相手を待っています</p>
          <p class="note">試合の設定：${esc(rulesTxt)}</p>
        </div>`;
    } else if (L.st === 'joining') {
      body = `<div class="lob-wait"><p class="prompt net-wait">部屋 ${esc(L.code)} に接続しています</p><button class="btn ghost" data-act="net-cancel">やめる</button></div>`;
    } else {
      body = `
        ${L.err ? `<p class="note warn lob-err" role="alert">${esc(L.err)}</p>` : ''}
        <label class="lob-field"><span>あなたの名前（相手の画面に出ます。12文字まで）</span><input id="net-name" class="lob-input" type="text" maxlength="12" autocomplete="nickname" placeholder="例：たろう" value="${esc(s.netName || '')}"></label>
        <div class="lob-grid">
          <section class="lob-card">
            <h3>部屋を作る</h3>
            <p class="note">あなたの端末が審判になります。試合の設定はタイトルで選んだもの：<b>${esc(rulesTxt)}</b></p>
            <button class="btn primary" data-act="net-create">部屋を作る</button>
          </section>
          <section class="lob-card enemy">
            <h3>部屋に入る</h3>
            <label class="lob-field"><span>部屋のコード（${NET.CODE_LEN}文字）</span><input id="net-code" class="lob-input code" type="text" maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="K7P2QX" value="${esc(L.code || '')}"></label>
            <button class="btn primary" data-act="net-join">入る</button>
          </section>
        </div>
        <p class="note">知り合いどうしで遊ぶためのしくみです。つなぐときだけ PeerJS の無料サービスを使い、試合のデータは端末どうしで直接やりとりします。会社や学校のネットワークなど、つながらない回線もあります。</p>`;
    }
    root.innerHTML = `
      <div class="wrap lobby">
        ${hudHTML('<span class="stat">ONLINE<b>対戦</b></span>', '<button class="btn ghost" data-act="to-title">戻る</button>')}
        <section class="panel lobby-panel" aria-label="オンライン対戦">
          <h2 class="ptitle">オンライン対戦<small>ONLINE BATTLE</small></h2>
          ${body}
        </section>
      </div>`;
  }
  // 名前を打つたびに残す・コードの欄で Enter を押したら入る
  root.addEventListener('input', (ev) => {
    if (ev.target && ev.target.id === 'net-name') { app.settings.netName = ev.target.value; store.set('settings', app.settings); }
  });
  root.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'net-code') { ev.preventDefault(); lobbyJoin(); }
  });
  // ページを閉じるときは、相手に「抜けた」と伝える（届かないこともあるので、相手側は合図が途切れたことでも気づく）
  window.addEventListener('pagehide', () => { if (app.net && app.net.link) app.net.link.send({ t: 'bye' }); });

  // ---------------- 公開ページの更新時に状態を引き継ぐ ----------------
  function snapshot() {
    try {
      // オンライン対戦は通信が切れるので引き継がない（タイトルから）
      if (app.net || app.lobby) return JSON.parse(JSON.stringify({ screen: 'title', settings: app.settings }));
      const g = app.game;
      const gd = g ? Object.assign({}, g) : null;
      if (gd) delete gd.rng;
      return JSON.parse(JSON.stringify({ screen: app.screen, settings: app.settings, setup: app.setup, ui: app.ui, game: gd, tour: app.tour }));
    } catch (e) { console.warn('snapshot failed', e); return {}; }
  }
  function restore(data) {
    try {
      if (!data || !data.screen) return false;
      app.settings = migrateSettings(Object.assign(app.settings, data.settings || {}));
      // ルールの形が違う古い対戦は引き継がない（新しいルールで途中から動かすと盤面が食い違うため）
      const ok = data.game && data.game.v === E.VERSION;
      const tourOK = !!(data.tour && data.tour.v === E.VERSION);
      app.tour = tourOK ? data.tour : null;
      if (data.tour && !tourOK) app.notice = 'ルールが更新されたため、大会を最初からやり直してください';
      if (ok) {
        const g = Object.create(E.Game.prototype);
        Object.assign(g, data.game);
        g.rng = Math.random;
        if (!g.events) g.events = [];
        app.game = g;
        app.fxSeen = g.events.length;
      } else if (data.game) {
        console.warn('restore skipped: version', data.game.v, 'expected', E.VERSION);
        app.notice = 'ルールが更新されたため、対戦を最初からやり直してください';
      }
      app.screen = data.screen === 'tour' ? (tourOK ? 'tour' : 'title') : data.screen === 'sim' ? 'sim' : (ok ? data.screen : 'title');
      // 大会の試合の途中で大会の記録がなければ、ふつうの対戦として続ける
      if (app.screen === 'title') app.tour = null;
      app.setup = data.setup;
      app.ui = Object.assign(freshUI(), data.ui || {});
      return true;
    } catch (e) { console.warn('restore failed', e); return false; }
  }

  function start(data) {
    restore(data || {});
    SND.setMode(app.settings.sound);
    app.busy = false;
    render();
    if (app.notice) { toast(app.notice, 'warn', true); app.notice = null; }
    if (app.screen === 'draft') runDraftCPU();
    if (app.screen === 'battle') kick();
  }
  if (window.claude && window.claude.hot && window.claude.hot.snapshot) {
    try { window.claude.hot.snapshot(snapshot); } catch (e) { /* なくても動く */ }
  }
  if (window.claude && window.claude.hot && window.claude.hot.ready) window.claude.hot.ready(start);
  else start((window.claude && window.claude.hot && window.claude.hot.data) || {});

  window.__sb = { app, render, handlers };
})();
