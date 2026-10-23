import os
import asyncio
from playwright.async_api import async_playwright
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width':1280,'height':900})
        errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(URL)
        await pg.click('[data-act=rules]'); n = await pg.locator('.rules').count(); await pg.keyboard.press('Escape')
        await pg.click('label[for=opt-mode-1]'); await pg.click('[data-act=start]')
        await pg.click('[data-act=random]'); await pg.click('[data-act=setup-done]')
        await pg.click('[data-act=random]'); await pg.click('[data-act=setup-done]')
        # P(先攻)がワープ → 手番交代後、相手視点のバナーに移動先が出ないこと
        info = await pg.evaluate("""() => { const a=window.__sb.app,g=a.game,pi=g.cur; const p=g.living(pi)[0];
          let params=null; for(let t=0;t<8&&!params;t++) for(let r=0;r<4&&!params;r++) for(let c=0;c<4&&!params;c++){ const q={pieceId:p.id,t,r0:r,c0:c}; if(g.validateItem(pi,'warp',q).ok) params=q; }
          return {pi, params} }""")
        if info['params']:
            await pg.evaluate("(i) => { const a=window.__sb.app; a.game.useItem(i.pi,'warp',i.params); a.ui.bannerIdx=a.game.log.length-1; window.__sb.render(); }", info)
            own = await pg.inner_text('.banner')
            c = await pg.evaluate("() => { const g=window.__sb.app.game; return [...Array(g.NN).keys()].find(c=>g.isCallable(g.cur,c)) }")
            await pg.click(f'.cell[data-board=pred][data-cell="{c}"]'); await pg.click('[data-act=end-turn]')
            sub = await pg.evaluate("() => window.__sb.app.game.sub")
            if sub=='treasure':
                c = await pg.evaluate("() => { const g=window.__sb.app.game; return [...Array(g.NN).keys()].find(c=>g.isTreasureCallable(g.cur,c)) }")
                await pg.click(f'.cell[data-board=pred][data-cell="{c}"]')
            logs = await pg.inner_text('.log')
            print('actor banner had destination:', '→' in own and 'ワープ' in own)
            print('opponent log hides destination:', all(not ('ワープ' in l and '→ ' in l and '移動前' not in l) for l in logs.splitlines()))
        print('rules modal:', n, 'errors:', errs)
        await b.close()
asyncio.run(main())
