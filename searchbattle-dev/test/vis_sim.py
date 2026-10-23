import os
# ゲームに組み込んだシミュレーターの確認：タイトルから開く・見本で結果が出る・点数を変えると数え直す（入力の場所はそのまま）
# ・比較表・並列で実行・決勝の回し直し・タイトルに戻っても計算を続けて知らせる（パソコン幅とスマホ幅）
import asyncio
from playwright.async_api import async_playwright
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
KPI = "() => [...document.querySelectorAll('.sim-kpi')].map(k => k.innerText.replace(/\\s+/g,' '))"

async def wait_idle(p, limit=180):
    for _ in range(limit):
        await p.wait_for_timeout(1000)
        if not await p.query_selector('[data-act="sim-stop"]'):
            return True
    return False

async def set_tours(p, n):
    await p.evaluate("(n) => { const s=document.getElementById('sim-tours'); const o=document.createElement('option'); o.text=String(n); s.add(o); s.value=String(n); s.dispatchEvent(new Event('change', {bubbles:true})); }", n)

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        for view, vp in [('desk', {'width': 1360, 'height': 900}), ('phone', {'width': 390, 'height': 844})]:
            p = await b.new_page(viewport=vp)
            errs = []
            p.on('pageerror', lambda e: errs.append(str(e)))
            p.on('console', lambda m: errs.append(m.text) if m.type in ('error', 'warning') else None)
            await p.goto(URL); await p.evaluate("() => localStorage.clear()"); await p.reload()
            # タイトルから開く
            await p.click('[data-act="sim-open"]')
            await p.wait_for_selector('.sim-kpis')
            k0 = await p.evaluate(KPI)
            src0 = await p.inner_text('.sim-src')
            await p.screenshot(path=f'{SHOTS}/simin_{view}.png', full_page=True)
            # 点数を変える（勝利点 6/9/12/15・はじめ50）：結果だけ描き直し、入力の場所は変わらない
            for i, v in enumerate([6, 9, 12, 15]):
                await p.fill(f'#sim-v{i}', str(v))
            await p.fill('#sim-start', '50')
            await p.wait_for_timeout(400)
            k1 = await p.evaluate(KPI)
            focus = await p.evaluate("() => document.activeElement && document.activeElement.id")
            tot = await p.inner_text('#sim-tot')
            fin = await p.evaluate("() => { const f=document.getElementById('sim-finnote'); return { note: f.textContent.slice(0,50), btn: !!f.querySelector('[data-act=\"sim-refinal\"]') }; }")
            await p.click('[data-act="sim-pin"]')
            await p.click('[data-act="sim-reset"]')
            await p.wait_for_timeout(300)
            rows = await p.evaluate("() => [...document.querySelectorAll('.sim-cmp tbody tr')].map(r => r.cells[0].innerText.replace(/\\s+/g,' '))")
            # 並列で実行（4大会）
            await set_tours(p, 4)
            await p.click('[data-act="sim-run"]')
            await p.wait_for_timeout(300)
            note = await p.evaluate("() => document.querySelector('.sim-side .sim-note').textContent")
            prog = await p.evaluate("() => { const t=document.getElementById('sim-progtext'); return t && t.textContent; }")
            ok1 = await wait_idle(p)
            src1 = await p.inner_text('.sim-src')
            note2 = await p.evaluate("() => document.querySelector('.sim-side .sim-note').textContent")
            # 決勝の回し直し：顔ぶれが変わる点数にして回し直す
            for i in range(4):
                await p.fill(f'#sim-v{i}', '0')
            await p.fill('#sim-gemPts', '0')
            await p.wait_for_timeout(400)
            re_btn = await p.evaluate("() => { const x=document.querySelector('[data-act=\"sim-refinal\"]'); return x && x.textContent; }")
            if re_btn:
                await p.click('[data-act="sim-refinal"]')
                await wait_idle(p)
            after = await p.evaluate("() => ({ finnote: document.getElementById('sim-finnote').textContent.slice(0,40), kpi: document.querySelectorAll('.sim-kpi')[3].innerText.replace(/\\s+/g,' ') })")
            sw = await p.evaluate("() => [document.documentElement.scrollWidth, innerWidth]")
            await p.screenshot(path=f'{SHOTS}/simin_{view}_after.png', full_page=True)
            # 計算の途中でタイトルへ戻る → 裏で続けて、終わったら知らせる → もう一度開くと新しい結果
            await p.click('[data-act="sim-reset"]')
            await set_tours(p, 3)
            await p.click('[data-act="sim-run"]')
            await p.wait_for_timeout(500)
            await p.click('[data-act="sim-back"]')
            title = await p.evaluate("() => !!document.querySelector('[data-act=\"sim-open\"]')")
            toast = None
            for _ in range(180):
                await p.wait_for_timeout(1000)
                toast = await p.evaluate("() => [...document.querySelectorAll('.toast, [role=status]')].map(t => t.textContent).join(' | ')")
                if 'シミュレーター' in (toast or ''): break
            await p.click('[data-act="sim-open"]')
            await p.wait_for_selector('.sim-kpis')
            src2 = await p.inner_text('.sim-src')
            # ページを開き直すと、前回の記録から始まる
            await p.reload()
            await p.click('[data-act="sim-open"]')
            await p.wait_for_selector('.sim-kpis')
            src3 = await p.inner_text('.sim-src')
            print(view, {'k0': k0, 'src0': src0[:50], 'k1': k1[:2], 'focus': focus, 'tot': tot, 'fin': fin, 'cmpRows': rows,
                         'runNote': note, 'prog': prog, 'idle': ok1, 'src1': src1, 'note2': note2, 'refinal': re_btn, 'after': after, 'sw': sw,
                         'title': title, 'toast': (toast or '')[:80], 'src2': src2, 'src3': src3, 'errs': errs[:5]})
            await p.close()
        await b.close()
asyncio.run(main())
