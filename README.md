# chartmaker

レイドのタイムチャート（1 列 = 1 プレイヤー、1 px = 1 秒、60 分）を PNG で作るツールです。
ブラウザで作戦を編集するエディタと、本番中に討伐状況を複数端末で共有する進捗管理画面（`/tracker`）があります。

- 公開先: https://chartmaker.jp （Google Cloud Run、サービス名 `chartmaker`、リージョン `asia-northeast1`）
- 開発者向けの詳しい仕様は [CLAUDE.md](CLAUDE.md) を参照

---

## 1. ローカルで動かす

### 初回

```sh
py -3.11 -m venv .venv
.venv/Scripts/pip install -r requirements.txt
```

### 起動

```sh
.venv/Scripts/python app.py
```

ブラウザで http://127.0.0.1:5000 を開きます（ポートは環境変数 `PORT` で変更可）。
ローカルでは進捗管理のセッションはメモリに置くため、サーバーを止めると消えます。

### ノートブックで PNG を作る

`time_chart.ipynb` のセルを実行します。`src/<名前>.txt` を読み、`output/<名前>.png` に書き出します。
`src/` と `output/` は Git 管理外なので、無ければ作成してください。

---

## 2. コマンドを打つ環境（Windows）

`deploy/*.sh` は bash のスクリプトです。**コマンドプロンプト（cmd）や PowerShell ではなく Git Bash** で実行します。
cmd で `export` を打つと「'export' は、内部コマンドまたは外部コマンド…として認識されていません」となります。

Git Bash を開いたら、毎回次を実行します（ウィンドウを開き直したらやり直し）。

```sh
cd /e/chartmaker
export PROJECT=<プロジェクトID>
# gcloud が Python を見つけられずに失敗するのを防ぐ
export CLOUDSDK_PYTHON="$(cygpath -w "$PWD/.venv/Scripts/python.exe")"
# gcloud に PATH が通っていない場合
export PATH="$PATH:/c/Users/akinori/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin"
```

<details>
<summary>cmd のまま実行する場合</summary>

```bat
cd /d E:\chartmaker
set PROJECT=<プロジェクトID>
set CLOUDSDK_PYTHON=E:\chartmaker\.venv\Scripts\python.exe
set PATH=%PATH%;C:\Users\akinori\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin
"C:\Program Files\Git\bin\bash.exe" deploy/deploy.sh
```

`bash` とだけ打つと WSL の `C:\Windows\System32\bash.exe` が起動することがあるため、Git の bash をフルパスで指定します。
</details>

---

## 3. Google Cloud への初回セットアップ（1 回だけ）

### 3-1. 準備

1. Google Cloud コンソールでプロジェクトを作り、請求先アカウントを紐づける
2. gcloud にログインする

   ```sh
   gcloud auth login
   ```

### 3-2. `deploy/setup.sh` — API・Firestore・サービスアカウント

```sh
bash deploy/setup.sh
```

- Cloud Run / Cloud Build / Artifact Registry / Firestore の API を有効化
- Firestore（Native モード、`asia-northeast1`）を作成。進捗管理のセッションを保存する
- `tracker_sessions` の `expire_at` に TTL を設定（24 時間を過ぎたセッションを自動削除）
- Cloud Run 用サービスアカウント `chartmaker-run` を作成（権限は Firestore の読み書きのみ）
- 作戦 txt の保存先バケット（既定 `chartmaker-output`、`PLAN_BUCKET=<名前>` で変更可）が無ければ作成し、`chartmaker-run` に一覧と作成だけを許可（上書き・削除はできない）

「setup 完了」と出れば成功です。

### 3-3. `deploy/budget.sh` — 予算と課金の自動停止

まずは動作確認のため `DRY_RUN=1`（ログを出すだけで課金は止めない）で作ります。

```sh
DRY_RUN=1 BUDGET=1000JPY bash deploy/budget.sh
```

- 予算 `chartmaker`（既定 1000 円）を作成。50% / 90% / 100% で通知
- 通知は Pub/Sub トピック `billing-alerts` に届き、Cloud Functions の `stop-billing` が受け取る
- 使用額が予算を超えていたら、`stop-billing` が **プロジェクトの課金を無効にし、Cloud Run を含むすべてのサービスが止まる**
- `BUDGET` の通貨は請求先アカウントの通貨に合わせる（日本円なら `JPY`）
- 予算が既にある場合は作り直さない。金額を変えるときはコンソールで編集する

通知が届くこと（後述のログ確認）を確かめたら、`DRY_RUN` を外して再実行し、本番の設定にします。

```sh
BUDGET=1000JPY bash deploy/budget.sh
```

> 予算の通知は数時間遅れて届くことがあるため、予算を少し超えることはあります。
> 料金の上限を実際に決めているのは、次の `deploy.sh` の `--max-instances` です。

---

## 4. デプロイ（コードを変えるたびに）

```sh
git pull                 # 最新のコードにする
bash deploy/deploy.sh
```

`gcloud run deploy --source .` で、Cloud Build が `Dockerfile` からイメージを作り、Cloud Run に公開します。
数分かかり、最後に表示される `Service URL` が公開 URL です。

| 設定 | 値 | 意味 |
|---|---|---|
| `--max-instances` | 1（`MAX_INSTANCES=2 bash deploy/deploy.sh` のように変更可） | 同時に動く台数の上限。**料金の上限を決める一番大事な値** |
| `--min-instances` | 0 | アクセスが無いときは 0 台になり課金されない。そのぶん最初のアクセスは数秒遅い |
| `--concurrency` | 32 | 1 台が同時に受けるリクエスト数 |
| CPU / メモリ | 1 / 1GiB | 画像生成 1 回で数百 MB 使う |
| `STORE` | `firestore` | 進捗管理のセッションを Firestore に保存（再起動・複数台でも共有） |
| `PLAN_BUCKET` | `chartmaker-output` | 画像生成した作戦 txt の保存先（第 5 章）。`PLAN_BUCKET= bash deploy/deploy.sh` で保存しない |

- ビルドしたイメージ（Artifact Registry）は新しい 2 つだけ残し、アップロードしたソースの zip（バケット `run-sources-<プロジェクトID>-asia-northeast1`）は 7 日で自動削除する設定も同時に入れています。どちらも保管料を無料枠に収めるため
- アップロードしないファイルは `.dockerignore` で指定しています（`.gcloudignore` はそれを読み込むだけ）。`src/` `output/` `deploy/` `.venv/` などは送られません

### デプロイ後の確認

1. 公開 URL を開き、エディタが表示されること
2. 「画像生成」で PNG が出ること
3. 「進捗管理」でセッションを作り、別の端末で同じ URL を開いて、討伐ボタンが 1 秒ほどで同期すること

### 独自ドメイン（chartmaker.jp）

ドメインはお名前.com で取得し、Cloud Run のドメインマッピングで割り当てています（Google Cloud 側の料金は無料、HTTPS 証明書は自動で発行・更新）。
割り当ては再デプロイしても消えないので、`deploy.sh` の変更は不要です。`run.app` の URL も引き続き使えます。

設定済みのため、通常は何もしなくてよいです。作り直すときの手順は次のとおりです。

1. **ドメインの所有を証明する**: `gcloud domains verify chartmaker.jp` で開く Search Console の TXT レコードを DNS に追加し、「確認」を押す
2. **Cloud Run に割り当てる**

   ```sh
   gcloud beta run domain-mappings create      --service=chartmaker --domain=chartmaker.jp      --region=asia-northeast1 --project="$PROJECT"
   ```

3. **表示された A / AAAA レコードを DNS に追加する**
4. **証明書の発行を待つ**（DNS の反映後、15 分〜24 時間）。次のコマンドで `CertificateProvisioned` が `True` になれば完了

   ```sh
   gcloud beta run domain-mappings describe      --domain=chartmaker.jp --region=asia-northeast1 --project="$PROJECT"
   ```

#### お名前.com の設定

Navi →「ドメイン」→「DNS設定/転送設定」→ `chartmaker.jp` →「DNSレコード設定を利用する」で、次のレコードを入れています（ホスト名はすべて空欄）。

| TYPE | VALUE |
|---|---|
| A | 216.239.32.21 / 216.239.34.21 / 216.239.36.21 / 216.239.38.21（4 行） |
| AAAA | 2001:4860:4802:32::15 / 2001:4860:4802:34::15 / 2001:4860:4802:36::15 / 2001:4860:4802:38::15（4 行） |
| TXT | `google-site-verification=...`（所有権の確認用。**消さない**） |

- ネームサーバーは `01.dnsv.jp`〜`04.dnsv.jp`（お名前.com の DNS）。お名前.com のレンタルサーバーを契約していると DNS レコード設定が使えず、ネームサーバーが `ns-rs*.gmoserver.jp` のままになる
- ドメインの期限が切れるとサイトに繋がらなくなるので、お名前.com の自動更新を有効にしておく
- 反映の確認: `nslookup -type=A chartmaker.jp 8.8.8.8`

---

## 5. アプリ側の負荷・料金対策

コンテナ内では gunicorn が 1 プロセス × 16 スレッドで動き、次の制限はそのプロセス内で共有されます（`app.py` の `LIMIT_*`）。

| 対象 | 上限（IP ごと） |
|---|---|
| 編集（`/api/parse`, `/api/detail`） | 300 回 / 分 |
| 画像生成（`/api/render`） | 20 回 / 分 |
| 進捗管理のセッション作成 | 20 回 / 時 |
| 討伐・取り消し | 120 回 / 分 |

- 超えると 429「リクエストが多すぎます」
- 画像生成は同時に 2 つまで。20 秒待っても空かなければ 503「混み合っています」
- 進捗管理の画面は毎秒サーバーに問い合わせるが、Firestore の読み取りは 1 台・1 セッションあたり毎秒 1 回にまとめている

### 作戦 txt の保存

画像生成に成功するたびに、その作戦の txt を `gs://<PLAN_BUCKET>/plans/` に保存します。

```
plans/20261001_003_47040000_44940000.txt
      日付      連番  Max スコア  Est スコア
```

- 日付は日本時間。連番は日ごとに 001 から振り、既存のファイルは上書きしない
- スコアは画像下部の `Max`（全戦闘 100% の合計）と `Est`（スコア率を掛けた見積もり）
- 同じ作戦でも画像生成するたびに別ファイルとして保存される
- 保存に失敗しても画像生成は失敗にならない（ログに「作戦の保存に失敗しました」と出る）
- ローカル（`PLAN_BUCKET` 未設定）では保存しない

---

## 6. 運用でよく使うコマンド

```sh
# 公開 URL を確認
gcloud run services describe chartmaker --project="$PROJECT" --region=asia-northeast1 --format='value(status.url)'

# Cloud Run のログ（直近 50 件）
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="chartmaker"' \
  --project="$PROJECT" --limit=50 --freshness=1d

# 課金停止関数のログ（予算通知が届いているかの確認）
gcloud functions logs read stop-billing --project="$PROJECT" --region=asia-northeast1 --gen2

# 保存した作戦 txt の一覧と、手元へのコピー
gcloud storage ls gs://chartmaker-output/plans/
gcloud storage cp -r gs://chartmaker-output/plans ./plans

# リビジョン一覧と、1 つ前のリビジョンへの切り戻し
gcloud run revisions list --service=chartmaker --project="$PROJECT" --region=asia-northeast1
gcloud run services update-traffic chartmaker --project="$PROJECT" --region=asia-northeast1 --to-revisions=<リビジョン名>=100
# 切り戻しをやめて最新に戻す
gcloud run services update-traffic chartmaker --project="$PROJECT" --region=asia-northeast1 --to-latest
```

イメージは新しい 2 つしか残さないため、切り戻せるのは 1 つ前のリビジョンまでです。

---

## 7. 困ったとき

| 症状 | 原因と対処 |
|---|---|
| `'export' は、内部コマンドまたは外部コマンド…` | cmd で実行している。Git Bash で実行する（[2 章](#2-コマンドを打つ環境windows)） |
| gcloud が `Python` とだけ出して失敗する | `CLOUDSDK_PYTHON` が未設定。[2 章](#2-コマンドを打つ環境windows)の `export` を実行する |
| `gcloud: command not found` | gcloud に PATH が通っていない。[2 章](#2-コマンドを打つ環境windows)の `PATH` を設定する |
| `chartmaker.jp` だけ開かない（`run.app` は開く） | ドメインの期限切れか DNS の変更。お名前.com の更新状況と DNS レコード（第 4 章）を確認する |
| サイトが開かなくなった | 予算超過で課金が止まった可能性。コンソールの「お支払い」でプロジェクトに請求先アカウントを紐づけ直すと再開する（必要なら予算額も見直す） |
| 進捗管理で「セッションが見つかりません」 | 作成から 24 時間を過ぎたセッションは自動で消える。作り直す |
| 429 / 503 が出る | 第 5 章の回数制限・同時実行数の上限。少し待つ |
