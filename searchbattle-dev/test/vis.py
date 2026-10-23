import os
# 1回の確認用：新UIの要所をまとめて撮る
import asyncio
from playwright.async_api import async_playwright
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
async def st(p): return await p.evaluate("() => { const a=window.__sb.app,g=a.game; return g?{sub:g.sub,cur:g.cur,turn:g.turn,busy:a.busy,phase:g.phase,used:g.itemUsed}:{} }")
async def human_wait(p):
    for _ in range(400):
        s=await st(p)
        if s.get('phase')!='play': return s
        if s['cur']==0 and not s['busy'] and s['sub'] in ('item','answer','treasure','sacrifice','bazooka'): return s
        await p.wait_for_timeout(120)
    return await st(p)
async def call_any(p, prefer_hit=False):
    c = await p.evaluate("""(h) => { const g=window.__sb.app.game; const cs=[...Array(g.NN).keys()].filter(c=>g.isCallable(0,c)); if(h){ const x=cs.find(c=>g.pieceAt(1,c)); if(x!=null) return x;} return cs[Math.floor(Math.random()*cs.length)] }""", prefer_hit)
    await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
async def finish_turn(p):
    s=await st(p)
    if s['sub']=='answer': await p.click('[data-act=end-turn]')
    s=await st(p)
    if s['sub']=='treasure':
        c = await p.evaluate("() => { const g=window.__sb.app.game; return [...Array(g.NN).keys()].find(c=>g.isTreasureCallable(0,c)) }")
        await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
async def main():
    async with async_playwright() as pw:
        b=await pw.chromium.launch(); p=await b.new_page(viewport={'width':1440,'height':940})
        errs=[]; p.on('pageerror', lambda e: errs.append(str(e)))
        await p.goto(URL); await p.click('label[for=opt-speed-1]'); await p.click('[data-act=start]')
        await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
        used=[]
        # 数ターン進めながら、コール前後にサーチ系を使う
        plan=[('all','pre'),('number','post'),('shape','post'),('pair','post'),('log','post'),('cube','pre')]
        tchance_shot=False
        for turn_i in range(14):
            s=await human_wait(p)
            if s.get('phase')!='play': break
            if s['sub']=='bazooka':
                c=await p.evaluate("() => window.__sb.app.game.living(0)[0].cells[0]"); await p.click(f'.cell[data-board=own][data-cell="{c}"]'); continue
            if s['sub']=='sacrifice':
                c=await p.evaluate("() => window.__sb.app.game.living(0)[0].cells[0]"); await p.click(f'.cell[data-board=own][data-cell="{c}"]'); continue
            if s['sub']=='treasure': await finish_turn(p); continue
            nxt = plan[0] if plan else None
            if nxt and nxt[1]=='pre' and s['sub']=='item':
                k=nxt[0]; await p.click(f'[data-act=item][data-key={k}]')
                if k=='all': await p.click('[data-act=item-use]')
                if k=='cube':
                    await p.wait_for_timeout(250); await p.screenshot(path=f'{SHOTS}/v3_2_cube_menu.png')
                    await p.click('.cm-btn[data-kind=cat][data-value="L字"]')
                plan.pop(0); used.append(k); await p.wait_for_timeout(300)
            await call_any(p, prefer_hit=True)
            await p.wait_for_timeout(300)
            s=await st(p)
            if s.get('phase')!='play': break
            nxt = plan[0] if plan else None
            if nxt and nxt[1]=='post' and s['sub']=='answer' and not s['used']:
                k=nxt[0]
                hits = await p.evaluate("() => { const g=window.__sb.app.game,v=g.players[0].view; return [...Array(g.NN).keys()].filter(c=>v.marks[c]&&v.marks[c].r!=='x'&&!v.dead[c]) }")
                ok=True
                if k=='pair' and len(hits)<2: ok=False
                if k=='log' and len(hits)<1: ok=False
                if ok:
                    await p.click(f'[data-act=item][data-key={k}]')
                    if k=='number':
                        await p.hover('.axbtn[data-line=row][data-index="1"]'); await p.wait_for_timeout(150)
                        await p.screenshot(path=f'{SHOTS}/v3_3_number_pick.png')
                        await p.click('.axbtn[data-line=row][data-index="1"]')
                    elif k=='shape':
                        c=await p.evaluate("() => { const g=window.__sb.app.game; return [...Array(g.NN).keys()].find(c=>!g.players[0].view.dead[c] && !g.players[0].view.marks[c]) }")
                        await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
                    elif k=='pair':
                        await p.click(f'.cell[data-board=pred][data-cell="{hits[0]}"]'); await p.click(f'.cell[data-board=pred][data-cell="{hits[1]}"]')
                    elif k=='log':
                        await p.click(f'.cell[data-board=pred][data-cell="{hits[0]}"]')
                    plan.pop(0); used.append(k+'(post)')
                    await p.wait_for_timeout(300)
            s=await st(p)
            if s.get('phase')!='play': break
            if s['sub']=='answer':
                await p.click('[data-act=end-turn]')
                await p.wait_for_timeout(200)
                s=await st(p)
                if s['sub']=='treasure' and not tchance_shot:
                    await p.wait_for_timeout(250); await p.screenshot(path=f'{SHOTS}/v3_4_tchance.png'); tchance_shot=True
                await finish_turn(p)
        # 調査記録が載った状態のフィールド＋ツールチップ
        s=await human_wait(p)
        await p.wait_for_timeout(1500)
        await p.hover('[data-act=item][data-key=warp]'); await p.wait_for_timeout(200)
        await p.screenshot(path=f'{SHOTS}/v3_1_battle_intel.png', full_page=True)
        print('used:', used, 'errors:', errs)
        await b.close()
asyncio.run(main())
