import datetime

import archive


class FakeBlob:
    def __init__(self, bucket, name):
        self.bucket, self.name = bucket, name

    def upload_from_string(self, data, content_type, if_generation_match):
        self.bucket.names.append(self.name)


class FakeBucket:
    def __init__(self, names):
        self.names = list(names)

    def list_blobs(self, prefix):
        return [FakeBlob(self, n) for n in self.names if n.startswith(prefix)]

    def blob(self, name):
        return FakeBlob(self, name)


def make(names):
    a = archive.GcsPlanArchive.__new__(archive.GcsPlanArchive)
    a._bucket = FakeBucket(names)
    a._exists = KeyError
    a._lock = archive.threading.Lock()
    return a


def test_names_and_sequence_per_prefix():
    day = datetime.datetime.now(archive.JST).strftime("%Y%m%d")
    a = make(["plans/{}_004_10_9.txt".format(day)])
    # 連番は保存先 (prefix) ごとに振る。セッションは末尾に ID を付ける
    assert a.save("t", 10, 9, prefix=archive.SESSION_PREFIX, tag="abc") == "sessions/{}_001_10_9_abc.txt".format(day)
    assert a.save("t", 10, 9, prefix=archive.SESSION_PREFIX, tag="def") == "sessions/{}_002_10_9_def.txt".format(day)
    assert a.save("t", 10, 9) == "plans/{}_005_10_9.txt".format(day)
