/**
 * IMAGINE TILE — Multiplayer & Math Rules Automated Test Suite
 * Run: node imaginetile-dev/test/net_multi_sim.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ITMulti = require('../it_multi.js');

function flushMicrotasks() {
  return new Promise(resolve => setTimeout(resolve, 15));
}

async function runTests() {
  let passed = 0;
  function ok(name) {
    passed++;
    console.log(`  ✔ PASS: ${name}`);
  }

  console.log('=== [1] 数理バランス＆レベル突破ボーナス計算テスト ===');
  {
    // ユーザー指定仕様: bonusEnergy = 50, 5人 ➔ 10pt or 💎4
    const b5 = ITMulti.calcBonusPerPlayer(50, 5);
    assert.strictEqual(b5.en, 10, '50 EN / 5 players should be 10pt');
    assert.strictEqual(b5.core, 4, 'ceil(50 / 3 / 5) should be 4 cores');

    const b4 = ITMulti.calcBonusPerPlayer(50, 4);
    assert.strictEqual(b4.en, 13);
    assert.strictEqual(b4.core, 5); // ceil(50/12) = 5

    const b3 = ITMulti.calcBonusPerPlayer(50, 3);
    assert.strictEqual(b3.en, 17);
    assert.strictEqual(b3.core, 6); // ceil(50/9) = 6

    const b2 = ITMulti.calcBonusPerPlayer(50, 2);
    assert.strictEqual(b2.en, 25);
    assert.strictEqual(b2.core, 9); // ceil(50/6) = 9

    const b1 = ITMulti.calcBonusPerPlayer(50, 1);
    assert.strictEqual(b1.en, 50);
    assert.strictEqual(b1.core, 17); // ceil(50/3) = 17

    const b0 = ITMulti.calcBonusPerPlayer(0, 5);
    assert.strictEqual(b0.en, 0);
    assert.strictEqual(b0.core, 0);
    ok('レベル突破ボーナス (EN / 1/3コア・人数割り切り上げ) 全人数検証');
  }

  {
    // 初期EN・クリアEN・回答コスト・クリア時コア倍率
    assert.strictEqual(ITMulti.calcPoolPerPlayer(50, 5), 10);
    assert.strictEqual(ITMulti.calcPoolPerPlayer(50, 3), 17);
    assert.strictEqual(ITMulti.calcPoolPerPlayer(50, 1), 50);

    assert.strictEqual(ITMulti.calcAnsCost(7, 1), 7);
    assert.strictEqual(ITMulti.calcAnsCost(7, 2), 4);
    assert.strictEqual(ITMulti.calcAnsCost(7, 3), 3);
    assert.strictEqual(ITMulti.calcAnsCost(7, 4), 2);
    assert.strictEqual(ITMulti.calcAnsCost(7, 5), 2);

    // 残30枚 ➔ B = ceil(30/25) = 2 ➔ ソロ +10, 2人 +5, 5人 +2
    assert.strictEqual(ITMulti.calcStageClearCore(30, 1, true), 10);
    assert.strictEqual(ITMulti.calcStageClearCore(30, 2, true), 5);
    assert.strictEqual(ITMulti.calcStageClearCore(30, 5, true), 2);
    assert.strictEqual(ITMulti.calcStageClearCore(30, 5, false), 0);
    ok('初期EN・回答コスト・ステージクリアコア獲得倍率 (1〜5人) 検証');
  }

  {
    // 自由編成の重複排除＆ソート
    assert.deepStrictEqual(ITMulti.sanitizeUnitsList([4, 1, 4, 0, -1, 9]), [0, 1, 4]);
    assert.deepStrictEqual(ITMulti.sanitizeUnitsList([]), [0]);
    const code = ITMulti.makeCode();
    assert.strictEqual(code.length, 6);
    assert.strictEqual(ITMulti.normCode(' ' + code.toLowerCase().slice(0, 3) + '-' + code.slice(3) + ' '), code);
    assert.strictEqual(ITMulti.normCode('INVALID0'), null); // '0' is excluded
    ok('自由編成サニタイズ＆部屋コード正規化検証');
  }

  console.log('\n=== [2] P2P ロビー（2〜5人入室・機体重複防止・READY同期・満員拒否）テスト ===');
  {
    let hostLobbySnap = null;
    const guestActions = [];
    const peerLeftEvents = [];

    const hostRoom = new ITMulti.HostRoom({
      code: 'TEST99',
      hostName: 'Captain',
      hostUnit: 2, // C.HACKER
      world: 'ocean',
      mode: 'hyper',
      onLobbyChange(st) { hostLobbySnap = st; },
      onGuestAction(pid, msg) { guestActions.push({ pid, msg }); },
      onPeerLeftInGame(pid, mem) { peerLeftEvents.push({ pid, mem }); }
    });

    // 4人のゲストを順番に接続（合計5人フル編成）
    const guests = [];
    const guestLinks = [];
    for (let i = 0; i < 4; i++) {
      const [hLink, gLink] = ITMulti.createMemoryLinkPair();
      hostRoom.attachGuestLink(hLink);
      let byeReason = null;
      const gc = new ITMulti.GuestClient(gLink, {
        name: `Player_${i + 1}`,
        handlers: {
          bye(r) { byeReason = r; }
        }
      });
      guests.push({ gc, getBye: () => byeReason });
      guestLinks.push(gLink);
    }
    await flushMicrotasks();

    assert.strictEqual(hostRoom.members.length, 5, 'Should have 5 members');
    const assignedUnits = hostRoom.members.map(m => m.unitIdx);
    const uniqueUnits = new Set(assignedUnits);
    assert.strictEqual(uniqueUnits.size, 5, 'All 5 units must be uniquely assigned without duplicates');
    ok('5人入室時の空き機体自動割り当て（重複ゼロ）検証');

    // 6人目の接続は full で拒否されること
    let sixthBye = null;
    {
      const [hLink6, gLink6] = ITMulti.createMemoryLinkPair();
      hostRoom.attachGuestLink(hLink6);
      new ITMulti.GuestClient(gLink6, {
        name: 'ExtraPlayer',
        handlers: { bye(r) { sixthBye = r; } }
      });
    }
    await flushMicrotasks();
    assert.strictEqual(sixthBye, 'full', '6th player should be rejected with full');
    ok('定員超過（6人目）の入室拒否検証');

    // ★ 5人満員状態での機体再クリック解除（unitIdx = -1）＆機体入れ替え（スワップ）テスト
    {
      const g0 = hostRoom.members.find(m => m.peerId === guests[0].gc.peerId);
      const origG0Unit = g0.unitIdx;
      assert.strictEqual(hostRoom.canStart().ok, true, 'Initially all 5 seated & ready -> canStart true');

      // ホストが自分の機体(2)を再クリックして搭乗解除
      const unRes = hostRoom.pickUnit('host', 2);
      await flushMicrotasks();
      assert.strictEqual(unRes.ok, true);
      assert.strictEqual(unRes.unselected, true);
      assert.strictEqual(hostRoom.members.find(m => m.peerId === 'host').unitIdx, -1, 'Host unitIdx must become -1');
      assert.strictEqual(hostRoom.canStart().ok, false, 'Cannot start while someone has unitIdx === -1');

      // 未搭乗者がいても5人満員なら6人目は full で拒否されること
      let sixthWhileUnseated = null;
      const [hLink6b, gLink6b] = ITMulti.createMemoryLinkPair();
      hostRoom.attachGuestLink(hLink6b);
      new ITMulti.GuestClient(gLink6b, {
        name: 'ExtraPlayer2',
        handlers: { bye(r) { sixthWhileUnseated = r; } }
      });
      await flushMicrotasks();
      assert.strictEqual(sixthWhileUnseated, 'full');

      // ゲスト0が空いた機体(2)へ移動し、ホストがゲスト0の元機体(origG0Unit)へ搭乗 ➔ 5人スワップ成立！
      guests[0].gc.pickUnit(2);
      await flushMicrotasks();
      assert.strictEqual(g0.unitIdx, 2, 'Guest 0 moved into vacated unit 2');
      hostRoom.pickUnit('host', origG0Unit);
      await flushMicrotasks();
      assert.strictEqual(hostRoom.members.find(m => m.peerId === 'host').unitIdx, origG0Unit, 'Host moved into Guest 0 vacated unit');
      assert.strictEqual(new Set(hostRoom.members.map(m => m.unitIdx)).size, 5, 'All 5 units uniquely assigned after swap');
      assert.strictEqual(hostRoom.canStart().ok, true, 'canStart becomes true again after swap');

      // ゲスト側の再クリック搭乗解除＆再搭乗も検証
      guests[0].gc.pickUnit(2); // 自分の機体(2)を再クリックで解除
      await flushMicrotasks();
      assert.strictEqual(g0.unitIdx, -1, 'Guest 0 unselected own unit');
      assert.strictEqual(hostRoom.canStart().ok, false, 'Cannot start while Guest 0 is unseated');
      guests[0].gc.pickUnit(2); // 再搭乗
      await flushMicrotasks();
      assert.strictEqual(g0.unitIdx, 2);
      assert.strictEqual(hostRoom.canStart().ok, true);

      // テストの後続ステップのためホストを2、ゲスト0をorigG0Unitに戻す
      hostRoom.pickUnit('host', origG0Unit); // unselect
      guests[0].gc.pickUnit(origG0Unit);
      await flushMicrotasks();
      hostRoom.pickUnit('host', 2);
      await flushMicrotasks();
    }
    ok('5人満員時の自機再クリック搭乗解除＆機体スワップ検証');

    // ゲスト1人を退室させて4人にし、機体変更テスト
    guests[3].gc.leave();
    await flushMicrotasks();
    assert.strictEqual(hostRoom.members.length, 4, 'Should be 4 members after 1 leaves');

    // 空いた機体番号を特定
    const occupiedSet = new Set(hostRoom.members.map(m => m.unitIdx));
    let freeUnit = -1;
    for (let u = 0; u < 5; u++) if (!occupiedSet.has(u)) freeUnit = u;
    assert.ok(freeUnit >= 0);

    // ゲスト0がホストの機体(2)を選ぼうとしても拒否されること
    let rejectedMsg = null;
    guests[0].gc.handlers.reject = (m) => { rejectedMsg = m; };
    guests[0].gc.pickUnit(2);
    await flushMicrotasks();
    assert.ok(rejectedMsg && rejectedMsg.reason, 'Picking occupied unit must be rejected');

    // ゲスト0が空いている機体(freeUnit)を選ぶと成功すること
    guests[0].gc.pickUnit(freeUnit);
    await flushMicrotasks();
    const g0Member = hostRoom.members.find(m => m.peerId === guests[0].gc.peerId);
    assert.strictEqual(g0Member.unitIdx, freeUnit, 'Picking free unit must succeed');
    assert.strictEqual(guests[1].gc.lobbyState.members.find(m => m.peerId === guests[0].gc.peerId).unitIdx, freeUnit, 'Other guests must receive updated unit selection');
    ok('機体選択の重複ロック＆空き機体への移動リアルタイム同期検証');

    // READY状態チェック
    guests[0].gc.setReady(false);
    await flushMicrotasks();
    assert.strictEqual(hostRoom.canStart().ok, false, 'Cannot start when a guest is not ready');
    guests[0].gc.setReady(true);
    await flushMicrotasks();
    assert.strictEqual(hostRoom.canStart().ok, true, 'Can start when all guests are ready');
    ok('全員READY判定と出撃ロック検証');

    // 試合開始＆アクション転送＆途中切断引き継ぎ検証
    hostRoom.phase = 'playing';
    const orderedPlayers = hostRoom.buildOrderedPlayers(['A.PILOT','B.ENGNR','C.HACKER','D.SNIPER','E.LEADER'], 2);
    assert.strictEqual(orderedPlayers.length, 4);
    for (let i = 1; i < orderedPlayers.length; i++) {
      assert.ok(orderedPlayers[i - 1].unitIdx < orderedPlayers[i].unitIdx, 'Players must be sorted by unitIdx');
    }

    // 進行中の新規入室は playing で拒否されること
    let midJoinBye = null;
    {
      const [hLinkMid, gLinkMid] = ITMulti.createMemoryLinkPair();
      hostRoom.attachGuestLink(hLinkMid);
      new ITMulti.GuestClient(gLinkMid, {
        name: 'LateJoiner',
        handlers: { bye(r) { midJoinBye = r; } }
      });
    }
    await flushMicrotasks();
    assert.strictEqual(midJoinBye, 'playing');

    // ゲストからのアクション送信
    guests[1].gc.sendAct({ act: 'shot', pi: 1 });
    await flushMicrotasks();
    assert.strictEqual(guestActions.length, 1);
    assert.strictEqual(guestActions[0].pid, guests[1].gc.peerId);
    assert.strictEqual(guestActions[0].msg.act, 'shot');

    // 試合中にゲスト2が切断 ➔ 試合終了せず controlledByHost が true になること
    const g2Pid = guests[2].gc.peerId;
    guests[2].gc.leave();
    await flushMicrotasks();
    assert.strictEqual(peerLeftEvents.length, 1);
    assert.strictEqual(peerLeftEvents[0].pid, g2Pid);
    const leftMember = hostRoom.members.find(m => m.peerId === g2Pid);
    assert.strictEqual(leftMember.connected, false);
    assert.strictEqual(leftMember.controlledByHost, true);
    ok('バトル中のアクション転送・進行中入室ブロック・途中切断ホスト引き継ぎ検証');

    // ロビー復帰時に切断済みメンバーがクリーンアップされること
    hostRoom.returnToLobby();
    await flushMicrotasks();
    assert.strictEqual(hostRoom.phase, 'lobby');
    assert.strictEqual(hostRoom.members.length, 3); // Host + Guest0 + Guest1
    assert.strictEqual(guests[0].gc.lobbyState.members.length, 3);
    ok('試合終了後のロビー一括復帰＆切断メンバー整理検証');

    hostRoom.closeRoom();
  }

  console.log('\n=== [3] imagine_tile.html 本体スクリプト構文＆組み込み検証 ===');
  {
    const htmlPath = path.resolve(__dirname, '../../imagine_tile.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
    assert.ok(scriptMatches.length >= 1, 'imagine_tile.html should contain inline script');
    for (let idx = 0; idx < scriptMatches.length; idx++) {
      // Syntax validation via Function constructor (parses entire JS without executing DOM code)
      new Function(scriptMatches[idx][1]);
    }
    assert.ok(html.includes('id="online-lobby"'), 'Online lobby modal must exist in HTML');
    assert.ok(html.includes('openOnlineLobby()'), 'Online lobby trigger button must exist');
    assert.ok(html.includes('calcBonusPerPlayer'), 'Bonus per-player calculation must be embedded');
    ok('imagine_tile.html の全JS構文パース検証＆必須UI要素存在チェック');
  }

  console.log(`\n🎉 ALL ${passed} TEST SUITES PASSED SUCCESSFULLY!`);
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
