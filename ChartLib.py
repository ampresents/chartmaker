import warnings
warnings.filterwarnings('ignore')

import cv2
import math
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# フォント・画像などのパスはこのディレクトリ + "/..." で解決する
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

BOSS_ICON_SIZE = 100 # ボスアイコンの一辺
BOSSES = ("1st_boss", "2nd_boss", "3rd_boss", "Realm_boss")
REGULAR_BOSSES = BOSSES[:3] # 階層ごとに 3 体とも倒すと Realm に挑める
IMAGE_KEYS = dict(zip(BOSSES, ("image_1st", "image_2nd", "image_3rd", "image_realm")))
COOL_TIME = 300 # 出撃からクールタイム明けまで (timelag を除く)
MAX_PLAYERS = 20 # 画像の列数

# ボスアイコンを読み込み、中央を正方形に切り出してから一辺 BOSS_ICON_SIZE に拡縮する
# 透過 PNG の透明度も保つため、アルファを掛けた色 (float, 0-255) とアルファ (0-1) の組で返す
def load_boss_icon(path, size=BOSS_ICON_SIZE):
    # cv2.imread は Windows で日本語を含むパスを読めないため、バイト列からデコードする
    img = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("ボス画像を読み込めません: {}".format(path))
    img = img.astype(np.float32) / (65535. if img.dtype == np.uint16 else 255.) * 255.
    if img.ndim == 2:
        img = img[:, :, None]
    if img.shape[2] in (1, 2): # グレースケール（とそのアルファ）
        img = np.concatenate([img[:, :, :1]] * 3 + [img[:, :, 1:]], axis=2)
    color = img[:, :, :3]
    alpha = img[:, :, 3:4] / 255. if img.shape[2] == 4 else np.ones_like(color[:, :, :1])
    icon = np.concatenate([color * alpha, alpha], axis=2) # 縁が黒ずまないよう、アルファを掛けてから拡縮する
    h, w = icon.shape[:2]
    side = min(h, w)
    top, left = (h - side) // 2, (w - side) // 2
    icon = icon[top:top+side, left:left+side]
    if side != size:
        # 縮小は INTER_AREA が綺麗。小さい画像を拡大するときは INTER_CUBIC
        interpolation = cv2.INTER_AREA if side > size else cv2.INTER_CUBIC
        icon = np.clip(cv2.resize(icon, (size, size), interpolation=interpolation), 0., None)
        icon[:, :, 3] = np.minimum(icon[:, :, 3], 1.)
    return icon[:, :, :3], icon[:, :, 3:]

# アイコンの透明部分を bgcolor (BGR) で塗って不透明な画像にする
def flatten_boss_icon(icon, bgcolor):
    color, alpha = icon
    return np.clip(np.rint(color + np.array(bgcolor, dtype=np.float32) * (1. - alpha)), 0, 255).astype(np.uint8)

# 構文解析
def format_clock(sec, remaining=False):
    """ブロックの時刻ラベル。remaining なら 60 分からの残り時間（過ぎたら -mm:ss）"""
    if remaining:
        sec = 3600 - sec
    sign = "-" if sec < 0 else ""
    return "{}{:02d}:{:02d}".format(sign, abs(sec)//60, abs(sec)%60)

def parse(text):
    chart = []
    constant = {}
    for i, raw_line in enumerate(text):
        line = raw_line.rstrip("\r\n") # 行末の改行を削除（最終行に改行が無くても文字を欠かさない）
        # コメント
        if line.startswith("#"):
            continue
        # 予約語の処理
        if line[:2] == "::":
            tokens =line[2:].split("=")
            constant[tokens[0]] = tokens[1] if len(tokens) > 1 else None
            continue
        # 行動の処理
        item = tuple(line.split(","))
        if len(item) <= 1:
            continue

        item = item + ("1.0",)  # 見積もりはデフォルトでワンパン
        if len(item) < 5:
            raise Exception("[line:{}] {}".format(i+1, line))

        if item[2] in BOSSES:
            chart.append(item[:5])
        else:
            raise Exception("[line:{}] {}".format(i+1, line))
            
        try:
            int(item[1])
            int(item[3])
            float(item[4])
        except:
            raise Exception("[line:{}] {}".format(i+1, line))

    return chart, constant

# プレイヤー名変換
def get_player_name(constant, player_num):
    return constant[player_num] if player_num in constant else player_num

# 階層レベル計算
def calc_level(commands, timelag, cool_time):
    new_info = []
    current_pos = {}
    
    for player_name, waiting_time, action, action_time, _ in commands:
        current_pos.setdefault(player_name, 0)
        current_pos[player_name] += int(waiting_time)

        push_start = current_pos[player_name]
        battle_end = push_start + timelag + int(action_time)
        new_info.append((push_start, battle_end, action))
        
        current_pos[player_name] += timelag + cool_time

    clear_time = [dict.fromkeys(BOSSES, 0)] + [dict.fromkeys(BOSSES) for _ in range(50)]
    current_floor = 1

    for push_start, battle_end, action in sorted(new_info):
        if action == "Realm_boss":
            if None in (clear_time[current_floor][b] for b in REGULAR_BOSSES):
                clear_time[current_floor-1][action] = min(clear_time[current_floor-1][action], battle_end)
            else:
                clear_time[current_floor][action] = battle_end if clear_time[current_floor][action] is None else min(clear_time[current_floor][action], battle_end)
                current_floor += 1
        else:
            if push_start > clear_time[current_floor-1]["Realm_boss"]:
                clear_time[current_floor][action] = battle_end if clear_time[current_floor][action] is None else min(clear_time[current_floor][action], battle_end)
                
    floor_time = [b["Realm_boss"] for b in clear_time]
    while floor_time[-1] is None:
        floor_time = floor_time[:-1]

    return floor_time, clear_time

# 情報変換
def generate_detail(commands, constant):
    cool_time = COOL_TIME
    detail = []
    current_pos = {}
    timelag = int(constant["timelag"])

    floor_time, _ = calc_level(commands, timelag, cool_time)

    for player_name, waiting_time, action, action_time, score_rate in commands:
        current_pos.setdefault(player_name, 0)

        current_pos[player_name] += int(waiting_time)
        play_time = int(action_time)

        item = {}
        item["push_start"] = current_pos[player_name]
        item["battle_start"] = item["push_start"] + timelag
        item["battle_end"] = item["battle_start"] + play_time
        item["play_time"] = play_time
        item["action"] = action
        item["cool_off"] = item["battle_start"] + cool_time
        item["raw_name"] = player_name
        item["player_name"] = get_player_name(constant, player_name)
        item["team"] = player_name[:-2]
        item["score_rate"] = score_rate
        
        floor = len(floor_time)
        for f, ft in enumerate(floor_time):
            if item["battle_start"] < ft:
                floor = f
                break
        item["level"] = floor

        score = 50000 * min(((floor-1)//5+1), 5) * (1.2 if action == "Realm_boss" else 1.0)
        item["score"] = int(score)
        item["est_score"] = math.ceil(score * max(min(float(score_rate), 1.), 0))
        detail.append(item)

        current_pos[player_name] += timelag + cool_time

    return detail

# 時刻ラベル（戦闘開始・戦闘終了・戦闘時間・出撃可能）の表示位置
# 既定の位置は各時刻の線に沿わせているが、戦闘が極端に短い・長いときや、ブロックが隙間なく続くときは
# 文字が重なる。そこでプレイヤーごとにラベルを上から順に並べ、必要な間隔を保ちつつ
# 既定の位置からのずれ（二乗和）が最小になるように押し広げる（間隔付きの Pool Adjacent Violators）
LABEL_PAD = 2         # ラベル同士の縁取りの間に空ける隙間
LABEL_TOP_LIMIT = 12  # 最初のラベルを戦闘開始 0 秒のときより上（ヘッダー側）に出さない

def layout_time_labels(details):
    columns = {}
    for i, detail in enumerate(details):
        labels = columns.setdefault(detail["raw_name"], [])
        # (detail の番号, 種類, 既定のベースライン, 縁取り込みの上端までの高さ, 下端までの高さ)
        labels.append((i, "battle_start", detail["battle_start"] + 12, 25, 4))
        labels.append((i, "battle_end", detail["battle_end"] - 4, 25, 4))
        if detail["play_time"] < 180:
            labels.append((i, "play_time", detail["battle_end"] + 40, 28, 7))
        labels.append((i, "cool_off", detail["cool_off"] - 12, 25, 4))

    positions = [{} for _ in details]
    for labels in columns.values():
        # 隣どうしに必要な間隔を累積して差し引くと、制約は「値が単調非減少」になる
        offsets = [0]
        for above, below in zip(labels, labels[1:]):
            offsets.append(offsets[-1] + above[4] + below[3] + LABEL_PAD)
        # 順序が逆転している隣接グループを併合して平均をとる
        groups = [] # [平均, 個数]
        for label, offset in zip(labels, offsets):
            groups.append([label[2] - offset, 1])
            while len(groups) > 1 and groups[-2][0] > groups[-1][0]:
                value, count = groups.pop()
                groups[-1][0] = (groups[-1][0] * groups[-1][1] + value * count) / (groups[-1][1] + count)
                groups[-1][1] += count
        values = [value for value, count in groups for _ in range(count)]

        prev_y, prev_offset = LABEL_TOP_LIMIT, None
        for (i, kind, _, _, _), offset, value in zip(labels, offsets, values):
            y = value + offset
            y = max(y, prev_y if prev_offset is None else prev_y + offset - prev_offset)
            positions[i][kind] = int(round(y))
            prev_y, prev_offset = y, offset
    return positions


# 画像生成
def generate_chart(src, dst, config, margin_top=160):
    with open(src, "r", encoding="utf-8") as p1:
        text = p1.readlines()
        commands, constant_from_txt = parse(text)
    setting = dict(config, **constant_from_txt)

    color_table = config["color_table"]
    advantage = {"blue":"yellow", "red":"blue", "green":"red", "yellow":"green", "white":"white"}

    player_list = {}
    party = {}
    player_scores = {}
    min_scores = {}

    base = np.full((6400, 220 + MAX_PLAYERS*246, 3), 0, dtype=np.uint8) # 縦広めにとっておく
    
    # BOSSアイコン（サイズや縦横比が違っても 100×100 に揃える）
    if "display_boss" in setting:
        if setting.get("icon_bgcolor") not in (None, *color_table):
            raise ValueError("::icon_bgcolor には {} のいずれかを指定してください".format("/".join(color_table)))
        boss_images = {boss: load_boss_icon(BASE_DIR + setting[key]) for boss, key in IMAGE_KEYS.items()}

    details = generate_detail(commands, setting)

    # 罫線の奥に表示したいもの
    for detail in details:
        player_name = detail["raw_name"]
        party.setdefault(player_name, {})
        boss_color = setting[detail["action"]]
        # プレイヤーを追加
        player_list.setdefault(player_name, 120 + len(player_list)*246)
        # プレイヤーごとのスコアを加算
        player_scores.setdefault(player_name, 0)
        player_scores[player_name] += detail["score"]
        min_scores.setdefault(player_name, 0)
        min_scores[player_name] += detail["est_score"]
        # 使用する編成を追加
        party[player_name][advantage[boss_color]] = None
        x = player_list[player_name]
        # タイムラグ3秒
        base[detail["push_start"]+margin_top:detail["battle_start"]+margin_top,x:x+240,:] = 64
        # クールタイム5分
        base[detail["battle_end"]+margin_top:detail["cool_off"]+margin_top,x:x+240,:] = 96
        # 市松模様表示
        if float(detail["score_rate"]) < 1.:
            square1 = np.full((24, 24,3), config["score_rate"]["pattern1"], dtype=int)
            square2 = np.full((24, 24,3), config["score_rate"]["pattern2"], dtype=int)
            tile = np.tile(np.vstack([np.hstack([square1, square2]), np.hstack([square2, square1])]), (12, 5, 1))
            base[detail["battle_start"]+margin_top:detail["cool_off"]+margin_top,x:x+240,:] = tile[:detail["cool_off"]-detail["battle_start"],:,:]
        # 戦闘中
        base[detail["battle_start"]+margin_top:detail["battle_end"]+margin_top,x:x+240,:] = color_table[boss_color]
        # 有利属性
        if "display_party" in setting:
            cv2.circle(base, center=(x+230, detail["battle_start"]+5+margin_top), radius=10, color=color_table[advantage[boss_color]], thickness=-1, lineType=cv2.LINE_4, shift=0)
        # BOSSアイコン
        if "display_boss" in setting:
            # 透明部分は、そのボスの属性色（::icon_bgcolor があればその色）で塗る
            boss_img = flatten_boss_icon(boss_images[detail["action"]], color_table[setting.get("icon_bgcolor") or boss_color])
            base[detail["battle_start"]+margin_top:detail["battle_start"]+margin_top+boss_img.shape[0],x:x+boss_img.shape[1],:] = boss_img

    # 罫線
    cv2.line(base, pt1=(100, margin_top),        pt2=(MAX_PLAYERS*246+120, margin_top),        color=config["grid_color"]["start"], thickness=3, lineType=cv2.LINE_4)
    cv2.line(base, pt1=(100, margin_top + 3600), pt2=(MAX_PLAYERS*246+120, margin_top + 3600), color=config["grid_color"]["end"],   thickness=3, lineType=cv2.LINE_4)
    for y in range(margin_top, 3600+margin_top+1, 60):
        cv2.line(base, pt1=(100, y), pt2=(MAX_PLAYERS*246+120, y), color=config["grid_color"]["even"] if (y-margin_top)%120==0 else config["grid_color"]["odd"], thickness=2 if (y-margin_top)%300==0 else 1, lineType=cv2.LINE_4)
        cv2.putText(base, text="{:02d}:00".format((3600+margin_top-y)//60), org=(10, y+10),         fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["grid_color"]["time"], thickness=2, lineType=cv2.LINE_4)
        cv2.putText(base, text="{:02d}:00".format((margin_top+y-300)//60),  org=(246*MAX_PLAYERS+120, y+10), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["grid_color"]["time"], thickness=2, lineType=cv2.LINE_4)
    cv2.line(base, pt1=(100, margin_top+1800), pt2=(MAX_PLAYERS*246+120, margin_top+1800), color=config["grid_color"]["30min"], thickness=3, lineType=cv2.LINE_4)
    cv2.putText(base, text="30:00", org=(10, margin_top+1810), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["grid_color"]["time30min"], thickness=2, lineType=cv2.LINE_4)
    cv2.putText(base, text="30:00", org=(246*MAX_PLAYERS+120, margin_top+1810), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["grid_color"]["time30min"], thickness=2, lineType=cv2.LINE_4)

    # 罫線の手前に表示したいもの
    label_y = layout_time_labels(details)
    remaining = "display_remaining" in setting
    for detail, pos in zip(details, label_y):
        x = player_list[detail["raw_name"]]

        # スコアレート
        est_score = float(detail["score_rate"])
        if est_score < 1.:
            cv2.putText(base, "{:2d}%".format(int(max(est_score, 0)*100)), org=(x+20, detail["battle_start"]+256+margin_top), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=3.0, color=config["score_rate"]["bgcolor"], thickness=16, lineType=cv2.LINE_4)
            cv2.putText(base, "{:2d}%".format(int(max(est_score, 0)*100)), org=(x+20, detail["battle_start"]+256+margin_top), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=3.0, color=config["score_rate"]["color"], thickness=8, lineType=cv2.LINE_4)

        # 戦闘開始・戦闘終了・出撃可能（重ならない位置は layout_time_labels で決める）
        cv2.putText(base, text=format_clock(detail["battle_start"], remaining), org=(x+112, pos["battle_start"]+margin_top), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["battle_start"]["bgcolor"], thickness=7, lineType=cv2.LINE_4)
        cv2.putText(base, text=format_clock(detail["battle_start"], remaining), org=(x+112, pos["battle_start"]+margin_top), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["battle_start"]["color"], thickness=2, lineType=cv2.LINE_4)
        cv2.putText(base, text=format_clock(detail["battle_end"], remaining), org=(x+112, pos["battle_end"]+margin_top), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["battle_end"]["bgcolor"], thickness=7, lineType=cv2.LINE_4)
        cv2.putText(base, text=format_clock(detail["battle_end"], remaining), org=(x+112, pos["battle_end"]+margin_top), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["battle_end"]["color"], thickness=2, lineType=cv2.LINE_4)
        cv2.putText(base, text=format_clock(detail["cool_off"], remaining), org=(x+112, pos["cool_off"]+margin_top), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["cool_off"]["bgcolor"], thickness=7, lineType=cv2.LINE_4)
        cv2.putText(base, text=format_clock(detail["cool_off"], remaining), org=(x+112, pos["cool_off"]+margin_top), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["battle_end"]["color"], thickness=2, lineType=cv2.LINE_4)
        # LV
        cv2.putText(base, text="Lv{:02d}".format(detail["level"]), org=(x+12, detail["battle_start"]+margin_top+(128 if "display_boss" in setting else 28)), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["level"]["bgcolor"], thickness=12, lineType=cv2.LINE_4)
        cv2.putText(base, text="Lv{:02d}".format(detail["level"]), org=(x+12, detail["battle_start"]+margin_top+(128 if "display_boss" in setting else 28)), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["level"]["color"], thickness=2, lineType=cv2.LINE_4)
        # 単体スコア
        cv2.putText(base, "{:>7,d}".format(detail["est_score"]), org=(x-4, detail["battle_start"]+margin_top+(160 if "display_boss" in setting else 60)), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=0.8, color=config["single_score"]["bgcolor"], thickness=12, lineType=cv2.LINE_4)
        cv2.putText(base, "{:>7,d}".format(detail["est_score"]), org=(x-4, detail["battle_start"]+margin_top+(160 if "display_boss" in setting else 60)), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=0.8, color=config["single_score"]["color"], thickness=2, lineType=cv2.LINE_4)
    
        # 戦闘時間
        if detail["play_time"] < 180:
            text = "{}sec".format(detail["play_time"])
            cv2.putText(base, text, org=(x+112, pos["play_time"]+margin_top+8), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["play_time"]["bgcolor"], thickness=14, lineType=cv2.LINE_4)
            cv2.putText(base, text, org=(x+112, pos["play_time"]+margin_top+8), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["play_time"]["color"], thickness=2, lineType=cv2.LINE_4)
  
    # スコア
    base[3840:] = 0
    if sum(min_scores.values()) < sum(player_scores.values()):
        cv2.putText(base, text="Est: {:,d}".format(sum(min_scores.values())), org=(3900, 3980), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=2.0, color=config["estimate_score"]["color"], thickness=6, lineType=cv2.LINE_4)
    cv2.putText(base, text="Max: {:,d}".format(sum(player_scores.values())), org=(4500, 3980), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=2.0, color=config["max_score"]["color"], thickness=6, lineType=cv2.LINE_4)
    # 個人スコア
    for i, s in enumerate(player_scores):
        if min_scores[s] < player_scores[s]:
            cv2.putText(base, "{:,d}".format(min_scores[s]), org=(i*246+145, 3880), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.2, color=config["estimate_score"]["color"], thickness=3, lineType=cv2.LINE_4)
        cv2.putText(base, "{:,d}".format(player_scores[s]), org=(i*246+145, 3920), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.2, color=config["max_score"]["color"], thickness=3, lineType=cv2.LINE_4)

    # ここからPILで処理
    font_name = ImageFont.truetype(BASE_DIR + setting["player_name"]["font"], setting["player_name"]["fontsize"])
    font_team = ImageFont.truetype(BASE_DIR + setting["team"]["font"], setting["team"]["fontsize"])
    img = Image.fromarray(base[:3600+margin_top+240]) # cv2(NumPy)型の画像をPIL型に変換
    draw = ImageDraw.Draw(img)
    for i, raw_name in enumerate(player_list):
        # メンバー名の描画
        name = get_player_name(setting, raw_name)
        w, _ = draw.textsize(name, font_name)
        draw.text((i*246+116+(246-w)//2, 48), name, font=font_name, fill=(*setting["player_name"]["color"], 0))

        # チーム名を描画
        if "display_team" in setting:
            if raw_name[:-2] in config["team"]["team_color"]:
                w, _ = draw.textsize(raw_name[:-2], font_team)
                draw.text((i*246+116+(246-w)//2, 8), raw_name[:-2], font=font_team, fill=(*config["team"]["team_color"][raw_name[:-2]], 0))

    # コメントを描画
    font = ImageFont.truetype(BASE_DIR + setting["comment_font"]["font"], setting["comment_font"]["fontsize"])
    draw.text((420, 3932), setting["comment"], font=font, fill=(*setting["comment_font"]["color"], 0))

    base = np.array(img) # PIL型の画像をcv2(NumPy)型に変換
    # ここまでPILで処理

    # 有利編成を描画
    for i, raw_name in enumerate(player_list):
        if "display_party" in setting:
            for idx, party_color in enumerate(party[raw_name]):
                cv2.circle(base, center=(i*246+44*idx+268-len(party[raw_name])*24, 120), radius=10, color=color_table[party_color], thickness=-1, lineType=cv2.LINE_4, shift=0)

    # ロゴ
    base[base.shape[0]-72:base.shape[0],0:380] = cv2.imread(BASE_DIR + setting["logo_image"])
    
    # 保存
    cv2.imwrite(dst, base)
