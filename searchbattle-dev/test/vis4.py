import os
# 見た目の確認用：新しい表示（W付き×・番号つき○・サーチラインのタグ・マス数タグ・相手の使用済みアイテム）が
# そろった盤面を作って撮る
import asyncio
from playwright.async_api import async_playwright
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', 'test.html'))
BUILD = """() => {
  const a = window.__sb.app, g = a.game, E = window.SBEngine, AI = window.SBAI;
  a.busy = true;
  const P0 = g.players[0], P1 = g.players[1];
  P0.wallet = 30;
  // CPUの個体を作り直す：L4（ヒット・ディスタンス用）、I3（ワープ用）、D2（サーチシェイプ用）
  P1.pieces = []; P1.treasure = null;
  const L = g._makePiece(P1, 'L4', 0, 0, 1, E.cellsFor('L4', 0, 0, 1, 4)); P1.pieces.push(L);
  const I = g._makePiece(P1, 'I3', 0, 3, 1, E.cellsFor('I3', 0, 3, 1, 4)); P1.pieces.push(I);
  const D = g._makePiece(P1, 'D2', 1, 0, 3, E.cellsFor('D2', 1, 0, 3, 4)); P1.pieces.push(D);
  P1.treasure = { pieceId: I.id, idx: 0, cell: I.cells[0] };
  const endHuman = () => { if (g.sub === 'answer') g.endTurn(0); if (g.sub === 'treasure') { const cs=[...Array(g.NN).keys()].filter(c=>g.isTreasureCallable(0,c)); g.treasureCall(0, cs[cs.length-1]); } };
  const cpuTurn = (item) => {
    if (item) g.useItem(1, item.key, item.params);
    const cs = [...Array(g.NN).keys()].filter(c => g.isCallable(1, c));
    g.call(1, cs[0]);
    if (g.sub === 'answer') g.endTurn(1);
    if (g.sub === 'treasure') { const t=[...Array(g.NN).keys()].filter(c=>g.isTreasureCallable(1,c)); g.treasureCall(1, t[0]); }
  };
  if (g.cur === 1) cpuTurn(null);
  // T1：サーチライン → L4の1マス目を◎
  g.useItem(0, 'line', { line: 'row', index: 1 });
  g.call(0, L.cells[0]); endHuman();
  cpuTurn({ key: 'shape', params: { cell: P0.pieces[0].cells[0] } });
  // T2：L4の2マス目を○ → ディスタンス（○の上）
  g.call(0, L.cells[1]);
  g.useItem(0, 'dist', { cell: L.cells[1] });
  endHuman();
  cpuTurn({ key: 'number', params: { cell: P0.pieces[0].cells[0] } });
  // T3：ディスタンス（まだヒットしていないL4のマス → 枠つき数字）
  g.useItem(0, 'dist', { cell: L.cells[3] });
  g.call(0, 12); endHuman();
  // CPU：I3をワープ（移動前に W）
  cpuTurn({ key: 'warp', params: AI.bestWarpTarget(g, 1, I) });
  // T4：ディスタンス（D2のマス → NoData）、サーチシェイプ（D2 → C）
  g.useItem(0, 'dist', { cell: D.cells[1] });
  const cs = [...Array(g.NN).keys()].filter(c => g.isCallable(0, c) && !g.pieceAt(1, c) && c !== 12);
  g.call(0, cs[0]); endHuman();
  cpuTurn({ key: 'pair', params: { a: P0.pieces[0].cells[0], b: 15 } });
  // T5：サーチシェイプ（D2 → C）、ペアショット（どの2マスでも）
  g.useItem(0, 'shape', { cell: D.cells[0] });
  const cs2 = [...Array(g.NN).keys()].filter(c => g.isCallable(0, c) && !g.pieceAt(1, c));
  g.call(0, cs2[0]); endHuman();
  cpuTurn(null);
  g.useItem(0, 'pair', { a: D.cells[0], b: L.cells[2] });
  a.busy = false; a.fxSeen = g.events.length;
  window.__sb.render();
  return { L: L.cells.map(c => g.coord(c)), I: I.cells.map(c => g.coord(c)), D: D.cells.map(c => g.coord(c)), sub: g.sub, cur: g.cur, log: g.log.slice(-14).map(l => l.text) };
}"""
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        errs = []
        for (w, h, name) in [(1440, 940, 'desktop'), (390, 844, 'mobile')]:
            ctx = await b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if w < 500 else 1)
            p = await ctx.new_page()
            p.on('pageerror', lambda e: errs.append(str(e)))
            await p.goto(URL)
            await p.click('label[for=opt-items-3]')
            await p.wait_for_selector('.item-pick')
            if name == 'desktop': await p.screenshot(path=f'{SHOTS}/v5_title_items.png', full_page=True)
            await p.click('label[for=opt-items-0]')
            await p.click('label[for=opt-speed-1]')
            await p.click('[data-act=start]')
            await p.click('[data-act=random]')
            if name == 'desktop': await p.screenshot(path=f'{SHOTS}/v5_setup.png', full_page=True)
            await p.click('[data-act=setup-done]')
            await p.wait_for_timeout(1800)
            for _ in range(60):
                s = await p.evaluate("() => { const a=window.__sb.app,g=a.game; return {busy:a.busy, cur:g.cur, sub:g.sub} }")
                if not s['busy'] and s['cur'] == 0: break
                await p.wait_for_timeout(150)
            info = await p.evaluate(BUILD)
            print(name, 'L', info['L'], 'I', info['I'], 'D', info['D'], info['sub'], info['cur'])
            for t in info['log']: print('   ', t)
            await p.wait_for_timeout(400)
            await p.screenshot(path=f'{SHOTS}/v5_battle_{name}.png', full_page=True)
            ow = await p.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")
            print(name, 'overflow', ow)
            await ctx.close()
        print('errors', errs)
        await b.close()
asyncio.run(main())
