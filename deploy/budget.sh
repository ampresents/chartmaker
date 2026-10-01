#!/usr/bin/env bash
# 予算アラートと、予算を超えたら課金を無効にする Cloud Functions を作る
# 使い方: PROJECT=<プロジェクトID> BUDGET=1000JPY bash deploy/budget.sh
#   BUDGET の通貨は請求先アカウントの通貨に合わせる (日本円なら JPY)
set -euo pipefail
: "${PROJECT:?PROJECT=<プロジェクトID> を指定してください}"
REGION="${REGION:-asia-northeast1}"
BUDGET="${BUDGET:-1000JPY}"
TOPIC=billing-alerts
SA="billing-guard@$PROJECT.iam.gserviceaccount.com"
HERE="$(cd "$(dirname "$0")" && pwd)"

gcloud services enable \
  cloudbilling.googleapis.com billingbudgets.googleapis.com pubsub.googleapis.com \
  cloudfunctions.googleapis.com eventarc.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  --project="$PROJECT"

gcloud pubsub topics describe "$TOPIC" --project="$PROJECT" >/dev/null 2>&1 \
  || gcloud pubsub topics create "$TOPIC" --project="$PROJECT"

# 課金を外す権限 (Project Billing Manager) と、Pub/Sub から関数を呼ぶ権限だけを持つアカウント
if ! gcloud iam service-accounts describe "$SA" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create billing-guard --project="$PROJECT" --display-name="課金の自動停止"
fi
for role in roles/billing.projectManager roles/run.invoker; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$SA" --role="$role" --condition=None >/dev/null
done

gcloud functions deploy stop-billing \
  --project="$PROJECT" --region="$REGION" --gen2 --runtime=python311 \
  --source="$HERE/billing_guard" --entry-point=stop_billing \
  --trigger-topic="$TOPIC" \
  --service-account="$SA" --trigger-service-account="$SA" \
  --max-instances=1 \
  --set-env-vars="PROJECT_ID=$PROJECT${DRY_RUN:+,DRY_RUN=1}"

ACCOUNT="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)')"
ACCOUNT="${ACCOUNT#billingAccounts/}"
if gcloud billing budgets list --billing-account="$ACCOUNT" --format='value(displayName)' | grep -qx chartmaker; then
  echo "予算 chartmaker は既にあります。金額を変えるときはコンソールで編集してください"
else
  gcloud billing budgets create --billing-account="$ACCOUNT" \
    --display-name=chartmaker --budget-amount="$BUDGET" \
    --filter-projects="projects/$PROJECT" \
    --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \
    --notifications-rule-pubsub-topic="projects/$PROJECT/topics/$TOPIC"
fi
echo "budget 完了"
