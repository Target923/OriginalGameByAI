/* サーチバトル — サウンド
   効果音もBGMも Web Audio でその場で合成する（音声ファイルは使わない）。
   ブラウザの決まりで、最初のクリックかキー操作のあとから鳴り始める。 */
window.SBAudio = (function () {
  'use strict';
  const AC = window.AudioContext || window.webkitAudioContext;
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ================= 回路 =================
  function gainNode(ctx, v, to) { const g = ctx.createGain(); g.gain.value = v; if (to) g.connect(to); return g; }
  function impulse(ctx, sec, decay) {
    const n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return b;
  }
  function noiseBuffer(ctx) {
    const n = ctx.sampleRate * 2, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  // 効果音とBGMは別々の音量で、最後にまとめて軽く圧縮して音割れを防ぐ
  function makeGraph(ctx, outNode) {
    const G = { ctx };
    G.master = gainNode(ctx, 0.9);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.2;
    G.master.connect(comp); comp.connect(outNode || ctx.destination);
    G.sfx = gainNode(ctx, 0.9, G.master);
    G.bgm = gainNode(ctx, 0.36, G.master);
    // 残響（短いホール）
    G.rev = ctx.createConvolver();
    G.rev.buffer = impulse(ctx, 2.2, 3);
    G.rev.connect(gainNode(ctx, 0.55, G.master));
    // 電子的なこだま
    G.echo = ctx.createDelay(2);
    G.echo.delayTime.value = 0.23;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000;
    G.echo.connect(lp); lp.connect(gainNode(ctx, 0.32, G.echo)); lp.connect(gainNode(ctx, 0.5, G.master));
    G.noise = noiseBuffer(ctx);
    return G;
  }

  // ================= 音の部品 =================
  // 立ち上がり a → 保持 hold → 減衰 d の音量変化
  function envGain(G, t, o) {
    const g = G.ctx.createGain(), p = g.gain;
    const v = Math.max(0.0002, o.v || 0.1), a = o.a || 0.004, h = o.hold || 0, d = o.d || 0.2;
    // 音量の初期値は 1 なので、開始時刻より前に音源が1サンプルでも鳴るとプチッと鳴る。最初から無音にしておく
    p.value = 0;
    p.setValueAtTime(0.0001, t);
    p.linearRampToValueAtTime(v, t + a);
    if (h) p.setValueAtTime(v, t + a + h);
    p.exponentialRampToValueAtTime(0.0001, t + a + h + d);
    return { g, end: t + a + h + d };
  }
  // 出口：左右の位置・残響・こだま
  function route(G, node, o) {
    const ctx = G.ctx;
    let last = node;
    if (o.pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan));
      node.connect(p); last = p;
    }
    last.connect(o.dest || G.sfx);
    if (o.rev) last.connect(gainNode(ctx, o.rev, o.revTo || G.rev));
    if (o.echo) last.connect(gainNode(ctx, o.echo, o.echoTo || G.echo));
  }
  // 発振器（f→f2 へ音程を動かせる。uni で少しずらして重ねると厚くなる）
  function tone(G, t, o) {
    const ctx = G.ctx, e = envGain(G, t, o);
    let into = e.g;
    if (o.lp) {
      const f = ctx.createBiquadFilter();
      f.type = o.ft || 'lowpass';
      f.Q.value = o.q == null ? 0.7 : o.q;
      f.frequency.setValueAtTime(o.lp, t);
      if (o.lp2) f.frequency.exponentialRampToValueAtTime(o.lp2, t + (o.lpT || (e.end - t)));
      f.connect(e.g); into = f;
    }
    const n = o.uni || 1;
    for (let i = 0; i < n; i++) {
      const os = ctx.createOscillator();
      os.type = o.type || 'sine';
      os.frequency.setValueAtTime(o.f, t);
      if (o.f2) os.frequency.exponentialRampToValueAtTime(o.f2, t + (o.glide || (e.end - t)));
      if (o.steps) for (const st of o.steps) os.frequency.setValueAtTime(st[1], t + st[0]);
      if (n > 1) os.detune.setValueAtTime((i - (n - 1) / 2) * (o.spread || 10), t);
      os.connect(into);
      os.start(t); os.stop(e.end + 0.05);
    }
    route(G, e.g, o);
    return e.end;
  }
  // 金属的なベル（FM合成）
  function bell(G, t, o) {
    const ctx = G.ctx, e = envGain(G, t, Object.assign({ a: 0.002 }, o));
    const car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain();
    car.frequency.setValueAtTime(o.f, t);
    mod.frequency.setValueAtTime(o.f * (o.ratio || 3.5), t);
    const depth = Math.max(0.5, o.f * (o.index == null ? 1.5 : o.index));
    mg.gain.setValueAtTime(depth, t);
    mg.gain.exponentialRampToValueAtTime(Math.max(0.5, depth * 0.04), e.end);
    mod.connect(mg); mg.connect(car.frequency); car.connect(e.g);
    route(G, e.g, o);
    car.start(t); mod.start(t); car.stop(e.end + 0.05); mod.stop(e.end + 0.05);
    return e.end;
  }
  // ノイズ（フィルターの帯域を動かして、風切り音・爆発・スキャン音に使う）
  function noise(G, t, o) {
    const ctx = G.ctx, e = envGain(G, t, o);
    const src = ctx.createBufferSource();
    src.buffer = G.noise; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.ft || 'bandpass';
    f.Q.value = o.q == null ? 1 : o.q;
    f.frequency.setValueAtTime(o.f || 1000, t);
    if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + (o.glide || (e.end - t)));
    src.connect(f); f.connect(e.g);
    route(G, e.g, o);
    src.start(t, Math.random() * 1.5); src.stop(e.end + 0.05);
    return e.end;
  }
  function kick(G, t, v, dest) {
    tone(G, t, { f: 150, f2: 40, glide: 0.14, a: 0.002, d: 0.34, v, dest });
    noise(G, t, { ft: 'lowpass', f: 1800, a: 0.001, d: 0.025, v: v * 0.3, dest });
  }
  function hat(G, t, v, open, dest) { noise(G, t, { ft: 'highpass', f: 7500, q: 0.6, a: 0.001, d: open ? 0.16 : 0.04, v, dest }); }
  function snare(G, t, v, dest) {
    noise(G, t, { ft: 'bandpass', f: 1900, q: 0.8, a: 0.001, d: 0.17, v, dest });
    tone(G, t, { type: 'triangle', f: 210, f2: 150, a: 0.001, d: 0.1, v: v * 0.6, dest });
  }
  function pad(G, t, notes, len, v, cut, dest) {
    const a = Math.min(0.8, len * 0.3);
    for (const m of notes) tone(G, t, { type: 'sawtooth', uni: 2, spread: 12, f: mtof(m), a, hold: Math.max(0.01, len - a), d: 1.2, v, lp: cut, q: 0.5, dest });
  }

  // ================= 効果音 =================
  // どれも (回路, 開始時刻, パラメータ)。p.pan は左右（自分フィールド＝左、相手フィールド＝右）
  const SFX = {
    // ---- 画面の操作 ----
    ui(G, t) { tone(G, t, { type: 'triangle', f: 1320, f2: 1760, glide: 0.03, a: 0.002, d: 0.07, v: 0.16 }); },
    tick(G, t) { tone(G, t, { f: 2200, a: 0.001, d: 0.04, v: 0.13 }); },
    select(G, t) {
      tone(G, t, { type: 'square', f: 880, a: 0.002, d: 0.06, v: 0.05, lp: 3000 });
      tone(G, t + 0.055, { type: 'square', f: 1320, a: 0.002, d: 0.12, v: 0.05, lp: 3000, echo: 0.25 });
    },
    cancel(G, t) {
      tone(G, t, { type: 'triangle', f: 1175, a: 0.002, d: 0.06, v: 0.08 });
      tone(G, t + 0.06, { type: 'triangle', f: 784, a: 0.002, d: 0.12, v: 0.08 });
    },
    deny(G, t) {
      tone(G, t, { type: 'square', f: 233, a: 0.002, d: 0.07, v: 0.045, lp: 1100 });
      tone(G, t + 0.09, { type: 'square', f: 196, a: 0.002, d: 0.1, v: 0.045, lp: 1000 });
    },
    error(G, t) {
      tone(G, t, { type: 'sawtooth', f: 138, a: 0.004, d: 0.26, v: 0.12, lp: 900 });
      tone(G, t, { type: 'square', f: 146, a: 0.004, d: 0.26, v: 0.075, lp: 900 });
    },
    open(G, t) {
      noise(G, t, { f: 900, f2: 3200, q: 1.2, a: 0.03, d: 0.16, v: 0.065 });
      tone(G, t, { f: 660, f2: 990, a: 0.01, d: 0.13, v: 0.08 });
    },
    close(G, t) {
      noise(G, t, { f: 3200, f2: 900, q: 1.2, a: 0.02, d: 0.14, v: 0.055 });
      tone(G, t, { f: 990, f2: 660, a: 0.01, d: 0.12, v: 0.08 });
    },
    place(G, t) {
      tone(G, t, { f: 170, f2: 80, a: 0.002, d: 0.14, v: 0.16 });
      noise(G, t, { ft: 'lowpass', f: 1200, a: 0.001, d: 0.05, v: 0.07 });
      bell(G, t + 0.005, { f: 523, ratio: 1.41, index: 1.2, d: 0.28, v: 0.05, rev: 0.12 });
    },
    remove(G, t) {
      tone(G, t, { f: 330, f2: 140, a: 0.002, d: 0.12, v: 0.1 });
      noise(G, t, { ft: 'highpass', f: 2500, a: 0.001, d: 0.05, v: 0.04 });
    },
    rotate(G, t) { noise(G, t, { f: 1800, f2: 5200, q: 1.5, a: 0.01, d: 0.09, v: 0.25 }); },
    shuffle(G, t) { [0, 7, 4, 12].forEach((d, i) => tone(G, t + i * 0.045, { type: 'square', f: mtof(72 + d), a: 0.002, d: 0.05, v: 0.04, lp: 2800 })); },
    gem(G, t) {
      bell(G, t, { f: 1568, ratio: 2, index: 0.5, d: 0.5, v: 0.07, echo: 0.3 });
      bell(G, t + 0.07, { f: 2093, ratio: 2, index: 0.5, d: 0.6, v: 0.06, echo: 0.3 });
    },
    pick(G, t) {
      tone(G, t, { type: 'triangle', f: 659, a: 0.003, d: 0.2, v: 0.07 });
      tone(G, t, { type: 'triangle', f: 988, a: 0.003, d: 0.2, v: 0.06 });
      bell(G, t + 0.04, { f: 1319, ratio: 2, index: 0.6, d: 0.45, v: 0.05, echo: 0.25 });
    },
    pickFoe(G, t) {
      tone(G, t, { type: 'square', f: 494, a: 0.003, d: 0.16, v: 0.04, lp: 1600, pan: 0.3 });
      tone(G, t + 0.06, { type: 'square', f: 370, a: 0.003, d: 0.2, v: 0.04, lp: 1400, pan: 0.3 });
    },
    confirm(G, t) {
      tone(G, t, { f: 880, a: 0.003, d: 0.09, v: 0.065 });
      tone(G, t + 0.08, { f: 1175, a: 0.003, d: 0.3, v: 0.065, rev: 0.2 });
    },
    sel(G, t, p) { tone(G, t, { type: 'triangle', f: mtof(76 + 2 * Math.min(6, p.n || 0)), a: 0.002, d: 0.07, v: 0.15, pan: p.pan }); },
    desel(G, t, p) { tone(G, t, { type: 'triangle', f: mtof(73 + 2 * Math.min(6, p.n || 0)), f2: mtof(66), a: 0.002, d: 0.08, v: 0.11, pan: p.pan }); },

    // ---- 対戦の出来事 ----
    start(G, t) {
      noise(G, t, { f: 300, f2: 5200, q: 1.4, a: 0.55, d: 0.12, v: 0.11 });
      tone(G, t, { type: 'sawtooth', f: 110, f2: 440, glide: 0.6, a: 0.5, d: 0.15, v: 0.04, lp: 2200 });
      const s = t + 0.62;
      for (const m of [62, 65, 69, 74]) tone(G, s, { type: 'sawtooth', uni: 2, spread: 14, f: mtof(m), a: 0.004, d: 0.7, v: 0.04, lp: 3200, lp2: 500, lpT: 0.5, rev: 0.25 });
      kick(G, s, 0.5);
      bell(G, s + 0.02, { f: 1175, ratio: 2, index: 0.8, d: 1, v: 0.05, rev: 0.3, echo: 0.2 });
    },
    turnMine(G, t, p) {
      const k = p.alt ? 0.891 : 1;
      tone(G, t, { type: 'triangle', f: 659 * k, a: 0.003, d: 0.12, v: 0.09 });
      tone(G, t + 0.09, { type: 'triangle', f: 988 * k, a: 0.003, d: 0.32, v: 0.09, echo: 0.25 });
    },
    turnFoe(G, t) {
      tone(G, t, { type: 'square', f: 494, a: 0.003, d: 0.12, v: 0.045, lp: 1700 });
      tone(G, t + 0.09, { type: 'square', f: 330, a: 0.003, d: 0.32, v: 0.045, lp: 1500, echo: 0.2 });
    },
    tchance(G, t) {
      [784, 988, 1175, 1568].forEach((f, i) => bell(G, t + i * 0.07, { f, ratio: 2, index: 0.6, d: 0.4, v: 0.085, echo: 0.3, rev: 0.15 }));
    },
    tfail(G, t, p) {
      tone(G, t, { f: 620, f2: 280, glide: 0.35, a: 0.004, d: 0.42, v: 0.1, pan: p.pan });
      tone(G, t, { type: 'square', f: 310, f2: 140, glide: 0.35, a: 0.004, d: 0.38, v: 0.04, lp: 900, pan: p.pan });
    },
    shield(G, t, p) {
      bell(G, t, { f: 880, ratio: 3.47, index: 2.2, d: 1.0, v: 0.12, rev: 0.4, pan: p.pan });
      bell(G, t + 0.02, { f: 1320, ratio: 2.76, index: 1.5, d: 0.8, v: 0.07, pan: p.pan });
      noise(G, t, { ft: 'highpass', f: 6000, a: 0.05, d: 0.5, v: 0.04, pan: p.pan });
    },
    miss(G, t, p) {
      tone(G, t, { f: 720, f2: 520, glide: 0.15, a: 0.003, d: 0.24, v: 0.15, rev: 0.25, pan: p.pan });
      noise(G, t, { f: 1300, q: 2, a: 0.001, d: 0.04, v: 0.045, pan: p.pan });
    },
    hit(G, t, p) {
      tone(G, t, { f: 190, f2: 55, glide: 0.16, a: 0.001, d: 0.28, v: 0.5, pan: p.pan });
      tone(G, t, { type: 'triangle', f: 380, f2: 120, glide: 0.12, a: 0.001, d: 0.16, v: 0.16, pan: p.pan });
      noise(G, t, { ft: 'lowpass', f: 2600, f2: 300, a: 0.001, d: 0.22, v: 0.33, pan: p.pan });
      bell(G, t, { f: 1480, ratio: 2.4, index: 1.5, d: 0.26, v: 0.07, pan: p.pan });
    },
    first(G, t, p) {
      tone(G, t, { type: 'square', f: 1760, a: 0.002, d: 0.05, v: 0.05, lp: 4000, pan: p.pan });
      tone(G, t + 0.07, { type: 'square', f: 2349, a: 0.002, d: 0.07, v: 0.05, lp: 4000, pan: p.pan });
      const s = t + 0.1;
      tone(G, s, { f: 200, f2: 50, glide: 0.2, a: 0.001, d: 0.34, v: 0.32, pan: p.pan });
      noise(G, s, { ft: 'lowpass', f: 3200, f2: 300, a: 0.001, d: 0.26, v: 0.22, pan: p.pan });
      tone(G, s, { type: 'sawtooth', f: 400, f2: 1600, glide: 0.3, a: 0.02, d: 0.3, v: 0.03, lp: 3500, pan: p.pan });
      bell(G, s + 0.03, { f: 2093, ratio: 2, index: 0.8, d: 0.55, v: 0.05, rev: 0.3, echo: 0.25, pan: p.pan });
    },
    destroy(G, t, p) {
      const big = !!p.big, pan = p.pan || 0;
      tone(G, t, { f: 150, f2: 30, glide: big ? 0.8 : 0.6, a: 0.002, d: big ? 1.1 : 0.8, v: 0.6, pan });
      tone(G, t, { type: 'triangle', f: 320, f2: 60, glide: 0.35, a: 0.002, d: big ? 0.6 : 0.45, v: big ? 0.55 : 0.45, pan });
      noise(G, t, { ft: 'lowpass', f: 5200, f2: 140, glide: big ? 1 : 0.8, a: 0.002, d: big ? 1.3 : 0.95, v: big ? 0.7 : 0.6, rev: 0.3, pan });
      noise(G, t, { f: 900, f2: 300, q: 0.8, a: 0.002, d: big ? 0.5 : 0.35, v: big ? 0.45 : 0.38, pan });
      for (let i = 0; i < (big ? 12 : 8); i++) noise(G, t + rnd(0.02, 0.5), { ft: 'highpass', f: rnd(1500, 4000), a: 0.001, d: rnd(0.015, 0.04), v: rnd(0.04, 0.1), pan: pan + rnd(-0.3, 0.3) });
      for (let i = 0; i < (big ? 6 : 4); i++) bell(G, t + rnd(0.05, 0.45), { f: rnd(1700, 3600), ratio: rnd(1.6, 2.9), index: 1.2, d: rnd(0.2, 0.45), v: rnd(0.02, 0.04), pan: pan + rnd(-0.4, 0.4) });
      if (p.penalty) tone(G, t + 0.05, { type: 'sawtooth', f: 440, f2: 110, glide: 0.5, a: 0.01, d: 0.55, v: 0.04, lp: 1800 });
    },
    answerOK(G, t, p) {
      const n = Math.max(1, Math.min(5, p.n || 1));
      for (let i = 0; i < n; i++) tone(G, t + i * 0.05, { type: 'triangle', f: mtof(76 + i * 3), a: 0.002, d: 0.08, v: 0.11, echo: 0.2, pan: p.pan });
      bell(G, t + n * 0.05 + 0.02, { f: 1568, ratio: 2, index: 0.8, d: 0.45, v: 0.08, rev: 0.25, pan: p.pan });
    },
    answerNG(G, t, p) {
      const steps = [];
      for (let i = 1; i < 15; i++) steps.push([i * 0.03, rnd(180, 1300)]);
      tone(G, t, { type: 'square', f: rnd(300, 900), steps, a: 0.003, hold: 0.3, d: 0.15, v: 0.05, lp: 2600, pan: p.pan });
      tone(G, t, { type: 'sawtooth', f: 98, a: 0.01, hold: 0.25, d: 0.3, v: 0.08, lp: 700, pan: p.pan });
      noise(G, t, { f: 900, q: 3, a: 0.01, d: 0.35, v: 0.07, pan: p.pan });
    },
    tH(G, t, p) {
      tone(G, t, { type: 'square', f: 988, a: 0.002, d: 0.07, v: 0.1, lp: 4500, pan: p.pan });
      tone(G, t + 0.07, { type: 'square', f: 1319, a: 0.002, d: 0.45, v: 0.1, lp: 4500, pan: p.pan });
      [1047, 1319, 1568, 2093].forEach((f, i) => bell(G, t + 0.2 + i * 0.06, { f, ratio: 2, index: 0.7, d: 0.7, v: 0.08, echo: 0.3, rev: 0.3, pan: p.pan }));
      noise(G, t + 0.15, { ft: 'highpass', f: 8000, a: 0.1, d: 0.9, v: 0.05, pan: p.pan });
    },
    tN(G, t, p) {
      tone(G, t, { f: 1047, a: 0.002, d: 0.3, v: 0.09, echo: 0.35, pan: p.pan });
      tone(G, t + 0.16, { f: 1175, a: 0.002, d: 0.35, v: 0.08, echo: 0.35, pan: p.pan });
    },
    tX(G, t, p) {
      tone(G, t, { f: 220, f2: 110, a: 0.002, d: 0.2, v: 0.13, pan: p.pan });
      noise(G, t, { ft: 'lowpass', f: 700, a: 0.001, d: 0.08, v: 0.06, pan: p.pan });
    },
    victory(G, t) {
      [72, 76, 79, 84].forEach((m, i) => tone(G, t + i * 0.1, { type: 'square', f: mtof(m), a: 0.003, d: 0.16, v: 0.05, lp: 3400 }));
      const s = t + 0.42;
      for (const m of [72, 76, 79, 83, 86]) tone(G, s, { type: 'sawtooth', uni: 2, spread: 12, f: mtof(m), a: 0.02, hold: 0.5, d: 1.2, v: 0.03, lp: 2600, lp2: 900, lpT: 1.4, rev: 0.3 });
      bell(G, s, { f: mtof(96), ratio: 2, index: 0.6, d: 1.5, v: 0.05, rev: 0.4, echo: 0.3 });
      kick(G, s, 0.45);
    },
    defeat(G, t) {
      [69, 68, 67, 66].forEach((m, i) => tone(G, t + i * 0.22, { type: 'triangle', f: mtof(m), a: 0.005, d: 0.26, v: 0.09 }));
      const s = t + 0.92;
      for (const m of [50, 53, 57]) tone(G, s, { type: 'sawtooth', uni: 2, spread: 10, f: mtof(m), a: 0.05, hold: 0.5, d: 1.4, v: 0.035, lp: 900, rev: 0.3 });
      tone(G, s, { f: mtof(38), a: 0.05, hold: 0.4, d: 1.4, v: 0.16 });
    },
    draw(G, t) {
      for (const m of [67, 72, 74]) tone(G, t, { type: 'triangle', f: mtof(m), a: 0.01, hold: 0.2, d: 0.4, v: 0.05 });
      for (const m of [69, 74, 76]) tone(G, t + 0.45, { type: 'triangle', f: mtof(m), a: 0.01, hold: 0.3, d: 1.0, v: 0.05, rev: 0.3 });
    },

    // ---- 大会 ----
    tourStart(G, t) {
      noise(G, t, { f: 200, f2: 6000, q: 1.2, a: 0.7, d: 0.15, v: 0.1 });
      [62, 69, 74].forEach((m, i) => kick(G, t + 0.75 + i * 0.16, 0.38));
      const s = t + 1.2;
      for (const m of [62, 66, 69, 74, 78]) tone(G, s, { type: 'sawtooth', uni: 2, spread: 14, f: mtof(m), a: 0.01, hold: 0.25, d: 1.1, v: 0.032, lp: 3600, lp2: 700, lpT: 1.2, rev: 0.3 });
      bell(G, s, { f: mtof(90), ratio: 2, index: 0.7, d: 1.4, v: 0.05, rev: 0.4, echo: 0.3 });
      kick(G, s, 0.5);
    },
    coin(G, t) {
      bell(G, t, { f: 1976, ratio: 1.5, index: 0.4, d: 0.25, v: 0.06 });
      bell(G, t + 0.07, { f: 2637, ratio: 1.5, index: 0.4, d: 0.45, v: 0.06, echo: 0.2 });
    },
    rankUp(G, t) {
      [76, 79, 83, 88].forEach((m, i) => tone(G, t + i * 0.06, { type: 'triangle', f: mtof(m), a: 0.002, d: 0.14, v: 0.07 }));
      bell(G, t + 0.26, { f: mtof(95), ratio: 2, index: 0.5, d: 0.7, v: 0.04, echo: 0.25 });
    },
    qualify(G, t) {
      [72, 76, 79, 84, 88].forEach((m, i) => tone(G, t + i * 0.08, { type: 'square', f: mtof(m), a: 0.003, d: 0.15, v: 0.045, lp: 3600 }));
      const s = t + 0.46;
      for (const m of [72, 76, 79, 84]) tone(G, s, { type: 'sawtooth', uni: 2, spread: 12, f: mtof(m), a: 0.02, hold: 0.45, d: 1.2, v: 0.032, lp: 2800, lp2: 900, lpT: 1.4, rev: 0.3 });
      bell(G, s, { f: mtof(100), ratio: 2, index: 0.6, d: 1.4, v: 0.05, rev: 0.4, echo: 0.3 });
      kick(G, s, 0.5);
    },
    eliminated(G, t) {
      [67, 66, 64, 62].forEach((m, i) => tone(G, t + i * 0.2, { type: 'triangle', f: mtof(m), a: 0.005, d: 0.24, v: 0.08 }));
      const s = t + 0.85;
      for (const m of [50, 55, 58]) tone(G, s, { type: 'sawtooth', uni: 2, spread: 10, f: mtof(m), a: 0.06, hold: 0.4, d: 1.3, v: 0.03, lp: 1000, rev: 0.3 });
    },
    champion(G, t) {
      [67, 72, 76, 79, 84].forEach((m, i) => tone(G, t + i * 0.09, { type: 'square', f: mtof(m), a: 0.003, d: 0.16, v: 0.05, lp: 3800 }));
      const s = t + 0.52;
      for (const m of [60, 67, 72, 76, 79, 84]) tone(G, s, { type: 'sawtooth', uni: 2, spread: 12, f: mtof(m), a: 0.02, hold: 0.7, d: 1.6, v: 0.03, lp: 3000, lp2: 1000, lpT: 1.8, rev: 0.35 });
      [0, 0.18, 0.36].forEach((d, i) => bell(G, s + d, { f: mtof(96 + i * 4), ratio: 2, index: 0.6, d: 1.4, v: 0.05, rev: 0.4, echo: 0.3 }));
      kick(G, s, 0.55); kick(G, s + 0.36, 0.4);
    },

    // ---- アイテム ----
    'i-cube'(G, t, p) {
      [523, 784, 1175].forEach((f, i) => bell(G, t + i * 0.08, { f, ratio: 1, index: 0.3, d: 0.6, v: 0.05, echo: 0.25, pan: p.pan }));
      tone(G, t, { type: 'sawtooth', uni: 2, spread: 8, f: 110, a: 0.25, hold: 0.5, d: 0.4, v: 0.04, lp: 500, pan: p.pan });
      noise(G, t, { f: 500, f2: 3200, q: 2, a: 0.4, d: 0.35, v: 0.04, pan: p.pan });
    },
    'i-line'(G, t, p) {
      noise(G, t, { f: 400, f2: 5000, glide: 0.9, q: 6, a: 0.05, hold: 0.7, d: 0.2, v: 0.11, pan: p.pan });
      tone(G, t, { f: 300, f2: 2400, glide: 0.9, a: 0.05, hold: 0.7, d: 0.2, v: 0.025, pan: p.pan });
      for (let i = 0; i < 8; i++) tone(G, t + 0.05 + i * 0.1, { f: 3000, a: 0.001, d: 0.02, v: 0.03, pan: p.pan });
    },
    'i-target'(G, t, p) {
      [1760, 1976, 2349].forEach((f, i) => tone(G, t + i * 0.07, { f, a: 0.001, d: 0.045, v: 0.12, pan: p.pan }));
      noise(G, t, { f: 1500, f2: 4000, q: 1.5, a: 0.03, d: 0.18, v: 0.05, pan: p.pan });
    },
    'i-pair'(G, t, p) {
      tone(G, t, { f: 1568, a: 0.001, d: 0.05, v: 0.08, pan: p.pan });
      tone(G, t + 0.08, { f: 1760, a: 0.001, d: 0.05, v: 0.08, pan: p.pan });
      tone(G, t + 0.22, { type: 'sawtooth', f: 2400, f2: 300, glide: 0.25, a: 0.002, d: 0.28, v: 0.065, lp: 5000, pan: p.pan });
      tone(G, t + 0.22, { f: 1200, f2: 400, glide: 0.25, a: 0.002, d: 0.25, v: 0.05, pan: p.pan });
    },
    // ノードショット：上下左右へ走査する4つの短い音
    'i-node'(G, t, p) {
      [1047, 1319, 1175, 1568].forEach((f, i) => tone(G, t + i * 0.06, { type: 'triangle', f, a: 0.002, d: 0.09, v: 0.07, echo: 0.2, pan: p.pan }));
      tone(G, t + 0.28, { f: 1760, a: 0.002, d: 0.3, v: 0.05, rev: 0.25, pan: p.pan });
    },
    'i-warp'(G, t, p) {
      noise(G, t, { f: 300, f2: 6000, glide: 0.45, q: 1.6, a: 0.02, hold: 0.2, d: 0.25, v: 0.09, pan: p.pan });
      tone(G, t, { f: 1400, f2: 180, glide: 0.4, a: 0.01, d: 0.45, v: 0.07, pan: p.pan });
      tone(G, t + 0.5, { f: 180, f2: 1600, glide: 0.3, a: 0.01, d: 0.35, v: 0.06, pan: p.pan });
      bell(G, t + 0.6, { f: 2093, ratio: 2, index: 0.5, d: 0.4, v: 0.04, echo: 0.3, pan: p.pan });
      bell(G, t + 0.66, { f: 2637, ratio: 2, index: 0.5, d: 0.4, v: 0.035, echo: 0.3, pan: p.pan });
    },
    'i-stealth'(G, t, p) {
      [1175, 1480, 1760].forEach((f, i) => tone(G, t + i * 0.04, { f, f2: f * 0.7, glide: 0.9, a: 0.01, d: 1.0, v: 0.035, echo: 0.35, pan: p.pan }));
      noise(G, t, { ft: 'highpass', f: 5000, f2: 1500, glide: 0.8, a: 0.02, d: 0.9, v: 0.05, pan: p.pan });
      tone(G, t, { f: 147, a: 0.3, d: 0.7, v: 0.06, pan: p.pan });
    },
    // バズーカ：警報（v10の宣言の音）→ 発射 → 着弾。空きブロックなら着弾だけで、分解の音はなし
    'i-bazooka'(G, t, p) {
      const pan = p.pan || 0;
      noise(G, t, { ft: 'lowpass', f: 1600, a: 0.001, d: 0.05, v: 0.22, pan });
      tone(G, t + 0.03, { type: 'square', f: 140, f2: 70, glide: 0.08, a: 0.001, d: 0.09, v: 0.12, lp: 900, pan });
      for (let i = 0; i < 2; i++) {
        const s0 = t + 0.12 + i * 0.22;
        tone(G, s0, { type: 'square', f: 880, a: 0.004, hold: 0.07, d: 0.03, v: 0.045, lp: 2600 });
        tone(G, s0 + 0.11, { type: 'square', f: 659, a: 0.004, hold: 0.07, d: 0.04, v: 0.045, lp: 2400 });
      }
      const s = t + 0.56;
      noise(G, s - 0.3, { f: 260, f2: 4200, glide: 0.3, q: 1.2, a: 0.2, d: 0.1, v: 0.12, pan });
      tone(G, s - 0.3, { type: 'sawtooth', f: 90, f2: 520, glide: 0.3, a: 0.22, d: 0.08, v: 0.04, lp: 1800, pan });
      if (p.hit) {
        SFX.destroy(G, s, { big: true, pan });
        kick(G, s, 0.5);
        const n = Math.max(2, Math.min(8, (p.n || 0) + 3));
        for (let i = 0; i < n; i++) bell(G, s + 0.12 + i * 0.05, { f: rnd(1700, 3200), ratio: 2.2, index: 1, d: 0.25, v: 0.03, pan: pan + rnd(-0.3, 0.3) });
      } else {
        noise(G, s, { ft: 'lowpass', f: 2600, f2: 300, a: 0.001, d: 0.35, v: 0.3, pan });
        tone(G, s, { f: 180, f2: 60, glide: 0.2, a: 0.001, d: 0.3, v: 0.3, pan });
      }
    },
    // 調べた結果：数（キューブ数・ブロック数・ブロック数）はその回数だけ「ピッ」と鳴らす
    readout(G, t, p) {
      const n = Math.max(1, Math.min(8, p.n || 1));
      for (let i = 0; i < n; i++) tone(G, t + i * 0.085, { type: 'square', f: 1568, a: 0.002, d: 0.045, v: 0.065, lp: 3200, pan: p.pan });
      tone(G, t + n * 0.085 + 0.03, { f: 2093, a: 0.002, d: 0.22, v: 0.08, rev: 0.2, pan: p.pan });
    },
    none(G, t, p) {
      tone(G, t, { type: 'triangle', f: 330, a: 0.002, d: 0.1, v: 0.09, pan: p.pan });
      tone(G, t + 0.1, { type: 'triangle', f: 247, a: 0.002, d: 0.16, v: 0.09, pan: p.pan });
    },
    found(G, t, p) {
      bell(G, t, { f: 1319, ratio: 2, index: 0.8, d: 0.5, v: 0.08, echo: 0.25, pan: p.pan });
      bell(G, t + 0.05, { f: 1760, ratio: 2, index: 0.8, d: 0.55, v: 0.07, echo: 0.25, pan: p.pan });
    },
    same(G, t, p) {
      tone(G, t, { f: 1047, a: 0.005, d: 0.5, v: 0.07, pan: p.pan });
      tone(G, t, { f: 1319, a: 0.005, d: 0.5, v: 0.06, pan: p.pan });
      bell(G, t + 0.03, { f: 2093, ratio: 2, index: 0.5, d: 0.5, v: 0.04, rev: 0.2, pan: p.pan });
    },
    notsame(G, t, p) {
      tone(G, t, { type: 'square', f: 523, a: 0.003, d: 0.3, v: 0.06, lp: 2000, pan: p.pan });
      tone(G, t, { type: 'square', f: 554, a: 0.003, d: 0.3, v: 0.06, lp: 2000, pan: p.pan });
      noise(G, t, { f: 3000, q: 2, a: 0.002, d: 0.15, v: 0.07, pan: p.pan });
    },
  };

  // ================= BGM =================
  // 待機中（タイトル・配置・ドラフト・結果）：Am9 → Fmaj9 → Dm9 → Esus4 → E の静かなループ
  const CALM = [
    { b: 45, pad: [57, 60, 64, 67, 71], arp: [69, 72, 76, 79, 83, 76] },
    null,
    { b: 41, pad: [53, 57, 60, 64, 67], arp: [65, 69, 72, 76, 79, 72] },
    null,
    { b: 38, pad: [50, 53, 57, 60, 64], arp: [62, 65, 69, 72, 76, 69] },
    null,
    { b: 40, pad: [52, 57, 59, 64], arp: [64, 69, 71, 76, 81, 71] },
    { b: 40, pad: [52, 56, 59, 64], arp: [64, 68, 71, 76, 80, 71] },
  ];
  // 対戦中：Dm の緊張感あるループ（終盤は打ち込みが増える）
  const BATTLE = [
    { b: 38, pad: [62, 65, 69, 72], arp: [74, 77, 81, 84] },
    { b: 38, pad: [62, 65, 69, 72], arp: [74, 77, 81, 86] },
    { b: 34, pad: [58, 62, 65, 69], arp: [70, 74, 77, 81] },
    { b: 36, pad: [60, 64, 67, 72], arp: [72, 76, 79, 84] },
    { b: 38, pad: [62, 65, 69, 72], arp: [74, 77, 81, 84] },
    { b: 38, pad: [62, 65, 69, 74], arp: [74, 77, 81, 86] },
    { b: 43, pad: [55, 58, 62, 65], arp: [67, 70, 74, 79] },
    { b: 45, pad: [57, 61, 64, 69], arp: [69, 73, 76, 81] },
  ];
  const on = (T, k) => !T.only || T.only === k;
  const TRACKS = {
    calm: {
      bpm: 84, fadeIn: 2.5, rev: 0.4,
      play(G, T, step, t, q) {
        const bar = Math.floor(step / 16) % 8, s = step % 16;
        const ch = CALM[bar] || CALM[bar - 1], D = T.out;
        if (s === 0 && CALM[bar] && on(T, 'pad')) pad(G, t, ch.pad, (CALM[bar + 1] === null ? 32 : 16) * q, 0.016, 1100, D);
        if (s === 0 && on(T, 'bass')) tone(G, t, { type: 'triangle', f: mtof(ch.b), a: 0.06, hold: 10 * q, d: 1.0, v: 0.09, dest: D });
        if (s === 8 && bar % 2 === 1 && on(T, 'bass')) tone(G, t, { type: 'triangle', f: mtof(ch.b + 7), a: 0.04, hold: 4 * q, d: 0.6, v: 0.05, dest: D });
        if (s % 2 === 0 && on(T, 'arp')) {
          const i = [0, 2, 4, 1, 3, 5, 2, 4][s / 2];
          tone(G, t, { type: 'triangle', f: mtof(ch.arp[i]), a: 0.004, d: 0.5, v: s % 8 === 0 ? 0.09 : 0.064, dest: D, echo: 0.45, echoTo: T.echo });
        }
        if ((s === 4 || s === 12) && on(T, 'drums')) noise(G, t, { ft: 'highpass', f: 7000, a: 0.002, d: 0.05, v: 0.08, dest: D });
        if (s === 14 && bar % 4 === 3 && on(T, 'bell')) bell(G, t, { f: mtof(ch.arp[4] + 12), ratio: 2, index: 0.4, d: 1.4, v: 0.04, dest: D, echo: 0.6, echoTo: T.echo });
      },
    },
    battle: {
      bpm: 120, fadeIn: 0.5, rev: 0.2,
      play(G, T, step, t, q) {
        const bar = Math.floor(step / 16) % 8, s = step % 16, ch = BATTLE[bar], hot = T.level >= 2, D = T.out;
        if (s === 0 && on(T, 'pad')) pad(G, t, ch.pad, 16 * q, hot ? 0.012 : 0.01, hot ? 1600 : 950, D);
        if ((hot || s % 2 === 0) && on(T, 'bass')) {
          const up = s % 4 === 2 ? 12 : 0;
          tone(G, t, { type: 'sawtooth', f: mtof(ch.b + up), a: 0.003, d: q * 1.7, v: s % 4 === 0 ? 0.2 : 0.15, lp: 1500, lp2: 220, lpT: q * 1.5, q: 5, dest: D });
        }
        if (on(T, 'drums')) {
          if (s === 0 || s === 8 || (hot && (s === 4 || s === 12)) || (!hot && s === 11 && bar % 2 === 1)) kick(G, t, 0.3, D);
          if (hot && (s === 4 || s === 12)) snare(G, t, 0.07, D);
          if (s % 4 === 2) hat(G, t, 0.045, s === 14 && bar % 2 === 1, D);
          else if (hot && s % 2 === 1) hat(G, t, 0.02, false, D);
        }
        if ((bar >= 4 || hot) && s % 2 === 0 && on(T, 'arp')) {
          const i = [0, 1, 2, 3, 2, 1, 0, 2][s / 2];
          tone(G, t, { type: 'square', f: mtof(ch.arp[i]), a: 0.003, d: q * 1.8, v: 0.045, lp: 2600, dest: D, echo: 0.5, echoTo: T.echo });
        }
        if (s === 13 && bar % 2 === 0 && on(T, 'bell')) bell(G, t, { f: mtof(ch.arp[3] + 12), ratio: 3.01, index: 0.7, d: 0.35, v: 0.035, dest: D, echo: 0.6, echoTo: T.echo });
      },
    },
  };
  // 曲ごとの出口（音量フェード用）とこだま
  function makeTrack(G, name, level, delay) {
    const ctx = G.ctx, def = TRACKS[name], now = ctx.currentTime;
    const T = { name, def, level: level || 1, step: 0, next: now + (delay || 0) + 0.06 };
    T.out = ctx.createGain();
    T.out.gain.setValueAtTime(0.0001, now);
    T.out.gain.setValueAtTime(0.0001, T.next);
    T.out.gain.exponentialRampToValueAtTime(1, T.next + def.fadeIn);
    T.out.connect(G.bgm);
    T.out.connect(gainNode(ctx, def.rev, G.rev));
    T.echo = ctx.createDelay(2);
    T.echo.delayTime.value = (60 / def.bpm) * 0.75;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
    T.fb = gainNode(ctx, 0.36, T.echo);
    T.echo.connect(lp); lp.connect(T.fb); lp.connect(gainNode(ctx, 0.55, T.out));
    return T;
  }

  // ================= 状態 =================
  let live = null, mode = 'all', unlocked = false;
  let track = null, timer = 0, wantName = null, wantLevel = 1, holdTimer = 0;

  function ensure() {
    if (live || !AC) return live;
    try { live = makeGraph(new AC({ latencyHint: 'interactive' })); }
    catch (e) { try { live = makeGraph(new AC()); } catch (e2) { live = null; } }
    return live;
  }
  // 最初の操作で音を出せるようにする（スマホでは無音を一度鳴らす必要がある）
  function unlock() {
    if (mode === 'off' || !ensure()) return;
    const ctx = live.ctx;
    if (ctx.state === 'suspended' && !document.hidden) ctx.resume().catch(() => {});
    if (!unlocked) {
      unlocked = true;
      try { const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); } catch (e) { /* なくても動く */ }
      apply();
    }
  }
  // 少し先までの音符を予約しておく（重い処理で一瞬止まっても途切れにくい）
  function pump() {
    if (!live || !track) return;
    const ctx = live.ctx;
    if (ctx.state !== 'running') return;
    const T = track, q = 60 / T.def.bpm / 4, horizon = ctx.currentTime + 0.5;
    if (T.next < ctx.currentTime - 0.1) {
      const skip = Math.ceil((ctx.currentTime - T.next) / q);
      T.step += skip; T.next += skip * q;
    }
    let guard = 0;
    while (T.next < horizon && guard++ < 64) {
      try { T.def.play(live, T, T.step, T.next, q); } catch (e) { /* 一音失敗しても止めない */ }
      T.step++; T.next += q;
    }
  }
  function stopTrack(fade) {
    if (!track || !live) return;
    const T = track, f = fade || 0.8, now = live.ctx.currentTime, p = T.out.gain;
    track = null;
    if (timer) { clearInterval(timer); timer = 0; }
    try {
      p.cancelScheduledValues(now);
      p.setValueAtTime(Math.max(0.0001, Math.min(1, p.value)), now);
      p.exponentialRampToValueAtTime(0.0001, now + f);
    } catch (e) { /* 止められなくても次の曲は鳴らせる */ }
    setTimeout(() => { try { T.fb.disconnect(); T.out.disconnect(); } catch (e) { /* 片付け */ } }, (f + 3) * 1000);
  }
  function apply() {
    if (holdTimer) return;   // 勝敗のジングルが終わるまで待つ
    if (!live || !unlocked || mode !== 'all' || !wantName) { if (track) stopTrack(0.8); return; }
    if (track && track.name === wantName) { track.level = wantLevel; return; }
    const battle = wantName === 'battle';
    if (track) stopTrack(battle ? 0.5 : 1.2);
    track = makeTrack(live, wantName, wantLevel, battle ? 0.7 : 0.2);
    if (!timer) timer = setInterval(pump, 50);
    pump();
  }

  // ================= 外から使う =================
  function setMode(m, byUser) {
    mode = m === 'sfx' || m === 'off' ? m : 'all';
    if (mode === 'off') { if (track) stopTrack(0.4); if (live) live.ctx.suspend().catch(() => {}); return; }
    if (byUser) unlock();
    apply();
  }
  // 場面：title / result（静かな曲）、battle（対戦曲。level 2 で終盤の激しい版）
  function scene(name, level) {
    wantName = name === 'battle' ? 'battle' : (name === 'title' || name === 'result') ? 'calm' : null;
    wantLevel = level || 1;
    apply();
  }
  function sfx(name, delay, params) {
    if (mode === 'off' || !live || !unlocked || document.hidden) return;
    const f = SFX[name];
    if (!f) return;
    try { f(live, live.ctx.currentTime + 0.01 + (delay || 0), params || {}); } catch (e) { /* 音が出なくてもゲームは続ける */ }
  }
  // 決着：対戦曲を止めてジングル、少しして静かな曲へ
  function result(kind) {
    wantName = 'calm'; wantLevel = 1;
    if (track) stopTrack(0.3);
    sfx(kind === 'win' ? 'victory' : kind === 'lose' ? 'defeat' : 'draw');
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { holdTimer = 0; apply(); }, 3000);
  }

  for (const t of ['pointerdown', 'keydown', 'touchend', 'click']) document.addEventListener(t, unlock, true);
  document.addEventListener('visibilitychange', () => {
    if (!live) return;
    if (document.hidden) live.ctx.suspend().catch(() => {});
    else if (unlocked && mode !== 'off') live.ctx.resume().catch(() => {});
  });

  // 確認用：音を画面に出さずに合成して、大きさを測る
  async function offline(kind, name, sec, params) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const sr = 44100, ctx = new OAC(2, Math.ceil(sr * sec), sr);
    // hp を指定すると、ノートPCのスピーカーのように低音を削ってから測る
    let outNode = null;
    if (params && params.hp) {
      const a = ctx.createBiquadFilter(), b2 = ctx.createBiquadFilter();
      a.type = b2.type = 'highpass'; a.frequency.value = b2.frequency.value = params.hp; a.Q.value = b2.Q.value = 0.7;
      a.connect(b2); b2.connect(ctx.destination); outNode = a;
    }
    const G = makeGraph(ctx, outNode);
    if (kind === 'sfx') SFX[name](G, 0.02, params || {});
    else {
      const T = makeTrack(G, name, (params && params.level) || 1, 0);
      T.only = params && params.only;
      const q = 60 / T.def.bpm / 4;
      for (let st = 0; T.next < sec; st++) { T.def.play(G, T, st, T.next, q); T.next += q; }
    }
    const buf = await ctx.startRendering();
    const L = buf.getChannelData(0), R = buf.getChannelData(1), win = Math.floor(sr * 0.05);
    let peak = 0, peakAt = 0, sum = 0, acc = 0, maxWin = 0, bad = 0, sumL = 0, sumR = 0;
    for (let i = 0; i < L.length; i++) {
      const a = L[i], b = R[i];
      if (!isFinite(a) || !isFinite(b)) { bad++; continue; }
      const m = Math.max(Math.abs(a), Math.abs(b));
      if (m > peak) { peak = m; peakAt = i / sr; }
      const e = (a * a + b * b) / 2;
      sum += e; acc += e; sumL += a * a; sumR += b * b;
      if ((i + 1) % win === 0) { maxWin = Math.max(maxWin, Math.sqrt(acc / win)); acc = 0; }
    }
    // 1サンプルだけ飛び出した点（プチッという雑音）を数える
    let spikes = 0;
    for (const X of [L, R]) {
      for (let i = 16; i < X.length - 16; i++) {
        const a = Math.abs(X[i]);
        if (a < 0.05) continue;
        let nb = 0;
        for (let j = 1; j <= 16; j++) nb = Math.max(nb, Math.abs(X[i - j]), Math.abs(X[i + j]));
        if (a > nb * 2.5) spikes++;
      }
    }
    return { peak, peakAt, rms: Math.sqrt(sum / L.length), loud: maxWin, bad, spikes, balance: sumL + sumR ? (sumR - sumL) / (sumR + sumL) : 0 };
  }

  return {
    setMode, scene, sfx, result,
    current: () => (track ? track.name : null),
    get level() { return track ? track.level : 0; },
    get mode() { return mode; },
    get ready() { return unlocked && !!live; },
    _offline: offline, _names: () => Object.keys(SFX), _dbg: { makeGraph, tone, noise, bell, pad, makeTrack, TRACKS },
  };
})();
