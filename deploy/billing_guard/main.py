# 予算の通知 (Pub/Sub) を受け、使用額が予算を超えていたらプロジェクトの課金を無効にする。
# 課金が無効になると Cloud Run などすべてのサービスが止まる。再開するにはコンソールで課金を有効に戻す。
# 参考: https://cloud.google.com/billing/docs/how-to/disable-billing-with-notifications
import base64
import json
import os

import functions_framework
from google.cloud import billing_v1

PROJECT_ID = os.environ["PROJECT_ID"]
DRY_RUN = bool(os.environ.get("DRY_RUN"))


@functions_framework.cloud_event
def stop_billing(event):
    msg = json.loads(base64.b64decode(event.data["message"]["data"]))
    cost, budget = msg["costAmount"], msg["budgetAmount"]
    print(f"cost={cost} budget={budget} currency={msg.get('currencyCode')}")
    if cost <= budget:
        return
    if DRY_RUN:
        print("DRY_RUN のため課金は無効にしません")
        return

    client = billing_v1.CloudBillingClient()
    name = f"projects/{PROJECT_ID}"
    if not client.get_project_billing_info(name=name).billing_enabled:
        print("課金は既に無効です")
        return
    client.update_project_billing_info(
        name=name, project_billing_info=billing_v1.ProjectBillingInfo(billing_account_name=""))
    print("予算を超えたため課金を無効にしました")
