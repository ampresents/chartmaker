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


def test_session_chart(client, monkeypatch):
    monkeypatch.setattr(app_module, "chart_cache", app_module.ChartCache(8))
    sid = create_session(client)
    assert "text" not in client.get("/api/sessions/" + sid).json  # 作戦テキストはポーリングで返さない
    r = client.get("/api/sessions/{}/chart.png".format(sid))
    assert r.status_code == 200 and r.mimetype == "image/png"
    assert r.data[1:4] == b"PNG" and "immutable" in r.headers["Cache-Control"]

    # 2 回目は描き直さない
    def fail(*_):
        raise AssertionError("re-rendered")
    monkeypatch.setattr(app_module, "render_png", fail)
    assert client.get("/api/sessions/{}/chart.png".format(sid)).data == r.data

    # 破棄したら 404
    client.delete("/api/sessions/" + sid)
    assert client.get("/api/sessions/{}/chart.png".format(sid)).status_code == 404


def test_session_chart_without_text(client, monkeypatch):
    monkeypatch.setattr(app_module, "chart_cache", app_module.ChartCache(8))
    sid = create_session(client)
    app_module.store.update(sid, lambda doc: {k: v for k, v in doc.items() if k != "text"})
    assert client.get("/api/sessions/{}/chart.png".format(sid)).status_code == 404
    assert client.get("/api/sessions/xxxx/chart.png").status_code == 404


def test_chart_cache_lru():
    c = app_module.ChartCache(2)
    c.put("a", b"1")
    c.put("b", b"2")
    c.get("a")
    c.put("c", b"3")
    assert c.get("b") is None and c.get("a") == b"1" and c.get("c") == b"3"


class FakeArchive:
    def __init__(self, fail=False):
        self.saved = []
        self.fail = fail

    def save(self, text, max_score, est_score, **kw):
        if self.fail:
            raise RuntimeError("down")
        self.saved.append((text, max_score, est_score, kw))
        return "x.txt"


def test_session_archive(client, monkeypatch):
    archive = FakeArchive()
    monkeypatch.setattr(app_module, "plan_archive", archive)
    sid = create_session(client)
    [(text, max_score, est_score, kw)] = archive.saved
    assert text == PLAN and kw == {"prefix": "sessions/", "tag": sid}
    assert max_score >= est_score > 0

    # 画像生成の保存先は今までどおり plans/
    client.post("/api/render", json={"text": PLAN})
    assert archive.saved[1][3] == {}


def test_session_archive_failure(client, monkeypatch):
    monkeypatch.setattr(app_module, "plan_archive", FakeArchive(fail=True))
    create_session(client)  # 保存に失敗してもセッションは作れる


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


def test_notify_pause(client, sent):
    sid = create_notify_session(client)
    url = "/api/sessions/{}/notify/pause".format(sid)
    assert client.get("/api/sessions/" + sid).json["notify_paused"] is False
    r = client.post(url, json={"paused": True})
    assert r.status_code == 200 and r.json["notify_paused"] is True
    assert client.get("/api/sessions/" + sid).json["notify_paused"] is True
    # 止めている間は送らず、通知済みにもしない
    assert notify(client, sid, 0).json["sent"] == []
    assert sent == []
    client.post(url, json={"paused": False})
    assert notify(client, sid, 0).json["sent"] == [0]
    assert len(sent) == 1


def test_notify_pause_errors(client):
    sid = create_notify_session(client)
    assert client.post("/api/sessions/{}/notify/pause".format(sid), json={"paused": 1}).status_code == 400
    plain = create_session(client)
    assert client.post("/api/sessions/{}/notify/pause".format(plain), json={"paused": True}).status_code == 409


def test_session_delete(client, sent, deleted):
    sid = create_notify_session(client)
    notify(client, sid, 0)  # メッセージ m1 がまだ残っている
    r = client.delete("/api/sessions/" + sid)
    assert r.status_code == 200 and r.json["cleared"] == 1
    assert deleted == [(WEBHOOK, "m1")]
    # 破棄後はどの操作も 404 になり、通知は送られない
    assert client.get("/api/sessions/" + sid).status_code == 404
    assert notify(client, sid, 1).status_code == 404
    assert len(sent) == 1
    assert client.delete("/api/sessions/" + sid).status_code == 404


def test_session_delete_without_discord(client, deleted):
    sid = create_session(client)
    assert client.delete("/api/sessions/" + sid).json["cleared"] == 0
    assert deleted == []


def test_notify_deletes_message_if_session_was_discarded(client, deleted, monkeypatch):
    # 送っている間に破棄されたら、メッセージ ID を覚える先が無いのですぐ消す
    sid = create_notify_session(client)

    def send(url, payload):
        client.delete("/api/sessions/" + sid)
        return "m9"
    monkeypatch.setattr(app_module, "send_discord", send)
    assert notify(client, sid, 0).status_code == 404
    assert deleted == [(WEBHOOK, "m9")]


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


# ---------------------------------------------------------------- 注意点

NOTED = PLAN.replace("Alpha01,0,2nd_boss,60\n", "Alpha01,0,2nd_boss,60\n#lock\n#note 2 体目は同時に\n").replace(
    "Beta01,3500,Realm_boss,170", "#note@600-900 回復を温存\nBeta01,3500,Realm_boss,170\n#note 最後")


def test_parse_notes():
    battles, ranges = app_module.parse_notes(NOTED)
    assert battles == {1: "2 体目は同時に", 4: "最後"}
    assert ranges == [{"start": 600, "end": 900, "text": "回復を温存"}]
    # 行動行より前の #note は付ける戦闘がないので無視する
    assert app_module.parse_notes("#note 先頭\n" + PLAN) == ({}, [])
    # プレイヤーが交互に並んでも txt の行の順で数える
    assert app_module.parse_notes("A01,0,1st_boss,9\nB01,0,1st_boss,9\n#note b\n")[0] == {1: "b"}


@pytest.mark.parametrize("line", ["#note@900-600 x", "#note@0-3601 x", "#note@0-10 ", "#note@0-10 " + "x" * 201])
def test_parse_notes_errors(client, line):
    with pytest.raises(app_module.InputError):
        app_module.parse_notes(PLAN + "\n" + line)
    r = client.post("/api/sessions", json={"text": PLAN + "\n" + line, "start_epoch_ms": 0})
    assert r.status_code == 400


def create_noted_session(client):
    r = client.post("/api/sessions", json={"text": NOTED, "start_epoch_ms": 0, "discord_webhook": WEBHOOK})
    assert r.status_code == 200
    return r.json["id"]


def test_session_notes(client):
    plan = client.get("/api/sessions/" + create_noted_session(client)).json["plan"]
    assert plan["detail"][1]["note"] == "2 体目は同時に"
    assert "note" not in plan["detail"][0]
    assert plan["notes"] == [{"start": 600, "end": 900, "text": "回復を温存"}]


def test_notify_appends_battle_note(client, sent):
    sid = create_noted_session(client)
    notify(client, sid, 1, 4)
    assert sent[0][1]["content"] == "Alpha01、Beta01、準備して下さい。Alpha01: 2 体目は同時に。Beta01: 最後"


def notify_note(client, sid, *notes):
    return client.post("/api/sessions/{}/notify".format(sid), json={"notes": list(notes)})


def test_notify_range_note(client, sent, deleted):
    sid = create_noted_session(client)
    r = notify_note(client, sid, 0)
    assert r.status_code == 200 and r.json["notes"] == [0] and r.json["sent"] == []
    assert notify_note(client, sid, 0).json["notes"] == []  # 別の端末からの同じ通知
    assert [p["content"] for _, p in sent] == ["注意: 回復を温存"]
    assert notify_note(client, sid, 1).status_code == 400
    assert notify_note(client, sid, "0").status_code == 400
    r = client.post("/api/sessions/{}/notify/clear".format(sid), json={"note": 0})
    assert r.json["cleared"] == 1 and deleted == [(WEBHOOK, "m1")]


def test_notify_range_note_pause(client, sent):
    sid = create_noted_session(client)
    client.post("/api/sessions/{}/notify/pause".format(sid), json={"paused": True})
    assert notify_note(client, sid, 0).json["notes"] == []
    client.post("/api/sessions/{}/notify/pause".format(sid), json={"paused": False})
    assert notify_note(client, sid, 0).json["notes"] == [0]
    assert len(sent) == 1
