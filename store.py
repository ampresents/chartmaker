# 進捗管理セッションの保存先
# ローカルではプロセス内メモリ、Cloud Run では Firestore (環境変数 STORE=firestore) を使う。
# どちらも update(id, fn) で fn に現在の doc を渡し、fn が返した doc を version+1 して保存する。
import copy
import os
import secrets
import threading
import time

SESSION_TTL = 24 * 3600  # これより古いセッションは消す (メモリストアのみ)


class NotFound(Exception):
    pass


def new_id():
    return secrets.token_urlsafe(16)


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
            if sid not in self._docs:
                raise NotFound(sid)
            return copy.deepcopy(self._docs[sid])

    def update(self, sid, fn):
        with self._lock:
            if sid not in self._docs:
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
        self._col.document(sid).set(dict(doc, version=1, created=time.time()))
        return sid

    def get(self, sid):
        snap = self._col.document(sid).get()
        if not snap.exists:
            raise NotFound(sid)
        return snap.to_dict()

    def update(self, sid, fn):
        ref = self._col.document(sid)

        @self._fs.transactional
        def run(tx):
            snap = ref.get(transaction=tx)
            if not snap.exists:
                raise NotFound(sid)
            doc = fn(snap.to_dict())
            doc["version"] += 1
            tx.set(ref, doc)
            return doc

        return run(self._client.transaction())


def make_store():
    if os.environ.get("STORE") == "firestore":
        return FirestoreStore()
    return MemoryStore()
