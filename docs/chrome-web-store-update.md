# 翻訳WatchdogをChrome画面から更新するには

現行の `C:\Users\piano\.gemini\antigravity\codex\translator\chatgpt-translation-watchdog` は、パッケージ化されていない拡張機能として読み込んだローカルフォルダーです。`chrome://extensions` のカードにある「再読み込み」は、このフォルダー内の現時点のファイルを読み直します。画面上部の「更新」はChrome Web Storeで公開された新しい配布版を取得します。GitHubのZIPや作業フォルダーを取得する機能ではありません。

## 将来の更新をChromeだけで行う手順

1. `dist/chatgpt-translation-watchdog-webstore-0.3.15.zip` をChrome Web Store Developer Dashboardにアップロードし、「非公開リンク（Unlisted）」または必要な配布範囲で審査・公開します。このストア用ZIPは直下に`manifest.json`と拡張アイコンがあります。初回は開発者アカウント、掲載情報、実際の拡張画面のスクリーンショット等が必要です。
2. 公開されたWeb StoreのURLから**一度だけ**配布版をインストールします。ローカル版と配布版は別の拡張として並ぶことがあるため、同じ翻訳スレを二重監視しないよう、ローカル版をOFFにしてから配布版で監視をONにします。設定・監視状態は拡張ごとのローカルストレージにあるため、配布版で設定を確認してください。
3. 次回以降は、新版のZIPを**同じWeb Storeアイテム**に提出・公開するとChromeが更新します。すぐ確認したい場合は `chrome://extensions` でデベロッパーモードをONにし、上部の「更新」を押します。content scriptが新しくなるよう翻訳タブを再読み込みします。

ストア登録が済むまでは、ZIPを同じフォルダーに展開してカードの「再読み込み」→翻訳タブの再読み込みが必要です。Chrome拡張の設定を変更するだけでローカル版にGitHubから更新をダウンロードさせる方法はありません。

参考: [Chromeの更新ライフサイクル](https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle)、[拡張の再読み込み](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)、[Web Storeの非公開リンク配布](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)。
