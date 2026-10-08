# 運動記録Webアプリ V0.1

HTML / CSS / JavaScriptだけで動く個人用の静的Webアプリです。ビルド工程、外部ライブラリ、サーバー側のデータ保存はありません。入力内容は開いているブラウザの`localStorage`に日付別で保存します。

## ファイル

- `index.html`：入力画面とアクセシブルなフォーム要素
- `style.css`：iPhone縦画面を優先した表示、タップ領域、キーボード操作バー
- `script.js`：日付別保存、入力復元、○変換、タブ区切りコピー
- `manifest.json`：ホーム画面追加用のPWA設定
- `service-worker.js`：静的ファイルのキャッシュとオフライン起動
- `icons/`：PWA用SVGアイコンとiPhoneホーム画面用PNGアイコン
- `.nojekyll`：GitHub PagesでJekyll処理を行わず、静的ファイルをそのまま配信
- `server.js`：Node.js組み込み機能だけを使うWindows向けローカル確認サーバー

## Windowsで確認

Node.jsがインストールされている場合、PowerShellでこのフォルダへ移動して実行します。

```powershell
node server.js
```

PCのブラウザで <http://localhost:8080> を開きます。終了はサーバーを起動したPowerShellで`Ctrl+C`です。

Python 3がある場合は、代わりに次のコマンドでも確認できます。

```powershell
py -m http.server 8080 --bind 0.0.0.0
```

## iPhoneを同じWi-Fiで確認

1. Windows PCとiPhoneを同じWi-Fiに接続します。
2. Windowsで`ipconfig`を実行し、利用中のWi-Fiアダプターの`IPv4 Address`を調べます（例：`192.168.1.25`）。
3. PCで`node server.js`を実行したままにします。
4. iPhoneのSafariで`http://192.168.1.25:8080`のようにPCのIPv4アドレスを開きます。
5. Windows Defenderファイアウォールが初回通信を確認した場合は、プライベートネットワーク上でのNode.js通信を許可します。

LAN上のHTTPでも画面とlocalStorageは確認できますが、SafariのAsync Clipboard APIとService WorkerはHTTPS（またはlocalhost）を必要とする場合があります。HTTPでのLAN確認では、`execCommand("copy")`と`copy`イベントの`DataTransfer`を使ったHTML＋プレーンテキストの代替経路を試します。HTTPS公開後にはAsync Clipboard APIの経路も改めて確認してください。iPhoneホーム画面への追加・オフライン起動はHTTPS公開後に確認してください。

## GitHub PagesでHTTPS公開

公開リポジトリの内容とサイトはインターネット上で誰でも見られます。このアプリは入力データをファイルに含めませんが、個人情報や記録データをリポジトリに追加しないでください。GitHub Pagesの利用条件はアカウントのプランにより異なります。

### 1. GitHubで空のリポジトリを作る

1. GitHubへサインインし、右上の **＋ → New repository** を選びます。
2. Repository nameに、例として`exercise-record-web`と入力します。
3. **Public**を選択します（GitHub Freeで公開する場合）。
4. **Add a README file**などの初期化項目は選択せず、空のまま **Create repository** を押します。
5. 作成したリポジトリのURLを控えます。例：`https://github.com/ユーザー名/exercise-record-web`。

### 2. Windowsからファイルをpushする

Git for Windowsがインストールされていることを確認します。PowerShellを開き、次を実行してください。`ユーザー名`はGitHubのユーザー名、`リポジトリ名`は作成した名前に置き換えます。`運動記録Webアプリ`フォルダ内で実行します。

```powershell
cd "C:\_work\Python\運動記録アプリ\運動記録Webアプリ"
git init
git add .
git commit -m "Publish exercise record web app"
git branch -M main
git remote add origin https://github.com/ユーザー名/リポジトリ名.git
git push -u origin main
```

ブラウザがGitHubへのサインインを求めたら、画面の案内に従ってください。`remote origin already exists`と表示された場合は、`git remote set-url origin https://github.com/ユーザー名/リポジトリ名.git`を実行してからpushします。

### 3. Pagesを有効にする

1. GitHubのリポジトリ画面で **Settings** を開きます。
2. 左側の **Pages** を選びます。
3. **Build and deployment → Source**を **Deploy from a branch** にします。
4. Branchで **main**、フォルダで **/(root)** を選び、**Save**を押します。
5. **Actions**タブでPagesのデプロイが完了するまで待ちます。リポジトリの **Settings → Pages** にサイトURLが表示されます。
6. URLは通常、`https://ユーザー名.github.io/リポジトリ名/`です。サイトが表示されたら、Pages設定に **Enforce HTTPS** があれば有効にしてください。

この構成では`index.html`をリポジトリ直下から配信し、CSS・JavaScript・manifest・Service Worker・アイコンはすべて相対URLを使います。そのため、`/<リポジトリ名>/`というプロジェクトサイトのパス配下でも参照できます。`.nojekyll`でビルドツールを介さず静的ファイルを配信します。

### 4. iPhone Safari実機チェックリスト

公開後、iPhoneのSafariでGitHub Pagesの**HTTPS URL**を開き、一つずつ確認してください。

- URLが`https://`で始まり、ページが正常に表示される
- 日付の初期値がiPhoneの今日の日付になっている
- 出社・在宅・休日を選択・解除でき、子供と動くを独立して切り替えられる
- スタンディングを5〜20分の範囲で変更できる
- スクワット・足踏み・プランクを＋/−で増減できる
- 散歩の分・秒・距離・歩数を数値入力でき、キーボードの「次へ」で次の入力欄へ移動できる
- 歩数だけを入力した場合でも、他の散歩欄が空欄のまま保存される
- 身体データの一部だけを入力した場合、未入力欄は空欄のまま保存される
- 散歩・身体データで`0`を明示的に入力した場合と、未入力の場合が区別される
- 入力後にSafariで再読み込みし、同じ日付の値が復元される
- 別の日付に移動すると、その日付の初期値または保存済みデータが表示され、元の日付に戻すと元の記録が復元される
- **運動データコピー**をタップし、日付なしの9列をコピーできる
- **身体データコピー**をタップし、日付なしの3列をコピーできる
- Numbersで貼り付け先セルを選んでペーストし、タブ区切りで各データが次の列に入る
- Numbersへのコピーに曜日が含まれない
- Safariの共有メニューから**ホーム画面に追加**し、追加したアイコンから起動できる
- ホーム画面から起動した状態でも、入力・保存・2種類のコピーが正常に動作する
- 通信を一旦切断し、必要な静的ファイルがキャッシュ済みであればアプリ画面を開ける
- 通信を戻した後も、通常どおりアプリを利用できる

クリップボードと貼り付けはiOS／Numbersのバージョンによって挙動が異なる可能性があるため、上記の貼り付け確認を実機で行ってください。ホーム画面追加後のデータもSafariで使ったときと同じように残るか、実際の起動方法ごとに確認してください。

GitHub PagesはHTTPSで静的ファイルを配信します。入力値を送る処理はなく、データはそのSafari/Webアプリのローカルストレージに残ります。SafariのWebサイトデータ消去、ブラウザ環境の変更、端末移行では入力内容が失われることがあります。Numbersに貼り付けるデータは各コピー操作時にクリップボードへ渡します。

## V0.1自己チェック

- 初回は端末のローカル日付を入力し、今日の日付を選択します。
- 各入力変更をすぐ`localStorage`へ保存し、日付を切り替えると保存値を読み直します。
- 勤務区分の排他選択、子供と動くの独立切替、運動の刻みを実装しています。
- 散歩・身体データは空文字を空欄として保持し、明示入力の`0`は`0`としてコピーします。
- キーボード操作バーは分→秒→距離→歩数、体重→体脂肪率→基礎代謝へ移動し、各グループ末尾で閉じます。
- コピー列は「運動9列」「身体3列」で、日付・曜日を含みません。
- 2種類のコピーで、HTMLテーブルとタブ区切りテキストを一緒にクリップボードへ書き、HTMLテーブルを先に指定します。
- HTMLテーブルの出力はHTML文書内の`table`・`tbody`・`tr`・`td`構造です。コピー元のフォントや背景色などのスタイル指定は加えません。Numbers側の貼り付け結果はiPhone実機で確認してください。
- Clipboard APIが使用できない環境では`execCommand("copy")`へフォールバックし、失敗時はメッセージを表示します。
- レスポンシブCSSでスマートフォン縦画面の幅、44px以上の主要タップ領域、safe-areaを考慮しています。

Windowsの一般的なブラウザでの確認は可能です。iPhone Safari実機での表示、ホーム画面追加、iOSキーボード表示、Numbersへの貼り付けは実機がない環境では確認できていません。LAN HTTPでのService Worker登録もブラウザのセキュリティ制限で利用できない場合があります。
