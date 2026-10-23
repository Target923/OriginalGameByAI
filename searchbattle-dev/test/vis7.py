import os
# 見た目の確認：進行表示がフィールドの上・サウンドボタン・アイテム選択中の表示（PCとスマホ幅）
import asyncio
from playwright.async_api import async_playwright
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
async def wait_human(p):
    for _ in range(300):
        s = await p.evaluate("() => { const a=window.__sb.app,g=a.game; return {busy:a.busy,cur:g.cur,sub:g.sub,phase:g.phase} }")
        if s['phase'] != 'play' or (not s['busy'] and s['cur'] == 0): return s
        await p.wait_for_timeout(120)
async def run(p, tag):
    await p.goto(URL)
    await p.evaluate("() => localStorage.clear()"); await p.reload()
    await p.screenshot(path=f'{SHOTS}/v7_{tag}_title.png', full_page=True)
    await p.click('label[for=opt-speed-1]'); await p.click('label[for=opt-rules-1]'); await p.click('label[for=opt-items-0]')
    await p.click('[data-act=start]'); await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
    for _ in range(60):
        if await p.evaluate("() => window.__sb.app.screen") == 'battle': break
        btn = await p.query_selector('[data-act=draft-pick]:not([disabled])')
        if btn: await btn.click()
        await p.wait_for_timeout(150)
    for _ in range(3):
        s = await wait_human(p)
        if s['sub'] in ('item', 'call'):
            c = await p.evaluate("() => { const g=window.__sb.app.game; return [...Array(g.NN).keys()].find(c=>g.isCallable(0,c)) }")
            await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
        s = await wait_human(p)
        if s['sub'] == 'answer': await p.click('[data-act=end-turn]')
        s = await wait_human(p)
        if s['sub'] == 'treasure':
            c = await p.evaluate("() => { const g=window.__sb.app.game; return [...Array(g.NN).keys()].find(c=>g.isTreasureCallable(0,c)) }")
            await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
    await wait_human(p); await p.wait_for_timeout(1300)
    await p.screenshot(path=f'{SHOTS}/v7_{tag}_battle.png', full_page=(tag == 'phone'))
    key = await p.evaluate("() => { const g=window.__sb.app.game; return ['dist','number','pair','shape'].find(k => g.itemStatus(0,k).usable) }")
    if key:
        await p.click(f'[data-act=item][data-key={key}]')
        await p.wait_for_timeout(200)
        await p.screenshot(path=f'{SHOTS}/v7_{tag}_item.png', full_page=(tag == 'phone'))
        # 盤面の位置が、アイテムを選ぶ前後でどれだけ動くか
        print(tag, 'item', key)
    y = await p.evaluate("() => { const b = document.querySelector('.fields'); return Math.round(b.getBoundingClientRect().top + window.scrollY) }")
    return y
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        errs = []
        p = await b.new_page(viewport={'width': 1440, 'height': 940})
        p.on('pageerror', lambda e: errs.append(str(e)))
        print('desktop fields top', await run(p, 'desk'))
        await p.close()
        p = await b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        p.on('pageerror', lambda e: errs.append(str(e)))
        print('phone fields top', await run(p, 'phone'))
        await p.close()
        print('errors', errs)
        await b.close()
asyncio.run(main())
