# ChatGPT Watchdogs

ChatGPT の画面に表示された状態を見て、明示的な失敗からの復旧を補助する Chrome 拡張です。２種類は別々の拡張です。

| 拡張 | バージョン | 用途 |
| --- | --- | --- |
| [翻訳おつかれ Watchdog](chatgpt-translation-watchdog/) | 0.3.12 | 「翻訳」プロジェクトの会話を監視し、停止時の再開や同一プロジェクトへの引き継ぎを補助 |
| [ChatGPT おつかれ Watchdog](chatgpt-error-watchdog/) | 0.1.4 | プロジェクトを限定せず、明示的なエラーからの復旧のみを補助 |

同じ会話で両方を同時に有効にしないでください。監視は初期状態では OFF です。復旧は画面の変化や ChatGPT の状態に左右されるため、実際に回答が再開したか確認してください。

## インストール

1. 必要な拡張の [翻訳版 ZIP](dist/chatgpt-translation-watchdog-0.3.12.zip) または [汎用版 ZIP](dist/chatgpt-error-watchdog-0.1.4.zip) を取得し、展開します。
2. 展開したフォルダーを開き、直下に `manifest.json` があることを確認します。
3. Chrome の `chrome://extensions` で「デベロッパー モード」を ON にし、「パッケージ化されていない拡張機能を読み込む」でそのフォルダーを選びます。

開発用ソースから直接読み込む場合は、このリポジトリの `chatgpt-translation-watchdog/` または `chatgpt-error-watchdog/` を選べます。ZIP 自体やリポジトリのルートは選ばないでください。

更新時は拡張機能カードを再読み込みしてください。ChatGPT タブは入力中の下書きを控え、応答が止まっていることを確認してから再読み込みします。

## テスト

各ソースフォルダーで `npm.cmd test` と `npm.cmd run check` を実行できます。汎用版のテスト依存は `npm.cmd ci` で導入します。これらの自動テストは実画面での復旧成功を保証しません。

各拡張の詳細・安全策はそれぞれの README を参照してください。
