import os
import asyncio, json, sys
from playwright.async_api import async_playwright
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))

async def state(page):
    return await page.evaluate("""() => { const a=window.__sb.app, g=a.game; if(!g) return {screen:a.screen};
      return {screen:a.screen, phase:g.phase, sub:g.sub, cur:g.cur, turn:g.turn, busy:a.busy, mode:a.ui&&a.ui.mode, result:g.result} }""")

async def play_game(page, rules, mode, log, shots=False, do_items=True, items='all'):
    await page.goto(URL)
    await page.evaluate("() => localStorage.clear()"); await page.reload()
    await page.wait_for_selector('[data-act=start]')
    if items == 'pick':
        await page.click('label[for=opt-items-0]')
        await page.wait_for_selector('.item-pick')
        # すべて外してから3つだけ選ぶ（最後の1つは外せない）
        for k in ['cube','line','number','shape','pair','node','bazooka','warp','stealth']:
            if await page.is_checked(f'#pick-{k}'): await page.click(f'label[for=pick-{k}]')
        for k in ['number','node','warp']:
            if not await page.is_checked(f'#pick-{k}'): await page.click(f'label[for=pick-{k}]')
        if await page.is_checked('#pick-stealth'): await page.click('label[for=pick-stealth]')
        if shots: await page.screenshot(path=f'{SHOTS}/v4_0_items.png', full_page=True)
    elif items == 'r4':
        # ランダム：6種から2つ減らして4種
        await page.click('label[for=opt-items-1]')
        await page.click('[data-act=step][data-key=randomN][data-d="-1"]')
        await page.click('[data-act=step][data-key=randomN][data-d="-1"]')
    elif items == 'draft':
        # ドラフト：1人3個ずつ
        await page.click('label[for=opt-items-2]')
        await page.click('[data-act=step][data-key=draftN][data-d="-1"]')
    else:
        await page.click('label[for=opt-items-0]')
    await page.click(f'label[for=opt-mode-{0 if mode=="cpu" else 1}]')
    await page.click(f'label[for=opt-rules-{0 if rules=="prelim" else 1}]')
    await page.click('label[for=opt-speed-1]')
    if shots: await page.screenshot(path=f'{SHOTS}/v4_1_title.png', full_page=True)
    await page.click('[data-act=start]')
    # 配置：手動で1個置いて外す→おまかせ
    await page.click('.cell[data-board=own][data-cell="5"]')
    await page.click('[data-act=rotate]')
    await page.click('.cell[data-board=own][data-cell="5"]')  # remove
    await page.click('[data-act=random]')
    if shots: await page.screenshot(path=f'{SHOTS}/v4_2_setup.png', full_page=True)
    await page.click('[data-act=setup-done]')
    if mode == 'pvp':
        await page.click('[data-act=random]'); await page.click('[data-act=setup-done]')
    # ドラフト
    for _ in range(40):
        s = await state(page)
        if s['screen'] != 'draft': break
        btn = await page.query_selector('[data-act=draft-pick]:not([disabled])')
        if btn: await btn.click()
        else: await page.wait_for_timeout(150)
    used_items = set(); answered_fail = False; answered_ok = False
    for step in range(4000):
        s = await state(page)
        if s.get('phase') == 'over': break
        if s.get('busy'): await page.wait_for_timeout(120); continue
        hv = await page.evaluate("() => { const a=window.__sb.app,g=a.game; return a.settings.mode==='cpu'?0:g.cur }")
        if s['cur'] != hv and mode=='cpu': await page.wait_for_timeout(120); continue
        sub = s['sub']
        if shots and s.get('turn',0) >= 5 and sub=='item' and not getattr(page,'_midshot',False):
            page._midshot = True
            await page.screenshot(path=f'{SHOTS}/v4_3_battle_desktop.png', full_page=True)
            # 当たりのマスをコールして演出の途中を撮る
            hitc = await page.evaluate(f"""() => {{ const g=window.__sb.app.game; for(let c=0;c<g.NN;c++){{ if(g.isCallable({hv},c) && g.pieceAt(1-{hv},c)) return c; }} return null }}""")
            if hitc is not None:
                await page.click(f'.cell[data-board=pred][data-cell="{hitc}"]')
                await page.wait_for_timeout(260)
                await page.screenshot(path=f'{SHOTS}/v4_6_fx_hit.png')
                continue
        if sub == 'answer' and do_items and not (await page.evaluate("() => window.__sb.app.game.itemUsed")) and (step % 3 == 0):
            sub = 'item'
        if sub == 'item' and do_items:
            # いくつかのアイテムをUIから使う
            plan = [('line',None),('number',None),('shape',None),('stealth',None),('warp',None),('cube',None),('pair',None),('node',None),('bazooka',None)]
            done=False
            for k,_ in plan:
                if k in used_items: continue
                ok = await page.evaluate(f"() => window.__sb.app.game.itemStatus({hv}, '{k}').usable")
                if not ok: continue
                if k in ('pair','node','bazooka'):
                    # ペア：撃破済み以外の任意の2マス／ノード・バズーカ：撃破済み以外のマス（個体のあるマスを優先）
                    hits = await page.evaluate(f"() => {{ const g=window.__sb.app.game,v=g.players[{hv}].view; const ok=[...Array(g.NN).keys()].filter(c=>!v.dead[c]); const near=ok.filter(c=>g.pieceAt(1-{hv},c)); return near.concat(ok.filter(c=>near.indexOf(c)<0)) }}")
                    if len(hits) < 2: continue
                await page.click(f'[data-act=item][data-key={k}]')
                if k=='line': await page.click('.axbtn[data-line=col][data-index="1"]')
                elif k=='number':
                    c = await page.evaluate(f"() => {{ const g=window.__sb.app.game; const cs=[...Array(g.NN).keys()].filter(c=>!g.players[{hv}].view.dead[c]); return cs[cs.length-1] }}")
                    await page.click(f'.cell[data-board=pred][data-cell="{c}"]')
                elif k=='cube': await page.click('.cm-btn[data-kind=size][data-value="2"]')
                elif k=='shape':
                    c = await page.evaluate(f"() => {{ const g=window.__sb.app.game; return [...Array(g.NN).keys()].find(c=>!g.players[{hv}].view.dead[c]) }}")
                    await page.click(f'.cell[data-board=pred][data-cell="{c}"]')
                elif k=='pair':
                    await page.click(f'.cell[data-board=pred][data-cell="{hits[0]}"]'); await page.click(f'.cell[data-board=pred][data-cell="{hits[1]}"]')
                elif k in ('node','bazooka'):
                    await page.click(f'.cell[data-board=pred][data-cell="{hits[0]}"]')
                elif k=='stealth':
                    c = await page.evaluate(f"() => {{ const g=window.__sb.app.game; const p=g.living({hv}).find(p=>!p.stealth); return p ? p.cells[0] : null }}")
                    if c is None: await page.click('[data-act=cancel]'); used_items.add(k); continue
                    await page.click(f'.cell[data-board=own][data-cell="{c}"]')
                elif k=='warp':
                    p = await page.evaluate(f"() => {{ const g=window.__sb.app.game; const p=g.living({hv}).find(p=>!p.isAdd); if(!p) return null; for(let c=0;c<g.NN;c++){{ }} return {{cell:p.cells[0]}} }}")
                    if p is None: continue
                    await page.click(f'.cell[data-board=own][data-cell="{p["cell"]}"]')
                    await page.click('[data-act=warp-rotate]')
                    # 有効な移動先を探してクリック
                    tgt = await page.evaluate(f"""() => {{ const a=window.__sb.app,g=a.game,w=a.ui.warp,p=g.players[{hv}].pieces.find(x=>x.id===w.pieceId);
                        for(let c=0;c<g.NN;c++){{ const o=SBEngine.ORIENT[p.shape][w.t]; }}
                        return null }}""")
                    # 盤面の各セルを試す（UIのアンカー計算を使う）
                    placed=False
                    for c in range(25 if rules=='final' else 16):
                        before = await page.evaluate("() => window.__sb.app.game.itemUsed")
                        await page.click(f'.cell[data-board=own][data-cell="{c}"]')
                        after = await page.evaluate("() => window.__sb.app.game.itemUsed")
                        if after and not before: placed=True; break
                    if not placed:
                        await page.click('[data-act=cancel]'); used_items.add(k); continue
                used_items.add(k); done=True
                log.append(('item',k))
                break
        s = await state(page)
        if s.get('phase')=='over': break
        if s['sub'] in ('item','call'):
            c = await page.evaluate(f"() => {{ const g=window.__sb.app.game; const cs=[...Array(g.NN).keys()].filter(c=>g.isCallable({hv},c)); return cs.length ? cs[Math.floor(Math.random()*cs.length)] : null }}")
            if c is None:
                await page.click('[data-act=skip-call]'); log.append(('skip',)); continue
            await page.click(f'.cell[data-board=pred][data-cell="{c}"]'); continue
        if s['sub']=='answer':
            # 1回は失敗アンサー、1回は正解アンサー（答えを知っている前提でUI経路を確認）
            if not answered_fail:
                c = await page.evaluate(f"() => {{ const g=window.__sb.app.game; return [...Array(g.NN).keys()].filter(c=>!g.players[{hv}].view.dead[c]).slice(0,2) }}")
                await page.click('[data-act=answer-start]')
                for x in c: await page.click(f'.cell[data-board=pred][data-cell="{x}"]')
                dis = await page.get_attribute('[data-act=answer-submit]', 'disabled')
                if dis is None:
                    await page.click('[data-act=answer-submit]'); answered_fail=True
                    s2 = await state(page)
                    if s2['sub']=='sacrifice':
                        c2 = await page.evaluate(f"() => window.__sb.app.game.living({hv})[0].cells[0]")
                        await page.click(f'.cell[data-board=own][data-cell="{c2}"]')
                    continue
                else:
                    await page.click('[data-act=cancel]')
            elif not answered_ok:
                cells = await page.evaluate(f"() => {{ const g=window.__sb.app.game; const p=g.living(1-{hv}).find(p=>!p.isAdd); return p?p.cells:null }}")
                if cells:
                    await page.click('[data-act=answer-start]')
                    for x in cells: await page.click(f'.cell[data-board=pred][data-cell="{x}"]')
                    await page.click('[data-act=answer-submit]'); answered_ok=True; continue
            # 全マスに当たっているのに生きている（ステルス）個体は、アンサーで倒す
            full = await page.evaluate(f"() => {{ const g=window.__sb.app.game; const p=g.living(1-{hv}).find(p=>p.hitMask===p.mask); return p?p.cells:null }}")
            if full:
                await page.click('[data-act=answer-start]')
                for x in full: await page.click(f'.cell[data-board=pred][data-cell="{x}"]')
                await page.click('[data-act=answer-submit]'); log.append(('stealth-answer',)); continue
            await page.click('[data-act=end-turn]'); continue
        if s['sub']=='treasure':
            c = await page.evaluate(f"() => {{ const g=window.__sb.app.game; return [...Array(g.NN).keys()].find(c=>g.isTreasureCallable({hv},c)) }}")
            await page.click(f'.cell[data-board=pred][data-cell="{c}"]'); continue
        if s['sub']=='sacrifice':
            c2 = await page.evaluate(f"() => window.__sb.app.game.living({hv})[0].cells[0]")
            await page.click(f'.cell[data-board=own][data-cell="{c2}"]'); continue
        await page.wait_for_timeout(100)
    s = await state(page)
    return s, used_items

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        errors = []
        for (rules, mode, shots, items) in [('prelim','cpu',True,'all'), ('final','cpu',False,'all'), ('prelim','pvp',False,'all'), ('final','pvp',False,'draft'), ('prelim','cpu',False,'pick'), ('final','cpu',False,'r4'), ('final','cpu',False,'draft')]:
            ctx = await browser.new_context(viewport={'width':1280,'height':900})
            page = await ctx.new_page()
            page.on('console', lambda m: errors.append((rules,mode,m.type,m.text)) if m.type in ('error','warning') else None)
            page.on('pageerror', lambda e: errors.append((rules,mode,'pageerror',str(e))))
            log=[]
            s, used = await play_game(page, rules, mode, log, shots=shots, items=items)
            keys = await page.evaluate("() => { const g=window.__sb.app.game; return g.draft ? 'draft ' + g.draft.picks.map(p=>p.join('/')).join(' | ') : g.itemKeys.join(',') }")
            bz = await page.evaluate("() => window.__sb.app.game.players.map(P => P.splitPieces.length)")
            print(rules, mode, items, '->', s.get('phase'), 'turn', s.get('turn'), 'result', s.get('result'), 'used', sorted(used), 'in play', keys, 'skips', sum(1 for x in log if x[0]=='skip'), 'stealth answers', sum(1 for x in log if x[0]=='stealth-answer'), 'splits', bz)
            if shots:
                await page.wait_for_selector('[data-act=reveal]', timeout=15000)
                await page.screenshot(path=f'{SHOTS}/v4_4_result.png')
                await page.click('[data-act=reveal]')
                await page.screenshot(path=f'{SHOTS}/v4_5_reveal.png', full_page=True)
            await ctx.close()
        # 対戦中の画面（スマホ・ダーク）
        ctx = await browser.new_context(viewport={'width':390,'height':844}, color_scheme='dark', device_scale_factor=2)
        page = await ctx.new_page()
        page.on('pageerror', lambda e: errors.append(('mobile','dark','pageerror',str(e))))
        await page.goto(URL)
        await page.evaluate("() => localStorage.clear()"); await page.reload()
        await page.click('[data-act=start]')
        await page.click('[data-act=random]'); await page.click('[data-act=setup-done]')
        for _ in range(400):
            s = await state(page)
            if s.get('turn',0) >= 4 and not s.get('busy') and s.get('cur')==0 and s.get('sub')=='item': break
            if s.get('busy') or s.get('cur')==1: await page.wait_for_timeout(150); continue
            if s['sub'] in ('item','call'):
                c = await page.evaluate("() => { const g=window.__sb.app.game; const cs=[...Array(g.NN).keys()].filter(c=>g.isCallable(0,c)); return cs[0] }")
                await page.click(f'.cell[data-board=pred][data-cell="{c}"]')
            elif s['sub']=='answer': await page.click('[data-act=end-turn]')
            elif s['sub']=='treasure':
                c = await page.evaluate("() => { const g=window.__sb.app.game; return [...Array(g.NN).keys()].find(c=>g.isTreasureCallable(0,c)) }")
                await page.click(f'.cell[data-board=pred][data-cell="{c}"]')
            else: await page.wait_for_timeout(150)
        await page.screenshot(path=f'{SHOTS}/v4_7_battle_mobile.png', full_page=True)
        ow = await page.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")
        print('mobile overflow check scrollWidth/innerWidth', ow)
        await ctx.close()
        await browser.close()
        print('errors:', len(errors))
        for e in errors[:30]: print('  ', e)

asyncio.run(main())
