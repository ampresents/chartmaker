# ChartLib の構文解析・階層進行・得点計算・時刻ラベル配置
import pytest

from conftest import read_fixture
from ChartLib import (COOL_TIME, calc_level, format_clock, generate_detail, layout_time_labels, parse,
                      LABEL_PAD)


def lines(text):
    return text.splitlines(True)


# ---------------------------------------------------------------- parse

def test_parse_constants_comments_and_actions():
    commands, constants = parse(lines(
        "# コメント\n"
        "::timelag=3\n"
        "::display_boss\n"
        "::Alpha01=山田\n"
        "\n"
        "Alpha01,5,1st_boss,30\n"
        "Alpha01,0,Realm_boss,40,0.5\r\n"
        "Beta01,1,2nd_boss,20"  # 最終行に改行が無くても欠けない
    ))
    assert constants == {"timelag": "3", "display_boss": None, "Alpha01": "山田"}
    assert commands == [
        ("Alpha01", "5", "1st_boss", "30", "1.0"),  # 与ダメージ率の既定は 1.0
        ("Alpha01", "0", "Realm_boss", "40", "0.5"),
        ("Beta01", "1", "2nd_boss", "20", "1.0"),
    ]


def test_parse_ignores_gui_lock_lines():
    # GUI はロックした行動の次の行に #lock を書く。チャートには影響しない
    plain = "::timelag=0\nAlpha01,5,1st_boss,30\nAlpha01,0,2nd_boss,40\n"
    locked = "::timelag=0\nAlpha01,5,1st_boss,30\n#lock\nAlpha01,0,2nd_boss,40\n#lock\n"
    assert parse(lines(locked)) == parse(lines(plain))


@pytest.mark.parametrize("line", [
    "Alpha01,5,4th_boss,30",     # 不明なボス
    "Alpha01,x,1st_boss,30",     # 待ち秒数が整数でない
    "Alpha01,5,1st_boss,3.5",    # 戦闘秒数が整数でない
    "Alpha01,5,1st_boss,30,abc", # 与ダメージ率が数でない
    "Alpha01,5,1st_boss",        # 項目が足りない
])
def test_parse_rejects_bad_action(line):
    with pytest.raises(Exception, match=r"\[line:2\]"):
        parse(lines("::timelag=0\n" + line + "\n"))


# ---------------------------------------------------------------- calc_level / generate_detail

def cmd(player, wait, boss, battle, rate="1.0"):
    return (player, str(wait), boss, str(battle), rate)


def test_calc_level_needs_three_regular_bosses_before_realm():
    commands = [
        cmd("A01", 10, "1st_boss", 20),    # 10-30
        cmd("B01", 10, "2nd_boss", 30),    # 10-40
        cmd("D01", 5, "Realm_boss", 20),   # 5-25: 3 体が残っているので進まない
        cmd("C01", 10, "3rd_boss", 40),    # 10-50
        cmd("D01", 300, "Realm_boss", 30), # 5+300+300=605-635: 1F クリア
        cmd("A01", 400, "1st_boss", 20),   # 710-730: 2F は 1st だけ (2F が開く 635 より後の出撃だけ数える)
    ]
    floor_time, clear_time = calc_level(commands, 0, COOL_TIME)
    assert floor_time == [0, 635]  # 未クリアの階層は末尾から削る
    assert clear_time[1] == {"1st_boss": 30, "2nd_boss": 40, "3rd_boss": 50, "Realm_boss": 635}
    assert clear_time[2] == {"1st_boss": 730, "2nd_boss": None, "3rd_boss": None, "Realm_boss": None}


def test_calc_level_includes_timelag_and_cooldown():
    # 2 回目の出撃は 前回の出撃 + timelag + 300
    commands = [
        cmd("A01", 1, "1st_boss", 10), cmd("B01", 1, "2nd_boss", 10), cmd("C01", 1, "3rd_boss", 10),
        cmd("A01", 0, "Realm_boss", 10),
    ]
    floor_time, _ = calc_level(commands, 3, COOL_TIME)
    assert floor_time == [0, 1 + 303 + 3 + 10]


def test_calc_level_quirk_push_at_zero_is_not_counted():
    # 出撃 0 秒の通常ボスは 1F に数えない (push_start > 0 が条件)
    commands = [cmd("A01", 0, "1st_boss", 10), cmd("B01", 1, "2nd_boss", 10), cmd("C01", 1, "3rd_boss", 10)]
    _, clear_time = calc_level(commands, 0, COOL_TIME)
    assert clear_time[1]["1st_boss"] is None
    assert clear_time[1]["2nd_boss"] == 11


def test_generate_detail_times_and_names():
    commands = [cmd("Alpha01", 5, "1st_boss", 30, "0.5"), cmd("Alpha01", 10, "2nd_boss", 40)]
    d1, d2 = generate_detail(commands, {"timelag": "3", "Alpha01": "山田"})
    assert (d1["push_start"], d1["battle_start"], d1["battle_end"], d1["cool_off"]) == (5, 8, 38, 308)
    assert (d2["push_start"], d2["battle_start"], d2["battle_end"]) == (5 + 303 + 10, 321, 361)
    assert (d1["player_name"], d1["raw_name"], d1["team"]) == ("山田", "Alpha01", "Alpha")
    assert (d1["score"], d1["est_score"]) == (50000, 25000)


def test_generate_detail_score_by_level():
    commands, constants = parse(lines(read_fixture("plan_full.txt")))
    detail = generate_detail(commands, constants)
    levels = {d["level"] for d in detail}
    assert {1, 5, 6, 10, 11} <= levels
    for d in detail:
        base = 50000 * min((d["level"] - 1) // 5 + 1, 5)
        assert d["score"] == int(base * (1.2 if d["action"] == "Realm_boss" else 1))
    by_level = {(d["level"], d["action"]): d["score"] for d in detail}
    assert by_level[(5, "1st_boss")] == 50000
    assert by_level[(6, "1st_boss")] == 100000
    assert by_level[(11, "Realm_boss")] == 180000


def test_generate_detail_score_is_capped_at_level_21():
    # 1 周 (3 体 + Realm) を 30 回繰り返す
    commands = []
    for i in range(30):
        wait = 1 if i == 0 else 0
        commands += [cmd("A01", wait, "1st_boss", 10), cmd("B01", wait, "2nd_boss", 10),
                     cmd("C01", wait, "3rd_boss", 10), cmd("D01", wait + 20 if i == 0 else 0, "Realm_boss", 10)]
    detail = generate_detail(commands, {"timelag": "0"})
    assert max(d["level"] for d in detail) == 30
    assert {d["score"] for d in detail if d["level"] >= 21 and d["action"] == "1st_boss"} == {250000}


@pytest.mark.parametrize("rate, est", [("1.0", 50000), ("0.333", 16650), ("1.5", 50000), ("-1", 0)])
def test_est_score_rate_is_clamped(rate, est):
    (d,) = generate_detail([cmd("A01", 1, "1st_boss", 10, rate)], {"timelag": "0"})
    assert d["est_score"] == est


# ---------------------------------------------------------------- format_clock

@pytest.mark.parametrize("sec, remaining, text", [
    (0, False, "00:00"), (125, False, "02:05"), (3600, False, "60:00"),
    (0, True, "60:00"), (3595, True, "00:05"), (3700, True, "-01:40"),
])
def test_format_clock(sec, remaining, text):
    assert format_clock(sec, remaining) == text


# ---------------------------------------------------------------- layout_time_labels

def detail_at(player, battle_start, play_time):
    return {"raw_name": player, "battle_start": battle_start, "battle_end": battle_start + play_time,
            "play_time": play_time, "cool_off": battle_start + COOL_TIME}


def test_layout_keeps_default_positions_when_far_apart():
    (pos,) = layout_time_labels([detail_at("A01", 600, 200)])
    assert pos == {"battle_start": 612, "battle_end": 796, "cool_off": 888}


def test_layout_spreads_overlapping_labels():
    # 短い戦闘が隙間なく続くとラベルが重なるので、間隔を空けて並べ直す
    details = [detail_at("A01", 600 + i * 300, 5) for i in range(3)] + [detail_at("B01", 600, 5)]
    positions = layout_time_labels(details)
    heights = {"battle_start": (25, 4), "battle_end": (25, 4), "play_time": (28, 7), "cool_off": (25, 4)}
    ys = sorted((y, kind) for pos in positions[:3] for kind, y in pos.items())
    for (y1, k1), (y2, k2) in zip(ys, ys[1:]):
        assert y2 - y1 >= heights[k1][1] + heights[k2][0] + LABEL_PAD - 1  # 丸めの 1 画素は許す
    # 別のプレイヤーの列には影響しない
    assert positions[3] == layout_time_labels([detail_at("B01", 600, 5)])[0]


def test_layout_does_not_go_above_header():
    (pos,) = layout_time_labels([detail_at("A01", 0, 1)])
    assert pos["battle_start"] >= 12
