import os
# v12.7 の画面確認：宝石（順位表のアイコン・結果の「宝石」の列・試合中の持ち点）と、勝利点 6・9・12・15
import asyncio
from playwright.async_api import async_playwright
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
FINISH = """() => { const a=window.__sb.app, g=a.game; let n=0; while (g.phase==='play' && n++<600) SBAI.playTurn(g, g.cur);
  a.busy=false; a.ui.showResult=true; window.__sb.render(); return g.phase }"""
GEMS = """() => { const T=window.__sb.app.tour; return [...document.querySelectorAll('.standings .st-row')].map(r=>({ id:+r.dataset.id, icons:r.querySelectorAll('.st-gems .gm').length, gems:T.players[+r.dataset.id].gems, pts:r.querySelector('.st-pts b').textContent })) }"""
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        for view, vp in [('desk', {'width': 1360, 'height': 900}), ('phone', {'width': 390, 'height': 844})]:
            p = await b.new_page(viewport=vp)
            errs = []
            p.on('pageerror', lambda e: errs.append(str(e)))
            await p.goto(URL); await p.evaluate("() => localStorage.clear()"); await p.reload()
            await p.wait_for_selector('[data-act=start]')
            await p.click('label[for=opt-rules-2]')
            await p.click('[data-act=start]')
            await p.wait_for_selector('[data-act=tour-next]')
            await p.wait_for_timeout(1200)
            intro_gems = await p.evaluate(GEMS)
            lede = await p.evaluate("() => (document.querySelector('.tour .lede, .tour p') || {}).textContent || ''")
            await p.screenshot(path=f'{SHOTS}/v127_intro_{view}.png', full_page=True)
            # ルール説明
            await p.evaluate("() => { window.__sb.app.modal='rules'; window.__sb.render(); }")
            rules = await p.evaluate("() => (document.querySelector('.overlay') || {}).textContent || ''")
            await p.evaluate("() => { window.__sb.app.modal=null; window.__sb.render(); }")
            # 第1試合：相手のトレジャーを見つけた状態の持ち点（試合中）を確かめてから最後まで
            await p.click('[data-act=tour-next]')
            await p.wait_for_selector('[data-act=random]')
            await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
            await p.wait_for_timeout(2300)
            live0 = await p.inner_text('.scorebar td.live')
            # 相手が自分のトレジャーを見つけた（試合中の持ち点は 5 減る）
            live1 = await p.evaluate("""() => { const a=window.__sb.app, g=a.game; g.players[1].view.treasureFound = true; window.__sb.render();
              const r=[...document.querySelectorAll('.scorebar td.live')].map(e=>e.textContent); g.players[1].view.treasureFound = false; window.__sb.render(); return r }""")
            await p.evaluate(FINISH)
            await p.wait_for_selector('.overlay .score')
            res = await p.inner_text('.overlay .dialog')
            mp = await p.evaluate("() => SBEngine.Tour.matchPoints(window.__sb.app.game)")
            vp1 = await p.evaluate("() => window.__sb.app.game.victoryPts")
            await p.screenshot(path=f'{SHOTS}/v127_res_{view}.png')
            await p.click('.overlay [data-act=tour-back]')
            await p.wait_for_timeout(3200)
            hub_gems = await p.evaluate(GEMS)
            tip = await p.evaluate("() => (document.querySelector('.standings .st-pts') || {}).dataset.tip")
            cards = await p.evaluate("() => [...document.querySelectorAll('.mc-pt')].map(e=>e.dataset.tip)")
            sw = await p.evaluate("() => [document.documentElement.scrollWidth, innerWidth]")
            await p.screenshot(path=f'{SHOTS}/v127_hub_{view}.png', full_page=True)
            # 2試合目の勝利点
            await p.click('[data-act=tour-next]')
            await p.wait_for_selector('[data-act=random]')
            vp2 = await p.evaluate("() => window.__sb.app.game.victoryPts")
            print(view, {'intro': intro_gems, 'lede': lede[:120], 'rules_has': ['宝石' in rules, '6・9・12・決勝15' in rules],
                         'live0': live0, 'live_found_by_foe': live1, 'res': res.replace('\n', ' ')[:330], 'mp': mp, 'vp1': vp1, 'vp2': vp2,
                         'hub': hub_gems, 'sum_gems': sum(x['gems'] for x in hub_gems), 'tip': tip, 'cards': cards, 'sw': sw, 'errs': errs})
            await p.close()
        await b.close()
asyncio.run(main())
