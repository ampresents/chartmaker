"""作戦 txt を検証して、階層の進みと予定スコアを出す (標準ライブラリだけで動く)。

使い方:
    python simulate.py plan.txt            # 人が読む形
    python simulate.py plan.txt --json     # 機械で読む形
    python simulate.py - < plan.txt        # 標準入力から

階層の数え方とスコアの式は references/rules.md と references/scoring.md に書いたものと
同じにする。ルールを変えたら、このファイルも合わせて直すこと。
"""
import argparse
import json
import math
import sys

BOSSES = ("1st_boss", "2nd_boss", "3rd_boss", "Realm_boss")
REGULAR = BOSSES[:3]
COOL_TIME = 300   # 出撃からクールタイム明けまで (timelag を除く)
CHART_SEC = 3600  # 作戦の長さ (60 分)
IDLE_WARN = 300   # これ以上何もしていない時間を「空き」として報告する


def split_action(item):
    """ChartLib.split_action と同じ。ID,待ち秒,ボス,戦闘秒[,割合][,lock|unlock[,注意点]] から
    ロックと注意点を除いた項目を返す (lock/unlock でも数でもない余分な項目があれば None)"""
    words = ("lock", "unlock")
    head, rest = item[:4], item[4:]
    if rest and rest[0].strip().lower() not in words:
        head.append(rest.pop(0))
    if rest and any(s.strip() for s in rest) and rest[0].strip().lower() not in words:
        return None
    return head


def parse(lines):
    """txt を (定数, 行動の一覧, エラーの一覧) にする。行動は出撃の絶対秒に直す"""
    const, actions, errors = {}, [], []
    clock = {}
    timelag = None
    raw = []
    for n, line in enumerate(lines, 1):
        line = line.rstrip("\r\n")
        if line.startswith("#"):
            continue
        if line.startswith("::"):
            key, _, value = line[2:].partition("=")
            const[key] = value if _ else None
            continue
        item = line.split(",")
        if len(item) <= 1:
            continue
        raw.append((n, line, split_action(item)))
    try:
        timelag = int(const.get("timelag") or 0)
    except ValueError:
        errors.append("::timelag が整数ではありません")
        timelag = 0
    for n, line, item in raw:
        if item is None or len(item) not in (4, 5) or item[2] not in BOSSES:
            errors.append(f"[{n}] 形式が違います: {line}")
            continue
        try:
            wait, sec = int(item[1]), int(item[3])
            rate = float(item[4]) if len(item) == 5 else 1.0
        except ValueError:
            errors.append(f"[{n}] 数値が読めません: {line}")
            continue
        p = item[0]
        if wait < 0:
            errors.append(f"[{n}] 待ち秒が負です (前の出撃のクールタイム中): {line}")
        push = clock.get(p, 0) + wait
        actions.append(dict(line=n, player=p, push=push, boss=item[2], sec=sec, rate=rate,
                            start=push + timelag, end=push + timelag + sec))
        clock[p] = push + timelag + COOL_TIME
    return const, timelag, actions, errors


def calc_floors(actions):
    """各階の撃破時刻。clear[f][boss] = 撃破の終了時刻 (f=0 は番兵)"""
    clear = [dict.fromkeys(BOSSES, 0)]
    cur = 1

    def at(f):
        while len(clear) <= f:
            clear.append(dict.fromkeys(BOSSES))
        return clear[f]

    for a in sorted(actions, key=lambda a: (a["push"], a["end"], a["boss"])):
        if a["boss"] == "Realm_boss":
            fl = at(cur)
            if any(fl[b] is None for b in REGULAR):
                # 3 体そろう前の Realm は前の階の Realm として数える
                prev = clear[cur - 1]
                prev["Realm_boss"] = min(prev["Realm_boss"], a["end"])
            else:
                fl["Realm_boss"] = a["end"] if fl["Realm_boss"] is None else min(fl["Realm_boss"], a["end"])
                cur += 1
        elif a["push"] > clear[cur - 1]["Realm_boss"]:
            fl = at(cur)
            fl[a["boss"]] = a["end"] if fl[a["boss"]] is None else min(fl[a["boss"]], a["end"])
    floor_time = [c["Realm_boss"] for c in clear]
    while floor_time and floor_time[-1] is None:
        floor_time.pop()
    return floor_time, clear


def level_of(start, floor_time):
    for f, t in enumerate(floor_time):
        if start < t:
            return f
    return len(floor_time)


def score_of(level, boss, rate):
    # TODO: references/scoring.md の式に合わせる
    base = 50000 * min((level - 1) // 5 + 1, 5) * (1.2 if boss == "Realm_boss" else 1.0)
    return math.ceil(base * max(min(rate, 1.0), 0.0))


def simulate(lines):
    const, timelag, actions, errors = parse(lines)
    floor_time, clear = calc_floors(actions)
    warnings = []
    for a in actions:
        a["level"] = level_of(a["start"], floor_time)
        a["score"] = score_of(a["level"], a["boss"], a["rate"])
        if a["push"] < 0 or a["end"] > CHART_SEC:
            warnings.append(f"[{a['line']}] {a['player']} の戦闘が 0–{CHART_SEC} 秒の外にあります ({a['push']}–{a['end']})")
        if a["level"] < 1:
            warnings.append(f"[{a['line']}] {a['player']} の戦闘が階層 0 に数えられます (1 階が始まる前)")

    # プレイヤーごとの空き (クールタイム明けから次の出撃まで)
    idle = {}
    for p in dict.fromkeys(a["player"] for a in actions):
        mine = sorted((a for a in actions if a["player"] == p), key=lambda a: a["push"])
        ready, gaps = 0, []
        for a in mine:
            if a["push"] - ready >= IDLE_WARN:
                gaps.append((ready, a["push"]))
            ready = a["push"] + timelag + COOL_TIME
        if CHART_SEC - ready >= IDLE_WARN:
            gaps.append((ready, CHART_SEC))
        if gaps:
            idle[p] = gaps

    floors = []
    for f in range(1, len(clear)):
        c = clear[f]
        if all(v is None for v in c.values()):
            break
        floors.append({"floor": f, **{b: c[b] for b in BOSSES}})
    return {
        "errors": errors,
        "warnings": warnings,
        "total_score": sum(a["score"] for a in actions),
        "max_level": max((a["level"] for a in actions), default=0),
        "battles": len(actions),
        "players": len({a["player"] for a in actions}),
        "floors": floors,
        "idle": idle,
        "actions": actions,
    }


def clock(sec):
    return f"{sec // 60:02d}:{sec % 60:02d}" if sec is not None else "--:--"


def report(r):
    out = []
    for e in r["errors"]:
        out.append(f"ERROR {e}")
    for w in r["warnings"]:
        out.append(f"WARN  {w}")
    out.append(f"予定スコア {r['total_score']:,} / 到達 Lv{r['max_level']} / {r['battles']} 戦 / {r['players']} 人")
    out.append("階  1st    2nd    3rd    Realm")
    for f in r["floors"]:
        out.append(f"{f['floor']:>2}  " + "  ".join(clock(f[b]) for b in BOSSES))
    if r["idle"]:
        out.append(f"空き ({IDLE_WARN} 秒以上):")
        for p, gaps in r["idle"].items():
            out.append(f"  {p}: " + ", ".join(f"{clock(a)}–{clock(b)}" for a, b in gaps))
    else:
        out.append(f"空き ({IDLE_WARN} 秒以上): なし")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("file", help="作戦 txt (- で標準入力)")
    ap.add_argument("--json", action="store_true", help="JSON で出す")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")  # Windows のコンソール (cp932) でも – などを出せるように
    if args.file == "-":
        sys.stdin.reconfigure(encoding="utf-8")
        lines = sys.stdin.read().splitlines()
    else:
        with open(args.file, encoding="utf-8") as f:
            lines = f.read().splitlines()
    r = simulate(lines)
    if args.json:
        print(json.dumps(r, ensure_ascii=False, indent=1))
    else:
        print(report(r))
    sys.exit(1 if r["errors"] else 0)


if __name__ == "__main__":
    main()
