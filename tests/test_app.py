# Flask の API (エディタ用と進行管理)
import os

# ローカル用の設定 (メモリ上のセッション、作戦を保存しない) で import する
os.environ.pop("STORE", None)
os.environ.pop("PLAN_BUCKET", None)

import pytest

import app as app_module
from conftest import read_fixture


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(app_module, "limiter", app_module.RateLimiter())
    return app_module.app.test_client()


PLAN = read_fixture("plan_plain.txt")


def test_parse(client):
    r = client.post("/api/parse", json={"text": PLAN})
    assert r.status_code == 200
    assert r.json["commands"][0] == ["Alpha01", "5", "1st_boss", "60", "1.0"]
    assert r.json["constants"]["display_remaining"] is None


@pytest.mark.parametrize("text, message", [
    ("", "テキストが空です"),
    ("Alpha01,5,4th_boss,30\n", "構文エラー"),
])
def test_parse_errors(client, text, message):
    r = client.post("/api/parse", json={"text": text})
    assert r.status_code == 400
    assert message in r.json["error"]


def test_detail(client):
    r = client.post("/api/detail", json={"text": PLAN})
    assert r.status_code == 200
    assert [d["level"] for d in r.json["detail"]] == [1, 1, 1, 1, 2]


@pytest.mark.parametrize("change, message", [
    (("::Realm_boss=blue", "::Realm_boss=purple"), "::Realm_boss="),
    (("::comment=plain", "::timelag=x"), "::timelag"),
    (("::comment=plain", "::display_boss\n::image_1st=/image/none.png"), "::image_1st"),
])
def test_detail_validation(client, change, message):
    r = client.post("/api/detail", json={"text": PLAN.replace(*change)})
    assert r.status_code == 400
    assert message in r.json["error"]


def test_too_many_players(client):
    text = "::1st_boss=red\n::2nd_boss=red\n::3rd_boss=red\n::Realm_boss=red\n"
    text += "".join("P{:02d}01,1,1st_boss,10\n".format(i) for i in range(21))
    r = client.post("/api/detail", json={"text": text})
    assert r.status_code == 400
    assert "最大 20 人" in r.json["error"]


def test_render(client):
    r = client.post("/api/render", json={"text": PLAN})
    assert r.status_code == 200
    assert r.mimetype == "image/png"
    assert r.data.startswith(b"\x89PNG")


def test_site(client):
    assert client.get("/api/site").json.keys() == {"support_url"}


def test_rate_limiter():
    limiter = app_module.RateLimiter()
    assert [limiter.allow("ip", 2, 60) for _ in range(3)] == [True, True, False]
    assert limiter.allow("other", 2, 60)


# ---------------------------------------------------------------- 進行管理

def create_session(client):
    r = client.post("/api/sessions", json={"text": PLAN, "start_epoch_ms": 1_700_000_000_000})
    assert r.status_code == 200
    return r.json["id"]


def kill(client, sid, floor, boss):
    return client.post("/api/sessions/{}/kill".format(sid), json={"floor": floor, "boss": boss})


def test_session_plan(client):
    sid = create_session(client)
    r = client.get("/api/sessions/" + sid)
    plan = r.json["plan"]
    assert r.json["version"] == 1 and r.json["events"] == []
    assert plan["cleartime"][1]["Realm_boss"] == 5 + 3 * 300 + 120
    assert len(plan["cleartime"]) == 2  # 末尾の空の階層は削る
    assert plan["bosses"]["Realm_boss"]["image"] == ""
    # 変わっていなければ version と時刻だけ返す
    assert client.get("/api/sessions/{}?since=1".format(sid)).json.keys() == {"version", "server_now"}


def test_session_create_errors(client):
    r = client.post("/api/sessions", json={"text": PLAN})
    assert r.status_code == 400
    r = client.post("/api/sessions", json={"text": "::1st_boss=red\n::2nd_boss=red\n::3rd_boss=red\n::Realm_boss=red\n",
                                           "start_epoch_ms": 0})
    assert r.status_code == 400


def test_session_kill_rules(client):
    sid = create_session(client)
    assert kill(client, sid, 1, "Realm_boss").status_code == 409  # 3 体を倒す前
    assert kill(client, sid, 1, "1st_boss").status_code == 200
    assert kill(client, sid, 1, "1st_boss").status_code == 409    # 二重押し
    assert kill(client, sid, 2, "2nd_boss").status_code == 409    # まだ 1F
    assert kill(client, sid, 1, "2nd_boss").status_code == 200
    assert kill(client, sid, 1, "3rd_boss").status_code == 200
    r = kill(client, sid, 1, "Realm_boss")
    assert r.status_code == 200
    assert r.json["version"] == 5
    assert [(e["floor"], e["boss"]) for e in r.json["events"]][-1] == (1, "Realm_boss")
    assert kill(client, sid, 1, "1st_boss").status_code == 409    # 既に 2F
    assert kill(client, sid, 2, "1st_boss").status_code == 200
    assert kill(client, sid, 2, "boss").status_code == 400


def test_session_undo(client):
    sid = create_session(client)
    url = "/api/sessions/{}/undo".format(sid)
    assert client.post(url, json={"count": 0}).status_code == 409  # 取り消すものがない
    kill(client, sid, 1, "1st_boss")
    kill(client, sid, 1, "2nd_boss")
    assert client.post(url, json={"count": 1}).status_code == 409  # 他の端末で更新済み
    r = client.post(url, json={"count": 2})
    assert r.status_code == 200
    assert [e["boss"] for e in r.json["events"]] == ["1st_boss"]


def test_session_not_found(client):
    assert client.get("/api/sessions/nope").status_code == 404
    assert kill(client, "nope", 1, "1st_boss").status_code == 404
