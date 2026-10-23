import os
# 見た目と動き（v12.3）：配置の◆◇、試合の所持キューブ（大会）、メモ（右クリック・メモのボタン・メモのマスはコールされない）
import asyncio, sys
from playwright.async_api import async_playwright
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
async def st(p):
    return await p.evaluate("() => { const a=window.__sb.app,g=a.game; return g ? {busy:a.busy,cur:g.cur,sub:g.sub,phase:g.phase,turn:g.turn,screen:a.screen} : {screen:a.screen,busy:a.busy} }")
async def settle(p, extra=0):
    for _ in range(300):
        s = await st(p)
        if not s.get('busy'): break
        await p.wait_for_timeout(80)
    if extra: await p.wait_for_timeout(extra)
    return await st(p)
async def run(p, tag, out):
    await p.goto(URL); await p.evaluate("() => localStorage.clear()"); await p.reload()
    # 大会の1試合目
    await p.click('label[for=opt-rules-2]'); await p.click('label[for=opt-speed-1]')
    await p.click('[data-act=start]'); await p.wait_for_timeout(300)
    await p.click('[data-act=tour-next]'); await p.wait_for_timeout(2300)
    # 配置：1つ置いて◆◇を見る
    await p.click('.shape-btn[data-key=I3]')
    await p.click('.cell[data-board=own][data-cell="0"]')
    await p.screenshot(path=f'{SHOTS}/v12_{tag}_setup.png', full_page=True)
    out['palette'] = await p.evaluate("() => [...document.querySelectorAll('.pal-h .cb')].map(e=>e.getAttribute('aria-label'))")
    await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
    s = await settle(p, 1200)
    # 相手の手番なら待つ
    for _ in range(60):
        s = await settle(p)
        if s['phase'] == 'play' and s['cur'] == 0 and s['sub'] == 'item': break
        await p.wait_for_timeout(150)
    free = await p.evaluate("() => { const g=window.__sb.app.game; return [...Array(g.NN).keys()].filter(c=>g.isCallable(0,c)) }")
    a, b, c3 = free[0], free[1], free[2]
    # 右クリックで×
    await p.click(f'.cell[data-board=pred][data-cell="{a}"]', button='right')
    # メモのボタン（●）→ タップでメモ
    await p.click('[data-act=memo-type][data-type=o]')
    await p.click(f'.cell[data-board=pred][data-cell="{b}"]')
    await p.click('[data-act=memo-type][data-type=t]')
    await p.click(f'.cell[data-board=pred][data-cell="{c3}"]')
    out['memoModeOn'] = await p.evaluate("() => window.__sb.app.ui.memoMode")
    await p.click('[data-act=memo-type][data-type=t]')   # もどる
    out['memo'] = await p.evaluate("() => window.__sb.app.ui.memo[0]")
    calls_before = await p.evaluate("() => window.__sb.app.game.players[0].kb.calls.length")
    await p.screenshot(path=f'{SHOTS}/v12_{tag}_memo.png', full_page=True)
    # メモのあるマスを左クリック → メモが外れるだけ
    await p.click(f'.cell[data-board=pred][data-cell="{a}"]')
    out['afterLeftClick'] = await p.evaluate(f"() => ({{ memo: window.__sb.app.ui.memo[0], calls: window.__sb.app.game.players[0].kb.calls.length, before: {calls_before} }})")
    # もう一度押すとコール
    await p.click(f'.cell[data-board=pred][data-cell="{a}"]')
    await settle(p, 400)
    out['afterSecondClick'] = await p.evaluate("() => window.__sb.app.game.players[0].kb.calls.length")
    el = await p.query_selector('.panel.scorebar')
    if el: await el.screenshot(path=f'{SHOTS}/v12_{tag}_score.png')
    out['held'] = await p.evaluate("() => [...document.querySelectorAll('.scorebar .held .cb')].map(e=>e.getAttribute('aria-label')).slice(0,4)")
    out['overflow'] = await p.evaluate("() => [document.documentElement.scrollWidth, innerWidth]")
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        for tag, vp in [('desk', {'width': 1360, 'height': 900}), ('phone', {'width': 390, 'height': 844})]:
            p = await b.new_page(viewport=vp)
            errs = []
            p.on('pageerror', lambda e: errs.append(str(e)))
            out = {}
            await run(p, tag, out)
            print(tag, out, 'errors', errs)
            await p.close()
        await b.close()
asyncio.run(main())
