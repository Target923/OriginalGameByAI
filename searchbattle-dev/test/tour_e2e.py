import os
# 大会モードを画面から最後まで通す（人の手番は画面のクリックで進める）
#  smart：CPUと同じ判断でコール・アンサー（決勝まで進みやすい）／weak：でたらめにコールしてアンサーしない（予選敗退の流れ）
# 使い方: python3 test/tour_e2e.py [smart|weak] [desk|phone]
import asyncio, sys, json
from playwright.async_api import async_playwright
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
STYLE = sys.argv[1] if len(sys.argv) > 1 else 'smart'
VIEW = sys.argv[2] if len(sys.argv) > 2 else 'desk'
FORCEQ = len(sys.argv) > 3 and sys.argv[3] == 'forceq'   # 決勝まで進む流れを確かめるため、予選の途中であなたにポイントを足す
VP = {'desk': {'width': 1360, 'height': 900}, 'phone': {'width': 390, 'height': 844}}[VIEW]

async def st(p):
    return await p.evaluate("""() => { const a=window.__sb.app, g=a.game, T=a.tour;
      return { screen:a.screen, busy:a.busy, modal:a.modal, stage:T&&T.stage, round:T&&T.round,
        phase:g&&g.phase, sub:g&&g.sub, cur:g&&g.cur, turn:g&&g.turn, showResult: !!(a.ui&&a.ui.showResult) } }""")

async def settle(p, ms=60):
    for _ in range(400):
        s = await st(p)
        if not s['busy']: return s
        await p.wait_for_timeout(ms)
    return await st(p)

async def human_turn(p, log):
    s = await st(p)
    sub = s['sub']
    if sub == 'sacrifice':
        c = await p.evaluate("() => window.__sb.app.game.living(0)[0].cells[0]")
        await p.click(f'.cell[data-board=own][data-cell="{c}"]'); return
    if sub == 'treasure':
        c = await p.evaluate("""() => { const g=window.__sb.app.game; const cs=[...Array(g.NN).keys()].filter(c=>g.isTreasureCallable(0,c));
          return STYLE_SMART ? SBAI.chooseTreasure(g,0) : cs[Math.floor(Math.random()*cs.length)] }""".replace('STYLE_SMART', 'true' if STYLE == 'smart' else 'false'))
        await p.click(f'.cell[data-board=pred][data-cell="{c}"]'); return
    if sub in ('item', 'call'):
        c = await p.evaluate("""() => { const g=window.__sb.app.game; const cs=[...Array(g.NN).keys()].filter(c=>g.isCallable(0,c));
          if (!cs.length) return null; return STYLE_SMART ? SBAI.chooseCall(g,0) : cs[Math.floor(Math.random()*cs.length)] }""".replace('STYLE_SMART', 'true' if STYLE == 'smart' else 'false'))
        if c is None:
            await p.click('[data-act=skip-call]'); return
        # ときどきアイテムも使う（サーチサイズ：コールするマスに）
        use = await p.evaluate("() => { const g=window.__sb.app.game; return g.sub==='item' && g.itemStatus(0,'number').usable && Math.random()<0.25 }")
        if use:
            await p.click('[data-act=item][data-key=number]')
            await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
            log.append('number')
            await settle(p)
            s2 = await st(p)
            if s2['phase'] != 'play' or s2['sub'] not in ('call',): return
        await p.click(f'.cell[data-board=pred][data-cell="{c}"]'); return
    if sub == 'answer':
        cells = None
        if STYLE == 'smart':
            cells = await p.evaluate("() => SBAI.chooseAnswer(window.__sb.app.game, 0)")
        if cells:
            await p.click('[data-act=answer-start]')
            for x in cells: await p.click(f'.cell[data-board=pred][data-cell="{x}"]')
            await p.click('[data-act=answer-submit]'); log.append('answer'); return
        await p.click('[data-act=end-turn]'); return

async def play_match(p, tag, log):
    # 配置：おまかせ → 完了
    await p.wait_for_selector('[data-act=random]')
    await p.click('[data-act=random]')
    await p.click('[data-act=setup-done]')
    for step in range(3000):
        s = await settle(p)
        if s['screen'] == 'draft':
            btn = await p.query_selector('[data-act=draft-pick]:not([disabled])')
            if btn: await btn.click()
            else: await p.wait_for_timeout(100)
            continue
        if s['phase'] == 'over': break
        if s['screen'] != 'battle' or s['cur'] != 0:
            await p.wait_for_timeout(80); continue
        await human_turn(p, log)
    # 結果 → 大会の画面へ
    for _ in range(100):
        if await p.query_selector('.overlay [data-act=tour-back]'): break
        await p.wait_for_timeout(100)
    await p.screenshot(path=f'{SHOTS}/tour_{VIEW}_{tag}_result.png')
    # 勝利点は予選1試合目から 5・10・15、決勝20。結果の画面の説明にもその数
    vc = await p.evaluate("""() => { const a=window.__sb.app, g=a.game, T=a.tour; const kind = T.stage==='final' ? 'final' : 'prelim';
      const d=document.querySelector('.overlay .dialog'); return { vp: g.victoryPts, want: SBEngine.Tour.victoryFor(kind, T.round), text: d ? d.textContent : '', hasGemCol: !!d && /宝石/.test(d.textContent) } }""")
    if vc['vp'] != vc['want']: log.append(f"VICTORY-{vc['vp']}-WANT-{vc['want']}")
    if f"勝利点{vc['want']}pt" not in vc['text'] and 'draw' not in tag: log.append(f"VICTORY-TEXT-{tag}")
    if not vc['hasGemCol']: log.append('NO-GEM-COLUMN')
    log.append(f"vp-{tag}-{vc['vp']}")
    await p.click('.overlay [data-act=tour-back]')
    await p.wait_for_timeout(300)

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        p = await b.new_page(viewport=VP)
        errs = []
        p.on('pageerror', lambda e: errs.append('pageerror ' + str(e)))
        p.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'ERR_TUNNEL' not in m.text else None)
        await p.goto(URL); await p.evaluate("() => localStorage.clear()"); await p.reload()
        await p.wait_for_selector('[data-act=start]')
        await p.click('label[for=opt-rules-2]')
        await p.click('label[for=opt-speed-1]')
        await p.click('[data-act=start]')
        await p.wait_for_timeout(1500)
        await p.screenshot(path=f'{SHOTS}/tour_{VIEW}_0_intro.png', full_page=True)
        log = []
        flow = []
        for k in range(12):
            s = await st(p)
            flow.append(s['stage'])
            if s['stage'] in ('intro', 'hub'):
                if s['stage'] == 'hub':
                    # 購入はなくなった：ショップが出ないこと。アイテムの数は使った分だけ減っている（最初は2つずつ）
                    if await p.query_selector('.shop, [data-act=tour-buy]'): log.append('SHOP-STILL-SHOWN')
                    bad = await p.evaluate("() => { const T=window.__sb.app.tour; return T.players.some(p=>SBEngine.ITEM_KEYS.some(k=>(p.inv[k]||0)>2||(p.inv[k]||0)<0)) }")
                    if bad: log.append('ITEM-COUNT-OUT-OF-RANGE')
                    # 宝石：順位表のアイコンの数＝持っている数、合計は16（4人×4つ）。持ち点の合計は400（100×4）
                    gm = await p.evaluate("() => { const T=window.__sb.app.tour; return [...document.querySelectorAll('.standings .st-row')].map(r=>[+r.dataset.id, r.querySelectorAll('.st-gems .gm:not(.lost)').length, T.players[+r.dataset.id].gems]) }")
                    if any(x[1] != x[2] for x in gm): log.append('GEM-ICONS-MISMATCH')
                    if sum(x[2] for x in gm) != 16: log.append('GEMS-NOT-16')
                    tot = await p.evaluate("() => window.__sb.app.tour.players.reduce((a,p)=>a+SBEngine.Tour.total(p),0)")
                    spd_lost = await p.evaluate("() => window.__sb.app.tour.players.reduce((a,p)=>a+(p.pts.spdLost||0),0)")
                    if not FORCEQ and tot != 400 - spd_lost: log.append(f'TOTAL-{tot}')
                    log.append('gems-' + ''.join(str(x[2]) for x in sorted(gm)))
                    if FORCEQ: await p.evaluate("() => { window.__sb.app.tour.players[0].pts.vicWon += 60; window.__sb.render(); }")
                    await p.wait_for_timeout(2600)
                    await p.screenshot(path=f'{SHOTS}/tour_{VIEW}_r{s["round"]}_hub.png', full_page=True)
                await p.click('[data-act=tour-next]')
                await play_match(p, f'r{s["round"]}', log)
                continue
            if s['stage'] == 'qualify':
                await p.wait_for_timeout(600)
                await p.screenshot(path=f'{SHOTS}/tour_{VIEW}_q_anim.png', full_page=True)
                await p.wait_for_timeout(2600)
                await p.screenshot(path=f'{SHOTS}/tour_{VIEW}_q.png', full_page=True)
                await p.click('[data-act=tour-next]')
                # 予選敗退：CPUどうしの決勝は手番ごとに画面へ戻りながら進む。終わるまで待つ
                for _ in range(600):
                    s2 = await st(p)
                    if s2['stage'] != 'qualify' or s2['screen'] != 'tour': break
                    await p.wait_for_timeout(100)
                continue
            if s['stage'] == 'final-hub':
                await p.wait_for_timeout(500)
                if await p.query_selector('.shop, [data-act=tour-buy]'): log.append('SHOP-IN-FINAL-HUB')
                if await p.query_selector('[data-act=tour-choose]'):
                    await p.click('[data-act=tour-choose][data-v=draft]')
                await p.screenshot(path=f'{SHOTS}/tour_{VIEW}_final_hub.png', full_page=True)
                await p.click('[data-act=tour-next]')
                await play_match(p, 'final', log)
                continue
            if s['stage'] == 'done':
                await p.wait_for_timeout(3000)
                await p.screenshot(path=f'{SHOTS}/tour_{VIEW}_done.png', full_page=True)
                await p.click('[data-act=tour-end]')
                break
        s = await st(p)
        T = await p.evaluate("() => null")
        res = await p.evaluate("""() => { const sw=[document.documentElement.scrollWidth, innerWidth]; return { screen: window.__sb.app.screen, sw } }""")
        print(STYLE, VIEW, 'flow', flow, 'end', res, 'log', {k: log.count(k) for k in set(log)}, 'errors', errs)
        await b.close()
asyncio.run(main())
