import os
# v15 ワープの画面確認（CPU戦・4×4）：
#  1. あなた：ワープを選ぶ → 自分のキューブのブロックを押す（トリガー）→ 別のブロックを押して選び直す → 空きブロックを押して移動先を置く
#     → 回転 → 完了。ワープ待ちのキューブにトリガーの印、移動先に薄いキューブの形が出る
#  2. CPU がトリガーをコール → ワープ発動の演出。あなたのキューブが移動先へ移り、CPU 側の予想盤面（エンジン）にワープレティクル
#  3. CPU のキューブにワープを決めさせ、あなたがアンサーで当てる → 逃げられる（レティクルなし・W付きの×）。トリガーを当てる → レティクル
#  パソコン幅とスマホ幅でスクリーンショット（SB_SHOTS）。エラーがないこと
import asyncio, sys
from playwright.async_api import async_playwright
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))

# 空きブロックの多い配置にする（あなた：3ブロックと4ブロック、CPU：3ブロック2つ）
SETUP = """() => { const g = window.__sb.app.game;
  g.clearSetup(0); g.randomSetup(0, [3, 4], Math.random);
  // CPU も空きブロックの多い配置に（アンサーで逃げる場面を作るため）
  const C = g.players[1]; C.setupDone = false; g.clearSetup(1); g.randomSetup(1, [3, 3], Math.random); g.finishSetup(1);
  window.__sb.render(); return [g.players[0].pieces.length, g.players[1].pieces.length]; }"""
# あなたの手番まで CPU を進める
MY_TURN = """() => { const a = window.__sb.app, g = a.game; let n = 0;
  while (g.phase === 'play' && g.cur !== 0 && n++ < 20) SBAI.playTurn(g, g.cur);
  a.busy = false; window.__sb.render(); return { cur: g.cur, sub: g.sub, phase: g.phase }; }"""
STATE = """() => { const a = window.__sb.app, g = a.game, P = g.players[0];
  const armed = P.pieces.filter((p) => p.alive && p.warpPlan).map((p) => ({ id: p.id, cells: p.cells, trig: p.warpPlan.trigger, dest: p.warpPlan.cells }));
  return { mode: a.ui.mode, warp: a.ui.warp, armed,
    wtr: document.querySelectorAll('.board[data-board="own"] .wtr').length,
    wdest: document.querySelectorAll('.board[data-board="own"] .cell.wdest').length,
    done: !!document.querySelector('[data-act="warp-done"]:not([disabled])'),
    errs: window.__errs || [] }; }"""

async def run(view, vp):
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        p = await b.new_page(viewport=vp)
        errs = []
        p.on('pageerror', lambda e: errs.append(str(e)))
        p.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'ERR_TUNNEL' not in m.text and 'fonts' not in m.text else None)
        await p.goto(URL); await p.evaluate("() => localStorage.clear()"); await p.reload()
        await p.wait_for_selector('[data-act=start]'); await p.click('[data-act=start]')
        await p.wait_for_selector('[data-act=random]')
        n = await p.evaluate(SETUP)
        await p.click('[data-act=setup-done]')
        await p.wait_for_timeout(1500)
        s = await p.evaluate(MY_TURN)
        await p.wait_for_timeout(300)
        # 1. ワープを選ぶ
        await p.click('[data-act=item][data-key=warp]')
        await p.wait_for_timeout(200)
        info = await p.evaluate("""() => { const g = window.__sb.app.game; const ps = g.warpable(0);
          const p = ps[0]; const open = p.cells.filter((c) => !(p.hitMask & (1 << c)));
          // 画面ではじめに選ばれている向き（いまの向き）で置ける移動先を選ぶ
          const opts = g.warpOptions(0, p); const opt = opts.find((o) => o.t === p.t) || opts[0];
          return { id: p.id, open, dest: opt.cells, at: opt.cells[0] }; }""")
        await p.click(f'.board[data-board="own"] .cell[data-cell="{info["open"][0]}"]')
        await p.wait_for_timeout(150)
        s1 = await p.evaluate(STATE)
        # トリガーを選び直す（同じキューブの別のブロック）
        if len(info['open']) > 1:
            await p.click(f'.board[data-board="own"] .cell[data-cell="{info["open"][1]}"]')
            await p.wait_for_timeout(150)
        s2 = await p.evaluate(STATE)
        # 移動先を置く
        await p.click(f'.board[data-board="own"] .cell[data-cell="{info["at"]}"]')
        await p.wait_for_timeout(200)
        s3 = await p.evaluate(STATE)
        await p.screenshot(path=f'{SHOTS}/v15_place_{view}.png', full_page=(view == 'phone'))
        # 回転してみる（置けなければ外れる）→ 置き直し
        await p.click('[data-act=warp-rotate]')
        await p.wait_for_timeout(200)
        s4 = await p.evaluate(STATE)
        if not s4['warp'] or not s4['warp'].get('pos'):
            # その向きで置けなければ、4回まわして元の向きに戻し、置き直す
            for _ in range(3):
                await p.click('[data-act=warp-rotate]')
                await p.wait_for_timeout(80)
            await p.click(f'.board[data-board="own"] .cell[data-cell="{info["at"]}"]')
            await p.wait_for_timeout(150)
        await p.click('[data-act=warp-done]')
        await p.wait_for_timeout(1800)
        s5 = await p.evaluate(STATE)
        await p.screenshot(path=f'{SHOTS}/v15_armed_{view}.png', full_page=(view == 'phone'))
        # 2. CPU にトリガーをコールさせる（ターンを終えて、CPU の手番でトリガーをコール）
        fire = await p.evaluate("""() => { const a = window.__sb.app, g = a.game;
          if (g.sub === 'call' || g.sub === 'item') { const c = [...Array(g.NN).keys()].find((x) => g.isCallable(0, x)); g.call(0, c); }
          if (g.phase !== 'play') return { over: true };
          g.endTurn(0); if (g.sub === 'treasure') { const c = [...Array(g.NN).keys()].find((x) => g.isTreasureCallable(0, x)); g.treasureCall(0, c); }
          const P = g.players[0]; const p = P.pieces.find((x) => x.alive && x.warpPlan);
          if (!p || g.cur !== 1) return { cur: g.cur, armed: !!p };
          const before = p.cells.slice(); const trig = p.warpPlan.trigger;
          const r = g.call(1, trig);
          a.busy = false; window.__sb.render();
          const v1 = g.players[1].view;
          return { r: r.r, before, after: p.cells, reticle: r.reticle, mark: v1.marks[r.reticle] && v1.marks[r.reticle].r,
            oldMarks: before.map((c) => v1.marks[c] ? v1.marks[c].r + (v1.marks[c].warp ? 'W' : '') : '-') }; }""")
        await p.wait_for_timeout(2600)
        await p.screenshot(path=f'{SHOTS}/v15_fired_{view}.png', full_page=(view == 'phone'))
        # 3. CPU のキューブにワープを決めさせ、あなたが当てる（アンサーで逃げる）
        esc_ = await p.evaluate("""() => { const a = window.__sb.app, g = a.game;
          if (g.phase !== 'play') return { over: true };
          // CPU の手番を終わらせて、あなたの手番へ
          let n = 0; while (g.phase === 'play' && g.cur !== 0 && n++ < 10) { if (g.sub === 'call' || g.sub === 'item') { const c = [...Array(g.NN).keys()].find((x) => g.isCallable(1, x)); if (c != null) g.call(1, c); else g.skipCall(1); } if (g.sub === 'answer') g.endTurn(1); if (g.sub === 'treasure') { const c = [...Array(g.NN).keys()].find((x) => g.isTreasureCallable(1, x)); g.treasureCall(1, c); } if (g.sub === 'sacrifice') g.sacrifice(1, g.living(1)[0].id); }
          if (g.phase !== 'play') return { over: true };
          // CPU のキューブに直接ワープを決めておく（テストのため）
          const ps = g.warpable(1); if (!ps.length) return { none: true };
          const q = ps[0]; const open = q.cells.filter((c) => !(q.hitMask & (1 << c))); const o = g.warpOptions(1, q)[0];
          q.warpPlan = { at: g.clock, trigger: open[0], t: o.t, r0: o.r0, c0: o.c0, cells: o.cells, mask: o.mask };
          const c0 = [...Array(g.NN).keys()].find((x) => g.isCallable(0, x) && !(q.mask & (1 << x)));
          g.call(0, c0);
          const before = q.cells.slice();
          const r = g.answer(0, before);
          a.busy = false; window.__sb.render();
          const v0 = g.players[0].view;
          return { escaped: r.escaped, sub: g.sub, alive: q.alive, moved: q.cells.join() !== before.join(),
            oldMarks: before.map((c) => v0.marks[c] ? v0.marks[c].r + (v0.marks[c].warp ? 'W' : '') : '-'),
            reticles: q.cells.filter((c) => v0.marks[c] && v0.marks[c].r === 'wp').length }; }""")
        await p.wait_for_timeout(2600)
        await p.screenshot(path=f'{SHOTS}/v15_escape_{view}.png', full_page=(view == 'phone'))
        await b.close()
        return { 'view': view, 'pieces': n, 'turn': s, 'pick': s1, 'repick': s2, 'placed': s3, 'rot': s4, 'armed': s5, 'fire': fire, 'escape': esc_, 'errs': errs }

async def main():
    out = []
    for view, vp in [('desk', {'width': 1360, 'height': 900}), ('phone', {'width': 390, 'height': 844})]:
        out.append(await run(view, vp))
    bad = 0
    for o in out:
        print(o['view'], 'pick', o['pick']['mode'], o['pick']['warp'], 'wtr', o['pick']['wtr'])
        print('  repick trig', o['repick']['warp'] and o['repick']['warp'].get('trig'), 'placed pos', o['placed']['warp'] and o['placed']['warp'].get('pos'), 'wdest', o['placed']['wdest'], 'done', o['placed']['done'])
        print('  armed', o['armed']['armed'], 'wtr', o['armed']['wtr'], 'wdest', o['armed']['wdest'], 'mode', o['armed']['mode'])
        print('  fire', o['fire'])
        print('  escape', o['escape'])
        print('  errs', o['errs'][:5])
        if o['errs']: bad += 1
        if not o['armed']['armed'] or o['armed']['wtr'] < 1 or o['armed']['wdest'] < 1: bad += 1
        f = o['fire']
        if f.get('r') and (f['r'] != 'wp' or f['mark'] != 'wp' or f['before'] == f['after']): bad += 1
        e = o['escape']
        if 'escaped' in e and (not e['escaped'] or not e['alive'] or not e['moved'] or e['reticles'] or any(m != 'xW' for m in e['oldMarks']) or e['sub'] != 'answer'): bad += 1
    print('BAD', bad)
    sys.exit(1 if bad else 0)
asyncio.run(main())
