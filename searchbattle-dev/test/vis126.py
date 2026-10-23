import os
# v12.6 の画面確認：単発の結果は勝ち負けだけ（点数なし）、大会は持ち点の奪い合い（結果・順位表・試合のカード・試合中の持ち点）
import asyncio
from playwright.async_api import async_playwright
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
FINISH = """() => { const a=window.__sb.app, g=a.game; let n=0; while (g.phase==='play' && n++<600) SBAI.playTurn(g, g.cur);
  a.busy=false; a.ui.showResult=true; window.__sb.render(); return g.phase }"""
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        for view, vp in [('desk', {'width': 1360, 'height': 900}), ('phone', {'width': 390, 'height': 844})]:
            p = await b.new_page(viewport=vp)
            errs = []
            p.on('pageerror', lambda e: errs.append(str(e)))
            await p.goto(URL); await p.evaluate("() => localStorage.clear()"); await p.reload()
            await p.wait_for_selector('[data-act=start]')
            # 単発（CPU戦 4×4）
            await p.click('[data-act=start]')
            await p.wait_for_selector('[data-act=random]')
            await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
            await p.wait_for_timeout(600)
            bar1 = await p.inner_text('.scorebar thead')
            await p.evaluate(FINISH)
            await p.wait_for_selector('.overlay .score')
            single = await p.inner_text('.overlay .dialog')
            await p.screenshot(path=f'{SHOTS}/v126_single_{view}.png')
            # 大会：第1試合を最後まで進めて、結果の画面と大会の画面
            await p.evaluate("() => { const a=window.__sb.app; a.screen='title'; a.game=null; a.ui=null; window.__sb.render(); }")
            await p.click('label[for=opt-rules-2]')
            await p.click('[data-act=start]')
            await p.wait_for_selector('[data-act=tour-next]')
            await p.click('[data-act=tour-next]')
            await p.wait_for_selector('[data-act=random]')
            await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
            await p.wait_for_timeout(2300)
            bar2 = await p.inner_text('.scorebar thead')
            live = await p.inner_text('.scorebar td.live')
            await p.evaluate(FINISH)
            await p.wait_for_selector('.overlay .score')
            tour_res = await p.inner_text('.overlay .dialog')
            mp = await p.evaluate("() => { const g=window.__sb.app.game; return SBEngine.Tour.matchPoints(g) }")
            await p.screenshot(path=f'{SHOTS}/v126_tourres_{view}.png')
            await p.click('.overlay [data-act=tour-back]')
            await p.wait_for_timeout(3200)
            totals = await p.evaluate("() => window.__sb.app.tour.players.map(p=>SBEngine.Tour.total(p))")
            note = await p.inner_text('.standings .note')
            cards = await p.evaluate("() => [...document.querySelectorAll('.mc-pt')].map(e=>e.textContent)")
            sw = await p.evaluate("() => [document.documentElement.scrollWidth, innerWidth]")
            await p.screenshot(path=f'{SHOTS}/v126_hub_{view}.png', full_page=True)
            print(view, {'bar_single': bar1.replace('\n', ' '), 'single_has_pt': 'pt' in single or '万円' in single, 'single': single.replace('\n', ' ')[:160],
                         'bar_tour': bar2.replace('\n', ' '), 'live': live, 'tour_res': tour_res.replace('\n', ' ')[:260], 'mp': mp,
                         'totals': totals, 'sum': sum(totals), 'cards': cards, 'note': note[:80], 'sw': sw, 'errs': errs})
            await p.close()
        await b.close()
asyncio.run(main())
