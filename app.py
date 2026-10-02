# chartmaker GUI サーバー
# ChartLib をそのまま使い、GUI が生成した txt から画像を作る薄いラッパー
import functools
import glob
import json
import os
import re
import tempfile
import threading
import time
import urllib.request
from collections import deque

from flask import Flask, jsonify, request, send_from_directory

from ChartLib import (BASE_DIR, BOSSES, REGULAR_BOSSES, IMAGE_KEYS, COOL_TIME, MAX_PLAYERS,
                      parse, generate_detail, generate_chart, calc_level)
from store import make_store, NotFound
from archive import make_plan_archive

MAX_TEXT = 200_000

# 公開時の料金対策。IP ごとの回数制限 (回数, 秒) と、画像生成の同時実行数
LIMIT_EDIT = (300, 60)        # /api/parse, /api/detail (エディタは編集のたびに呼ぶ)
LIMIT_RENDER = (20, 60)       # /api/render
LIMIT_SESSION = (20, 3600)    # POST /api/sessions
LIMIT_KILL = (120, 60)        # 討伐・取り消し
RENDER_SLOTS = 2              # 画像生成 1 回で数百 MB 使うので同時に動かす数を絞る
RENDER_WAIT = 20              # 空きを待つ秒数。過ぎたら 503

# 画面右上に出す支援 (寄付) ページの URL。https 以外や未設定なら出さない
SUPPORT_URL = os.environ.get("SUPPORT_URL", "").strip()
if not SUPPORT_URL.startswith("https://"):
    SUPPORT_URL = ""

WEB_DIR = os.path.join(BASE_DIR, "web")
IMAGE_DIR = os.path.join(BASE_DIR, "image")

app = Flask(__name__, static_folder=WEB_DIR, static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = MAX_TEXT * 4
# config.json の記述順（チームはギリシャ文字順、Shadow は最後）を保つ
app.json.sort_keys = False

store = make_store()
plan_archive = make_plan_archive()


def load_config():
    with open(os.path.join(BASE_DIR, "config.json"), encoding="utf-8") as f:
        return json.load(f)


class InputError(Exception):
    pass


@app.errorhandler(InputError)
def handle_input_error(e):
    return jsonify(error=str(e)), 400


class TooMany(Exception):
    pass


@app.errorhandler(TooMany)
def handle_too_many(e):
    return jsonify(error="リクエストが多すぎます。しばらくしてから再度お試しください"), 429


class Busy(Exception):
    pass


@app.errorhandler(Busy)
def handle_busy(e):
    return jsonify(error="混み合っています。しばらくしてから再度お試しください"), 503


class RateLimiter:
    """プロセス内の簡易な回数制限。インスタンスごとに数えるので、上限は max-instances 倍まで緩む"""

    def __init__(self):
        self._hits = {}  # key -> deque[時刻]
        self._lock = threading.Lock()

    def allow(self, key, limit, window):
        now = time.monotonic()
        with self._lock:
            q = self._hits.setdefault(key, deque())
            while q and now - q[0] >= window:
                q.popleft()
            if len(q) >= limit:
                return False
            q.append(now)
            if len(self._hits) > 10000:
                for k in [k for k, v in self._hits.items() if not v or now - v[-1] > 3600]:
                    del self._hits[k]
            return True


limiter = RateLimiter()
render_slots = threading.BoundedSemaphore(RENDER_SLOTS)


def client_ip():
    # Cloud Run (K_SERVICE が設定される) では Google のフロントエンドが X-Forwarded-For の末尾に
    # 接続元 IP を足す。先頭はクライアントが自由に書けるので使わない
    forwarded = request.headers.get("X-Forwarded-For", "")
    if os.environ.get("K_SERVICE") and forwarded:
        return forwarded.split(",")[-1].strip()
    return request.remote_addr or ""


def rate_limit(name, rule):
    def deco(f):
        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            if not limiter.allow((client_ip(), name), *rule):
                raise TooMany()
            return f(*args, **kwargs)
        return wrapper
    return deco


def parse_request():
    text = (request.get_json(silent=True) or {}).get("text", "")
    if not isinstance(text, str) or not text.strip():
        raise InputError("テキストが空です")
    if len(text) > MAX_TEXT:
        raise InputError("テキストが大きすぎます")
    try:
        commands, constants = parse(text.splitlines(True))
    except Exception as e:
        raise InputError("構文エラー: {}".format(e))
    return text, commands, constants


def validate(commands, constants, config, check_images=True):
    setting = dict(config, **constants)
    for boss in BOSSES:
        if setting.get(boss) not in config["color_table"]:
            raise InputError("::{}= に属性色 ({}) を指定してください".format(boss, "/".join(config["color_table"])))
    players = {c[0] for c in commands}
    if len(players) > MAX_PLAYERS:
        raise InputError("プレイヤーは最大 {} 人です（{} 人）".format(MAX_PLAYERS, len(players)))
    try:
        int(setting["timelag"])
    except (TypeError, ValueError):
        raise InputError("::timelag は整数で指定してください")
    if check_images and "display_boss" in setting:
        for key in IMAGE_KEYS.values():
            path = setting.get(key)
            if not path or not os.path.isfile(BASE_DIR + path):
                raise InputError("::{} の画像が見つかりません: {}".format(key, path))
    return setting


@app.get("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


# ヘッダー用。画像に焼き込むロゴ (config.json の logo_image) と同じファイルを使う
@app.get("/logo.png")
def logo():
    return send_from_directory(BASE_DIR, "logo.png")


# ブラウザのタブに出すアイコン
@app.get("/icon.png")
def icon():
    return send_from_directory(BASE_DIR, "icon.png")


@app.get("/image/<path:name>")
def image(name):
    return send_from_directory(IMAGE_DIR, name)


@app.get("/api/config")
def api_config():
    # 既定画像の blank.png を先頭に、残りはファイル名順
    images = sorted((os.path.basename(p) for p in glob.glob(os.path.join(IMAGE_DIR, "*.png"))),
                    key=lambda n: (n != "blank.png", n))
    return jsonify(config=load_config(), images=["/image/" + n for n in images])


@app.get("/api/site")
def api_site():
    return jsonify(support_url=SUPPORT_URL)


@app.post("/api/parse")
@rate_limit("edit", LIMIT_EDIT)
def api_parse():
    _, commands, constants = parse_request()
    return jsonify(commands=commands, constants=constants)


@app.post("/api/detail")
@rate_limit("edit", LIMIT_EDIT)
def api_detail():
    _, commands, constants = parse_request()
    setting = validate(commands, constants, load_config())
    return jsonify(detail=generate_detail(commands, setting))


@app.post("/api/render")
@rate_limit("render", LIMIT_RENDER)
def api_render():
    text, commands, constants = parse_request()
    config = load_config()
    setting = validate(commands, constants, config)
    if not render_slots.acquire(timeout=RENDER_WAIT):
        raise Busy()
    try:
        png = render_png(text, config)
    finally:
        render_slots.release()
    archive_plan(text, commands, setting)
    return app.response_class(png, mimetype="image/png")


def archive_plan(text, commands, setting):
    """画像生成できた作戦 txt を保存する。保存に失敗しても画像は返す"""
    if plan_archive is None:
        return
    try:
        detail = generate_detail(commands, setting)
        name = plan_archive.save(text, sum(d["score"] for d in detail), sum(d["est_score"] for d in detail))
        print("作戦を保存しました:", name)
    except Exception as e:
        print("作戦の保存に失敗しました:", repr(e))


def render_png(text, config):
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "chart.txt")
        dst = os.path.join(tmp, "chart.png")
        with open(src, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        try:
            generate_chart(src, dst, config)
        except Exception as e:
            raise InputError("画像生成に失敗しました: {}".format(e))
        with open(dst, "rb") as f:
            return f.read()


# ---------------------------------------------------------------- 進行管理

@app.get("/tracker")
@app.get("/tracker/<sid>")
def tracker(sid=None):
    return send_from_directory(WEB_DIR, "tracker.html")


def now_ms():
    return int(time.time() * 1000)


@app.errorhandler(NotFound)
def handle_not_found(e):
    return jsonify(error="セッションが見つかりません（期限切れの可能性があります）"), 404


class Conflict(Exception):
    pass


@app.errorhandler(Conflict)
def handle_conflict(e):
    return jsonify(error=str(e)), 409


@app.post("/api/sessions")
@rate_limit("session", LIMIT_SESSION)
def api_session_create():
    _, commands, constants = parse_request()
    config = load_config()
    # 進行管理では画像が無くても表示できるので確認しない
    setting = validate(commands, constants, config, check_images=False)
    start = (request.get_json(silent=True) or {}).get("start_epoch_ms")
    if not isinstance(start, (int, float)):
        raise InputError("開始日時を指定してください")
    if not commands:
        raise InputError("戦闘がありません")

    timelag = int(setting["timelag"])
    _, clear_time = calc_level(commands, timelag, COOL_TIME)
    while clear_time and all(v is None for v in clear_time[-1].values()):
        clear_time.pop()
    keep = ("push_start", "battle_start", "battle_end", "action", "raw_name", "player_name", "team", "est_score", "level")
    detail = [{k: d[k] for k in keep} for d in generate_detail(commands, setting)]

    icon_bg = setting.get("icon_bgcolor")
    bosses = {}
    for b in BOSSES:
        path = setting.get(IMAGE_KEYS[b]) or ""
        bosses[b] = {
            "color": config["color_table"][setting[b]],
            "icon_bg": config["color_table"].get(icon_bg) or config["color_table"][setting[b]],
            "image": path if path and os.path.isfile(BASE_DIR + path) else "",
        }
    plan = {
        "comment": setting.get("comment") or "",
        "start_epoch_ms": int(start),
        "bosses": bosses,
        "team_color": config["team"]["team_color"],
        "cleartime": clear_time,
        "detail": detail,
    }
    discord = discord_setting(request.get_json(silent=True) or {})
    plan["notify_lead"] = discord["lead"] if discord else None
    plan["notify_tts"] = discord["tts"] if discord else None
    # Webhook URL は plan の外に置き、GET で返さない
    sid = store.create({"plan": plan, "events": [], "discord": discord, "notified": []})
    return jsonify(id=sid)


# サーバーから任意の URL へ POST させないよう、Discord の Webhook だけ受け付ける
DISCORD_WEBHOOK = re.compile(r"https://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/webhooks/\d+/[\w-]+", re.ASCII)
NOTIFY_LEAD = (5, 120, 30)  # 何秒前に読み上げるか (最小, 最大, 既定)
MAX_NOTIFY_BATTLES = MAX_PLAYERS  # 1 通にまとめる戦闘の上限 (同時に出撃できるのは全員まで)


def discord_setting(body):
    webhook = body.get("discord_webhook") or ""
    if not webhook:
        return None
    if not isinstance(webhook, str) or not DISCORD_WEBHOOK.fullmatch(webhook.strip()):
        raise InputError("Discord の Webhook URL (https://discord.com/api/webhooks/...) を指定してください")
    lead = body.get("notify_lead", NOTIFY_LEAD[2])
    if not isinstance(lead, int) or isinstance(lead, bool) or not NOTIFY_LEAD[0] <= lead <= NOTIFY_LEAD[1]:
        raise InputError("通知は {}〜{} 秒前で指定してください".format(*NOTIFY_LEAD[:2]))
    tts = body.get("notify_tts", True)  # False なら読み上げないただのテキストで送る
    if not isinstance(tts, bool):
        raise InputError("不正な指定です")
    return {"webhook": webhook.strip(), "lead": lead, "tts": tts}


def discord_request(method, url, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json", "User-Agent": "chartmaker"})
    with urllib.request.urlopen(req, timeout=5) as res:
        return res.read()


def send_discord(webhook, payload):
    """メッセージを送り、あとで消せるようにメッセージ ID を返す (wait=true で本文が返る)"""
    return json.loads(discord_request("POST", webhook + "?wait=true", payload))["id"]


def delete_discord(webhook, message_id):
    discord_request("DELETE", "{}/messages/{}".format(webhook, message_id))


@app.get("/api/sessions/<sid>")
def api_session_get(sid):
    doc = store.get(sid)
    since = request.args.get("since", type=int)
    if since == doc["version"]:
        return jsonify(version=doc["version"], server_now=now_ms())
    return jsonify(version=doc["version"], plan=doc["plan"], events=doc["events"], server_now=now_ms())


def current_floor(events):
    floor = 1 + sum(1 for e in events if e["boss"] == "Realm_boss")
    killed = {e["boss"] for e in events if e["floor"] == floor}
    return floor, killed


@app.post("/api/sessions/<sid>/kill")
@rate_limit("kill", LIMIT_KILL)
def api_session_kill(sid):
    body = request.get_json(silent=True) or {}
    boss, floor = body.get("boss"), body.get("floor")
    if boss not in BOSSES or not isinstance(floor, int):
        raise InputError("不正な指定です")

    def apply(doc):
        cur, killed = current_floor(doc["events"])
        if floor != cur:
            raise Conflict("既に階層が進んでいます")
        if boss in killed:
            raise Conflict("既に討伐済みです")
        if boss == "Realm_boss" and not set(REGULAR_BOSSES) <= killed:
            raise Conflict("1st・2nd・3rd を倒すまで Realm には挑めません")
        at = now_ms()
        doc["events"].append({"floor": floor, "boss": boss, "at": at,
                              "t": round((at - doc["plan"]["start_epoch_ms"]) / 1000)})
        return doc

    doc = store.update(sid, apply)
    return jsonify(version=doc["version"], events=doc["events"], server_now=now_ms())


@app.post("/api/sessions/<sid>/undo")
@rate_limit("kill", LIMIT_KILL)
def api_session_undo(sid):
    count = (request.get_json(silent=True) or {}).get("count")

    def apply(doc):
        if not doc["events"]:
            raise Conflict("取り消す討伐がありません")
        if count != len(doc["events"]):
            raise Conflict("他の端末で更新されました。もう一度確認してください")
        doc["events"].pop()
        return doc

    doc = store.update(sid, apply)
    return jsonify(version=doc["version"], events=doc["events"], server_now=now_ms())


@app.post("/api/sessions/<sid>/notify")
@rate_limit("kill", LIMIT_KILL)
def api_session_notify(sid):
    """出撃が近い戦闘をまとめて Discord のメッセージ (既定は TTS) で知らせる。複数の端末から来ても 1 戦 1 回だけ送る"""
    battles = (request.get_json(silent=True) or {}).get("battles")
    if (not isinstance(battles, list) or not 0 < len(battles) <= MAX_NOTIFY_BATTLES
            or not all(isinstance(b, int) and not isinstance(b, bool) for b in battles)):
        raise InputError("不正な指定です")
    battles = list(dict.fromkeys(battles))
    result = {}

    def apply(doc):
        if not doc.get("discord"):
            raise Conflict("Discord 通知は設定されていません")
        if not all(0 <= b < len(doc["plan"]["detail"]) for b in battles):
            raise InputError("不正な指定です")
        # Firestore のトランザクションは再実行されることがあるので、毎回決め直す
        result["sent"] = [b for b in battles if b not in doc["notified"]]
        doc["notified"].extend(result["sent"])
        return doc

    doc = store.update(sid, apply)
    sent = result["sent"]
    if sent:
        names = []
        for b in sent:
            d = doc["plan"]["detail"][b]
            name = d["player_name"] or d["raw_name"]
            if name not in names:
                names.append(name)
        payload = {
            "content": "{}、準備して下さい".format("、".join(names)),
            "tts": doc["discord"].get("tts", True),  # tts を持たない古いセッションは読み上げる
            "allowed_mentions": {"parse": []},  # 名前に @everyone などがあっても通知しない
        }
        try:
            message_id = send_discord(doc["discord"]["webhook"], payload)
        except Exception as e:
            print("Discord への通知に失敗しました:", repr(e))
            message_id = None
        if message_id:
            # 出撃したら消すので、送ったメッセージを戦闘ごとに覚えておく (まとめた戦闘は同じ ID)
            def remember(doc):
                messages = doc.setdefault("messages", {})
                for b in sent:
                    messages[str(b)] = {"id": str(message_id), "at": time.time()}
                return doc
            doc = store.update(sid, remember)
    return jsonify(version=doc["version"], sent=sent, server_now=now_ms())


# 消し忘れを残さないよう、これより古い通知は別の戦闘の削除のついでに消す
MESSAGE_KEEP = NOTIFY_LEAD[1] + 60


@app.post("/api/sessions/<sid>/notify/clear")
@rate_limit("kill", LIMIT_KILL)
def api_session_notify_clear(sid):
    """出撃した戦闘の通知メッセージを Discord から消す。複数の端末から来ても 1 回だけ消す"""
    battle = (request.get_json(silent=True) or {}).get("battle")
    if not isinstance(battle, int) or isinstance(battle, bool):
        raise InputError("不正な指定です")

    def targets(doc):
        old = time.time() - MESSAGE_KEEP
        messages = doc.get("messages") or {}
        mine = messages.get(str(battle), {}).get("id")
        # まとめて送った通知は、そのうち 1 戦が出撃した時点で消す
        return [k for k, m in messages.items() if m["id"] == mine or m["at"] < old]

    # 消すものが無ければ書き込まない (version を上げない)
    if not targets(store.get(sid)):
        return jsonify(cleared=0, server_now=now_ms())
    removed = []

    def apply(doc):
        removed[:] = [doc["messages"].pop(k) for k in targets(doc)]
        return doc

    doc = store.update(sid, apply)
    for message_id in dict.fromkeys(m["id"] for m in removed):
        try:
            delete_discord(doc["discord"]["webhook"], message_id)
        except Exception as e:
            print("Discord の通知の削除に失敗しました:", repr(e))
    return jsonify(version=doc["version"], cleared=len(set(m["id"] for m in removed)), server_now=now_ms())


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=False)
