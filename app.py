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
from collections import OrderedDict, deque

from flask import Flask, jsonify, request, send_from_directory

from ChartLib import (BASE_DIR, BOSSES, REGULAR_BOSSES, IMAGE_KEYS, COOL_TIME, MAX_PLAYERS,
                      parse, generate_detail, generate_chart, calc_level)
from store import make_store, NotFound
from archive import make_plan_archive, SESSION_PREFIX

MAX_TEXT = 200_000

# 公開時の料金対策。IP ごとの回数制限 (回数, 秒) と、画像生成の同時実行数
LIMIT_EDIT = (300, 60)        # /api/parse, /api/detail (エディタは編集のたびに呼ぶ)
LIMIT_RENDER = (20, 60)       # /api/render と、進行管理の作戦画像を新しく描くとき
LIMIT_SESSION = (20, 3600)    # POST /api/sessions
LIMIT_KILL = (120, 60)        # 討伐・取り消し
RENDER_SLOTS = 2              # 画像生成 1 回で数百 MB 使うので同時に動かす数を絞る
RENDER_WAIT = 20              # 空きを待つ秒数。過ぎたら 503
CHART_CACHE = 8               # 進行管理の作戦画像をプロセス内に何セッション分とっておくか

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
    archive_plan(text, lambda: generate_detail(commands, setting))
    return app.response_class(png, mimetype="image/png")


def archive_plan(text, detail, **kw):
    """画像生成やセッション作成に使った作戦 txt を保存する。保存に失敗しても処理は続ける"""
    if plan_archive is None:
        return
    try:
        if callable(detail):
            detail = detail()
        name = plan_archive.save(text, sum(d["score"] for d in detail), sum(d["est_score"] for d in detail), **kw)
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


CHART_SEC = 3600  # 作戦の長さ (秒)
NOTE_MAX = 200  # 注意点 1 件の文字数の上限
MAX_NOTES = 50  # 全体の注意点の件数の上限
NOTE_MARK = "#note "  # 直前の行動行に付く注意点
RANGE_NOTE = re.compile(r"#note@(\d+)-(\d+)(?: (.*))?")  # 作戦の経過秒の範囲に付く注意点


def parse_notes(text):
    """txt の注意点のコメント行を読む。戦闘の注意点は {detail の添字: 本文}、全体の注意点は [{start, end, text}]。
    行動行の判定は ChartLib.parse と同じなので、添字は generate_detail の順と一致する"""
    battle_notes = {}
    ranges = []
    count = 0
    for no, line in enumerate(text.splitlines(), 1):
        if line.startswith("#"):
            m = RANGE_NOTE.fullmatch(line.rstrip())
            if m:
                start, end, body = int(m[1]), int(m[2]), (m[3] or "").strip()
                if not 0 <= start < end <= CHART_SEC:
                    raise InputError("[line:{}] 注意点の時刻の範囲が正しくありません".format(no))
                ranges.append({"start": start, "end": end, "text": check_note(body, no)})
            elif line.startswith(NOTE_MARK) and count:
                battle_notes[count - 1] = check_note(line[len(NOTE_MARK):].strip(), no)
            continue
        if line.startswith("::") or len(line.split(",")) <= 1:
            continue
        count += 1
    if len(ranges) > MAX_NOTES:
        raise InputError("全体の注意点は {} 件までです".format(MAX_NOTES))
    return battle_notes, ranges


def check_note(body, no):
    if not body or len(body) > NOTE_MAX:
        raise InputError("[line:{}] 注意点は 1〜{} 文字で書いてください".format(no, NOTE_MAX))
    return body


@app.post("/api/sessions")
@rate_limit("session", LIMIT_SESSION)
def api_session_create():
    text, commands, constants = parse_request()
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
    full_detail = generate_detail(commands, setting)
    detail = [{k: d[k] for k in keep} for d in full_detail]
    battle_notes, range_notes = parse_notes(text)
    for i, note in battle_notes.items():
        detail[i]["note"] = note

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
        "notes": range_notes,
    }
    discord = discord_setting(request.get_json(silent=True) or {})
    plan["notify_lead"] = discord["lead"] if discord else None
    plan["notify_tts"] = discord["tts"] if discord else None
    # Webhook URL と作戦テキスト (作戦画像用) は plan の外に置き、GET で返さない
    sid = store.create({"plan": plan, "events": [], "discord": discord, "notified": [], "notes_notified": [], "text": text})
    archive_plan(text, full_detail, prefix=SESSION_PREFIX, tag=sid)
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


def delete_discord_quietly(webhook, message_id):
    try:
        delete_discord(webhook, message_id)
    except Exception as e:
        print("Discord の通知の削除に失敗しました:", repr(e))


@app.get("/api/sessions/<sid>")
def api_session_get(sid):
    doc = store.get(sid)
    since = request.args.get("since", type=int)
    if since == doc["version"]:
        return jsonify(version=doc["version"], server_now=now_ms())
    return jsonify(version=doc["version"], plan=doc["plan"], events=doc["events"],
                   notify_paused=bool(doc.get("notify_paused")), server_now=now_ms())


class ChartCache:
    """進行管理の作戦画像。作戦は途中で変わらないので、セッションごとに 1 回だけ描いて使い回す"""

    def __init__(self, size):
        self.size = size
        self._items = OrderedDict()
        self._lock = threading.Lock()

    def get(self, sid):
        with self._lock:
            png = self._items.get(sid)
            if png is not None:
                self._items.move_to_end(sid)
            return png

    def put(self, sid, png):
        with self._lock:
            self._items[sid] = png
            self._items.move_to_end(sid)
            while len(self._items) > self.size:
                self._items.popitem(last=False)

    def drop(self, sid):
        with self._lock:
            self._items.pop(sid, None)


chart_cache = ChartCache(CHART_CACHE)


@app.get("/api/sessions/<sid>/chart.png")
def api_session_chart(sid):
    doc = store.get(sid)  # 期限切れ・破棄済みなら 404
    png = chart_cache.get(sid)
    if png is None:
        if not doc.get("text"):
            raise NotFound(sid)  # 作戦テキストを保存する前に作ったセッション
        if not limiter.allow((client_ip(), "render"), *LIMIT_RENDER):
            raise TooMany()
        if not render_slots.acquire(timeout=RENDER_WAIT):
            raise Busy()
        try:
            png = render_png(doc["text"], load_config())
        finally:
            render_slots.release()
        chart_cache.put(sid, png)
    r = app.response_class(png, mimetype="image/png")
    r.headers["Cache-Control"] = "private, max-age=86400, immutable"
    return r


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
    body = request.get_json(silent=True) or {}
    battles = body.get("battles", [])
    notes = body.get("notes", [])
    if (not index_list(battles, MAX_NOTIFY_BATTLES) or not index_list(notes, MAX_NOTES)
            or not battles and not notes):
        raise InputError("不正な指定です")
    battles = list(dict.fromkeys(battles))
    notes = list(dict.fromkeys(notes))
    result = {}

    def apply(doc):
        if not doc.get("discord"):
            raise Conflict("Discord 通知は設定されていません")
        if (not all(0 <= b < len(doc["plan"]["detail"]) for b in battles)
                or not all(0 <= n < len(doc["plan"].get("notes", [])) for n in notes)):
            raise InputError("不正な指定です")
        # Firestore のトランザクションは再実行されることがあるので、毎回決め直す
        if doc.get("notify_paused"):
            result["sent"] = result["notes"] = []  # 止めている間は送らず、通知済みにもしない
            return doc
        result["sent"] = [b for b in battles if b not in doc["notified"]]
        doc["notified"].extend(result["sent"])
        done = doc.setdefault("notes_notified", [])  # 注意点の前に作ったセッションには無い
        result["notes"] = [n for n in notes if n not in done]
        done.extend(result["notes"])
        return doc

    doc = store.update(sid, apply)
    sent = result["sent"]
    if sent:
        names = []
        cautions = []
        for b in sent:
            d = doc["plan"]["detail"][b]
            name = d["player_name"] or d["raw_name"]
            if name not in names:
                names.append(name)
            if d.get("note"):
                cautions.append("{}: {}".format(name, d["note"]))
        content = "{}、準備して下さい".format("、".join(names))
        if cautions:
            content += "。" + "。".join(cautions)
        doc = send_and_remember(sid, doc, content, [str(b) for b in sent])
    for n in result["notes"]:
        doc = send_and_remember(sid, doc, "注意: " + doc["plan"]["notes"][n]["text"], ["n{}".format(n)])
    return jsonify(version=doc["version"], sent=sent, notes=result["notes"], server_now=now_ms())


def index_list(v, limit):
    return (isinstance(v, list) and len(v) <= limit
            and all(isinstance(b, int) and not isinstance(b, bool) for b in v))


DISCORD_CONTENT_MAX = 2000


def send_and_remember(sid, doc, content, keys):
    """Discord へ 1 通送り、あとで消せるよう messages[key] にメッセージ ID を覚える。送れなければ何もしない"""
    payload = {
        "content": content[:DISCORD_CONTENT_MAX],
        "tts": doc["discord"].get("tts", True),  # tts を持たない古いセッションは読み上げる
        "allowed_mentions": {"parse": []},  # 名前に @everyone などがあっても通知しない
    }
    try:
        message_id = send_discord(doc["discord"]["webhook"], payload)
    except Exception as e:
        print("Discord への通知に失敗しました:", repr(e))
        return doc
    if not message_id:
        return doc

    # 出撃したら消すので、送ったメッセージを戦闘ごとに覚えておく (まとめた戦闘は同じ ID)
    def remember(doc):
        messages = doc.setdefault("messages", {})
        for k in keys:
            messages[k] = {"id": str(message_id), "at": time.time()}
        return doc
    try:
        return store.update(sid, remember)
    except NotFound:
        # 送っている間にセッションが破棄された。消す機会がもう無いので、すぐ消す
        delete_discord_quietly(doc["discord"]["webhook"], message_id)
        raise


@app.post("/api/sessions/<sid>/notify/pause")
@rate_limit("kill", LIMIT_KILL)
def api_session_notify_pause(sid):
    """進行が大きく狂ったときなどに、全端末の Discord 通知を止める・再開する"""
    paused = (request.get_json(silent=True) or {}).get("paused")
    if not isinstance(paused, bool):
        raise InputError("不正な指定です")

    def apply(doc):
        if not doc.get("discord"):
            raise Conflict("Discord 通知は設定されていません")
        doc["notify_paused"] = paused
        return doc

    doc = store.update(sid, apply)
    return jsonify(version=doc["version"], notify_paused=paused, server_now=now_ms())


# 消し忘れを残さないよう、これより古い通知は別の戦闘の削除のついでに消す
MESSAGE_KEEP = NOTIFY_LEAD[1] + 60


@app.post("/api/sessions/<sid>/notify/clear")
@rate_limit("kill", LIMIT_KILL)
def api_session_notify_clear(sid):
    """出撃した戦闘 (battle) か始まった全体の注意点 (note) の通知メッセージを Discord から消す。
    複数の端末から来ても 1 回だけ消す"""
    body = request.get_json(silent=True) or {}
    key = None
    for name, prefix in (("battle", ""), ("note", "n")):
        v = body.get(name)
        if isinstance(v, int) and not isinstance(v, bool):
            key = prefix + str(v)
    if key is None:
        raise InputError("不正な指定です")

    def targets(doc):
        old = time.time() - MESSAGE_KEEP
        messages = doc.get("messages") or {}
        mine = messages.get(key, {}).get("id")
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
        delete_discord_quietly(doc["discord"]["webhook"], message_id)
    return jsonify(version=doc["version"], cleared=len(set(m["id"] for m in removed)), server_now=now_ms())


@app.delete("/api/sessions/<sid>")
@rate_limit("kill", LIMIT_KILL)
def api_session_delete(sid):
    """セッションを破棄する。全端末の進行管理が終わり、Discord 通知も以後は送られない"""
    doc = store.delete(sid)
    chart_cache.drop(sid)
    # まだ消していない通知メッセージも消す
    ids = list(dict.fromkeys(m["id"] for m in (doc.get("messages") or {}).values()))
    for message_id in ids:
        delete_discord_quietly(doc["discord"]["webhook"], message_id)
    return jsonify(deleted=True, cleared=len(ids), server_now=now_ms())


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=False)
