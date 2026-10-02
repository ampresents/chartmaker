# 進行管理セッションの保存先
# ローカルではプロセス内メモリ、Cloud Run では Firestore (環境変数 STORE=firestore) を使う。
# どちらも update(id, fn) で fn に現在の doc を渡し、fn が返した doc を version+1 して保存する。
import copy
import datetime
import os
import secrets
import threading
import time

SESSION_TTL = 24 * 3600  # 作成からこの秒数で失効 (延長しない)。Firestore の実体は expire_at の TTL ポリシーで後から消える
CACHE_TTL = 1.0  # CachedStore が get の結果を使い回す秒数


class NotFound(Exception):
    pass


def new_id():
    return secrets.token_urlsafe(16)


def expired(doc):
    """作成から SESSION_TTL を過ぎたか。

    Firestore の TTL 削除は期限から遅れて (最大 24 時間ほど) 行われるので、読むたびに確かめる。
    """
    exp = doc.get("expire_at")
    if exp is not None:
        return exp <= datetime.datetime.now(datetime.timezone.utc)
    return doc["created"] + SESSION_TTL <= time.time()


class MemoryStore:
    def __init__(self):
        self._docs = {}
        self._lock = threading.Lock()

    def _expire(self):
        limit = time.time() - SESSION_TTL
        for k in [k for k, d in self._docs.items() if d["created"] < limit]:
            del self._docs[k]

    def create(self, doc):
        with self._lock:
            self._expire()
            sid = new_id()
            self._docs[sid] = dict(copy.deepcopy(doc), version=1, created=time.time())
            return sid

    def get(self, sid):
        with self._lock:
            if sid not in self._docs or expired(self._docs[sid]):
                raise NotFound(sid)
            return copy.deepcopy(self._docs[sid])

    def update(self, sid, fn):
        with self._lock:
            if sid not in self._docs or expired(self._docs[sid]):
                raise NotFound(sid)
            doc = fn(copy.deepcopy(self._docs[sid]))
            doc["version"] += 1
            self._docs[sid] = doc
            return copy.deepcopy(doc)


class FirestoreStore:
    def __init__(self, collection="tracker_sessions"):
        from google.cloud import firestore  # ローカルでは不要なので遅延 import
        self._fs = firestore
        self._client = firestore.Client()
        self._col = self._client.collection(collection)

    def create(self, doc):
        sid = new_id()
        expire = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=SESSION_TTL)
        self._col.document(sid).set(dict(doc, version=1, created=time.time(), expire_at=expire))
        return sid

    def get(self, sid):
        snap = self._col.document(sid).get()
        if not snap.exists or expired(snap.to_dict()):
            raise NotFound(sid)
        return snap.to_dict()

    def update(self, sid, fn):
        ref = self._col.document(sid)

        @self._fs.transactional
        def run(tx):
            snap = ref.get(transaction=tx)
            if not snap.exists or expired(snap.to_dict()):
                raise NotFound(sid)
            doc = fn(snap.to_dict())
            doc["version"] += 1
            tx.set(ref, doc)
            return doc

        return run(self._client.transaction())


class CachedStore:
    """get の結果を ttl 秒だけインスタンス内で使い回す。

    進行管理の画面は毎秒ポーリングするので、そのままでは Firestore の読み取りが端末数に比例する。
    同じインスタンスに来た同じセッションの get を 1 回の読み取りにまとめる。
    update は常に元のストアで (トランザクションで) 行い、結果をキャッシュに入れる。
    別インスタンスでの更新が見えるのは最大 ttl 秒遅れる。
    """

    def __init__(self, inner, ttl=CACHE_TTL):
        self._inner = inner
        self._ttl = ttl
        self._cache = {}  # sid -> (取得時刻, doc)
        self._lock = threading.Lock()

    def _put(self, sid, doc):
        now = time.monotonic()
        with self._lock:
            self._cache[sid] = (now, doc)
            for k in [k for k, (t, _) in self._cache.items() if now - t > 60]:
                del self._cache[k]

    def create(self, doc):
        return self._inner.create(doc)

    def get(self, sid):
        with self._lock:
            hit = self._cache.get(sid)
        if hit and time.monotonic() - hit[0] < self._ttl:
            if expired(hit[1]):
                raise NotFound(sid)
            return copy.deepcopy(hit[1])
        doc = self._inner.get(sid)
        self._put(sid, doc)
        return copy.deepcopy(doc)

    def update(self, sid, fn):
        doc = self._inner.update(sid, fn)
        self._put(sid, doc)
        return copy.deepcopy(doc)


def make_store():
    if os.environ.get("STORE") == "firestore":
        return CachedStore(FirestoreStore())
    return MemoryStore()
