# Cloud Run 用。gcloud run deploy --source . でこのファイルからビルドされる
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 1 プロセスにまとめ、キャッシュと回数制限をプロセス内で共有する。
# 同時接続は Cloud Run の --concurrency で絞る (deploy/deploy.sh)
CMD exec gunicorn --bind :$PORT --workers 1 --threads 16 --timeout 60 app:app
