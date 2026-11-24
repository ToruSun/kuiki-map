# kuiki-map（区域マップ）

区域マップの画面（GitHub Pages）と、サーバー（Google Apps Script）のプログラムです。
区域・家・名前・記録などのデータは、ここには入りません（データは会衆の Google スプレッドシートだけにあります）。

## 中身

| 場所 | 中身 | 反映のしかた |
|---|---|---|
| いちばん上（`index.html`・`*.js`・`vendor/`） | 画面 | main にまぜると GitHub Pages が自動で公開（1〜2分） |
| `config.js` | 会衆ごとの設定（サーバーの URL・会館の場所・会衆の範囲・市町村など。いくつかの市町村や県にまたがってもよい） | 同上 |
| `gas/` | サーバー（Apps Script）の15ファイルと `appsscript.json` | main にまぜると Actions「サーバーを入れる」が clasp で自動で入れる |
| `chiban/`・`tools/chiban-*` | 地番の地図（土地の区切り）の表と、それを作る道具 | Actions「地番の地図」→ `chiban-update` → 確かめて main へ |
| `gas/sankouzu*.gs`・`tools/sankouzu-build.py` | 市町村の地番参考図（SHP）で、法務省の線が無い所をおぎなう道具（データは公開しない） | スプレッドシートのメニュー「地番参考図から土地の区切りを作る」 |
| `gas/gaibu.gs`・`gaibu.js` | 外の一覧の取り込みの口：会衆がほかで使っている一覧（アパートなどの訪問の記録）を、移行のあいだ何度でも入れる。一覧を読んで送るプログラムは会衆ごとに用意し、ここには置かない（区域係の画面で作る「取り込みの鍵」で送る） | 画面・サーバーと同じ |
| `tools/kami-yobi.mjs` | 紙の予備（S-12・S-13）を作るロボット | Actions「紙の予備」（はじめは止めてある） |

## サーバーの自動デプロイ（clasp）

`gas/` を書きかえて main にまぜると、`.github/workflows/gas-deploy.yml` が次を行います。

1. `clasp push --force`：`gas/` の全部のファイルで Apps Script のプロジェクトを置きかえる（エディタで直接書いた変更は消えます。直すときは `gas/` で）
2. `clasp deploy -i <今のウェブアプリの番号>`：今のウェブアプリを新しい版にする。番号は `config.js` の `apiUrl` から取るので、URL は変わりません

はじめに1回だけ、本人が用意します（無いあいだは、Actions は何もせずに終わります）。

1. https://script.google.com/home/usersettings で「Google Apps Script API」をオンにする（スプレッドシートの持ち主のアカウントで）
2. Apps Script の「プロジェクトの設定」→「スクリプト ID」を、GitHub の Settings →「Secrets and variables」→「Actions」→「Variables」に `GAS_SCRIPT_ID` として入れる
3. 同じアカウントで `clasp login` を行い、できた `~/.clasprc.json` の中身を、「Secrets」に `CLASPRC_JSON` として入れる（Google の鍵です。チャット・issue・ファイルには貼らない）
4. 「Actions」→「サーバーを入れる」→「Run workflow」で、緑になるか確かめる

鍵は月に1回くらい見直し、もう使わないときは https://myaccount.google.com/permissions で clasp の許可を外します。

## 画面を直したとき（必ず）

版の番号を3か所そろえて上げます。そろっていないと、スマホが新しい版に切りかわりません。

- `index.html` の `<meta name="app-version" content="2026.13.NNN">`
- `app.js` の `APP_JS_VER = '2026.13.NNN'`（と、ふつうは `CHANGELOG` の先頭に1件）
- `sw.js` の `APP_CACHE = 'kuiki-app-vNNN'`

`.js` のファイルを足したときは、`index.html` の `<script>` と、`sw.js` の `APP_NAMES` にも足します。

## 守ること

- このリポジトリは公開（Public）です。招待コード（`?t=`・`?j=` の後ろ）・Google の鍵・人の名前や家の情報を、ファイルにも issue にも書かない
- スプレッドシートとバックアップのフォルダは共有しない
- 地番の地図は、住所の場所を調べるためだけに使う（所有者を調べる目的には使わない）。出典（CC BY）の表示を消さない
- 市町村の地番参考図は、その市町村の利用規約を読み、必要なら了解を取ってから使う。データは公開ページ・GitHub に置かない（持ち主のドライブだけ）。地番は入れない

出典：国土地理院（地理院タイル・基盤地図情報）、登記所備付地図データ（法務省／AIGID・CC BY 4.0）、© OpenStreetMap contributors（ODbL）、市町村の固定資産（土地）地番参考図（使う会衆だけ）
