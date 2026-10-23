import os
# 見た目の確認（v10）：サーチサイズ／シェイプの NoData、ペアショットの＝・≠、バズーカの宣言〜発動（1vs1・予選）
import asyncio, sys
from playwright.async_api import async_playwright
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
async def st(p):
    return await p.evaluate("() => { const a=window.__sb.app,g=a.game; return {busy:a.busy,cur:g.cur,sub:g.sub,phase:g.phase,turn:g.turn,used:g.itemUsed} }")
async def settle(p):
    for _ in range(200):
        s = await st(p)
        if not s['busy']: return s
        await p.wait_for_timeout(80)
async def call_empty(p, t=0):
    # 4〜6ターン目は、まだ当たっていない個体の1マスをコール（◎を作る）。それ以外は空きマス（アイテムで調べたマスは避ける）
    c = await p.evaluate(f"""() => {{ const g=window.__sb.app.game, v=g.cur; const kb=g.players[v].kb;
      const probed=new Set(kb.empties.filter(e=>e.src==='number'||e.src==='shape').map(e=>e.c));
      const cs=[...Array(g.NN).keys()].filter(c=>g.isCallable(v,c));
      if ({t} >= 4 && {t} <= 6) {{ const q=g.living(1-v).find(q=>!q.hitMask); if (q) return q.cells[0]; }}
      return cs.find(c=>!g.pieceAt(1-v,c) && !probed.has(c)) ?? cs.find(c=>!probed.has(c)) ?? cs[0] }}""")
    await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
async def finish_turn(p):
    s = await settle(p)
    if s['sub'] == 'answer': await p.click('[data-act=end-turn]')
    s = await settle(p)
    if s['sub'] == 'treasure':
        c = await p.evaluate("() => { const g=window.__sb.app.game; return [...Array(g.NN).keys()].find(c=>g.isTreasureCallable(g.cur,c)) }")
        await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
    await p.wait_for_timeout(250)
async def use_cell_item(p, key, empty=True):
    c = await p.evaluate(f"() => {{ const g=window.__sb.app.game, v=g.cur; const cs=[...Array(g.NN).keys()].filter(c=>!g.players[v].view.dead[c] && !g.players[v].view.marks[c]).reverse(); return cs.find(c=>{'!' if empty else ''}g.pieceAt(1-v,c)) }}")
    if c is None: return None
    await p.click(f'[data-act=item][data-key={key}]')
    await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
    return c
async def run(p, tag):
    await p.goto(URL)
    await p.evaluate("() => localStorage.clear()"); await p.reload()
    await p.click('label[for=opt-mode-1]'); await p.click('label[for=opt-rules-0]'); await p.click('label[for=opt-items-0]'); await p.click('label[for=opt-speed-1]')
    await p.click('[data-act=start]')
    await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
    await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
    await p.wait_for_timeout(1200)
    shot = 0
    while True:
        s = await settle(p)
        if s['phase'] != 'play': print(tag, 'game ended early', s); return
        t, cur = s['turn'], s['cur']
        if t >= 9: break
        # プレイヤー1：アイテムを試す
        if cur == 0 and s['sub'] == 'item' and not s['used']:
            if t == 2: await use_cell_item(p, 'number', True)
            elif t == 3: await use_cell_item(p, 'shape', True)
            elif t == 4:
                ab = await p.evaluate("() => { const g=window.__sb.app.game; const q=g.living(1)[0]; return [q.cells[0], q.cells[1]] }")
                await p.click('[data-act=item][data-key=pair]'); await p.click(f'.cell[data-board=pred][data-cell="{ab[0]}"]'); await p.click(f'.cell[data-board=pred][data-cell="{ab[1]}"]')
            await settle(p); await p.wait_for_timeout(1400)
        if cur == 1 and s['sub'] == 'item' and t == 4 and not s['used']:
            ab = await p.evaluate("() => { const g=window.__sb.app.game; const cs=[...Array(g.NN).keys()].filter(c=>!g.pieceAt(0,c)); return [cs[0], cs[3]] }")
            await p.click('[data-act=item][data-key=pair]'); await p.click(f'.cell[data-board=pred][data-cell="{ab[0]}"]'); await p.click(f'.cell[data-board=pred][data-cell="{ab[1]}"]')
            await settle(p); await p.wait_for_timeout(1400)
        s = await settle(p)
        if s['sub'] in ('item', 'call'): await call_empty(p, t)
        await settle(p); await p.wait_for_timeout(900)
        if t == 5 and cur == 1:
            await p.screenshot(path=f'{SHOTS}/v10_{tag}_nodata_pairs.png', full_page=(tag == 'phone'))
            # 相手フィールド（プレイヤー2から見たプレイヤー1のフィールド）と自分フィールドを拡大して撮る
            el = await p.query_selector('.board[data-board=own]')
            if el: await el.screenshot(path=f'{SHOTS}/v10_{tag}_board_own.png')
            el = await p.query_selector('.board[data-board=pred]')
            if el: await el.screenshot(path=f'{SHOTS}/v10_{tag}_board_pred.png')
        if t == 8:
            s = await settle(p)
            btn = await p.query_selector('[data-act=bz-declare]')
            if btn:
                await p.screenshot(path=f'{SHOTS}/v10_{tag}_bz_button_p{cur+1}.png', full_page=(tag == 'phone'))
                await btn.click()
                await p.wait_for_selector('[data-act=bz-confirm]')
                await p.screenshot(path=f'{SHOTS}/v10_{tag}_bz_confirm_p{cur+1}.png', full_page=(tag == 'phone'))
                await p.click('[data-act=bz-confirm]')
                await p.wait_for_timeout(500)
                await p.screenshot(path=f'{SHOTS}/v10_{tag}_bz_declared_p{cur+1}.png')
                await p.wait_for_timeout(1200)
            else:
                print(tag, 'no declare button at turn 8 for', cur)
        first = await p.evaluate("() => window.__sb.app.game.first")
        if t == 8 and cur == 1 - first:
            # 後に動く人の手番を終える（8ターン目は偶数なのでトレジャーコールもある）→ 次のターンの始めに発動
            s = await settle(p)
            if s['sub'] == 'answer': await p.click('[data-act=end-turn]')
            s = await settle(p)
            if s['sub'] == 'treasure':
                c = await p.evaluate("() => { const g=window.__sb.app.game; return [...Array(g.NN).keys()].find(c=>g.isTreasureCallable(g.cur,c)) }")
                await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
            # 発動の演出の途中
            await p.wait_for_timeout(650)
            await p.screenshot(path=f'{SHOTS}/v10_{tag}_bz_fire1.png')
            await p.wait_for_timeout(700)
            await p.screenshot(path=f'{SHOTS}/v10_{tag}_bz_fire2.png')
            await settle(p); await p.wait_for_timeout(2500)
            await p.screenshot(path=f'{SHOTS}/v10_{tag}_bz_after.png', full_page=(tag == 'phone'))
            hud = await p.evaluate("() => document.querySelector('.bzstat') && document.querySelector('.bzstat').textContent")
            print(tag, 'after fire HUD:', hud, 'fired', await p.evaluate("() => window.__sb.app.game.bazooka.fired"))
            break
        await finish_turn(p)
    logs = await p.evaluate("() => [...document.querySelectorAll('.loglist li.k-bazooka .x')].map(e=>e.textContent)")
    print(tag, 'bazooka log entries:', logs[:6])
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
        ow = await p.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")
        print('phone overflow', ow)
        await p.close()
        print('errors', errs)
        await b.close()
asyncio.run(main())
