# 🏕️ ORIGINAL BOARD GAME ARCHIVE — 開発引き継ぎドキュメント一式 (Handover Package)

このフォルダには、これまでのチャットで設計・実装・検証した**全ゲームのルール、実装仕様、数理バランス・シミュレーション結果、localStorage構造、および次フェーズ（マルチプレイ実装等）のロードマップ**がすべて格納されています。
GitHubリポジトリにソースコードと一緒にコミットし、次のチャットで共有することで、コンテキストを100%維持したままスムーズに開発を継続できます。

## 📁 収録ドキュメント一覧

| ファイル名 | 内容 |
| :--- | :--- |
| `README.md` | 本ファイル。リポジトリ構成一覧・次チャット用プロンプトテンプレート・localStorageキー仕様 |
| `01_IMAGINE_TILE_SPEC.md` | **第2作『IMAGINE TILE（イマジンタイル）』** 完全実装仕様書（1機シングル/5機チーム・新エネルギールール・コア経済・3ワールド妨害・Unsplash API連携） |
| `02_IMAGINE_TILE_SIMULATION_AND_MULTIPLAYER_ROADMAP.md` | **『IMAGINE TILE』** 1〜5人エネルギー＆回答コスト数理表・5機別モンテカルロシミュレーション結果・**次フェーズ「1〜5人マルチプレイ」実装設計書** |
| `03_SHIFT_AND_SHAFT_SPEC_AND_SIM.md` | **第1作『シフト＆シャフト (Shift & Shaft)』** 公式ルール・重み付けAI評価関数・1,000戦シミュレーション結果 |
| `04_SEARCH_BATTLE_AND_COLOR_TERRITORY_SPEC.md` | **第3作『サーチバトル』＆第4作『色彩陣取り』** ルール・アイテム仕様・AI推論エンジン仕様 |
| `05_LAUNCHER_ARCHITECTURE.md` | **全6作総合ランチャー (`index.html`)** モンハン風3D循環カルーセル構造＆スロット拡張ガイド |

## 🗂️ リポジトリ内メインファイル構成

| ファイル名 | 役割・ステータス |
| :--- | :--- |
| `index.html` (`original_board_game_archive_6.html`) | 全6作総合ランチャー（モンハン風アイテムポーチ3D循環カルーセル・iframe起動＆別タブ起動対応） |
| `shift_and_shaft_game.html` | **Slot 01**：『シフト＆シャフト』デジタル対戦＆戦術シミュレーター v2.0（完成・収録済） |
| `shift_and_shaft_rulebook.pdf` | **Slot 01**：『シフト＆シャフト』公式ルールブック PDF（全2ページ・収録済） |
| `imagine_tile.html` (`game_02.html`) | **Slot 02**：『IMAGINE TILE（イマジンタイル）』1機シングル＆5機チーム対応・3ワールド妨害・Unsplash 102問クレジット完全埋め込み版（完成・収録済） |
| `サーチバトル.html` | **Slot 03**：『サーチバトル (Search Battle)』位置あて推理バトル（完成・収録済） |
| `色彩陣取り.html` | **Slot 04**：『色彩陣取り (Color Territory)』混色・明暗合成＆戦術アイテム陣取りパズル（完成・収録済） |
| `game_05.html` / `game_06.html` | **Slot 05 / 06**：第5作・第6作用拡張スロット（ランチャー側で枠確保済） |

## 💾 ブラウザ保存 (`localStorage`) キー一覧

| キー名 | 対象ファイル | 保存データ内容 |
| :--- | :--- | :--- |
| `imagine_tile_settings_v2` | `imagine_tile.html` | 設定値（`initEnergy:50`, `clearEnergy:25`, `bonusEnergy:15`, `initCore:0`, `stageHazard:true`, `coreSystem:true`）、選択ワールド（`world`）、編成スタイル（`playStyle`: `'team'`/`'solo'`）、ソロ選択機体（`soloUnit`: `0..4`） |
| `imagine_tile_custom_v2` | `imagine_tile.html` | CUSTOMモードのステージ構成配列（問題数・盤面サイズ・ギミック指定）および `scaleEnergy` フラグ |
| `imagine_tile_questions_v1` | `imagine_tile.html` | 問題エディタで編集・追加された問題リスト（`QS`） |
| `imagine_tile_unsplash_key_v1` | `imagine_tile.html` | エディタ用 Unsplash Access Key（一般公開時は空欄でOK） |
| `imagine_tile_unsplash_credits_v2` | `imagine_tile.html` | 画像スラッグ（`photo-xxx`）完全一致検証済みの撮影者クレジットキャッシュ |
| `imagine_tile_unsplash_dl_v1` | `imagine_tile.html` | Unsplash API Download Trigger 送信済み履歴 |
| `boardgame_archive_catalog_v4` | `index.html` | 総合ランチャーの6スロット情報カスタマイズデータ |

## 💬 次のチャット開始時の共有テンプレート

次のチャットを始める際は、ソースコード（`imagine_tile.html` 等）と本フォルダ（または `HANDOVER_MASTER.md`）を添付し、以下のように話しかけるとスムーズです：

> 『IMAGINE TILE』およびボードゲームアーカイブの引き継ぎです。
> 添付の引き継ぎドキュメントと `imagine_tile.html` を読み込み、現在の仕様（1機シングル＆5機チーム、新エネルギールール：初期50pt/クリア25pt/エンドレス7×5÷人数、回答コスト `ceil(sz/人数)` 固定、突破ボーナス15pt or 💎5選択式）を把握したうえで、次フェーズの【マルチプレイ実装 / 新機能追加】を進めてください。
