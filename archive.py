# 画像生成した作戦 txt の保存先
# 環境変数 PLAN_BUCKET に Cloud Storage のバケット名を設定したときだけ保存する (ローカルでは保存しない)。
# ファイル名は plans/YYYYMMDD_連番_Maxスコア_Estスコア.txt。日付は日本時間、連番は日ごとに 001 から振る。
import datetime
import os
import threading

JST = datetime.timezone(datetime.timedelta(hours=9))  # 日本は夏時間が無いので固定でよい
PREFIX = "plans/"


class GcsPlanArchive:
    def __init__(self, bucket):
        from google.cloud import storage  # ローカルでは不要なので遅延 import
        from google.api_core.exceptions import PreconditionFailed
        self._bucket = storage.Client().bucket(bucket)
        self._exists = PreconditionFailed
        self._lock = threading.Lock()

    def _next_seq(self, day):
        head = PREFIX + day + "_"
        seqs = [0]
        for blob in self._bucket.list_blobs(prefix=head):
            seq = blob.name[len(head):].split("_")[0]
            if seq.isdigit():
                seqs.append(int(seq))
        return max(seqs) + 1

    def save(self, text, max_score, est_score):
        day = datetime.datetime.now(JST).strftime("%Y%m%d")
        # 連番は同じプロセス内ではロックで重ならない。if_generation_match=0 で既存のファイルは上書きしない
        with self._lock:
            seq = self._next_seq(day)
            for _ in range(10):
                name = "{}{}_{:03d}_{}_{}.txt".format(PREFIX, day, seq, max_score, est_score)
                try:
                    self._bucket.blob(name).upload_from_string(
                        text.encode("utf-8"), content_type="text/plain; charset=utf-8", if_generation_match=0)
                    return name
                except self._exists:
                    seq += 1
        raise RuntimeError("連番が空きませんでした: " + name)


def make_plan_archive():
    bucket = os.environ.get("PLAN_BUCKET")
    return GcsPlanArchive(bucket) if bucket else None
