# 進行管理セッションの一覧 (管理者用、ローカルで実行する)
# アプリには一覧 API を置かない (URL の ID が唯一のアクセス制御のため)。Firestore を直接読む。
# 事前に: gcloud auth application-default login
# 使い方: PROJECT=<プロジェクトID> .venv/Scripts/python deploy/list_sessions.py [--all] [--url=https://...]
#   --all  期限切れでまだ TTL 削除されていないものも表示する
#   --url  サービスの URL。指定すると各セッションの進行管理画面の URL を出す
import datetime
import os
import sys

from google.cloud import firestore

JST = datetime.timezone(datetime.timedelta(hours=9))


def main():
    project = os.environ.get("PROJECT")
    if not project:
        sys.exit("PROJECT=<プロジェクトID> を指定してください")
    show_all = "--all" in sys.argv[1:]
    base = next((a[len("--url="):].rstrip("/") for a in sys.argv[1:] if a.startswith("--url=")), "")

    now = datetime.datetime.now(datetime.timezone.utc)
    col = firestore.Client(project=project).collection("tracker_sessions")
    query = col if show_all else col.where(filter=firestore.FieldFilter("expire_at", ">", now))
    docs = sorted(query.stream(), key=lambda s: s.get("created"))

    for s in docs:
        d = s.to_dict()
        plan, events = d["plan"], d["events"]
        floor = 1 + sum(1 for e in events if e["boss"] == "Realm_boss")
        start = datetime.datetime.fromtimestamp(plan["start_epoch_ms"] / 1000, JST)
        created = datetime.datetime.fromtimestamp(d["created"], JST)
        expire = d["expire_at"].astimezone(JST)
        state = "期限切れ" if d["expire_at"] <= now else f"残り {(d['expire_at'] - now).total_seconds() / 3600:.1f}h"
        print(f"{base}/tracker/{s.id}" if base else s.id)
        print(f"  作成 {created:%m/%d %H:%M}  失効 {expire:%m/%d %H:%M} ({state})"
              f"  開始 {start:%m/%d %H:%M}  討伐 {len(events)}  {floor}F  {plan.get('comment') or ''}")
    print(f"{len(docs)} 件" + ("" if show_all else " (有効期限内)"))


if __name__ == "__main__":
    main()
