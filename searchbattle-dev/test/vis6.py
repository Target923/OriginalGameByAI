import os
# 見た目の確認用：ステルスの印・トレジャー残り回数・ドラフト順・コールを飛ばすボタン
import asyncio
from playwright.async_api import async_playwright
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
async def wait_human(p):
    for _ in range(200):
        s = await p.evaluate("() => { const a=window.__sb.app,g=a.game; return {busy:a.busy,cur:g.cur,sub:g.sub,phase:g.phase} }")
        if s['phase'] != 'play' or (not s['busy'] and s['cur'] == 0): return s
        await p.wait_for_timeout(150)
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        errs = []
        # 1) 予選：ステルスを使ってから数ターン
        p = await b.new_page(viewport={'width': 1440, 'height': 940})
        p.on('pageerror', lambda e: errs.append(str(e)))
        await p.goto(URL)
        await p.click('label[for=opt-speed-1]'); await p.click('label[for=opt-rules-0]'); await p.click('label[for=opt-items-0]')
        await p.click('[data-act=start]'); await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
        await wait_human(p)
        await p.click('[data-act=item][data-key=stealth]')
        c = await p.evaluate("() => window.__sb.app.game.living(0)[0].cells[0]")
        await p.click(f'.cell[data-board=own][data-cell="{c}"]')
        await p.wait_for_timeout(300)
        for _ in range(4):
            s = await wait_human(p)
            if s['phase'] != 'play': break
            if s['sub'] in ('item', 'call'):
                c = await p.evaluate("() => { const g=window.__sb.app.game; return [...Array(g.NN).keys()].find(c=>g.isCallable(0,c)) }")
                await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
            s = await wait_human(p)
            if s['sub'] == 'answer': await p.click('[data-act=end-turn]')
            s = await wait_human(p)
            if s['sub'] == 'treasure':
                c = await p.evaluate("() => { const g=window.__sb.app.game; return [...Array(g.NN).keys()].find(c=>g.isTreasureCallable(0,c)) }")
                await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
        await wait_human(p); await p.wait_for_timeout(1200)
        await p.screenshot(path=f'{SHOTS}/v6_battle.png')
        # 2) コールできるマスがない状態を作って、ボタンを確かめる
        await p.evaluate("""() => { const a=window.__sb.app,g=a.game; const v=g.players[0].view;
            for (let c=0;c<g.NN;c++) if (!v.marks[c] && !v.dead[c]) v.marks[c] = { r:'x', callable:false, t:g._tick() };
            if (g.sub !== 'item') { g.sub='item'; g.itemUsed=false; } window.__sb.render(); }""")
        await p.wait_for_timeout(200)
        has = await p.evaluate("() => !!document.querySelector('[data-act=skip-call]')")
        await p.screenshot(path=f'{SHOTS}/v6_skip.png', clip={'x': 290, 'y': 640, 'width': 860, 'height': 160})
        if has:
            await p.click('[data-act=skip-call]')
            sub = await p.evaluate("() => window.__sb.app.game.sub")
            print('skip-call button present, after click sub =', sub)
        else:
            print('skip-call button missing')
        await p.close()
        # 3) 決勝：ドラフト画面
        p = await b.new_page(viewport={'width': 1280, 'height': 820})
        p.on('pageerror', lambda e: errs.append(str(e)))
        await p.goto(URL)
        await p.click('label[for=opt-rules-1]'); await p.click('[data-act=start]'); await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
        await p.wait_for_timeout(1500)
        await p.screenshot(path=f'{SHOTS}/v6_draft.png')
        note = await p.evaluate("() => document.querySelector('.draft .note').textContent")
        print('draft note:', note)
        await p.close()
        print('errors', errs)
        await b.close()
asyncio.run(main())
