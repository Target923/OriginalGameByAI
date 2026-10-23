// ワープの不変条件を検証：ログ・イベント・×マーク・実位置の一致、元の位置との非重複
const E = require('../src/engine.js');
const AI = require('../src/ai.js');
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
let warps=0, bad=0, pieceBad=0, roundtrips=0;
function checkPieces(G, tag){
  for (const P of G.players) for (const p of P.pieces) {
    const cells = E.cellsFor(p.shape, p.t, p.r0, p.c0, G.N);
    const ok = cells && cells.join() === p.cells.join() && E.maskOf(p.cells) === p.mask;
    if (!ok) { pieceBad++; if (pieceBad < 5) console.log('PIECE MISMATCH', tag, p.shape, p.t, p.r0, p.c0, p.cells, cells); }
  }
}
const origUse = E.Game.prototype.useItem;
E.Game.prototype.useItem = function(pi, key, params) {
  if (key !== 'warp') return origUse.call(this, pi, key, params);
  const p = this.players[pi].pieces.find(x => x.id === params.pieceId);
  const before = p ? p.cells.slice() : null;
  const nEv = this.events.length, nLog = this.log.length;
  const r = origUse.call(this, pi, key, params);
  if (!r.ok) return r;
  warps++;
  const ev = this.events.slice(nEv).find(e => e.type === 'item' && e.key === 'warp');
  const lg = this.log[nLog];
  const fromTxt = E.coordList(before, this.N);
  const after = p.cells;
  const overlap = after.some(c => before.includes(c));
  const evOk = ev && ev.oldCells.join() === before.join();
  const logOk = lg && lg.text.includes('移動前 ' + fromTxt);
  const xOk = before.every(c => this.players[1-pi].view.marks[c] && this.players[1-pi].view.marks[c].r === 'x');
  if (overlap || !evOk || !logOk || !xOk) { bad++; if (bad < 6) console.log('WARP BAD', {overlap, evOk, logOk, xOk, before, after, text: lg && lg.text}); }
  return r;
};
for (let gi = 0; gi < 300; gi++) {
  for (const rules of ['prelim','final']) {
    const rng = mulberry32(5000 + gi);
    let G = new E.Game({ rules, rng, cpu:[true,true], wallet: 15 });
    AI.setup(G, 0); AI.setup(G, 1); G.finishSetup(0); G.finishSetup(1);
    while (G.phase === 'draft') { const pi = G.draftTurn(); G.draftPick(pi, AI.draftPick(G, pi)); }
    let guard = 0;
    while (G.phase === 'play' && guard++ < 400) {
      // ときどき画面更新時の状態引き継ぎ（JSON往復）を挟む
      if (guard % 7 === 0) {
        const data = JSON.parse(JSON.stringify(Object.assign({}, G, { rng: undefined })));
        const g2 = Object.create(E.Game.prototype); Object.assign(g2, data); g2.rng = rng; G = g2; roundtrips++;
      }
      // 防御判定に関係なく、使えるならランダムにワープも試す
      if (G.sub === 'item' && G.itemStatus(G.cur, 'warp').usable && rng() < 0.25) {
        const pi = G.cur; const ps = G.living(pi);
        const p = ps[Math.floor(rng()*ps.length)];
        const tgt = AI.bestWarpTarget(G, pi, p);
        if (tgt) G.useItem(pi, 'warp', tgt);
        if (G.phase !== 'play') break;
      }
      AI.playTurn(G, G.cur);
      checkPieces(G, rules);
    }
  }
}
console.log({ warps, bad, pieceBad, roundtrips });
