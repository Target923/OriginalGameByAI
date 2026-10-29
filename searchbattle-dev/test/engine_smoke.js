const E = require('../src/engine.js');
for (const N of [4,5]) {
  const P = E.placements(N);
  console.log('N='+N, Object.keys(P).map(k=>k+':'+P[k].length).join(' '));
}
// identifyShape sanity
console.log(E.identifyShape([0,1,2,5],4), E.identifyShape([0,4,8,9],4), E.identifyShape([0,1,4,5],4), E.identifyShape([0,1,5,6],4));
// random-move fuzz
function rnd(n){return Math.floor(Math.random()*n);}
let games=0, errors=0, draws=0, turns=0, skips=0, bz=0, fired=0; // bz: バズーカで分解した回数
for (let g=0; g<400; g++) {
  const G = new E.Game({rules: g%2?'final':'prelim'});
  for (const pi of [0,1]) { if(!G.randomSetup(pi)) throw new Error('setup fail'); const r=G.finishSetup(pi); if(!r.ok) throw new Error(r.reason); }
  if (G.phase==='draft') { while (G.phase==='draft') { const pi=G.draftTurn(); G.draftPick(pi, G.draft.pool[rnd(G.draft.pool.length)]); } }
  let guard=0;
  while (G.phase==='play' && guard++<2000) {
    const pi=G.cur, me=G.players[pi];
    if (G.sub==='item') {
      if (Math.random()<0.3) {
        const keys=E.ITEM_KEYS.filter(k=>G.itemStatus(pi,k).usable);
        if (keys.length) {
          const k=keys[rnd(keys.length)];
          const N=G.N, NN=G.NN;
          let params={};
          if (k==='cube') params = Math.random()<.5?{kind:'cat',value:E.CATS[rnd(3)]}:{kind:'size',value:1+rnd(5)};
          if (k==='line') params={line:Math.random()<.5?'row':'col',index:rnd(N)};
          if (k==='shape'||k==='number'||k==='node'||k==='bazooka') { const cs=[...Array(NN).keys()].filter(c=>!me.view.dead[c]); params={cell:cs[rnd(cs.length)]}; }
          if (k==='pair') { const cs=[...Array(NN).keys()].filter(c=>!me.view.dead[c]); if(cs.length<2) continue; const a=cs[rnd(cs.length)]; const rest=cs.filter(c=>c!==a); params={a, b:rest[rnd(rest.length)]}; }
          if (k==='warp') { const ps=G.living(pi); const p=ps[rnd(ps.length)]; let ok=false; for(let i=0;i<50&&!ok;i++){ params={pieceId:p.id,t:rnd(8),r0:rnd(N),c0:rnd(N)}; ok=G.validateItem(pi,'warp',params).ok;} if(!ok) continue; }
          if (k==='stealth') { const ps=G.living(pi).filter(p=>!p.stealth&&!p.stealthRevealed&&p.hitMask!==p.mask); if(!ps.length) continue; const sp=ps[rnd(ps.length)]; const op=sp.cells.filter(c=>!(sp.hitMask&(1<<c))); params={pieceId:sp.id,cell:op[rnd(op.length)]}; }
          const r=G.useItem(pi,k,params); if(!r.ok){errors++; console.log('item err',k,r.reason); } if (k==='bazooka' && r.hit) bz++;
          continue;
        }
      }
    }
    if (G.sub==='item'||G.sub==='call') {
      const cs=[...Array(G.NN).keys()].filter(c=>G.isCallable(pi,c));
      if(!cs.length){ const r=G.skipCall(pi); if(!r.ok){ console.log('SKIP FAILED', G.turn); errors++; break; } skips++; continue; }
      G.call(pi, cs[rnd(cs.length)]);
      continue;
    }
    if (G.sub==='answer') {
      if (Math.random()<0.15) { // random answer: a random living foe piece (cheat-ish) or garbage
        const foe=G.players[1-pi]; const ls=foe.pieces.filter(p=>p.alive);
        const cells = Math.random()<0.5 ? ls[rnd(ls.length)].cells : [rnd(G.NN)];
        G.answer(pi, cells);
        continue;
      }
      G.endTurn(pi); continue;
    }
    if (G.sub==='sacrifice') { const ls=G.living(pi); G.sacrifice(pi, ls[rnd(ls.length)].id); continue; }
    if (G.sub==='treasure') { const cs=[...Array(G.NN).keys()].filter(c=>G.isTreasureCallable(pi,c)); G.treasureCall(pi, cs[rnd(cs.length)]); continue; }
    console.log('stuck', G.sub); errors++; break;
  }
  if (G.phase!=='over') { console.log('not over', G.phase, G.sub, G.turn); errors++; }
  games++; turns+=G.turn; if (G.result&&G.result.draw) draws++; fired += G.players.reduce((a,P)=>a+P.splitPieces.length,0);
  // invariants
  for (const P of G.players) { const s=P.score; if (s.total !== s.attack+s.survival+s.treasure-s.rebuy) errors++; }
}
console.log({games, errors, draws, skips, bz, fired, avgTurns: (turns/games).toFixed(1)});
