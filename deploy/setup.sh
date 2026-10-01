#!/usr/bin/env bash
# 初回だけ実行する。API の有効化、Firestore の作成、サービスアカウントの作成
# 使い方: PROJECT=<プロジェクトID> bash deploy/setup.sh
set -euo pipefail
: "${PROJECT:?PROJECT=<プロジェクトID> を指定してください}"
REGION="${REGION:-asia-northeast1}"

gcloud config set project "$PROJECT"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com

# 進捗管理のセッションを置く Firestore (Native モード)
if ! gcloud firestore databases describe --database='(default)' >/dev/null 2>&1; then
  gcloud firestore databases create --location="$REGION"
fi
# expire_at を過ぎたセッションを自動で消す
gcloud firestore fields ttls update expire_at --collection-group=tracker_sessions --enable-ttl --async

# Cloud Run 用。Firestore の読み書きだけ許可する
SA="chartmaker-run@$PROJECT.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create chartmaker-run --display-name="chartmaker Cloud Run"
fi
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role=roles/datastore.user --condition=None >/dev/null
echo "setup 完了"
