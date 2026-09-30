# chartmaker GUI サーバー
# ChartLib をそのまま使い、GUI が生成した txt から画像を作る薄いラッパー
import glob
import json
import os
import tempfile

from flask import Flask, jsonify, request, send_from_directory

from mysite.settings import BASE_DIR
from ChartLib import parse, generate_detail, generate_chart

BOSSES = ("1st_boss", "2nd_boss", "3rd_boss", "Realm_boss")
MAX_PLAYERS = 20
MAX_TEXT = 200_000

WEB_DIR = os.path.join(BASE_DIR, "web")
IMAGE_DIR = os.path.join(BASE_DIR, "image")

# generate_detail がデバッグ用 json を書き出すため
os.makedirs(os.path.join(BASE_DIR, "output"), exist_ok=True)

app = Flask(__name__, static_folder=WEB_DIR, static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = MAX_TEXT * 4
# config.json の記述順（チームはギリシャ文字順、Shadow は最後）を保つ
app.json.sort_keys = False


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


def validate(commands, constants, config):
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
    if "display_boss" in setting:
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


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=False)
