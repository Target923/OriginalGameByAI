import os
# v12.5 の画面確認：配置の上限（4×4は4個体）、大会の画面にショップがないこと、タイトルの大会の説明
import asyncio, sys
from playwright.async_api import async_playwright
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        out = {}
        for view, vp in [('desk', {'width': 1360, 'height': 900}), ('phone', {'width': 390, 'height': 844})]:
            p = await b.new_page(viewport=vp)
            errs = []
            p.on('pageerror', lambda e: errs.append(str(e)))
            await p.goto(URL); await p.evaluate("() => localStorage.clear()"); await p.reload()
            await p.wait_for_selector('[data-act=start]')
            # 4×4 の CPU戦で、2マスを5つ置こうとする
            await p.click('[data-act=start]')
            await p.wait_for_selector('[data-act=setup-done]')
            await p.click('[data-act=shape][data-key=D2]')
            placed = 0
            for c in [0, 2, 8, 10, 5]:
                await p.click(f'.cell[data-board=own][data-cell="{c}"]')
                await p.wait_for_timeout(120)
            n = await p.evaluate("() => window.__sb.app.game.players[0].pieces.length")
            head = await p.inner_text('.setup .fhead small')
            toast = await p.evaluate("() => [...document.querySelectorAll('.toast')].map(t=>t.textContent).join('|')")
            await p.screenshot(path=f'{SHOTS}/v125_setup_{view}.png')
            # タイトルの大会の説明
            await p.evaluate("() => { window.__sb.app.screen='title'; window.__sb.app.game=null; window.__sb.render(); }")
            await p.click('label[for=opt-rules-2]')
            title_txt = await p.inner_text('.set-fixed') if await p.query_selector('.set-fixed') else ''
            await p.click('[data-act=start]')
            await p.wait_for_timeout(1200)
            shop = await p.query_selector('.shop, [data-act=tour-buy]')
            inv = await p.evaluate("() => window.__sb.app.tour.players.map(p=>Object.values(p.inv).reduce((a,b)=>a+b,0))")
            sw = await p.evaluate("() => [document.documentElement.scrollWidth, innerWidth]")
            await p.screenshot(path=f'{SHOTS}/v125_tour_{view}.png', full_page=True)
            out[view] = dict(pieces=n, head=head, toast=toast, title=title_txt[:60], shop=bool(shop), inv=inv, sw=sw, errs=errs)
            await p.close()
        for k, v in out.items(): print(k, v)
        await b.close()
asyncio.run(main())
