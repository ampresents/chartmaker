import warnings
warnings.filterwarnings('ignore')

import cv2
import json
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from mysite.settings import BASE_DIR

# 構文解析
def parse(text, item_num=5):
    chart = []
    constant = {}
    for i, line in enumerate(text):
        # コメント
        if line[0] == "#":
            continue
        # 予約語の処理
        if line[:2] == "::":
            tokens =line[2:-1].split("=")
            constant[tokens[0]] = tokens[1] if len(tokens) > 1 else None
            continue
        # 行動の処理
        item = tuple(line[:-1].split(",")) # 行末の\nを削除
        if len(item) <= 1:
            continue

        item = item + ("1.0",)  # 見積もりはデフォルトでワンパン
        if len(item) < item_num:
            raise Exception("[line:{}] {}".format(i+1, line))

        if item[2] in ("1st_boss", "2nd_boss", "3rd_boss", "Realm_boss"):
            chart.append(item[:item_num])
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
        battle_end = push_start + timelag + (120 if action_time is None else int(action_time))
        new_info.append((push_start, battle_end, action))
        
        current_pos[player_name] += timelag + cool_time

    clear_time = [{"1st_boss":0, "2nd_boss":0, "3rd_boss":0, "Realm_boss":0}] + [{"1st_boss":None, "2nd_boss":None, "3rd_boss":None, "Realm_boss":None} for _ in range(50)]
    current_floor = 1

    for push_start, battle_end, action in sorted(new_info):
        if action == "Realm_boss":
            if None in (clear_time[current_floor]["1st_boss"], clear_time[current_floor]["2nd_boss"], clear_time[current_floor]["3rd_boss"]):
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
    cool_time = 300
    detail = []
    current_pos = {}
    timelag = int(constant["timelag"])

    floor_time, clear_time = calc_level(commands, timelag, cool_time)
    with open(BASE_DIR + "/output/cleartime.json", "w") as cleartime:
        cleartime.write(json.dumps(clear_time, indent=4))
    
    for player_name, waiting_time, action, action_time, score_rate in commands:
        current_pos.setdefault(player_name, 0)

        current_pos[player_name] += int(waiting_time)
        play_time = 120 if action_time is None else int(action_time)

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

    with open(BASE_DIR + "/output/detail.json", "w") as detailjson:
        detailjson.write(json.dumps(detail, indent=4, ensure_ascii=False))
    return detail


# 画像生成
def generate_chart(src, dst, config, margin_top=160):
    with open(src, "r", encoding="utf-8") as p1:
        text = p1.readlines()
        commands, constant_from_txt = parse(text)
    setting = dict(config, **constant_from_txt)

    color_table = config["color_table"]
    advantage = {"blue":"yellow", "red":"blue", "green":"red", "yellow":"green", "white":"white"}

    player_list = {}
    current_pos = {}
    party = {}
    player_scores = {}
    min_scores = {}

    base = np.full((6400, 220 + 20*246, 3), 0, dtype=np.uint8) # 縦広めにとっておく
    
    # 罫線の奥に表示したいもの
    for detail in generate_detail(commands, setting):
        player_name = detail["raw_name"]
        current_pos[player_name] = 0
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
            boss_images = {
                "1st_boss"  :cv2.imread(BASE_DIR + setting["image_1st"]),
                "2nd_boss"  :cv2.imread(BASE_DIR + setting["image_2nd"]),
                "3rd_boss"  :cv2.imread(BASE_DIR + setting["image_3rd"]),
                "Realm_boss":cv2.imread(BASE_DIR + setting["image_realm"])
            }
            boss_img = boss_images[detail["action"]]
            base[detail["battle_start"]+margin_top:detail["battle_start"]+margin_top+boss_img.shape[0],x:x+boss_img.shape[1],:] = boss_img

    # 罫線
    cv2.line(base, pt1=(100, margin_top),        pt2=(20*246+120, margin_top),        color=config["grid_color"]["start"], thickness=3, lineType=cv2.LINE_4)
    cv2.line(base, pt1=(100, margin_top + 3600), pt2=(20*246+120, margin_top + 3600), color=config["grid_color"]["end"],   thickness=3, lineType=cv2.LINE_4)
    for y in range(margin_top, 3600+margin_top+1, 60):
        cv2.line(base, pt1=(100, y), pt2=(20*246+120, y), color=config["grid_color"]["even"] if (y-margin_top)%120==0 else config["grid_color"]["odd"], thickness=2 if (y-margin_top)%300==0 else 1, lineType=cv2.LINE_4)
        cv2.putText(base, text="{:02d}:00".format((3600+margin_top-y)//60), org=(10, y+10),         fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["grid_color"]["time"], thickness=2, lineType=cv2.LINE_4)
        cv2.putText(base, text="{:02d}:00".format((margin_top+y-300)//60),  org=(246*20+120, y+10), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["grid_color"]["time"], thickness=2, lineType=cv2.LINE_4)
    cv2.line(base, pt1=(100, margin_top+1800), pt2=(20*246+120, margin_top+1800), color=config["grid_color"]["30min"], thickness=3, lineType=cv2.LINE_4)
    cv2.putText(base, text="30:00", org=(10, margin_top+1810), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["grid_color"]["time30min"], thickness=2, lineType=cv2.LINE_4)
    cv2.putText(base, text="30:00", org=(246*20+120, margin_top+1810), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["grid_color"]["time30min"], thickness=2, lineType=cv2.LINE_4)

    # 罫線の手前に表示したいもの
    for detail in generate_detail(commands, setting):
        # プレイヤーを追加
        player_list.setdefault(detail["raw_name"], 120 + len(player_list)*246)
        x = player_list[detail["raw_name"]]

        # スコアレート
        est_score = float(detail["score_rate"])
        if est_score < 1.:
            cv2.putText(base, "{:2d}%".format(int(max(est_score, 0)*100)), org=(x+20, detail["battle_start"]+256+margin_top), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=3.0, color=config["score_rate"]["bgcolor"], thickness=16, lineType=cv2.LINE_4)
            cv2.putText(base, "{:2d}%".format(int(max(est_score, 0)*100)), org=(x+20, detail["battle_start"]+256+margin_top), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=3.0, color=config["score_rate"]["color"], thickness=8, lineType=cv2.LINE_4)

        # 戦闘開始・戦闘終了・出撃可能
        cv2.putText(base, text="{:02d}:{:02d}".format(detail["battle_start"]//60,detail["battle_start"]%60), org=(x+104, detail["battle_start"]+24+margin_top-12), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["battle_start"]["bgcolor"], thickness=7, lineType=cv2.LINE_4)
        cv2.putText(base, text="{:02d}:{:02d}".format(detail["battle_start"]//60,detail["battle_start"]%60), org=(x+104, detail["battle_start"]+24+margin_top-12), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["battle_start"]["color"], thickness=2, lineType=cv2.LINE_4)
        cv2.putText(base, text="{:02d}:{:02d}".format(detail["battle_end"]//60,detail["battle_end"]%60), org=(x+104, detail["battle_end"]-4+margin_top), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["battle_end"]["bgcolor"], thickness=7, lineType=cv2.LINE_4)
        cv2.putText(base, text="{:02d}:{:02d}".format(detail["battle_end"]//60,detail["battle_end"]%60), org=(x+104, detail["battle_end"]-4+margin_top), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["battle_end"]["color"], thickness=2, lineType=cv2.LINE_4)
        cv2.putText(base, text="{:02d}:{:02d}".format(detail["cool_off"]//60,detail["cool_off"]%60), org=(x+104, detail["cool_off"]+margin_top-12), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["cool_off"]["bgcolor"], thickness=7, lineType=cv2.LINE_4)
        cv2.putText(base, text="{:02d}:{:02d}".format(detail["cool_off"]//60,detail["cool_off"]%60), org=(x+104, detail["cool_off"]+margin_top-12), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["battle_end"]["color"], thickness=2, lineType=cv2.LINE_4)
        # LV
        cv2.putText(base, text="Lv{:02d}".format(detail["level"]), org=(x+12, detail["battle_start"]+margin_top+(128 if "display_boss" in setting else 28)), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["level"]["bgcolor"], thickness=12, lineType=cv2.LINE_4)
        cv2.putText(base, text="Lv{:02d}".format(detail["level"]), org=(x+12, detail["battle_start"]+margin_top+(128 if "display_boss" in setting else 28)), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["level"]["color"], thickness=2, lineType=cv2.LINE_4)
        # 単体スコア
        cv2.putText(base, "{:>7,d}".format(detail["est_score"]), org=(x-4, detail["battle_start"]+margin_top+(160 if "display_boss" in setting else 60)), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=0.8, color=config["single_score"]["bgcolor"], thickness=12, lineType=cv2.LINE_4)
        cv2.putText(base, "{:>7,d}".format(detail["est_score"]), org=(x-4, detail["battle_start"]+margin_top+(160 if "display_boss" in setting else 60)), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=0.8, color=config["single_score"]["color"], thickness=2, lineType=cv2.LINE_4)
    
        # 戦闘時間
        if detail["play_time"] < 180:
            #text = "No limit" if detail["play_time"] > 190 else "{}sec".format(detail["play_time"])
            text = "{}sec".format(detail["play_time"])
            cv2.putText(base, text, org=(x+108, detail["battle_end"]+40+margin_top), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["play_time"]["bgcolor"], thickness=14, lineType=cv2.LINE_4)
            cv2.putText(base, text, org=(x+108, detail["battle_end"]+40+margin_top), fontFace=cv2.FONT_HERSHEY_SIMPLEX, fontScale=1.0, color=config["play_time"]["color"], thickness=2, lineType=cv2.LINE_4)
  
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
    for i, raw_name in enumerate(current_pos.keys()):
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
    draw.text((420, 3940), setting["comment"], font=font, fill=(*setting["comment_font"]["color"], 0))

    base = np.array(img) # PIL型の画像をcv2(NumPy)型に変換
    # ここまでPILで処理

    # 有利編成を描画
    for i, raw_name in enumerate(current_pos.keys()):
        if "display_party" in setting:
            for idx, party_color in enumerate(party[raw_name]):
                cv2.circle(base, center=(i*246+44*idx+268-len(party[raw_name])*24, 120), radius=10, color=color_table[party_color], thickness=-1, lineType=cv2.LINE_4, shift=0)

    # ロゴ
    base[base.shape[0]-72:base.shape[0],0:380] = cv2.imread(BASE_DIR + setting["logo_image"])
    
    # 保存
    cv2.imwrite(dst, base)
