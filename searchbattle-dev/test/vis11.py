import os
# 見た目の確認（v11）：ノードショット（数字・NoData）、バズーカ（分解・ヒット済みの撃破・破片）を1vs1の予選で
import asyncio
from playwright.async_api import async_playwright
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
async def st(p):
    return await p.evaluate("() => { const a=window.__sb.app,g=a.game; return {busy:a.busy,cur:g.cur,sub:g.sub,phase:g.phase,turn:g.turn,used:g.itemUsed,first:g.first} }")
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
async def run(p, tag):
    await p.goto(URL)
    await p.evaluate("() => localStorage.clear()"); await p.reload()
    await p.click('label[for=opt-mode-1]'); await p.click('label[for=opt-rules-0]'); await p.click('label[for=opt-items-0]'); await p.click('label[for=opt-speed-1]')
    await p.click('[data-act=start]')
    await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
    await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
    await settle(p, 1200)
    A = (await st(p))['first']
    target = None
    for _ in range(12):
        s = await settle(p)
        if s['phase'] != 'play': break
        t, cur = s['turn'], s['cur']
        if cur != A:
            await call_empty(p); await end_turn(p); continue
        if t == 1:
            # 相手の個体（3マス以上）の1マスをコールして◎を作る
            target = await ev(p, "() => { const g=window.__sb.app.game, v=g.cur; const q=g.living(1-v).slice().sort((a,b)=>b.size-a.size)[0]; return { cells: q.cells, size: q.size } }")
            await click_pred(p, target['cells'][0]); await settle(p, 900); await end_turn(p); continue
        if t == 2:
            # ノードショット：同じ個体の別のマス（数字）→ そのマスをコールして○
            await p.click('[data-act=item][data-key=node]')
            await settle(p, 100)
            await p.screenshot(path=f'{SHOTS}/v11_{tag}_node_dock.png', full_page=(tag == 'phone'))
            await click_pred(p, target['cells'][1]); await settle(p, 1500)
            await click_pred(p, target['cells'][1]); await settle(p, 900)
            el = await p.query_selector('.board[data-board=pred]')
            if el: await el.screenshot(path=f'{SHOTS}/v11_{tag}_node_result.png')
            await end_turn(p); continue
        if t == 3:
            # バズーカ：◎のマスに撃ち込む（◎と○のマスが砕け、残りは1マスキューブに）
            await p.click('[data-act=item][data-key=bazooka]')
            await settle(p, 100)
            await p.screenshot(path=f'{SHOTS}/v11_{tag}_bazooka_dock.png', full_page=(tag == 'phone'))
            await click_pred(p, target['cells'][0])
            await p.wait_for_timeout(700)
            await p.screenshot(path=f'{SHOTS}/v11_{tag}_bazooka_fx.png')
            await settle(p, 1600)
            await p.screenshot(path=f'{SHOTS}/v11_{tag}_bazooka_after.png', full_page=(tag == 'phone'))
            info = await ev(p, "() => { const g=window.__sb.app.game, v=g.cur; const P=g.players[1-v]; return { split: P.splitPieces.map(x=>x.cells), frags: P.pieces.filter(x=>x.frag).map(x=>[x.cells[0], x.alive]), log: g.log.slice(-2).map(e=>e.text) } }")
            print(tag, 'bazooka', info)
            await call_empty(p); await end_turn(p); continue
        if t == 4:
            # サーチサイズ：空きマス → NoData（ノードショットの NoData と同じ表示）
            c = await ev(p, "() => { const g=window.__sb.app.game, v=g.cur; return [...Array(g.NN).keys()].find(c=>!g.pieceAt(1-v,c) && !g.players[v].view.marks[c] && !g.players[v].view.dead[c]) }")
            await p.click('[data-act=item][data-key=number]'); await click_pred(p, c); await settle(p, 1500)
            await call_empty(p)
            await p.screenshot(path=f'{SHOTS}/v11_{tag}_A_view.png', full_page=(tag == 'phone'))
            await end_turn(p)
            # 相手（分解された側）の画面：自分フィールドに破片
            await settle(p, 900)
            await p.screenshot(path=f'{SHOTS}/v11_{tag}_B_view.png', full_page=(tag == 'phone'))
            el = await p.query_selector('.board[data-board=own]')
            if el: await el.screenshot(path=f'{SHOTS}/v11_{tag}_B_own.png')
            break
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        errs = []
        p = await b.new_page(viewport={'width': 1440, 'height': 940})
        p.on('pageerror', lambda e: errs.append(str(e)))
        p.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'ERR_TUNNEL' not in m.text else None)
        await run(p, 'desk')
        await p.close()
        p = await b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        p.on('pageerror', lambda e: errs.append(str(e)))
        await run(p, 'phone')
        print('phone overflow', await p.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]"))
        await p.close()
        print('errors', errs)
        await b.close()
asyncio.run(main())
