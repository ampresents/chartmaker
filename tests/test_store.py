# 進行管理セッションの保存 (MemoryStore と CachedStore)
import pytest

import store
from store import CachedStore, MemoryStore, NotFound


def test_update_increments_version():
    s = MemoryStore()
    sid = s.create({"events": []})
    doc = s.update(sid, lambda d: dict(d, events=d["events"] + [1]))
    assert (doc["version"], doc["events"]) == (2, [1])
    assert s.get(sid)["version"] == 2


def test_session_expires_after_ttl(monkeypatch):
    now = [1_000_000.0]
    monkeypatch.setattr(store.time, "time", lambda: now[0])
    s = MemoryStore()
    sid = s.create({"events": []})
    now[0] += store.SESSION_TTL - 1
    s.update(sid, lambda d: d)  # 更新しても期限は延びない
    now[0] += 1
    with pytest.raises(NotFound):
        s.get(sid)
    with pytest.raises(NotFound):
        s.update(sid, lambda d: d)


def test_cached_store_reuses_get_and_checks_expiry(monkeypatch):
    now = [1_000_000.0]
    monkeypatch.setattr(store.time, "time", lambda: now[0])
    monkeypatch.setattr(store.time, "monotonic", lambda: now[0])
    inner = MemoryStore()
    calls = []
    real_get = inner.get
    inner.get = lambda sid: calls.append(sid) or real_get(sid)
    s = CachedStore(inner)
    sid = s.create({"events": []})
    s.get(sid)
    s.get(sid)
    assert len(calls) == 1  # 1 秒以内は使い回す
    now[0] += store.CACHE_TTL
    s.get(sid)
    assert len(calls) == 2
    # キャッシュに残っていても期限切れなら見つからない扱いにする
    now[0] += store.SESSION_TTL - store.CACHE_TTL - 0.5
    s.get(sid)
    now[0] += 0.5
    with pytest.raises(NotFound):
        s.get(sid)
