import os
# 見た目の確認（v11.1）：バズーカのアイコン（アンバー・少し大きめ）、サーチライン／サーチキューブのタグの「残り」、ドラフト順の表示
import asyncio
from playwright.async_api import async_playwright
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
async def st(p):
    return await p.evaluate("() => { const a=window.__sb.app,g=a.game; return g ? {busy:a.busy,cur:g.cur,sub:g.sub,phase:g.phase,turn:g.turn,used:g.itemUsed,first:g.first} : {busy:a.busy} }")
async def settle(p, extra=0):
    for _ in range(200):
        s = await st(p)
        if not s['busy']: break
        await p.wait_for_timeout(80)
    if extra: await p.wait_for_timeout(extra)
    return await st(p)
async def ev(p, js):
    return await p.evaluate(js)
async def click_pred(p, c):
    await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
async def end_turn(p):
    s = await settle(p)
    if s['sub'] == 'answer': await p.click('[data-act=end-turn]')
    s = await settle(p)
    if s['sub'] == 'treasure':
        c = await ev(p, "() => { const g=window.__sb.app.game; return [...Array(g.NN).keys()].find(c=>g.isTreasureCallable(g.cur,c)) }")
        await click_pred(p, c)
    await settle(p, 300)
async def call_empty(p):
    c = await ev(p, "() => { const g=window.__sb.app.game, v=g.cur; const cs=[...Array(g.NN).keys()].filter(c=>g.isCallable(v,c)); return cs.find(c=>!g.pieceAt(1-v,c)) ?? cs[0] }")
    await click_pred(p, c)
    await settle(p, 200)
async def start(p, rules_idx):
    await p.goto(URL)
    await p.evaluate("() => localStorage.clear()"); await p.reload()
    await p.click('label[for=opt-mode-1]'); await p.click(f'label[for=opt-rules-{rules_idx}]'); await p.click('label[for=opt-items-0]'); await p.click('label[for=opt-speed-1]')
    await p.click('[data-act=start]')
    await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
    await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
    await settle(p, 1200)
async def run(p, tag):
    out = {}
    # 決勝：ドラフト画面（順番の表示・バズーカのカード）
    await start(p, 1)
    s = await st(p)
    if s.get('phase') == 'draft':
        out['draftOrder'] = await ev(p, "() => { const g=window.__sb.app.game; return g.draft.order.map(x=>x===g.first?'先':'後').join('') }")
        out['draftNote'] = await ev(p, "() => document.querySelector('.panel.draft .note')?.textContent")
        await p.screenshot(path=f'{SHOTS}/v11b_{tag}_draft.png', full_page=True)
    # 予選：サーチライン → 「残り」のタグ、アイテム欄のバズーカ
    await start(p, 0)
    A = (await st(p))['first']
    for _ in range(8):
        s = await settle(p)
        if s['phase'] != 'play': break
        t, cur = s['turn'], s['cur']
        if cur != A:
            await call_empty(p); await end_turn(p); continue
        if t == 1:
            await p.click('[data-act=item][data-key=line]'); await settle(p, 100)
            await p.click('[data-act=pick-line][data-line=col][data-index="1"]'); await settle(p, 1800)
            await call_empty(p); await end_turn(p); continue
        if t == 2:
            await call_empty(p)
            # バズーカを選んだ状態（ドックの見出し）→ もう一度押してやめる
            await p.click('[data-act=item][data-key=bazooka]'); await settle(p, 100)
            await p.screenshot(path=f'{SHOTS}/v11b_{tag}_bzsel.png', full_page=(tag == 'phone'))
            await p.click('[data-act=item][data-key=bazooka]'); await settle(p, 100)
            await p.click('[data-act=item][data-key=cube]'); await settle(p, 100)
            btn = await p.query_selector('.cube-menu [data-act=cube][data-kind=cat]')
            if btn:
                await btn.click(); await settle(p, 1800)
            out['tags'] = await ev(p, "() => [...document.querySelectorAll('.itag')].map(e=>e.textContent)")
            out['log'] = await ev(p, "() => window.__sb.app.game.log.filter(e=>e.kind==='item').map(e=>e.text)")
            out['bzChip'] = await ev(p, "() => { const e=document.querySelector('.chips.mine .ichip.bz'); if(!e) return null; const r=e.getBoundingClientRect(); const o=document.querySelector('.chips.mine .ichip:not(.bz)').getBoundingClientRect(); return { w:r.width, other:o.width, color:getComputedStyle(e).color } }")
            await p.screenshot(path=f'{SHOTS}/v11b_{tag}_play.png', full_page=True)
            break
    out['overflow'] = await ev(p, "() => [document.documentElement.scrollWidth, window.innerWidth]")
    return out
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        for tag, vp in [('desk', {'width': 1360, 'height': 900}), ('phone', {'width': 390, 'height': 844})]:
            p = await b.new_page(viewport=vp)
            errs = []
            p.on('pageerror', lambda e: errs.append(str(e)))
            r = await run(p, tag)
            print(tag, r, 'errors', errs)
            await p.close()
        await b.close()
asyncio.run(main())
