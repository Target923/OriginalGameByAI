import os
# v12.9 リプレイの画面確認：単発の試合の結果から開く・1手ずつ／手番ずつ進む・自動再生・確率のラベル・閉じる、
# 大会の途中経過の「試合の記録」から CPUどうしの試合を開く（パソコン幅とスマホ幅）
import asyncio, sys
from playwright.async_api import async_playwright
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
FINISH = """() => { const a=window.__sb.app, g=a.game; let n=0; while (g.phase==='play' && n++<600) SBAI.playTurn(g, g.cur);
  a.busy=false; a.ui.showResult=true; window.__sb.render(); return g.phase }"""
STATE = """() => { const R=window.__sb.app.replay; if (!R) return null; const g=R.game;
  return { pos:R.pos, frames:R.frames.length, unit:R.unit, playing:R.playing, prob:!!R.prob[R.pos],
    pcts:[...document.querySelectorAll('#replay .rp-pct')].map(e=>e.textContent),
    alive:[g.living(0).length, g.living(1).length], now:(document.getElementById('rp-now')||{}).textContent,
    count:(document.getElementById('rp-count')||{}).textContent, logCur: document.querySelectorAll('.rp-log li.cur').length,
    appHidden: getComputedStyle(document.getElementById('app')).display } }"""
async def wait_prob(p, ms=8000):
    for _ in range(ms // 100):
        s = await p.evaluate(STATE)
        if s and s['prob']: return s
        await p.wait_for_timeout(100)
    return await p.evaluate(STATE)
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        for view, vp in [('desk', {'width': 1360, 'height': 900}), ('phone', {'width': 390, 'height': 844})]:
            p = await b.new_page(viewport=vp)
            errs = []
            p.on('pageerror', lambda e: errs.append(str(e)))
            p.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'ERR_TUNNEL' not in m.text else None)
            await p.goto(URL); await p.evaluate("() => localStorage.clear()"); await p.reload()
            await p.wait_for_selector('[data-act=start]')
            await p.click('[data-act=start]')
            await p.wait_for_selector('[data-act=random]')
            await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
            await p.wait_for_timeout(800)
            await p.evaluate(FINISH)
            await p.wait_for_selector('.overlay [data-act=replay-open]')
            await p.click('.overlay [data-act=replay-open]')
            await p.wait_for_selector('#replay .rp')
            s0 = await wait_prob(p)
            await p.screenshot(path=f'{SHOTS}/v129_start_{view}.png', full_page=False)
            # 1手ずつ進む（演出つき）
            for _ in range(3):
                await p.click('#replay [data-act=rp-next]')
                await p.wait_for_timeout(1700)
            s1 = await wait_prob(p)
            # 途中の場面へ（スライダー）
            mid = s1['frames'] // 2
            await p.evaluate(f"() => {{ const r=document.querySelector('#replay .rp-range'); r.value={mid}; r.dispatchEvent(new Event('input', {{bubbles:true}})); }}")
            s2 = await wait_prob(p)
            await p.screenshot(path=f'{SHOTS}/v129_mid_{view}.png', full_page=True)
            # 手番ずつ
            await p.click('#replay [data-act=rp-unit][data-v=turn]')
            await p.click('#replay [data-act=rp-next]')
            await p.wait_for_timeout(3500)
            s3 = await p.evaluate(STATE)
            # 自動再生を少し → 止める
            await p.click('#replay [data-act=rp-play]')
            await p.wait_for_timeout(4000)
            s4 = await p.evaluate(STATE)
            await p.click('#replay [data-act=rp-play]')
            await p.wait_for_timeout(300)
            s5 = await p.evaluate(STATE)
            # 最後の場面
            await p.click('#replay [data-act=rp-last]')
            s6 = await wait_prob(p)
            await p.screenshot(path=f'{SHOTS}/v129_end_{view}.png', full_page=True)
            # ログの行で飛ぶ
            await p.click('#rp-log0 li:nth-child(2)')
            s7 = await p.evaluate(STATE)
            # 盤のマスを押しても何も起きない
            await p.click('#replay .board[data-board=pred] .cell[data-cell="0"]')
            s8 = await p.evaluate(STATE)
            # 閉じる → 結果の画面に戻る
            await p.keyboard.press('Escape')
            await p.wait_for_timeout(300)
            back = await p.evaluate("() => ({ replay: !!window.__sb.app.replay, result: !!document.querySelector('.overlay [data-act=replay-open]'), appShown: getComputedStyle(document.getElementById('app')).display !== 'none', phase: window.__sb.app.game.phase })")
            print(view, 'single', {'s0': s0, 'after3': [s1['pos'], s1['count']], 'mid': [s2['pos'], s2['pcts'][:6], s2['alive']], 'turnStep': [s3['pos'], s3['unit']],
                  'autoplay': [s4['pos'], s4['playing']], 'stopped': s5['playing'], 'end': [s6['pos'], s6['frames'], s6['pcts'], s6['now'][:60]], 'jump': s7['pos'], 'cellClick': s8['pos'], 'back': back})
            # 大会：第1試合の後、試合の記録からCPUどうしの試合のリプレイ
            await p.evaluate("() => { const a=window.__sb.app; a.screen='title'; a.game=null; a.ui=null; window.__sb.render(); }")
            await p.click('label[for=opt-rules-2]')
            await p.click('[data-act=start]')
            await p.wait_for_selector('[data-act=tour-next]')
            await p.click('[data-act=tour-next]')
            await p.wait_for_selector('[data-act=random]')
            await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
            await p.wait_for_timeout(1500)
            await p.evaluate(FINISH)
            await p.wait_for_selector('.overlay [data-act=tour-back]')
            await p.click('.overlay [data-act=tour-back]')
            await p.wait_for_timeout(3500)
            hist = await p.evaluate("() => [...document.querySelectorAll('.history .hl li')].map(li => li.textContent.replace(/\\s+/g,' ').trim())")
            nbtn = await p.evaluate("() => document.querySelectorAll('[data-act=replay-open]').length")
            await p.screenshot(path=f'{SHOTS}/v129_hub_{view}.png', full_page=True)
            # CPUどうしの試合（2つ目の記録）
            await p.click('.history .hl li:nth-child(2) [data-act=replay-open]')
            await p.wait_for_selector('#replay .rp')
            t0 = await wait_prob(p)
            await p.click('#replay [data-act=rp-last]')
            t1 = await wait_prob(p)
            await p.screenshot(path=f'{SHOTS}/v129_tour_end_{view}.png', full_page=True)
            title = await p.evaluate("() => document.getElementById('rp-h').textContent")
            await p.click('#replay [data-act=rp-close]')
            await p.wait_for_timeout(300)
            hub_back = await p.evaluate("() => ({ screen: window.__sb.app.screen, stage: window.__sb.app.tour.stage, hist: document.querySelectorAll('.history .hl li').length })")
            sw = await p.evaluate("() => [document.documentElement.scrollWidth, innerWidth]")
            print(view, 'tour', {'hist': hist, 'buttons': nbtn, 'title': title, 'start': [t0['frames'], t0['pcts']], 'end': [t1['pos'], t1['pcts'], t1['alive']], 'back': hub_back, 'sw': sw, 'errs': errs})
            await p.close()
        await b.close()
asyncio.run(main())
