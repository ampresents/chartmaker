#!/usr/bin/env bash
# リポジトリのルートから実行する。コードを変えたらこれを再実行する
# 使い方: PROJECT=<プロジェクトID> bash deploy/deploy.sh
set -euo pipefail
: "${PROJECT:?PROJECT=<プロジェクトID> を指定してください}"
REGION="${REGION:-asia-northeast1}"
MAX_INSTANCES="${MAX_INSTANCES:-1}"   # 料金の上限を決める一番大事な値
PLAN_BUCKET="${PLAN_BUCKET-chartmaker-output}"  # 作戦 txt の保存先。PLAN_BUCKET= (空) で保存しない
SUPPORT_URL="${SUPPORT_URL-https://ofuse.me/643432cb}"  # 画面右上の「開発を支援」リンク先 (OFUSE)。SUPPORT_URL= (空) でリンクを出さない
# Google AdSense。未設定 (空) なら広告を出さない。枠ごとのユニット ID が空ならその枠だけ出さない
ADSENSE_CLIENT="${ADSENSE_CLIENT-}"              # ca-pub-数字
ADSENSE_SLOT_EDITOR="${ADSENSE_SLOT_EDITOR-}"    # 作戦編集画面のサイドパネル下
ADSENSE_SLOT_TRACKER="${ADSENSE_SLOT_TRACKER-}"  # 進行管理のセッション作成画面 (討伐中のボードには出さない)

gcloud run deploy chartmaker \
  --project="$PROJECT" --region="$REGION" --source=. \
  --service-account="chartmaker-run@$PROJECT.iam.gserviceaccount.com" \
  --allow-unauthenticated \
  --min-instances=0 --max-instances="$MAX_INSTANCES" \
  --concurrency=32 --cpu=1 --memory=1Gi --timeout=60 \
  --cpu-throttling \
  --set-env-vars="^@^STORE=firestore@PLAN_BUCKET=$PLAN_BUCKET@SUPPORT_URL=$SUPPORT_URL@ADSENSE_CLIENT=$ADSENSE_CLIENT@ADSENSE_SLOT_EDITOR=$ADSENSE_SLOT_EDITOR@ADSENSE_SLOT_TRACKER=$ADSENSE_SLOT_TRACKER"

# --source でビルドしたイメージは Artifact Registry に溜まり、保管料がかかる。新しい 2 つだけ残す
POLICY="$(mktemp)"
cat > "$POLICY" <<'JSON'
[
  {"name": "keep-recent", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 2}},
  {"name": "delete-old", "action": {"type": "Delete"}, "condition": {"tagState": "any", "olderThan": "86400s"}}
]
JSON
gcloud artifacts repositories set-cleanup-policies cloud-run-source-deploy \
  --project="$PROJECT" --location="$REGION" --policy="$POLICY" --no-dry-run

# --source でアップロードしたソースの zip もバケットに溜まる。ビルド後は使わないので 7 日で消す
LIFECYCLE="$(mktemp)"
cat > "$LIFECYCLE" <<'JSON'
{"rule": [{"action": {"type": "Delete"}, "condition": {"age": 7}}]}
JSON
gcloud storage buckets update "gs://run-sources-$PROJECT-$REGION" \
  --project="$PROJECT" --lifecycle-file="$LIFECYCLE"
