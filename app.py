# chartmaker GUI サーバー
# ChartLib をそのまま使い、GUI が生成した txt から画像を作る薄いラッパー
import glob
import json
import os
import tempfile
import time

from flask import Flask, jsonify, request, send_from_directory

from mysite.settings import BASE_DIR
from ChartLib import parse, generate_detail, generate_chart, calc_level
from store import make_store, NotFound

BOSSES = ("1st_boss", "2nd_boss", "3rd_boss", "Realm_boss")
MAX_PLAYERS = 20
MAX_TEXT = 200_000
COOL_TIME = 300  # generate_detail の cool_time
IMAGE_KEYS = dict(zip(BOSSES, ("image_1st", "image_2nd", "image_3rd", "image_realm")))

WEB_DIR = os.path.join(BASE_DIR, "web")
IMAGE_DIR = os.path.join(BASE_DIR, "image")

# generate_detail がデバッグ用 json を書き出すため
os.makedirs(os.path.join(BASE_DIR, "output"), exist_ok=True)

app = Flask(__name__, static_folder=WEB_DIR, static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = MAX_TEXT * 4
# config.json の記述順（チームはギリシャ文字順、Shadow は最後）を保つ
app.json.sort_keys = False

store = make_store()


def load_config():
    with open(os.path.join(BASE_DIR, "config.json"), encoding="utf-8") as f:
        return json.load(f)


class InputError(Exception):
    pass


@app.errorhandler(InputError)
def handle_input_error(e):
    return jsonify(error=str(e)), 400


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
        for key in ("image_1st", "image_2nd", "image_3rd", "image_realm"):
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
    images = sorted(os.path.basename(p) for p in glob.glob(os.path.join(IMAGE_DIR, "*.png")))
    return jsonify(config=load_config(), images=["/image/" + n for n in images])


@app.post("/api/parse")
def api_parse():
    _, commands, constants = parse_request()
    return jsonify(commands=commands, constants=constants)


@app.post("/api/detail")
def api_detail():
    _, commands, constants = parse_request()
    setting = validate(commands, constants, load_config())
    return jsonify(detail=generate_detail(commands, setting))


@app.post("/api/render")
def api_render():
    text, commands, constants = parse_request()
    config = load_config()
    validate(commands, constants, config)
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
            png = f.read()
    return app.response_class(png, mimetype="image/png")


# ---------------------------------------------------------------- 進捗管理

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
def api_session_create():
    _, commands, constants = parse_request()
    config = load_config()
    # 進捗管理では画像が無くても表示できるので確認しない
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
        "start_time": setting.get("start_time") or "",
        "bosses": bosses,
        "team_color": config["team"]["team_color"],
        "cleartime": clear_time,
        "detail": detail,
    }
    sid = store.create({"plan": plan, "events": []})
    return jsonify(id=sid)


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
        if boss == "Realm_boss" and not {"1st_boss", "2nd_boss", "3rd_boss"} <= killed:
            raise Conflict("1st・2nd・3rd を倒すまで Realm には挑めません")
        at = now_ms()
        doc["events"].append({"floor": floor, "boss": boss, "at": at,
                              "t": round((at - doc["plan"]["start_epoch_ms"]) / 1000)})
        return doc

    doc = store.update(sid, apply)
    return jsonify(version=doc["version"], events=doc["events"], server_now=now_ms())


@app.post("/api/sessions/<sid>/undo")
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


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=False)
