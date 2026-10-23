import os
# 音まわりの確認：最初の操作で鳴り始める・場面ごとのBGM・効果音の呼び出し・切り替えボタン
# あわせて、アイテムの再押しキャンセルと、進行表示がフィールドの上にあることも確かめる
import asyncio, json, sys
from playwright.async_api import async_playwright
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
PATCH = """() => { if (window.__sfxPatched) return; window.__sfxPatched = true; window.__sfxLog = [];
  const o = SBAudio.sfx.bind(SBAudio); SBAudio.sfx = (n, d, p) => { window.__sfxLog.push(n); return o(n, d, p); };
  const r = SBAudio.result.bind(SBAudio); SBAudio.result = (k) => { window.__sfxLog.push('RESULT:' + k); return r(k); }; }"""
async def wait_human(p, limit=400):
    for _ in range(limit):
        s = await p.evaluate("() => { const a=window.__sb.app,g=a.game; return {busy:a.busy,cur:g.cur,sub:g.sub,phase:g.phase,turn:g.turn} }")
        if s['phase'] != 'play' or (not s['busy'] and s['cur'] == 0): return s
        await p.wait_for_timeout(100)
    return s
async def main():
    bad = []
    async with async_playwright() as pw:
        b = await pw.chromium.launch(args=['--autoplay-policy=user-gesture-required'])
        ctx = await b.new_context(viewport={'width': 1366, 'height': 900})
        p = await ctx.new_page()
        msgs = []
        p.on('console', lambda m: msgs.append(m.type + ': ' + m.text) if m.type in ('error', 'warning') else None)
        p.on('pageerror', lambda e: msgs.append('pageerror: ' + str(e)))
        await p.goto(URL)
        await p.evaluate("() => localStorage.clear()")
        await p.reload()
        await p.evaluate(PATCH)
        st = await p.evaluate("() => ({ mode: SBAudio.mode, ready: SBAudio.ready, cur: SBAudio.current() })")
        print('before gesture', st)
        if st['ready']: bad.append('ready before any gesture')
        # 最初の操作
        await p.click('label[for=opt-speed-1]')
        await p.wait_for_timeout(400)
        st = await p.evaluate("() => ({ mode: SBAudio.mode, ready: SBAudio.ready, cur: SBAudio.current() })")
        print('after first click', st)
        if not st['ready'] or st['cur'] != 'calm': bad.append('title music did not start: ' + json.dumps(st))
        # タイトルの切り替えボタン：BGMと効果音 → 効果音だけ → 音なし → BGMと効果音
        seq = []
        for i in range(3):
            await p.click('[data-act=sound]')
            await p.wait_for_timeout(150)
            seq.append(await p.evaluate("() => [window.__sb.app.settings.sound, SBAudio.mode, SBAudio.current(), document.querySelector('[data-act=sound] span').textContent, document.querySelector('input[name=sound]:checked').value]"))
        print('toggle sequence', seq)
        if [x[0] for x in seq] != ['sfx', 'off', 'all']: bad.append('toggle order ' + str(seq))
        if seq[0][2] is not None or seq[1][2] is not None: bad.append('music still playing when BGM off')
        if seq[2][2] != 'calm': bad.append('music did not resume')
        if any(x[0] != x[4] for x in seq): bad.append('title radio out of sync')
        # 設定のラジオでも切り替えられる
        await p.click('label[for=opt-sound-1]')
        await p.wait_for_timeout(100)
        r = await p.evaluate("() => [window.__sb.app.settings.sound, SBAudio.current(), JSON.parse(localStorage.getItem('sb.settings')).sound]")
        print('radio -> sfx', r)
        if r[0] != 'sfx' or r[1] is not None or r[2] != 'sfx': bad.append('radio sound setting ' + str(r))
        await p.click('label[for=opt-sound-0]')
        await p.wait_for_timeout(100)
        # 対戦へ
        await p.click('label[for=opt-rules-0]'); await p.click('label[for=opt-items-0]')
        await p.click('[data-act=start]')
        await p.click('[data-act=random]'); await p.click('[data-act=setup-done]')
        await p.wait_for_timeout(300)
        cur = await p.evaluate("() => SBAudio.current()")
        print('battle music', cur)
        if cur != 'battle': bad.append('battle music not started: ' + str(cur))
        # 進行表示がフィールドの上
        order = await p.evaluate("() => { const c = document.querySelector('.center'); return [...c.children].map(e => e.className.split(' ').slice(0, 2).join('.')); }")
        print('center order', order)
        if not (order and 'dock' in order[0] and 'fields' in order[1]): bad.append('dock not above fields: ' + str(order))
        s = await wait_human(p)
        # アイテムの再押しでキャンセル
        if s['sub'] == 'item':
            key = await p.evaluate("() => { const g=window.__sb.app.game; return ['number','shape','dist','pair','line','cube'].find(k => g.itemStatus(0,k).usable) }")
            if key:
                await p.click(f'[data-act=item][data-key={key}]')
                m1 = await p.evaluate("() => [window.__sb.app.ui.mode, window.__sb.app.ui.item, document.querySelector('.dock .itemhead') ? 1 : 0]")
                await p.click(f'[data-act=item][data-key={key}]')
                m2 = await p.evaluate("() => [window.__sb.app.ui.mode, window.__sb.app.ui.item, document.querySelector('.dock .itemhead') ? 1 : 0]")
                print('item', key, 'select', m1, '-> re-press', m2)
                if m1[0] is None or m2[0] is not None or m2[1] is not None: bad.append('re-press cancel failed')
                # 別のアイテムに持ち替え
                other = await p.evaluate("(k) => { const g=window.__sb.app.game; return ['number','shape','dist','pair','line','cube'].find(x => x !== k && g.itemStatus(0,x).usable) }", key)
                if other:
                    await p.click(f'[data-act=item][data-key={key}]'); await p.click(f'[data-act=item][data-key={other}]')
                    m3 = await p.evaluate("() => window.__sb.app.ui.item")
                    print('switch', key, '->', other, '=>', m3)
                    if m3 != other: bad.append('switching items failed')
                    await p.click(f'[data-act=item][data-key={other}]')
        # 数ターン遊ぶ
        for turn in range(14):
            s = await wait_human(p)
            if s['phase'] != 'play': break
            if s['sub'] in ('item', 'call'):
                c = await p.evaluate("() => { const g=window.__sb.app.game; const cs=[...Array(g.NN).keys()].filter(c=>g.isCallable(0,c)); const hit=cs.filter(c=>g.pieceAt(1,c)); const pool=(hit.length&&Math.random()<0.6)?hit:cs; return pool.length?pool[Math.floor(Math.random()*pool.length)]:null }")
                if c is None: await p.click('[data-act=skip-call]')
                else: await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
            s = await wait_human(p)
            if s['phase'] != 'play': break
            if s['sub'] == 'answer':
                # ときどきアイテム（コールの後）
                k2 = await p.evaluate("() => { const g=window.__sb.app.game; return g.itemUsed ? null : ['number','dist','shape'].find(k => g.itemStatus(0,k).usable) }")
                if k2 and turn % 2 == 0:
                    await p.click(f'[data-act=item][data-key={k2}]')
                    c = await p.evaluate("(k) => { const g=window.__sb.app.game, v=g.players[0].view; return [...Array(g.NN).keys()].find(c => !v.dead[c] && !(k==='dist' && v.marks[c] && v.marks[c].r==='oo')) }", k2)
                    await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
                    s = await wait_human(p)
                if s['sub'] == 'answer': await p.click('[data-act=end-turn]')
            s = await wait_human(p)
            if s['sub'] == 'treasure':
                c = await p.evaluate("() => { const g=window.__sb.app.game; return [...Array(g.NN).keys()].find(c=>g.isTreasureCallable(0,c)) }")
                await p.click(f'.cell[data-board=pred][data-cell="{c}"]')
        await p.wait_for_timeout(1500)
        log = await p.evaluate("() => window.__sfxLog")
        from collections import Counter
        cnt = Counter(log)
        print('sfx calls', dict(cnt))
        for need in ['turnMine', 'turnFoe', 'confirm', 'select', 'cancel']:
            if need not in cnt: bad.append('missing sfx ' + need)
        if not any(k in cnt for k in ['miss', 'hit', 'first']): bad.append('no call sounds')
        lvl = await p.evaluate("() => { const g = window.__sb.app.game; return [g.turn, g.rules.lateTurn, g.phase, SBAudio.current(), SBAudio.level] }")
        print('turn / late turn / phase / music / level', lvl)
        if lvl[2] == 'play' and lvl[0] >= lvl[1] and lvl[4] != 2: bad.append('late-game music level not raised')
        # 対戦中にBGMを止める・戻す（先に決着して結果の画面が出ていたら閉じてから）
        if (await p.evaluate("() => window.__sb.app.game.phase")) == 'over':
            await p.wait_for_selector('.overlay', timeout=20000)
            await p.keyboard.press('Escape'); await p.wait_for_timeout(150)
        await p.click('[data-act=sound]')
        a = await p.evaluate("() => [SBAudio.mode, SBAudio.current()]")
        await p.click('[data-act=sound]'); await p.click('[data-act=sound]')
        b2 = await p.evaluate("() => [SBAudio.mode, SBAudio.current(), window.__sb.app.game.phase]")
        print('battle toggle', a, b2)
        if a[1] is not None: bad.append('BGM not stopped in battle')
        if b2[2] == 'play' and b2[1] != 'battle': bad.append('battle BGM not resumed')
        if b2[2] == 'over':
            await p.wait_for_timeout(3300)
            c3 = await p.evaluate("() => SBAudio.current()")
            print('after result jingle', c3)
            if c3 != 'calm': bad.append('calm music after result: ' + str(c3))
        # やめる → タイトルの曲（結果画面が出ていればそちらのボタン）
        ov = await p.query_selector('.overlay [data-act=to-title]')
        await (ov.click() if ov else p.click('.hud [data-act=to-title]'))
        await p.wait_for_timeout(200)
        t = await p.evaluate("() => SBAudio.current()")
        print('after quit', t)
        if t != 'calm': bad.append('title music after quit: ' + str(t))
        msgs = [m for m in msgs if 'TUNNEL' not in m]
        print('console', msgs[:6])
        if msgs: bad.append('console messages')
        await b.close()
    print('PROBLEMS:', bad if bad else 'none')
asyncio.run(main())
