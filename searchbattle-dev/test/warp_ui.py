import os
# 画面上でCPUのワープを観測し、次をすべて突き合わせる
#  - 消える演出が出たマス / ログの「移動前」 / 盤面の W 付き× / エンジン上の移動前
#  - CPUの生きている個体が「再コールできない×」の下にいないこと（当てられない状態がない）
# ときどき公開ページの更新（スナップショット→再読み込み→復元）も挟む
import asyncio, json, re, random
from playwright.async_api import async_playwright
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
# 公開ページの更新を再現する。スナップショットは読み込み前のスクリプトで直接渡す
# （sessionStorage に書いてすぐ再読み込みすると、書き込みが間に合わず消えることがあるため）
HOT = """
(() => {
  // 読み込み前のスクリプトの実行順に頼らないよう、アプリが ready を呼んだ時点で読む
  window.claude = { hot: { snapshot(fn) { window.__snap = fn; }, ready(cb) {
    let data = {};
    try { data = window.__hotData ? JSON.parse(window.__hotData) : {}; } catch (e) {}
    cb(data);
  } } };
})();
"""
OBS = """
if (!window.__obs) { window.__obs = true; window.__dis = [];
new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) {
  if (n.nodeType===1 && n.classList.contains('fxo') && n.classList.contains('dissolve')) {
    const cell = n.parentElement; const board = cell.closest('.board');
    window.__dis.push({ cell: +cell.dataset.cell, board: board && board.dataset.board, ev: window.__sb.app.game.events.length });
  } } }).observe(document.getElementById('app'), { childList: true, subtree: true }); }
"""
CHECK = """() => {
  const g = window.__sb.app.game, N = g.N, v = g.players[0].view;
  const out = { bad: [] };
  // 1) CPUの生きている個体の下に、再コールできない×がない
  for (const p of g.living(1)) for (const c of p.cells) {
    const el = document.querySelector(`.board[data-board="pred"] .cell[data-cell="${c}"]`);
    const x = el && el.querySelector('.ink-x');
    if (x && !x.classList.contains('stale')) out.bad.push('unhittable ' + g.coord(c));
    if (v.marks[c] && v.marks[c].r === 'x' && !v.marks[c].callable) out.bad.push('engine-unhittable ' + g.coord(c));
  }
  // 2) 最新のCPUワープ：ログ・W付き×・エンジンの移動前が一致
  const ws = g.events.filter(e => e.type === 'item' && e.key === 'warp' && e.actor === 1);
  if (ws.length) {
    const w = ws[ws.length - 1];
    const logs = g.log.filter(l => l.kind === 'item' && l.key === 'warp' && l.actor === 1);
    const lt = logs[logs.length - 1].text;
    const want = SBEngine.coordList(w.oldCells, N);
    if (lt.indexOf('移動前 ' + want) < 0) out.bad.push('log ' + lt + ' vs ' + want);
    const wcells = [...document.querySelectorAll('.board[data-board="pred"] .cell')].filter(el => el.querySelector('.wtag')).map(el => +el.dataset.cell);
    const addAfter = g.events.some(e => e.type === 'item' && e.key === 'add' && e.id > w.id);
    const later = g.events.some(e => e.type === 'item' && e.key === 'warp' && e.id > w.id);
    if (!later && !addAfter && wcells.sort((a,b)=>a-b).join() !== w.oldCells.slice().sort((a,b)=>a-b).join()) out.bad.push('W ' + wcells + ' vs ' + w.oldCells);
    const dis = window.__dis.filter(d => d.board === 'pred' && d.ev > w.id).map(d => d.cell);
    out.lastWarp = { id: w.id, old: SBEngine.coordList(w.oldCells, N), log: lt, dis: [...new Set(dis)].sort((a,b)=>a-b).map(c => g.coord(c)).join('・') };
  }
  out.nWarps = ws.length;
  return out;
}"""

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        total = 0; bad = 0; reloads = 0; seen = set()
        for game in range(8):
            ctx = await b.new_context(viewport={'width':1440,'height':940})
            p = await ctx.new_page()
            await p.add_init_script(HOT)
            errs=[]; p.on('pageerror', lambda e: errs.append(str(e)))
            await p.goto(URL)
            await p.click('label[for=opt-speed-1]')
            await p.click(f'label[for=opt-rules-{game%2}]')
            await p.click('label[for=opt-items-0]')
            await p.click('[data-act=start]')
            await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
            for _ in range(40):
                if await p.evaluate("() => window.__sb.app.screen") == 'battle': break
                btn = await p.query_selector('[data-act=draft-pick]:not([disabled])')
                if btn: await btn.click()
                await p.wait_for_timeout(150)
            await p.evaluate(OBS)
            human_turns = 0
            for step in range(3000):
                s = await p.evaluate("() => { const a=window.__sb.app,g=a.game; return {sub:g.sub,cur:g.cur,busy:a.busy,phase:g.phase,turn:g.turn} }")
                if s['phase'] != 'play': break
                if s['busy'] or (s['cur'] == 1 and s['sub'] != 'bazooka'): await p.wait_for_timeout(80); continue
                if s['sub'] == 'item':
                    r = await p.evaluate(CHECK)
                    if r.get('lastWarp') and r['lastWarp']['id'] not in seen:
                        seen.add(r['lastWarp']['id']); total += 1
                        print('game', game, 'CPU warp', r['lastWarp'])
                    if r['bad']:
                        bad += 1; print('  BAD', r['bad'])
                    human_turns += 1
                    # ときどき公開ページの更新を再現
                    if human_turns % 4 == 0:
                        snapinfo = await p.evaluate("() => { const s = window.__snap(); const str = JSON.stringify(s); return { str, len: str.length, hasGame: !!s.game, screen: s.screen, v: s.game && s.game.v } }")
                        seq = reloads + 1
                        await ctx.add_init_script('if (!(window.__hotSeq >= %d)) { window.__hotSeq = %d; window.__hotData = %s; }' % (seq, seq, json.dumps(snapinfo.pop('str'))))
                        await p.reload(); reloads += 1
                        await p.evaluate(OBS)
                        ok = await p.evaluate("() => !!(window.__sb && window.__sb.app.game)")
                        if not ok:
                            diag = await p.evaluate("() => ({ screen: window.__sb && window.__sb.app.screen, stored: (window.__hotData || '').length, toast: document.getElementById('toast') && document.getElementById('toast').textContent })")
                            print('RESTORE FAILED', snapinfo, diag, errs[:3]); bad += 1
                            break
                        r2 = await p.evaluate(CHECK)
                        if r2['bad']: bad += 1; print('  BAD after reload', r2['bad'])
                        continue
                if s['sub'] in ('item','call'):
                    c = await p.evaluate("""() => { const g=window.__sb.app.game; const cs=[...Array(g.NN).keys()].filter(c=>g.isCallable(0,c));
                        const hit=cs.filter(c=>g.pieceAt(1,c)); const pool = (hit.length && Math.random()<0.7) ? hit : cs; return pool[Math.floor(Math.random()*pool.length)] }""")
                    await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
                elif s['sub'] == 'answer': await p.click('[data-act=end-turn]')
                elif s['sub'] == 'treasure':
                    c = await p.evaluate("() => { const g=window.__sb.app.game; return [...Array(g.NN).keys()].find(c=>g.isTreasureCallable(0,c)) }")
                    await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
                elif s['sub'] in ('sacrifice','bazooka'):
                    c = await p.evaluate("() => window.__sb.app.game.living(0)[0].cells[0]")
                    await p.click(f'.cell[data-board=own][data-cell="{c}"]')
                else: await p.wait_for_timeout(100)
            fin = await p.evaluate("() => window.__sb.app.game.phase")
            if errs: print('page errors', errs[:3])
            print('game', game, 'finished:', fin)
            await ctx.close()
        print('CPU warps checked:', total, 'problems:', bad, 'reloads:', reloads)
        await b.close()
asyncio.run(main())
