# サーチバトル 引き継ぎ資料（2026-10-23）

新しいチャットで続きをするための資料。最初にこれを読み、ルールの細部が要るときだけ「確定ルール」「総括」の該当箇所を読む（全部は読まない）。

## いまの状態
- ルール v12.12、エンジンのバージョン17（src/engine.js の `VERSION`）。公開 Version 38。
- 直近の変更
  - v12.11：バズーカで分解した相手の個体を失ったかどうかは、試合終了まで非公開（所持キューブの表示も）。
  - v12.12：サーチラインの答え＝「個体数 / マス数」。タグは「B列 残り2個体 / 3マス」の1ブロックで、撃破ごとに更新。CPUも個体数を推理に使う。決勝のドラフトでラインをノードの次に上げた。
  - ターン開始の表示にターン数（YOUR TURN 05・5ターン目・あなたの手番）。
  - シミュレーターをゲーム本体に組み込んだ（タイトル →「シミュレーター」）。見本はバージョン17で200回。

## 置き場所
| もの | 場所・メモ |
| --- | --- |
| ゲーム本体（公開ページ） | https://claude.ai/artifact/3UbGw7pjqKEpw1Zb9qa6to 。別のチャットから更新するときは、先に read してから url を付けて publish |
| ルールブック（Docs） | https://claude.ai/artifact/H8PsvKivxY1fXYnd5D6pfJ 。docs のツールで編集（doc 829a8622-d46e-45a1-8ac0-5435a3b5d4d1、本文 node 80d22682-fb23）。変えるところだけ find で書き換える |
| 旧シミュレーター（別ページ） | https://claude.ai/artifact/W54fL2qr9z9zauoT1kaJfG 。本体に組み込んだので不要。削除はユーザーの確認待ち |
| 確定ルール・総括 | プロジェクトのドキュメント claude/サーチバトル_確定ルール.md・claude/サーチバトル_総括.md（docs/rules.md・docs/summary.md と同じ中身。project_write の local_path で上げる） |
| GitHub | Target923/OriginalGameByAI（2026-10-24 から書き込み権限あり。main に直接 push する）。ルートの index.html がランチャーで、同じ階層のファイル名で各ゲームを開く（このゲームは search_battle.html。ルールブックのボタンは search_battle_rulebook.pdf を見る）。開発フォルダは searchbattle-dev/ に置く（ランチャーはファイル名で開くだけなので、別のフォルダは影響しない） |

## 開発フォルダの戻し方
1. add_repo（access: "push"）でリポジトリを追加し、/home/claude/originalgamebyai に clone する。開発はその中の searchbattle-dev/（build.js がある階層）で直接行う。
2. `node build.js` → dist/searchbattle.html（artifact に publish する本文。head がないので、そのままでは開かない）、dist/search_battle.html（GitHub のランチャー用。そのまま開ける完全な HTML）、dist/test.html（テスト用。中身は search_battle.html と同じ。window.__sb・SBEngine・SBAI が使える）。
3. Node と Python の Playwright（Chromium 入り）を使う。画面テストのスクリーンショットは環境変数 SB_SHOTS（なければ /tmp/sb_shots）。

## ファイル
- src/engine.js ルール（Game・Tour・リプレイ）／src/ai.js CPU／src/ui.js 画面（シミュレーター画面も）／src/audio.js 音／src/sim.js シミュレーターの計算（画面とコマンドで共通）／src/template.html HTML と CSS／src/sim-sample.json シミュレーターの見本
- build.js：template.html に各ファイルを差し込んで1ファイルにする
- tools/sim.js：シミュレーターのコマンド（run・rescore・sample）。tools/item_value.js：アイテムの価値の測定（片方だけ持たない対戦）
- docs/rules.md（確定ルールと変更履歴）・docs/summary.md（総括）・docs/handover.md（この資料）

## テスト（変更したら回す。時間はこの環境で）
| 何を確かめる | コマンド | 時間 |
| --- | --- | --- |
| 基本の動き | `node test/engine_smoke.js` | 数秒 |
| CPU の推理の誤り（確定が正しいか） | `node test/soundness.js 60` | 約2分 |
| 盤面の決まりごと・リプレイ | `node test/invariants.js 120` | 約2.5分 |
| リプレイの再現 | `node test/replay_check.js` | 約1分 |
| 大会（CPU だけ。アンサー失敗・点の合計も厳しく） | `node test/tour_sim.js 20` | 約1分 |
| 画面 | `python3 test/vis129.py`（リプレイ）・`test/vis_sim.py`（シミュレーター）・`test/tour_e2e.py`（大会を画面で通す） | 各2〜4分 |

CPU の動きを変えたら見本を作り直す：`node tools/sim.js sample --tours 200 --out src/sim-sample.json`（約6.5分）。

## ユーザーとの決まりごと
- 返事は日本語。
- 公開の手順：ビルド → dist/searchbattle.html を artifact に publish → dist/search_battle.html をリポジトリのルートの search_battle.html に上書き → searchbattle-dev/ の変更と一緒に1コミットで main に push。ルートだけ・フォルダだけの片方を更新しない（次のセッションは searchbattle-dev/ のソースから作り直すため）。
- コミットメッセージ：英語で Conventional Commits の形にする（ユーザーの希望）。1行目は `type(searchbattle): summary`（type は feat・fix・docs・refactor・test・chore。作業途中を残すときだけ WIP）。本文に要点を英語で書き、最後に Claude がコミットしたとわかる署名行（Co-Authored-By: Claude …）を付ける。ルール変更は summary に v 番号を入れる（例：`feat(searchbattle): v12.13 ...`）。
- push したら、何を変えたかと公開ページに反映されることを一言伝える。ファイルの送付・zip は不要になった（ユーザーが求めたときだけ）。
- セッションが約40万トークンを超えたら新しいチャットに移る（ユーザーの運用）。
- ルールを変えたら、docs/rules.md（変更履歴に v 番号）・docs/summary.md・プロジェクトのドキュメント・ルールブック（Docs）を更新する。ルールの形が変わったら engine.js の VERSION を上げる（途中の対戦・大会は引き継がない）。
- GitHub は main に直接 push してよい（ユーザーの了承済み。2026-10-24）。ユーザーはコードの中身は見ないので、何を変えたかは日本語で短く伝える。
- 表記：熟語にできるものは熟語にする（例：くじ→抽選）。表記ゆれはユーザーが随時報告する。
- CPU は人間と同じ情報だけで推理する。人間に見える情報を足したら CPU にも使わせ、見えすぎる情報は伏せる（v12.11 の例）。
- 長い実験のループに入らない。測定は必要な分を1回にとどめ、途中経過を報告する。点数のルールの検討は、ユーザーがシミュレーター画面で回す（トークンを使わない）。
- トークンの節約：長いコードや出力を表示しない。様子見の回数を減らす。

## 残っている課題・アイデア
- 決勝の先攻有利（CPU どうしの見本で51.5〜59.0%。測定ごとにぶれる）。
- 性格の強さの差（見本 v17：キューブ温存型38.4%・堅実型33.8%・アイテム浪費型14.2%。±5%ほどぶれる）。
- 厚い盤面の決勝では CPU の考える時間が長い（1試合約3.5秒）。
- サーチキューブは「いずれリワーク予定」。
- 人間らしい駆け引き（ブラフ・読み合い）を CPU に。
- 旧シミュレーターの artifact を消すか（ユーザーの確認待ち）。

## 最新の主な数字
- サーチラインの価値（持たない側の勝率の下がり方）：予選−10.0・決勝−13.7（v12.11 までは−5.3・−1.2）。
- 見本 v17（200回）：3試合目で決勝の2人が入れ替わる63.0%、先攻の勝率 予選55.6%・決勝59.0%、優勝者の持ち点 平均163.6。
