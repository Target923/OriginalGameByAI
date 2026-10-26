# 🏛️ 05. 全6作総合ランチャー (`index.html`) アーキテクチャ＆拡張ガイド

## 1. モンハン風アイテムポーチ 3D循環カルーセル (`mh-carousel-viewport`)
- **永続DOM方式による滑らかな3Dアニメーション**：
  - カード移動時に `innerHTML` を再生成するとCSSトランジションが破綻するため、初回ロード時（`buildSlotElements()`）に6枚のカード要素（`#slotCard_0` 〜 `#slotCard_5`）を1度だけ生成します。
  - 左右回転時は各カードの `data-offset` 属性（`-3, -2, -1, 0, +1, +2, +3`）のみを書き換え、裏側を回るカードは `.no-transition` で反対側の待機位置（`±3`）へ瞬時にプリステージしてから強制リフロー（`void el.offsetWidth`）後に `±2` へ滑り込ませることで、どの方向へ何度回しても途切れない3D回転を実現しています。
- **マルチ入力＆Web Audio効果音**：
  - L/Rボタンクリック、キーボード（`◀`/`▶`/`A`/`D`/`Enter`/`Esc`）、マウスホイール回転、タッチ＆マウス左右ドラッグスワイプに完全対応。
  - Web Audio APIによる操作クリック音・ゲーム起動ファンファーレ（ON/OFF切替可）を搭載。

## 2. 現在のスロット登録状況 (`DEFAULT_GAMES`)

| スロット | アイコン | ゲームタイトル | 参照HTMLファイル | 参照ルールブックPDF | 状態 |
| :---: | :---: | :--- | :--- | :--- | :---: |
| **ITEM 01** | ♠ | シフト＆シャフト (Shift & Shaft) | `shift_and_shaft_game.html` | `shift_and_shaft_rulebook.pdf` | `ready` |
| **ITEM 02** | 🛸 | イマジンタイル (Imagine Tile) | `imagine_tile.html` | `imagine_tile_rulebook.pdf` | `ready` |
| **ITEM 03** | 🎯 | サーチバトル (Search Battle) | `サーチバトル.html` | `search_battle_rulebook.pdf` | `ready` |
| **ITEM 04** | 🎨 | 色彩陣取り (Color Territory) | `色彩陣取り.html` | `color_territory_rulebook.pdf` | `ready` |
| **ITEM 05** | ★ | 第5作：オリジナルゲーム（Slot 05） | `game_05.html` | `game_05_rulebook.pdf` | `pending` |
| **ITEM 06** | 👑 | 第6作：オリジナルゲーム（Slot 06） | `game_06.html` | `game_06_rulebook.pdf` | `pending` |

- 新しいゲーム（第5作・第6作）を追加する際は、同じフォルダにHTMLファイルを配置し、ランチャー下部の「⚙️ スロット名・ファイル名を編集」モーダル（または `DEFAULT_GAMES` 配列）でファイル名とステータス（`ready`）を設定するだけで即座にランチャー内起動・別タブ起動が可能になります。
