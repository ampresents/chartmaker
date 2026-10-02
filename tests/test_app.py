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


# ---------------------------------------------------------------- Discord 通知

WEBHOOK = "https://discord.com/api/webhooks/123456/abc_DEF-ghi"


@pytest.fixture
def sent(monkeypatch):
    calls = []

    def send(url, payload):
        calls.append((url, payload))
        return "m{}".format(len(calls))  # Discord のメッセージ ID
    monkeypatch.setattr(app_module, "send_discord", send)
    return calls


@pytest.fixture
def deleted(monkeypatch):
    calls = []
    monkeypatch.setattr(app_module, "delete_discord", lambda url, message_id: calls.append((url, message_id)))
    return calls


def create_notify_session(client, **extra):
    r = client.post("/api/sessions", json=dict(text=PLAN, start_epoch_ms=1_700_000_000_000,
                                               discord_webhook=WEBHOOK, **extra))
    assert r.status_code == 200
    return r.json["id"]


def notify(client, sid, *battles):
    return client.post("/api/sessions/{}/notify".format(sid), json={"battles": list(battles)})


@pytest.mark.parametrize("body", [
    {"discord_webhook": "http://discord.com/api/webhooks/1/abc"},
    {"discord_webhook": "https://example.com/api/webhooks/1/abc"},
    {"discord_webhook": "https://discord.com.evil.example/api/webhooks/1/abc"},
    {"discord_webhook": "https://discord.com/api/webhooks/1/abc?x=1"},
    {"discord_webhook": WEBHOOK, "notify_lead": 4},
    {"discord_webhook": WEBHOOK, "notify_lead": "30"},
    {"discord_webhook": WEBHOOK, "notify_tts": "false"},
])
def test_notify_create_errors(client, body):
    r = client.post("/api/sessions", json=dict(text=PLAN, start_epoch_ms=0, **body))
    assert r.status_code == 400


def test_notify_webhook_is_not_returned(client):
    sid = create_notify_session(client, notify_lead=20)
    r = client.get("/api/sessions/" + sid)
    assert WEBHOOK not in r.get_data(as_text=True)
    assert r.json["plan"]["notify_lead"] == 20
    assert r.json["plan"]["notify_tts"] is True
    assert client.get("/api/sessions/" + create_session(client)).json["plan"]["notify_lead"] is None


def test_notify_sends_once(client, sent):
    sid = create_notify_session(client)
    r = notify(client, sid, 0)
    assert r.status_code == 200 and r.json["sent"] == [0]
    assert notify(client, sid, 0).json["sent"] == []  # 別の端末からの同じ通知
    assert len(sent) == 1
    url, payload = sent[0]
    assert url == WEBHOOK
    assert payload["tts"] is True
    assert payload["allowed_mentions"] == {"parse": []}
    assert payload["content"] == "Alpha01、準備して下さい"
    assert notify(client, sid, 1).json["sent"] == [1]
    assert len(sent) == 2


def test_notify_without_tts(client, sent):
    # 読み上げをオフにすると、同じ本文をただのテキストとして送る
    sid = create_notify_session(client, notify_tts=False)
    assert client.get("/api/sessions/" + sid).json["plan"]["notify_tts"] is False
    notify(client, sid, 0)
    assert sent[0][1]["tts"] is False
    assert sent[0][1]["content"] == "Alpha01、準備して下さい"


def test_notify_groups_players(client, sent):
    sid = create_notify_session(client)
    notify(client, sid, 1)
    # 同時に出撃する人をまとめて 1 通で呼ぶ。通知済みの戦闘と同じ人の重複は除く
    r = notify(client, sid, 4, 1, 2, 4)
    assert r.json["sent"] == [4, 2]
    assert sent[-1][1]["content"] == "Beta01、Alpha01、準備して下さい"
    assert len(sent) == 2


def test_notify_errors(client, sent):
    sid = create_notify_session(client)
    assert notify(client, sid, 99).status_code == 400
    assert notify(client, sid, -1).status_code == 400
    assert notify(client, sid, "0").status_code == 400
    assert notify(client, sid, True).status_code == 400
    assert notify(client, sid).status_code == 400
    assert notify(client, sid, 0, 99).status_code == 400  # 1 つでも不正なら何も送らない
    assert client.post("/api/sessions/{}/notify".format(sid), json={"battles": 0}).status_code == 400
    assert notify(client, create_session(client), 0).status_code == 409  # Webhook なし
    assert notify(client, "nope", 0).status_code == 404
    assert sent == []


def clear(client, sid, battle):
    return client.post("/api/sessions/{}/notify/clear".format(sid), json={"battle": battle})


def test_notify_clear_deletes_once(client, sent, deleted):
    sid = create_notify_session(client)
    assert clear(client, sid, 0).json["cleared"] == 0  # まだ送っていない
    notify(client, sid, 0)
    notify(client, sid, 1)
    version = client.get("/api/sessions/" + sid).json["version"]
    assert clear(client, sid, 0).json["cleared"] == 1
    assert deleted == [(WEBHOOK, "m1")]
    r = clear(client, sid, 0)  # 別の端末からの同じ削除
    assert r.json["cleared"] == 0 and "version" not in r.json
    assert client.get("/api/sessions/" + sid).json["version"] == version + 1
    assert clear(client, sid, "0").status_code == 400
    assert deleted == [(WEBHOOK, "m1")]


def test_notify_clear_deletes_grouped_message_once(client, sent, deleted):
    sid = create_notify_session(client)
    notify(client, sid, 0, 4)
    assert clear(client, sid, 4).json["cleared"] == 1
    assert clear(client, sid, 0).json["cleared"] == 0  # まとめた通知は消し済み
    assert deleted == [(WEBHOOK, "m1")]


def test_notify_clear_removes_stale_messages(client, sent, deleted, monkeypatch):
    sid = create_notify_session(client)
    notify(client, sid, 0)
    now = app_module.time.time()
    monkeypatch.setattr(app_module.time, "time", lambda: now + app_module.MESSAGE_KEEP + 1)
    notify(client, sid, 1)
    # 戦闘 1 を消すついでに、消し忘れた古い戦闘 0 も消す
    assert clear(client, sid, 1).json["cleared"] == 2
    assert sorted(m for _, m in deleted) == ["m1", "m2"]


def test_notify_send_failure_is_ignored(client, monkeypatch):
    def fail(url, payload):
        raise OSError("down")
    monkeypatch.setattr(app_module, "send_discord", fail)
    sid = create_notify_session(client)
    assert notify(client, sid, 0).status_code == 200
