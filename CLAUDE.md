# CLAUDE.md — kuiki-map を直す Claude への指示

区域マップ（藤沢市北の会衆）の画面とサーバーのリポジトリです。依頼者は会衆の区域係で、プログラムの専門家ではありません。説明は短い日本語で。全体は `README.md`。

## しくみ
- 画面：リポジトリのいちばん上（GitHub Pages・main の `/`）。設定は `config.js` だけで会衆ごとに変わる
- サーバー：`gas/`（Apps Script・V8）。main への push で Actions「サーバーを入れる」が `clasp push` と `clasp deploy -i`（同じ URL）を行う
- データ：Google スプレッドシート（このリポジトリには入らない）

## 直すときの決まり
1. 画面の `.js`・`.html` を変えたら、版を3か所そろえて上げる：`index.html` の `app-version`・`app.js` の `APP_JS_VER`（と `CHANGELOG` に1件）・`sw.js` の `APP_CACHE`。ファイルを足したら `index.html` の `<script>` と `sw.js` の `APP_NAMES` にも
2. 変えたら `node --check` で全部の `.js` と、`gas/` をつないだものを確かめる。`gas/` の15ファイルで、同じ名前の関数・定数がぶつからないように
3. `gas/` は Apps Script のプロジェクトを丸ごと置きかえる。Code.gs の定数をほかのファイルが使うので、Code.gs がいちばん先（ワークフローの `filePushOrder`）
4. 画面とサーバーの両方にかかる変更（受け付けの action・データの形）は、古い画面・古いサーバーのどちらとも動くようにする（スマホの更新は少し遅れる）

## 守ること（必ず）
- 公開リポジトリ。招待コード（`?t=`・`?j=`）・`.clasprc.json`・人の名前・家・記録を、ファイル・commit・issue・PR に書かない。Secret（`CLASPRC_JSON`・`KUIKI_ROBOT_TOKEN`）は本人が GitHub の画面で入れる
- スプレッドシートの中身（名前・訪問の記録・拒否の家）は読まない・書き出さない
- Google の承認・ウェブアプリの新しいデプロイ・パスワードは本人が押す
- main への force push、リポジトリやシートの削除はしない
- 地番の地図（`chiban/`）は住所の場所を調べるためだけ。出典（CC BY）を消さない

## 毎年の入れかえ：藤沢市の地番参考図（4月ごろ）
法務省の線が無い所（長後など）は、市の「固定資産（土地）地番参考図」（SHP）でおぎなう。藤沢市の了解あり（電話・2026-11-16：区域マップに線を重ね、会衆の人だけが見る）。**データは公開ページ・GitHub に置かない**
- Claude なしで、スプレッドシートのメニューだけでできる（gas/sankouzu-build.gs）
  1. 本人：市のホームページ（https://www.city.fujisawa.kanagawa.jp/sisanzei/kurashi/zekin/koteshisan/chibanzu.html ）で規約に同意して zip をダウンロードし、パソコンで展開する
  2. 本人：中の「固定資産土地.shp」「固定資産土地.dbf」の2つだけを、ドライブの「区域マップ_地番参考図」に入れる（zip のままは大きすぎて読めない）
  3. 本人：メニュー「地番参考図から土地の区切りを作る」→ 時点（例 2027-01）→ 5分ごとに自動で続く。「地番参考図の作成の進み具合」で確かめる
  4. できた `kuiki-sankouzu.json.gz` をサーバー（sankouzu.gs）が次の問い合わせで字ごとに分けて使う。地番は入れない。出典は凡例に出る
- 同じことを手元でするときは `python3 tools/sankouzu-build.py <zip> kuiki-sankouzu.json.gz`（結果は Apps Script 版と同じになることを確かめてある）
