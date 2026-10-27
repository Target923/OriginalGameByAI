/**
 * Full Runtime E2E Integration Test for imagine_tile.html
 * Executes the actual <script> of imagine_tile.html inside isolated browser-like VM contexts
 * connected via real Node.js BroadcastChannel (?net=local).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { BroadcastChannel } = require('worker_threads');

const HTML_PATH = 'C:\\Users\\岡本\\Desktop\\ai_game\\imagine_tile.html';
const rawHtml = fs.readFileSync(HTML_PATH, 'utf8');

// Extract all element IDs from HTML so getElementById always finds real elements present in imagine_tile.html
const allHtmlIds = [...rawHtml.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const scriptMatch = rawHtml.match(/<script>([\s\S]*?)<\/script>/i);
assert.ok(scriptMatch, 'imagine_tile.html must contain <script>');
const inlineScript = scriptMatch[1];

function createBrowserSandbox(urlSearch = '?net=local') {
  const elementsById = new Map();
  const bodyChildren = [];
  const docListeners = {};
  const winListeners = {};

  function makeClassList(el) {
    const getSet = () => new Set((el.className || '').split(/\s+/).filter(Boolean));
    const sync = (s) => { el.className = [...s].join(' '); };
    return {
      add(...cls) { const s = getSet(); cls.forEach(c => c && s.add(c)); sync(s); },
      remove(...cls) { const s = getSet(); cls.forEach(c => s.delete(c)); sync(s); },
      toggle(c, force) {
        const s = getSet();
        const on = force !== undefined ? !!force : !s.has(c);
        if (on) s.add(c); else s.delete(c);
        sync(s);
        return on;
      },
      contains(c) { return getSet().has(c); }
    };
  }

  function makeStyle() {
    const st = {
      display: '',
      opacity: '1',
      width: '400px',
      height: '400px',
      setProperty(k, v) { st[k] = v; },
      getPropertyValue(k) { return st[k] || ''; }
    };
    return st;
  }

  function createCtx2D() {
    return new Proxy({}, {
      get(target, prop) {
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
          return () => ({ addColorStop() {} });
        }
        if (prop === 'measureText') return () => ({ width: 40 });
        if (prop in target) return target[prop];
        return () => {};
      },
      set(target, prop, val) { target[prop] = val; return true; }
    });
  }

  function registerIdsFromHtml(htmlStr) {
    if (!htmlStr) return;
    const matches = htmlStr.matchAll(/\bid="([^"]+)"/g);
    for (const m of matches) {
      const id = m[1];
      if (!elementsById.has(id)) {
        const el = makeElement('div', id);
        // Check if value="..." exists near id
        elementsById.set(id, el);
      }
    }
  }

  function makeElement(tag = 'div', id = '') {
    const el = {
      tagName: String(tag).toUpperCase(),
      id: id || '',
      className: '',
      dataset: {},
      style: makeStyle(),
      children: [],
      parentNode: null,
      value: '',
      disabled: false,
      checked: false,
      textContent: '',
      _innerHTML: '',
      offsetWidth: 420,
      offsetHeight: 420,
      width: 800,
      height: 600,
      naturalWidth: 800,
      complete: true,
      _listeners: {},
      addEventListener(ev, fn) {
        (el._listeners[ev] = el._listeners[ev] || []).push(fn);
      },
      removeEventListener(ev, fn) {
        if (el._listeners[ev]) el._listeners[ev] = el._listeners[ev].filter(x => x !== fn);
      },
      appendChild(child) {
        if (!child) return child;
        if (child._isFragment) {
          child.children.forEach(c => el.appendChild(c));
          child.children = [];
          return child;
        }
        child.parentNode = el;
        el.children.push(child);
        if (child.id) elementsById.set(child.id, child);
        return child;
      },
      remove() {
        if (el.parentNode && el.parentNode.children) {
          el.parentNode.children = el.parentNode.children.filter(c => c !== el);
        }
      },
      removeAttribute(attr) { delete el[attr]; },
      setAttribute(attr, v) { el[attr] = String(v); if (attr === 'id') { el.id = String(v); elementsById.set(el.id, el); } },
      getAttribute(attr) { return el[attr] || null; },
      getBoundingClientRect() { return { left: 100, top: 100, width: 420, height: 420, right: 520, bottom: 520 }; },
      getContext() { return createCtx2D(); },
      focus() { documentObj.activeElement = el; },
      blur() { if (documentObj.activeElement === el) documentObj.activeElement = documentObj.body; },
      play() { return Promise.resolve(); },
      pause() {},
      load() {},
      decode() { return Promise.resolve(); },
      closest(sel) {
        if (sel === '.tile' && el.classList.contains('tile')) return el;
        return null;
      },
      querySelector(sel) {
        return queryInTree(el, sel)[0] || null;
      },
      querySelectorAll(sel) {
        return queryInTree(el, sel);
      }
    };
    el.classList = makeClassList(el);
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._innerHTML; },
      set(v) {
        el._innerHTML = String(v || '');
        el.children = [];
        registerIdsFromHtml(el._innerHTML);
      }
    });
    if (id) elementsById.set(id, el);
    return el;
  }

  function matchesSimpleSelector(el, sel) {
    if (!el || !el.classList) return false;
    if (sel.startsWith('#')) return el.id === sel.slice(1);
    if (sel === '.tile:not(.revealed)') return el.classList.contains('tile') && !el.classList.contains('revealed');
    if (sel.startsWith('.tile[data-i="')) {
      const m = sel.match(/data-i="(\d+)"/);
      return el.classList.contains('tile') && m && String(el.dataset.i) === m[1];
    }
    if (sel.startsWith('.')) {
      const classes = sel.slice(1).split('.');
      return classes.every(c => el.classList.contains(c));
    }
    return el.tagName === sel.toUpperCase();
  }

  function queryInTree(root, sel) {
    // Handle '.cslot:nth-child(N) .sub' used by updateStripLight / getCarCenter
    const nthMatch = sel.match(/^\.cslot:nth-child\((\d+)\)\s+(.+)$/);
    if (nthMatch) {
      const idx = parseInt(nthMatch[1], 10) - 1;
      const strip = elementsById.get('strip');
      if (!strip || !strip.children[idx]) return [];
      return queryInTree(strip.children[idx], nthMatch[2].trim());
    }
    const out = [];
    function walk(node) {
      if (!node || !node.children) return;
      for (const ch of node.children) {
        if (matchesSimpleSelector(ch, sel)) out.push(ch);
        walk(ch);
      }
    }
    walk(root);
    return out;
  }

  const hudMock = makeElement('div');
  hudMock.className = 'hud';
  hudMock.offsetWidth = 1280;
  hudMock.offsetHeight = 42;
  const sbarMock = makeElement('div');
  sbarMock.className = 'sbar';
  sbarMock.offsetWidth = 1280;
  sbarMock.offsetHeight = 18;
  const olBoxMock = makeElement('div');
  olBoxMock.className = 'ol-box';
  olBoxMock.offsetWidth = 760;
  olBoxMock.offsetHeight = 540;
  const spBoxMock = makeElement('div');
  spBoxMock.className = 'sp-box';
  spBoxMock.offsetWidth = 420;
  spBoxMock.offsetHeight = 500;
  const cmBoxMock = makeElement('div');
  cmBoxMock.className = 'cm-box';
  cmBoxMock.offsetWidth = 650;
  cmBoxMock.offsetHeight = 640;
  const bmBoxMock = makeElement('div');
  bmBoxMock.className = 'bm-box';
  bmBoxMock.offsetWidth = 600;
  bmBoxMock.offsetHeight = 420;
  const pmBoxMock = makeElement('div');
  pmBoxMock.className = 'pm-box';
  pmBoxMock.offsetWidth = 340;
  pmBoxMock.offsetHeight = 320;
  const gosInnerMock = makeElement('div');
  gosInnerMock.className = 'gos-inner';
  gosInnerMock.offsetWidth = 500;
  gosInnerMock.offsetHeight = 460;
  const mciMock = makeElement('div');
  mciMock.className = 'mci';
  mciMock.offsetWidth = 520;
  mciMock.offsetHeight = 420;

  const documentObj = {
    body: makeElement('body', 'body'),
    head: makeElement('head', 'head'),
    documentElement: makeElement('html', 'html'),
    activeElement: null,
    getElementById(id) {
      if (!elementsById.has(id)) {
        // Lazily create if needed
        makeElement('div', id);
      }
      return elementsById.get(id);
    },
    createElement(tag) {
      if (tag === 'canvas') return makeElement('canvas');
      if (tag === 'input') return makeElement('input');
      if (tag === 'button') return makeElement('button');
      return makeElement(tag);
    },
    createDocumentFragment() {
      return { _isFragment: true, children: [], appendChild(c) { this.children.push(c); return c; } };
    },
    querySelector(sel) {
      if (sel === '.hud') return hudMock;
      if (sel === '.sbar') return sbarMock;
      if (sel === '.ol-box') return olBoxMock;
      if (sel === '.sp-box') return spBoxMock;
      if (sel === '.cm-box') return cmBoxMock;
      if (sel === '.bm-box') return bmBoxMock;
      if (sel === '.pm-box') return pmBoxMock;
      if (sel === '.gos-inner') return gosInnerMock;
      if (sel === '.mci') return mciMock;
      if (sel.startsWith('#') && elementsById.has(sel.slice(1))) return elementsById.get(sel.slice(1));
      const strip = elementsById.get('strip');
      if (strip) {
        const r = queryInTree(strip, sel);
        if (r.length) return r[0];
      }
      const bd = elementsById.get('board');
      if (bd) {
        const r = queryInTree(bd, sel);
        if (r.length) return r[0];
      }
      return makeElement('div');
    },
    querySelectorAll(sel) {
      if (sel === '.cslot') {
        const strip = elementsById.get('strip');
        return strip ? strip.children : [];
      }
      const bd = elementsById.get('board');
      if (bd && sel.includes('tile')) return queryInTree(bd, sel);
      return [];
    },
    addEventListener(ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); }
  };
  documentObj.activeElement = documentObj.body;

  // Pre-populate all real HTML IDs with realistic layout metrics
  for (const id of allHtmlIds) {
    const tag = id.includes('canvas') || id === 'stars' || id === 'fx' ? 'canvas' : id.includes('inp') ? 'input' : 'div';
    const el = makeElement(tag, id);
    if (id === 'game' || id === 'gos' || id === 'mcs' || id === 'settings' || id === 'custom-mode-panel') {
      el.style.display = 'none';
    }
    if (id === 'lpanel' || id === 'rpanel') { el.offsetWidth = 160; el.offsetHeight = 520; }
    if (id === 'strip') { el.offsetWidth = 1280; el.offsetHeight = 118; }
    if (id === 'iw') { el.offsetWidth = 540; el.offsetHeight = 680; }
    if (id === 'online-lobby') el.appendChild(olBoxMock);
    if (id === 'settings') el.appendChild(spBoxMock);
    if (id === 'custom-mode-panel') el.appendChild(cmBoxMock);
    if (id === 'bonus-modal') el.appendChild(bmBoxMock);
    if (id === 'pause-modal') el.appendChild(pmBoxMock);
    if (id === 'gos') el.appendChild(gosInnerMock);
    if (id === 'mcs') el.appendChild(mciMock);
  }

  // Storage mock
  const store = new Map();
  const localStorageMock = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); }
  };

  // Timer tracking so we can clean up intervals on teardown
  const activeIntervals = new Set();
  const activeTimeouts = new Set();
  function wrappedSetInterval(fn, ms) {
    const id = setInterval(fn, ms);
    activeIntervals.add(id);
    return id;
  }
  function wrappedClearInterval(id) {
    activeIntervals.delete(id);
    clearInterval(id);
  }
  function wrappedSetTimeout(fn, ms) {
    const effMs = (ms >= 900 && ms <= 2500) ? 35 : ms;
    const id = setTimeout(() => {
      activeTimeouts.delete(id);
      fn();
    }, effMs);
    activeTimeouts.add(id);
    return id;
  }
  function wrappedClearTimeout(id) {
    activeTimeouts.delete(id);
    clearTimeout(id);
  }

  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Set,
    Map,
    Promise,
    Uint32Array,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    queueMicrotask,
    BroadcastChannel,
    performance: { now: () => Date.now() },
    localStorage: localStorageMock,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    location: { search: urlSearch, href: 'http://localhost/imagine_tile.html' + urlSearch },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    document: documentObj,
    Image: function () {
      const im = makeElement('img');
      Object.defineProperty(im, 'src', {
        get() { return im._src || ''; },
        set(v) {
          im._src = v;
          if (im.onload) wrappedSetTimeout(() => { if (im.onload) im.onload(); }, 2);
        }
      });
      return im;
    },
    AudioContext: function () {
      const makeParam = () => ({ value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} });
      const makeNode = () => ({ gain: makeParam(), frequency: makeParam(), detune: makeParam(), type: 'sine', buffer: null, connect() {}, start() {}, stop() {} });
      return {
        currentTime: 0,
        sampleRate: 44100,
        state: 'running',
        destination: {},
        resume() { return Promise.resolve(); },
        createGain: makeNode,
        createOscillator: makeNode,
        createBiquadFilter: makeNode,
        createBufferSource: makeNode,
        createBuffer: (_ch, len) => ({ getChannelData: () => new Float32Array(Math.max(1, len | 0)) })
      };
    },
    webkitAudioContext: undefined,
    fetch: () => Promise.reject(new Error('offline test')),
    alert: () => {},
    confirm: () => true,
    requestAnimationFrame: (cb) => wrappedSetTimeout(() => cb(Date.now()), 16),
    cancelAnimationFrame: (id) => wrappedClearTimeout(id),
    setInterval: wrappedSetInterval,
    clearInterval: wrappedClearInterval,
    setTimeout: wrappedSetTimeout,
    clearTimeout: wrappedClearTimeout,
    addEventListener(ev, fn) { (winListeners[ev] = winListeners[ev] || []).push(fn); }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(inlineScript, ctx, { filename: 'imagine_tile.inline.js' });

  // Speed up travel & intro animations for fast deterministic E2E testing!
  vm.runInContext(`
    showTravelAnim = function(lvIdx, onDone) { if (onDone) setTimeout(onDone, 10); };
    showQIntro = function(qn, hint, onDone) { if (onDone) setTimeout(onDone, 10); };
    laserFire = function(x1, y1, x2, y2, col, onDone) { if (onDone) setTimeout(onDone, 5); };
  `, ctx);

  return {
    ctx,
    eval: (code) => {
      const r = vm.runInContext(code, ctx);
      return (r && typeof r === 'object') ? JSON.parse(JSON.stringify(r)) : r;
    },
    destroy() {
      try { vm.runInContext(`if (typeof cleanupOnlineConnectionsOnly === 'function') cleanupOnlineConnectionsOnly();`, ctx); } catch (e) {}
      for (const id of activeIntervals) clearInterval(id);
      for (const id of activeTimeouts) clearTimeout(id);
      activeIntervals.clear();
      activeTimeouts.clear();
    }
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitUntil(fn, timeoutMs = 4000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

async function main() {
  console.log('=== [E2E-1] オフライン自由編成 (3機編成) ＆ Q3突破ボーナス個別選択テスト ===');
  const soloTab = createBrowserSandbox('');
  try {
    // Default bonusEnergy must be 50
    assert.strictEqual(soloTab.eval('SETTINGS.bonusEnergy'), 50, 'Default bonusEnergy must be 50');

    // Verify viewport-height scaling on Title Screen (#intro > #iw)
    soloTab.eval(`
      window.innerWidth = 1280;
      window.innerHeight = 500;
      fitViewportLayout();
    `);
    const shortIntroTf = soloTab.eval(`document.getElementById('iw').style.transform`);
    assert.ok(shortIntroTf.startsWith('scale(0.'), `Short viewport should scale down #iw, got: ${shortIntroTf}`);

    soloTab.eval(`
      window.innerWidth = 1920;
      window.innerHeight = 1080;
      fitViewportLayout();
    `);
    const tallIntroTf = soloTab.eval(`document.getElementById('iw').style.transform`);
    assert.ok(tallIntroTf.startsWith('scale(1.'), `Tall viewport should scale up #iw, got: ${tallIntroTf}`);
    soloTab.eval(`window.innerWidth = 1280; window.innerHeight = 800; fitViewportLayout();`);

    // Toggle off unit 1 and unit 3 -> remaining [0, 2, 4] (PILOT, HACKER, LEADER)
    soloTab.eval(`
      setPlayStyle('team');
      selectSoloUnit(1); // turn off ENGNR
      selectSoloUnit(3); // turn off SNIPER
    `);
    const selUnits = soloTab.eval('Array.from(currentSelectedUnits)');
    assert.deepStrictEqual(selUnits, [0, 2, 4], 'Should have 3 units [0, 2, 4] selected');
    assert.strictEqual(soloTab.eval('currentPlayStyle'), 'custom_units');

    // Test setSettingDirect up to 5000 and test initCore = 15 split among 3 units
    soloTab.eval(`
      setSettingDirect('initCore', 5000);
      setSettingDirect('initEnergy', 5000);
      setSettingDirect('clearEnergy', 5000);
      setSettingDirect('bonusEnergy', 5000);
    `);
    assert.strictEqual(soloTab.eval('SETTINGS.initCore'), 5000);
    assert.strictEqual(soloTab.eval('SETTINGS.initEnergy'), 5000);
    assert.strictEqual(soloTab.eval('SETTINGS.clearEnergy'), 5000);
    assert.strictEqual(soloTab.eval('SETTINGS.bonusEnergy'), 5000);

    // Reset settings for standard scenario (with initCore = 15)
    soloTab.eval(`
      setSettingDirect('initCore', 15);
      setSettingDirect('initEnergy', 50);
      setSettingDirect('clearEnergy', 25);
      setSettingDirect('bonusEnergy', 50);
    `);

    // Start Normal Game with 3 units
    soloTab.eval(`startGame('normal')`);
    await waitUntil(() => soloTab.eval('G.sz === 7 && G.tid !== null'), 2000, 'Offline Q1 loaded');

    assert.strictEqual(soloTab.eval('G.players.length'), 3);
    assert.deepStrictEqual(soloTab.eval('G.players.map(p => p.unitIdx)'), [0, 2, 4]);
    // 50 / 3 = ceil(16.66) = 17pt per unit!
    assert.deepStrictEqual(soloTab.eval('G.players.map(p => p.energy)'), [17, 17, 17]);
    // 15 initCore / 3 units = 5 cores per unit!
    assert.deepStrictEqual(soloTab.eval('G.players.map(p => p.core)'), [5, 5, 5]);
    // Answer cost on 7x7 with 3 units = ceil(7/3) = 3pt!
    assert.strictEqual(soloTab.eval('getAnsCost()'), 3);

    // Verify dynamic viewport-height board resizing (both shrinking on short window & expanding >620px on tall window without changing tile colors)
    const colorsBeforeResize = soloTab.eval('G.tileColors.slice(0, 5)');
    soloTab.eval(`
      window.innerWidth = 1280;
      window.innerHeight = 480;
      resizeBoardToViewport();
    `);
    const shortBoardPx = parseInt(soloTab.eval(`document.getElementById('bwrap').style.height`), 10);
    assert.ok(shortBoardPx > 120 && shortBoardPx <= 300, `Board should shrink cleanly on 480px height, got ${shortBoardPx}`);

    soloTab.eval(`
      window.innerWidth = 1600;
      window.innerHeight = 1100;
      resizeBoardToViewport();
    `);
    const tallBoardPx = parseInt(soloTab.eval(`document.getElementById('bwrap').style.height`), 10);
    assert.ok(tallBoardPx > 620, `Board should expand smoothly above 620px on tall 1100px window, got ${tallBoardPx}`);
    assert.deepStrictEqual(soloTab.eval('G.tileColors.slice(0, 5)'), colorsBeforeResize, 'Tile colors must remain unchanged during resize');
    soloTab.eval(`window.innerWidth = 1280; window.innerHeight = 800; resizeBoardToViewport();`);

    // Clear Q1, Q2, Q3 to reach Q4 (qi === 3) where Level Clear Bonus modal triggers!
    for (let qStep = 0; qStep < 3; qStep++) {
      await waitUntil(() => soloTab.eval(`G.qi === ${qStep} && !G.done`), 3000, `Offline Q${qStep + 1} ready`);
      soloTab.eval(`{
        const ans = QS[G.order[G.qi]].answer;
        document.getElementById('ainp-0').value = ans;
        submitAns(0);
      }`);
      if (qStep < 2) {
        await waitUntil(() => soloTab.eval(`G.qi === ${qStep + 1} && !G.done`), 3000, `Advance to Q${qStep + 2}`);
      }
    }

    // At Q4 (qi === 3), bonus-modal should become active!
    await waitUntil(() => soloTab.eval(`document.getElementById('bonus-modal').classList.contains('active')`), 3500, 'Offline Q4 bonus modal active');

    // Check individual choices: Unit 0 -> energy (+17pt), Unit 1 -> core (+💎6), Unit 2 -> core (+💎6)
    const beforeBonus = soloTab.eval('G.players.map(p => ({ en: p.energy, core: p.core }))');
    soloTab.eval(`
      toggleOfflinePlayerBonusType(0, 'energy');
      toggleOfflinePlayerBonusType(1, 'core');
      toggleOfflinePlayerBonusType(2, 'core');
      commitOfflineMultiBonus();
    `);
    const afterBonus = soloTab.eval('G.players.map(p => ({ en: p.energy, core: p.core }))');
    assert.strictEqual(afterBonus[0].en - beforeBonus[0].en, 17, 'Unit 0 should receive +17pt EN (ceil(50/3))');
    assert.strictEqual(afterBonus[1].core - beforeBonus[1].core, 6, 'Unit 1 should receive +6 Core (ceil(50/9))');
    assert.strictEqual(afterBonus[2].core - beforeBonus[2].core, 6, 'Unit 2 should receive +6 Core (ceil(50/9))');
    console.log('  ✔ PASS: オフライン3機自由編成・初期EN分配・回答コスト・Q3突破個別ボーナス選択');
  } finally {
    soloTab.destroy();
  }

  console.log('\n=== [E2E-2] オンライン3人協力マルチ (BroadcastChannel実通信・攻撃同期・非停止タイマー・途中切断引継・クリアボーナス) ===');
  const hostTab = createBrowserSandbox('?net=local');
  const guest1Tab = createBrowserSandbox('?net=local');
  const guest2Tab = createBrowserSandbox('?net=local');
  try {
    // 1. Host opens lobby and creates room
    hostTab.eval(`
      openOnlineLobby();
      document.getElementById('ol-name-inp').value = 'HostTaro';
      createOnlineRoom();
    `);
    await waitUntil(() => hostTab.eval(`NET.active && NET.role === 'host' && NET.roomCode.length === 6`), 2000, 'Host room created');
    const code = hostTab.eval('NET.roomCode');

    // Host starts on unit 0 (PILOT) by default
    assert.strictEqual(hostTab.eval(`NET.lobbyState.members[0].unitIdx`), 0, 'Host initially on unit 0');

    // 2. Guest 1 & Guest 2 join using the 6-char room code!
    guest1Tab.eval(`
      openOnlineLobby();
      document.getElementById('ol-name-inp').value = 'GuestHanako';
      document.getElementById('ol-code-inp').value = '${code}';
      joinOnlineRoomByInput();
    `);
    guest2Tab.eval(`
      openOnlineLobby();
      document.getElementById('ol-name-inp').value = 'GuestKen';
      document.getElementById('ol-code-inp').value = '${code}';
      joinOnlineRoomByInput();
    `);

    await waitUntil(() => hostTab.eval(`NET.lobbyState && NET.lobbyState.members.length === 3`), 2000, '3 players in lobby');
    await waitUntil(() => guest1Tab.eval(`NET.myPeerId !== null`) && guest2Tab.eval(`NET.myPeerId !== null`), 2000, 'Guests welcomed');

    // Initially Host=0, Guest1=1, Guest2=2 (or Guest2=1, Guest1=2).
    // First move Guest 2 to unit 4 (LEADER), then move Guest 1 to unit 2 (HACKER)!
    guest2Tab.eval(`pickOnlineLobbyUnit(4)`);
    await waitUntil(() => hostTab.eval(`NET.lobbyState.members.some(m => m.unitIdx === 4)`), 1500, 'Guest 2 picked unit 4');
    guest1Tab.eval(`pickOnlineLobbyUnit(2)`);
    await waitUntil(() => {
      const units = hostTab.eval(`NET.lobbyState.members.map(m => m.unitIdx).sort()`);
      return JSON.stringify(units) === '[0,2,4]';
    }, 2000, 'Units [0,2,4] synced');

    // Verify clicking own boarded unit again in lobby unselects it (unitIdx = -1) & displays #ol-unassigned-bar, then re-boarding restores ready!
    guest1Tab.eval(`pickOnlineLobbyUnit(2)`); // unselect own unit 2
    await waitUntil(() => (
      hostTab.eval(`NET.lobbyState.members.some(m => m.unitIdx === -1)`) &&
      guest1Tab.eval(`document.getElementById('ol-unassigned-bar').style.display === 'flex'`) &&
      hostTab.eval(`!NET.hostRoom.canStart().ok`)
    ), 1500, 'Guest 1 unselected unit 2 -> unassigned bar shown & start blocked');
    guest1Tab.eval(`pickOnlineLobbyUnit(2)`); // re-select unit 2
    await waitUntil(() => (
      hostTab.eval(`NET.hostRoom.canStart().ok`) &&
      guest1Tab.eval(`document.getElementById('ol-unassigned-bar').style.display === 'none'`)
    ), 1500, 'Guest 1 re-boarded unit 2 -> unassigned bar hidden & start enabled');

    // 3. Host starts online match!
    hostTab.eval(`hostStartOnlineMatch()`);
    await waitUntil(() => (
      hostTab.eval(`G.sz === 7 && G.tid !== null`) &&
      guest1Tab.eval(`G.sz === 7 && G.tid !== null`) &&
      guest2Tab.eval(`G.sz === 7 && G.tid !== null`)
    ), 3000, 'All 3 tabs started Q1');

    // Verify board & palette sync across Host, Guest 1, Guest 2
    assert.strictEqual(hostTab.eval('G.paletteSeed'), guest1Tab.eval('G.paletteSeed'), 'Palette seed must match');
    assert.strictEqual(JSON.stringify(hostTab.eval('G.tileColors.slice(0,5)')), JSON.stringify(guest2Tab.eval('G.tileColors.slice(0,5)')), 'Deterministic tile colors must match');
    assert.strictEqual(JSON.stringify(hostTab.eval('G.barrier')), JSON.stringify(guest1Tab.eval('G.barrier')), 'Cyber barriers must match');

    // Verify slot ownership locks:
    // Sorted units are [0 (Host, pi=0), 2 (Guest1, pi=1), 4 (Guest2, pi=2)]
    assert.strictEqual(hostTab.eval('canControlPlayer(0) && !canControlPlayer(1) && !canControlPlayer(2)'), true, 'Host controls only pi=0');
    assert.strictEqual(guest1Tab.eval('!canControlPlayer(0) && canControlPlayer(1) && !canControlPlayer(2)'), true, 'Guest1 controls only pi=1');
    assert.strictEqual(guest2Tab.eval('!canControlPlayer(0) && !canControlPlayer(1) && canControlPlayer(2)'), true, 'Guest2 controls only pi=2');

    // 4. Guest 1 fires SHOT (doRand(1)) -> Host executes -> All 3 tabs reveal the same tile & deduct 1pt!
    guest1Tab.eval(`doRand(1)`);
    await waitUntil(() => hostTab.eval('G.players[1].energy === 16') && guest2Tab.eval('G.players[1].energy === 16'), 2000, 'Guest 1 SHOT synced to all tabs');
    assert.strictEqual(
      hostTab.eval('G.rev.filter(Boolean).length + (isHazardOn() ? (Math.ceil(49*0.3) - G.barrier.filter(Boolean).length) : 0)'),
      1,
      'Exactly 1 tile or barrier hit on Host'
    );
    assert.strictEqual(JSON.stringify(hostTab.eval('G.rev')), JSON.stringify(guest2Tab.eval('G.rev')), 'G.rev synced across peers');
    assert.strictEqual(JSON.stringify(hostTab.eval('G.barrier')), JSON.stringify(guest2Tab.eval('G.barrier')), 'G.barrier synced across peers');

    // 5. Verify timer does NOT stop when Guest 1 opens Pause menu in Online mode!
    guest1Tab.eval(`togglePause()`);
    const tBefore = hostTab.eval('G.tsecMs');
    await sleep(250);
    const tAfter = hostTab.eval('G.tsecMs');
    assert.ok(tAfter < tBefore, 'Timer must keep running non-stop during online match');
    guest1Tab.eval(`togglePause()`);

    // 6. Clear Q1, Q2, Q3 in online mode (Guest 2 answers Q1, Host answers Q2, Guest 1 answers Q3)
    const answerers = [
      { tab: guest2Tab, pi: 2 },
      { tab: hostTab, pi: 0 },
      { tab: guest1Tab, pi: 1 }
    ];
    for (let qStep = 0; qStep < 3; qStep++) {
      await waitUntil(() => hostTab.eval(`G.qi === ${qStep} && !G.done && !G.roundLocked`), 3500, `Online Q${qStep + 1} ready`);
      const ans = hostTab.eval(`G.onlineCurrentQ.answer`);
      const { tab, pi } = answerers[qStep];
      tab.eval(`
        document.getElementById('ainp-${pi}').value = ${JSON.stringify(ans)};
        submitAns(${pi});
      `);
      if (qStep < 2) {
        await waitUntil(() => (
          hostTab.eval(`G.qi === ${qStep + 1} && !G.done`) &&
          guest1Tab.eval(`G.qi === ${qStep + 1} && !G.done`) &&
          guest2Tab.eval(`G.qi === ${qStep + 1} && !G.done`)
        ), 3500, `Online advance to Q${qStep + 2}`);
      }
    }

    // 7. At Q4 (qi === 3), all 3 tabs open #bonus-modal!
    await waitUntil(() => (
      hostTab.eval(`document.getElementById('bonus-modal').classList.contains('active')`) &&
      guest1Tab.eval(`document.getElementById('bonus-modal').classList.contains('active')`) &&
      guest2Tab.eval(`document.getElementById('bonus-modal').classList.contains('active')`)
    ), 3500, 'Online Q4 bonus modal open on all 3 tabs');

    // Host picks 'energy' (+17pt), Guest 1 picks 'core' (+6 cores)
    const preBonusHost = hostTab.eval('G.players.map(p => ({ en: p.energy, core: p.core }))');
    hostTab.eval(`pickOnlineBonusForPi(0, 'energy')`);
    guest1Tab.eval(`pickOnlineBonusForPi(1, 'core')`);
    await sleep(80);
    // Still waiting for Guest 2, so modal is still open!
    assert.strictEqual(hostTab.eval(`document.getElementById('bonus-modal').classList.contains('active')`), true);

    // 8. Simulate Guest 2 sudden disconnect mid-bonus!
    guest2Tab.eval(`leaveOnlineRoomAndHome()`);
    await waitUntil(() => hostTab.eval(`G.players[2].controlledByHost === true`), 2000, 'Host inherited disconnected Guest 2 unit');

    // Now Host can pick bonus for inherited unit pi=2 ('core')!
    hostTab.eval(`pickOnlineBonusForPi(2, 'core')`);

    // Bonus commits and Q4 timer starts on both Host & Guest 1!
    await waitUntil(() => (
      !hostTab.eval(`document.getElementById('bonus-modal').classList.contains('active')`) &&
      !guest1Tab.eval(`document.getElementById('bonus-modal').classList.contains('active')`) &&
      hostTab.eval(`G.tid !== null`)
    ), 2500, 'Bonus committed and Q4 started');

    const postBonusHost = hostTab.eval('G.players.map(p => ({ en: p.energy, core: p.core }))');
    const postBonusGuest1 = guest1Tab.eval('G.players.map(p => ({ en: p.energy, core: p.core }))');
    assert.deepStrictEqual(postBonusHost, postBonusGuest1, 'Host and Guest 1 player resources must match 100%');
    assert.strictEqual(postBonusHost[0].en - preBonusHost[0].en, 17, 'Host unit received +17pt EN');
    assert.strictEqual(postBonusHost[1].core - preBonusHost[1].core, 6, 'Guest 1 unit received +6 Core');
    assert.strictEqual(postBonusHost[2].core - preBonusHost[2].core, 6, 'Inherited Guest 2 unit received +6 Core');

    // Also verify Host can now fire SHOT using inherited Guest 2 unit (pi=2)!
    const en2Before = hostTab.eval('G.players[2].energy');
    hostTab.eval(`doRand(2)`);
    await waitUntil(() => guest1Tab.eval(`G.players[2].energy === ${en2Before - 1}`), 2000, 'Host fired SHOT on inherited unit pi=2 and synced to Guest 1');

    console.log('  ✔ PASS: 3人オンライン部屋作成・入室・機体重複ロック・SHOT/ANSWER同期・非停止タイマー・個別ボーナス同期・途中切断ホスト引継');
  } finally {
    hostTab.destroy();
    guest1Tab.destroy();
    guest2Tab.destroy();
  }

  console.log('\n🎉 ALL FULL-STACK E2E RUNTIME TESTS PASSED!');
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ E2E TEST FAILED:', err);
  process.exit(1);
});
