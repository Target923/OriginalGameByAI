# オンライン対戦の画面テスト（通信あり）
#  この環境に PeerServer（npm の peer）を立て、Playwright でブラウザを2つ（ホスト＝PC幅、ゲスト＝スマホ幅）開いて、
#  部屋を作る → コードで入る → 配置 → ドラフト → 対戦（アイテム・わざと外すアンサー・差し出しも）→ 決着 → リプレイ →
#  もう一度 → 退出 までを、画面のボタンを押して通す。3人目が同じ部屋に入ろうとすると断られることも確かめる。
#  外の PeerJS クラウドには出られないので、URL の ?peer=127.0.0.1:9000 でこの環境のサーバーを使い、
#  PeerJS の本体（CDN）は、テストの中で手元のファイルに差し替える。
#  確かめること：ゲストの手元にホストの秘密（生きているキューブ・トレジャー・操作の記録）が一度も届かない／
#   決着後の両者の対戦がまったく同じ／勝ち負けの表示が逆になっている／もう一度・退出が動く／画面のエラーがない
# 使い方：python3 test/online_e2e.py   （初回は SB_NETDEPS（既定 /tmp/sb_netdeps）に peer と peerjs を npm で入れる）
import os, sys, json, asyncio, subprocess
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.environ.get('SB_SHOTS', '/tmp/sb_shots'); os.makedirs(SHOTS, exist_ok=True)
DEPS = os.environ.get('SB_NETDEPS', '/tmp/sb_netdeps')
PORT = int(os.environ.get('SB_PEER_PORT', '9000'))
URL = 'file://' + os.path.abspath(os.path.join(HERE, '..', 'dist', 'test.html')) + f'?peer=127.0.0.1:{PORT}'
PEERJS_CDN = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js'
fails = []
def fail(m):
    fails.append(m); print('FAIL', m)

def ensure_deps():
    nm = os.path.join(DEPS, 'node_modules')
    if not (os.path.exists(os.path.join(nm, 'peer')) and os.path.exists(os.path.join(nm, 'peerjs'))):
        os.makedirs(DEPS, exist_ok=True)
        subprocess.run(['npm', 'install', '--prefix', DEPS, 'peer@1.0.2', 'peerjs@1.5.5', '--no-audit', '--no-fund'], check=True, stdout=subprocess.DEVNULL)

def start_server():
    code = f"const {{ PeerServer }} = require('peer'); PeerServer({{ host: '127.0.0.1', port: {PORT}, path: '/' }}, () => console.log('ready'));"
    p = subprocess.Popen(['node', '-e', code], cwd=DEPS, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    line = p.stdout.readline()
    if 'ready' not in line:
        p.kill(); raise RuntimeError('PeerServer did not start: ' + line)
    return p

STATE = """() => { const a = window.__sb.app, g = a.game, n = a.net;
  const o = { screen: a.screen, lobby: a.lobby && a.lobby.st, code: a.lobby && a.lobby.code, err: a.lobby && a.lobby.err, net: !!n, modal: a.modal, replay: !!a.replay };
  if (n) Object.assign(o, { seat: n.seat, role: n.role, gone: n.gone, wait: !!(n.guest && n.guest.wait), sent: !!(n.guest && n.guest.setupSent), mineDone: !!(g && g.players[n.seat].setupDone) });
  if (g) Object.assign(o, { phase: g.phase, sub: g.sub, cur: g.cur, turn: g.turn, itemUsed: g.itemUsed, draftTurn: g.phase === 'draft' ? g.draftTurn() : -1, showResult: !!(a.ui && a.ui.showResult) });
  return o; }"""
# ゲストの手元に、ホストの秘密が届いていないか（決着までのあいだ）
GUEST_SECRET = """() => { const g = window.__sb.app.game; if (!g || g.phase === 'over') return null;
  const H = g.players[0];
  if (H.pieces.some((p) => p.alive)) return 'ホストの生きている個体';
  if (H.treasure) return 'ホストのトレジャー';
  if (H.splitPieces && H.splitPieces.length) return 'splitPieces';
  if (g.actions) return '操作の記録';
  if (g.events.some((e) => e.actor === 0 && e.priv)) return 'ホストの priv';
  return null; }"""
# 自分の番の1手を選ぶ（CPU の考え方を借りる。ゲストは自分に届いた伏せた盤面だけで考える）
CHOOSE = """(arg) => {
  const a = window.__sb.app, g = a.game, v = a.net.seat, AI = window.SBAI;
  const dead = g.players[v].view.dead, marks = g.players[v].view.marks;
  if (g.sub === 'sacrifice') { const id = AI.chooseSacrifice(g, v); const p = g.players[v].pieces.find((x) => x.id === id && x.alive) || g.living(v)[0]; return { kind: 'own', cell: p.cells[0] }; }
  if (g.sub === 'treasure') return { kind: 'pred', cell: AI.chooseTreasure(g, v) };
  if (g.sub === 'item' && g.turn >= 2) {
    for (const k of ['warp', 'stealth', 'line', 'number', 'bazooka']) {
      if (arg.used.indexOf(k) >= 0 || !g.itemStatus(v, k).usable) continue;
      if (k === 'stealth') { const p = g.living(v).find((p) => !p.stealth); if (p) return { kind: 'item', key: k, own: p.cells[0] }; continue; }
      if (k === 'warp') {
        // 今の向きのまま置ける場所がある個体だけ（盤がいっぱいだと動かせない）
        const p = g.living(v).find((p) => !p.isAdd && !p.frag && [...Array(g.NN).keys()].some((c) => g.validateItem(v, 'warp', { pieceId: p.id, t: p.t, r0: Math.floor(c / g.N), c0: c % g.N }).ok));
        if (p) return { kind: 'item', key: k, own: p.cells[0], warp: true };
        continue;
      }
      if (k === 'line') return { kind: 'item', key: k, line: 'col', index: 1 };
      const cs = [...Array(g.NN).keys()].filter((c) => !dead[c]);
      if (cs.length) return { kind: 'item', key: k, pred: cs[Math.floor(Math.random() * cs.length)] };
    }
  }
  if (g.sub === 'item' || g.sub === 'call') {
    if (!g.hasCallable(v)) return { kind: 'act', act: 'skip-call' };
    return { kind: 'pred', cell: AI.chooseCall(g, v) };
  }
  if (g.sub === 'answer') {
    if (arg.failAnswer) {
      // わざと外すアンサー：×（何もない）とわかっている1マスを宣言する（差し出しの流れを確かめる）
      const c = [...Array(g.NN).keys()].find((c) => marks[c] && marks[c].r === 'x' && !dead[c]);
      if (c != null) return { kind: 'answer', cells: [c], fail: true };
    }
    const cells = AI.chooseAnswer(g, v);
    if (cells) return { kind: 'answer', cells };
    return { kind: 'act', act: 'end-turn' };
  }
  return null;
}"""

async def wait_for(page, cond, timeout=15.0, what=''):
    t = 0.0
    while t < timeout:
        s = await page.evaluate(STATE)
        if cond(s): return s
        await asyncio.sleep(0.1); t += 0.1
    fail(f'timeout: {what} {s}')
    return s

async def settle(page):
    # ゲストが送った操作の結果（state）が届くまで待つ
    for _ in range(100):
        s = await page.evaluate(STATE)
        if not s.get('wait'): return s
        await asyncio.sleep(0.05)
    fail('ゲストの結果が届かない'); return s

async def do_plan(page, plan, N):
    k = plan['kind']
    if k == 'pred': await page.click(f'.cell[data-board=pred][data-cell="{plan["cell"]}"]')
    elif k == 'own': await page.click(f'.cell[data-board=own][data-cell="{plan["cell"]}"]')
    elif k == 'act': await page.click(f'[data-act="{plan["act"]}"]')
    elif k == 'answer':
        await page.click('[data-act=answer-start]')
        for c in plan['cells']: await page.click(f'.cell[data-board=pred][data-cell="{c}"]')
        try: await page.click('[data-act=answer-submit]', timeout=2000)
        except Exception: await page.click('[data-act=cancel]'); await page.click('[data-act=end-turn]')
    elif k == 'item':
        await page.click(f'[data-act=item][data-key={plan["key"]}]')
        if plan['key'] == 'line': await page.click(f'.axbtn[data-line={plan["line"]}][data-index="{plan["index"]}"]')
        elif 'pred' in plan: await page.click(f'.cell[data-board=pred][data-cell="{plan["pred"]}"]')
        elif plan.get('warp'):
            await page.click(f'.cell[data-board=own][data-cell="{plan["own"]}"]')
            # 置ける場所を、自分の盤のマスを順に押して探す（置けないマスは手元で断られる）
            for c in range(N):
                await page.click(f'.cell[data-board=own][data-cell="{c}"]')
                s = await page.evaluate(STATE)
                if s.get('wait') or s.get('itemUsed'): break
            else:
                await page.click('[data-act=cancel]')
        else: await page.click(f'.cell[data-board=own][data-cell="{plan["own"]}"]')

async def play_match(host, guest, no):
    N = await host.evaluate("() => window.__sb.app.game.NN")
    used = {0: [], 1: []}
    failed_answer = {0: False, 1: False}
    shot = False
    for step in range(3000):
        sh = await host.evaluate(STATE)
        sg = await guest.evaluate(STATE)
        leak = await guest.evaluate(GUEST_SECRET)
        if leak: fail(f'T{sh.get("turn")} ゲストに届いた: {leak}'); break
        if sh.get('phase') == 'over': break
        if sh.get('phase') != 'play': await asyncio.sleep(0.1); continue
        cur = sh['cur']
        page, st = (host, sh) if cur == 0 else (guest, sg)
        # ゲストの画面がまだ追いついていなければ待つ
        if st.get('wait') or st.get('phase') != 'play' or st.get('cur') != cur or st.get('sub') != sh.get('sub'):
            await asyncio.sleep(0.08); continue
        if not shot and sh.get('turn', 0) >= 4 and cur == 1 and sh.get('sub') == 'item':
            shot = True
            await host.screenshot(path=f'{SHOTS}/on_4_host_battle_{no}.png')
            await guest.screenshot(path=f'{SHOTS}/on_5_guest_battle_{no}.png', full_page=True)
        plan = await page.evaluate(CHOOSE, {'used': used[cur], 'failAnswer': not failed_answer[cur] and sh.get('turn', 0) >= 3})
        if not plan: await asyncio.sleep(0.1); continue
        if plan.get('fail'): failed_answer[cur] = True
        if plan['kind'] == 'item': used[cur].append(plan['key'])
        await do_plan(page, plan, N)
        if cur == 1: await settle(guest)
        await asyncio.sleep(0.05)
    await wait_for(host, lambda s: s.get('showResult'), 20, 'ホストの結果')
    await wait_for(guest, lambda s: s.get('showResult'), 20, 'ゲストの結果')
    gh = await host.evaluate("() => JSON.stringify(Object.assign({}, window.__sb.app.game, { rng: undefined }))")
    gg = await guest.evaluate("() => JSON.stringify(Object.assign({}, window.__sb.app.game, { rng: undefined }))")
    if gh != gg: fail('決着後の対戦がホストとゲストで違う')
    vh = await host.inner_text('.verdict'); vg = await guest.inner_text('.verdict')
    if not ((vh, vg) in (('VICTORY', 'DEFEAT'), ('DEFEAT', 'VICTORY'), ('DRAW', 'DRAW'))): fail(f'勝ち負けの表示 {vh} / {vg}')
    await host.screenshot(path=f'{SHOTS}/on_6_host_result_{no}.png')
    await guest.screenshot(path=f'{SHOTS}/on_7_guest_result_{no}.png')
    res = await host.evaluate("() => { const g = window.__sb.app.game; return { turn: g.turn, winner: g.result.winner, items: g.log.filter(e => e.kind === 'item').map(e => e.actor + ':' + e.key), penalty: g.log.filter(e => e.kind === 'penalty').length } }")
    print('match', no, json.dumps(res, ensure_ascii=False), 'used', used, 'failAnswer', failed_answer)

async def manual_setup(page):
    await page.click('.cell[data-board=own][data-cell="0"]')
    await page.click('.cell[data-board=own][data-cell="10"]')
    await page.click('[data-act=treasure-mode]')
    await page.click('.cell[data-board=own][data-cell="0"]')

async def open_page(browser, w, h, errors, tag):
    ctx = await browser.new_context(viewport={'width': w, 'height': h})
    # PeerJS の本体は手元のファイルから。外のフォントは読まない（この環境からは届かない）
    await ctx.route(PEERJS_CDN, lambda r: r.fulfill(path=os.path.join(DEPS, 'node_modules', 'peerjs', 'dist', 'peerjs.min.js'), content_type='application/javascript'))
    await ctx.route('https://fonts.googleapis.com/**', lambda r: r.abort())
    await ctx.route('https://fonts.gstatic.com/**', lambda r: r.abort())
    page = await ctx.new_page()
    page.on('pageerror', lambda e: errors.append((tag, 'pageerror', str(e))))
    page.on('console', lambda m: errors.append((tag, m.type, m.text)) if m.type == 'error' and 'fonts.g' not in m.text and 'ERR_FAILED' not in m.text else None)
    await page.goto(URL)
    await page.evaluate("() => localStorage.clear()"); await page.reload()
    await page.wait_for_selector('[data-act=start]')
    await page.click('label[for=opt-mode-2]')      # オンライン対戦
    await page.click('label[for=opt-speed-1]')     # 演出：はやい
    return page

async def toast_text(page):
    return await page.evaluate("() => { const t = document.getElementById('toast'); return t ? t.textContent : '' }")

async def main():
    ensure_deps()
    server = start_server()
    errors = []
    try:
        async with async_playwright() as p:
            # mDNS で手元の住所を隠す機能を切る（同じ機械の中の2つのブラウザが直接つながれるように）
            browser = await p.chromium.launch(args=['--disable-features=WebRtcHideLocalIpsWithMdns'])
            host = await open_page(browser, 1360, 900, errors, 'host')
            guest = await open_page(browser, 390, 844, errors, 'guest')
            # ホスト：ドラフトありの設定で部屋を作る
            await host.click('label[for=opt-items-2]')
            await host.click('[data-act=start]')
            await host.fill('#net-name', 'ホスト太郎')
            await host.click('[data-act=net-create]')
            s = await wait_for(host, lambda s: s.get('lobby') == 'hosting', 15, '部屋を作る')
            code = s.get('code')
            await host.screenshot(path=f'{SHOTS}/on_1_host_room.png')
            # ゲスト：コードを入れて入る（小文字・ハイフン入りでも入れる）
            await guest.click('[data-act=start]')
            await guest.fill('#net-name', '<b>ゲスト花子</b>')
            await guest.fill('#net-code', code[:3].lower() + '-' + code[3:])
            await guest.screenshot(path=f'{SHOTS}/on_2_guest_lobby.png')
            await guest.press('#net-code', 'Enter')
            await wait_for(guest, lambda s: s.get('screen') == 'setup', 20, 'ゲストが配置へ')
            await wait_for(host, lambda s: s.get('screen') == 'setup', 5, 'ホストが配置へ')
            foe = await host.evaluate("() => window.__sb.app.net.foe")
            if '<' in foe or '>' in foe: fail('相手の名前に < > が残る: ' + foe)
            # 3人目：同じ部屋には入れない
            third = await open_page(browser, 800, 700, errors, 'third')
            await third.click('[data-act=start]')
            # まず、ない部屋のコード
            wrong = 'ABCDEF' if code != 'ABCDEF' else 'ABCDEG'
            await third.fill('#net-code', wrong)
            await third.click('[data-act=net-join]')
            s3 = await wait_for(third, lambda s: s.get('lobby') == 'idle' and s.get('err'), 25, 'ない部屋')
            if '見つかりません' not in (s3.get('err') or ''): fail('ない部屋の知らせ: ' + str(s3.get('err')))
            await third.fill('#net-code', code)
            await third.click('[data-act=net-join]')
            s3 = await wait_for(third, lambda s: s.get('lobby') == 'idle' and s.get('err'), 20, '3人目が断られる')
            if '対戦中' not in (s3.get('err') or ''): fail('3人目の知らせ: ' + str(s3.get('err')))   # 「満員」か「入れませんでした（もう対戦中か…）」のどちらでも「対戦中」を含む
            await third.close()
            # 配置：ゲストが先に送り、ホストの画面に「配置完了」が出るのを確かめる
            await guest.click('[data-act=random]'); await guest.click('[data-act=setup-done]')
            await wait_for(guest, lambda s: s.get('sent') or s.get('mineDone'), 5, 'ゲストの配置を送る')
            await guest.screenshot(path=f'{SHOTS}/on_3_guest_setup_wait.png', full_page=True)
            await host.wait_for_selector('.net-foe b', timeout=5000)
            leak = await guest.evaluate(GUEST_SECRET)
            if leak: fail('配置中に届いた: ' + leak)
            await host.click('[data-act=random]'); await host.click('[data-act=setup-done]')
            await wait_for(host, lambda s: s.get('screen') == 'draft', 10, 'ホストがドラフトへ')
            await wait_for(guest, lambda s: s.get('screen') == 'draft', 10, 'ゲストがドラフトへ')
            # ドラフト：自分の番の人だけが選べる
            for _ in range(200):
                sh = await host.evaluate(STATE)
                if sh.get('phase') != 'draft': break
                pg = host if sh['draftTurn'] == 0 else guest
                other = guest if pg is host else host
                if await other.query_selector('[data-act=draft-pick]:not([disabled])'): fail('相手の番なのに選べる'); break
                btn = await pg.query_selector('[data-act=draft-pick]:not([disabled])')
                if btn: await btn.click(); await settle(pg)
                await asyncio.sleep(0.15)
            await wait_for(host, lambda s: s.get('screen') == 'battle', 10, 'ホストが対戦へ')
            await wait_for(guest, lambda s: s.get('screen') == 'battle', 10, 'ゲストが対戦へ')
            await play_match(host, guest, 1)
            # ゲストもリプレイを開ける（決着後に全部が届いているので）
            await guest.click('[data-act=replay-open]')
            await wait_for(guest, lambda s: s.get('replay'), 10, 'ゲストのリプレイ')
            await guest.keyboard.press('Escape')
            await wait_for(guest, lambda s: not s.get('replay'), 10, 'リプレイを閉じる')
            # もう一度：ホストが始めると、両方とも配置へ
            if await guest.query_selector('.overlay [data-act=restart]'): fail('ゲストに「もう一度」が出ている')
            # 2試合目はドラフトなし・9種を1つずつ（ホストの設定を変えてから「もう一度」）
            await host.evaluate("() => { window.__sb.app.settings.items = 'pick'; window.__sb.app.settings.itemPick = window.SBEngine.ITEM_KEYS.slice(); }")
            await host.click('.overlay [data-act=restart]')
            await wait_for(host, lambda s: s.get('screen') == 'setup' and s.get('phase') == 'setup', 10, 'もう一度（ホスト）')
            await wait_for(guest, lambda s: s.get('screen') == 'setup' and s.get('phase') == 'setup', 10, 'もう一度（ゲスト）')
            if '次の試合' not in await toast_text(guest): fail('ゲストに次の試合の知らせが出ない')
            # 今度はホストが先に配置を終える（ゲストの画面に「配置完了」が出る）。
            #  ワープを使えるよう、2マスのキューブ2つだけを手で置く（自動配置は盤がいっぱいになり、ワープで動かせない）
            await manual_setup(host); await host.click('[data-act=setup-done]')
            await guest.wait_for_selector('.net-foe b', timeout=5000)
            await manual_setup(guest); await guest.click('[data-act=setup-done]')
            await wait_for(guest, lambda s: s.get('screen') == 'battle', 10, '2試合目の対戦（ゲスト）')
            await wait_for(host, lambda s: s.get('screen') == 'battle', 10, '2試合目の対戦（ホスト）')
            await play_match(host, guest, 2)
            await host.click('.overlay [data-act=restart]')
            await wait_for(guest, lambda s: s.get('screen') == 'setup' and s.get('phase') == 'setup', 10, '3試合目（ゲスト）')
            # ゲストが途中で退出：確かめる画面 → 部屋を出る。ホストはタイトルに戻り、知らせが出る
            await guest.click('.hud [data-act=to-title]')
            await wait_for(guest, lambda s: s.get('modal') == 'net-quit', 5, '退出の確認')
            await guest.click('[data-act=net-quit]')
            await wait_for(guest, lambda s: s.get('screen') == 'title' and not s.get('net'), 5, 'ゲストがタイトルへ')
            await wait_for(host, lambda s: s.get('screen') == 'title' and not s.get('net'), 10, 'ホストがタイトルへ')
            if '退出' not in await toast_text(host): fail('ホストに退出の知らせが出ない: ' + await toast_text(host))
            # claude.ai の公開ページ（window.claude がある）では、オンライン対戦の代わりに遊べるページを案内する
            ctx = await browser.new_context(viewport={'width': 390, 'height': 844})
            await ctx.add_init_script("window.claude = {}")
            art = await ctx.new_page()
            art.on('pageerror', lambda e: errors.append(('artifact', 'pageerror', str(e))))
            await art.goto(URL)
            await art.evaluate("() => localStorage.clear()"); await art.reload()
            await art.click('label[for=opt-mode-2]')
            await art.click('[data-act=start]')
            await art.wait_for_selector('.lob-blocked a[href*="github.io"]', timeout=5000)
            if await art.query_selector('[data-act=net-create]'): fail('公開ページで部屋を作れてしまう')
            if await art.evaluate("() => !!window.Peer"): fail('公開ページで PeerJS を読み込んだ')
            await art.screenshot(path=f'{SHOTS}/on_8_artifact_blocked.png')
            await browser.close()
    finally:
        server.kill()
    errs = [e for e in errors if 'ERR_TUNNEL' not in e[2]]
    if errs: fail('画面のエラー: ' + json.dumps(errs[:5], ensure_ascii=False))
    print('NG %d件' % len(fails) if fails else 'OK')
    sys.exit(1 if fails else 0)

asyncio.run(main())
