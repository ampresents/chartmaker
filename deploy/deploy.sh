#!/usr/bin/env bash
# リポジトリのルートから実行する。コードを変えたらこれを再実行する
# 使い方: PROJECT=<プロジェクトID> bash deploy/deploy.sh
set -euo pipefail
: "${PROJECT:?PROJECT=<プロジェクトID> を指定してください}"
REGION="${REGION:-asia-northeast1}"
MAX_INSTANCES="${MAX_INSTANCES:-1}"   # 料金の上限を決める一番大事な値

gcloud run deploy chartmaker \
  --project="$PROJECT" --region="$REGION" --source=. \
  --service-account="chartmaker-run@$PROJECT.iam.gserviceaccount.com" \
  --allow-unauthenticated \
  --min-instances=0 --max-instances="$MAX_INSTANCES" \
  --concurrency=32 --cpu=1 --memory=1Gi --timeout=60 \
  --cpu-throttling \
  --set-env-vars=STORE=firestore

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
