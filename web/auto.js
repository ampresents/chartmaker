"use strict";
// 作戦の自動作成 (β)。プレイヤーごとの強さの表から、貪欲法で作戦を組み、方針のパラメータを探索して予定スコアを最大にする。
// すべてブラウザで計算し、サーバーには最後の確認 (/api/detail) しか送らない。強さの表と設定は localStorage にだけ残す。
// app.js の後に読み込む。トップレベルの名前は auto / AUTO_ で始める。

const AUTO_KEY = "chartmaker.auto.v1";
const AUTO_REG = ["1st_boss", "2nd_boss", "3rd_boss"];
const AUTO_REG_SEC = 30;   // 1st/2nd/3rd は全階層 30 秒で倒す見積もり
const AUTO_DEFAULTS = {
  realmLow: [30, 36, 36, 38, 40, 44, 46, 50, 50, 55],  // Lv1–10 の Realm (1 人で倒す) の秒数
  killSec: 100,    // Lv11–20 の撃破役
  grindSec: 280,   // Lv11–20 の稼ぎ役
  topSec: 280,     // Lv21 以降
  margin: 6,       // 撃破から次の出撃までの余裕
  count: 20,       // 名前のあるプレイヤーがいないときの人数
  seconds: 10,     // 探索時間
};
const AUTO_POWER = [50, 100, 100];  // 強さの既定値 (%): 撃破役 100 秒、稼ぎ役 280 秒、Lv21 以降
// Realm を担当できる範囲。0: なし (1st/2nd/3rd のみ)、1: Lv10 まで、2: Lv20 まで、3: Lv21 以降も
const AUTO_TIERS = ["なし (1st/2nd/3rd のみ)", "Lv10 まで", "Lv20 まで", "Lv21 以降も"];
const AUTO_TIER_MAX = [0, 10, 20, Infinity];
const AUTO_TIER = 3;
const AUTO_STAGGER = [0, 7, 15, 23, 37, 61];
const AUTO_JOIN_FROM = [1, 6, 11, 16, 21];

let autoRunning = null;  // 実行中の {stop: bool}

// 計算の合間に一度イベントを処理させる。setTimeout は裏のタブで 1 秒に 1 回まで絞られるので、MessageChannel を使う
const autoChannel = new MessageChannel();
const autoWaiting = [];
autoChannel.port1.onmessage = () => autoWaiting.shift()?.();
function autoYield() {
  return new Promise((r) => { autoWaiting.push(r); autoChannel.port2.postMessage(0); });
}

function autoLoad() {
  let d = {};
  try { d = JSON.parse(localStorage.getItem(AUTO_KEY)) || {}; } catch (e) { /* 壊れていたら既定値 */ }
  return { ...AUTO_DEFAULTS, ...d, power: d.power && typeof d.power === "object" ? d.power : {},
    tier: d.tier && typeof d.tier === "object" ? d.tier : {} };
}

function autoSave(s) {
  try { localStorage.setItem(AUTO_KEY, JSON.stringify(s)); } catch (e) { /* 保存できなくても動作は続ける */ }
}

// ---------------------------------------------------------------- 作戦の組み立て

// power[i] = [撃破役, 稼ぎ役, Lv21 以降] (0–1)。cfg は秒数の設定 (cfg.tier[i] は AUTO_TIERS の番号、省略で全員 3)、
// p は方針のパラメータ。1 秒ずつ進め、開いたボスに撃破役を出し、残りの人は先の撃破役が足りる範囲で合流させる。
// 戦闘の一覧 [{i, t, boss, level, sec, rate}] を返す
function autoBuild(cfg, rawPower, p) {
  const n = rawPower.length;
  const { lag, cool, margin: m, realmLow, killSec, grindSec, topSec } = cfg;
  const tier = cfg.tier || rawPower.map(() => AUTO_TIER);
  const can = (i, f) => f <= AUTO_TIER_MAX[tier[i]];
  // 担当できない階層帯の強さは 0 として扱う
  const power = autoMask(rawPower, tier);
  const ready = p.offset.slice();
  const all = power.map((_, i) => i);
  const kNeed = autoTeamSize(power, 0, all.filter((i) => tier[i] >= 2)) + p.kadd;
  const tNeed = autoTeamSize(power, 2, all.filter((i) => tier[i] >= 3));
  const need = (f) => (f <= 10 ? 1 : f <= 20 ? kNeed : tNeed);
  const realmSec = (f) => (f <= 10 ? realmLow[f - 1] : f <= 20 ? killSec : topSec);
  // 全員でも 100% に届かない階層帯は倒せないので、全員が稼ぎ役として Realm に挑む
  const stuck = [0, 2].map((k) => power.reduce((s, x) => s + x[k], 0) < 1 - 1e-9);
  const order = p.killer === "strong" ? (a, b) => power[b][0] - power[a][0] : (a, b) => power[a][0] - power[b][0];
  let floor = 1, openReg = 1, kills = {}, realmOpen = null, rkill = null;
  const battles = [];
  const go = (i, t, boss, sec, rate) => {
    battles.push({ i, t, boss, level: floor, sec, rate });
    ready[i] = t + cool;
  };
  const fits = (t, sec) => t + lag + sec <= CHART_SEC;
  // free の中で担当範囲が一番狭い人 (同じなら free の順)。Realm に回せる人を残すため
  const narrowest = (free, ok) => {
    let x = -1;
    for (let y = 0; y < free.length; y++) if (ok(free[y]) && (x < 0 || tier[free[y]] < tier[free[x]])) x = y;
    return x;
  };

  for (let t = 1; t < CHART_SEC; t++) {
    if (rkill !== null && t >= rkill + Math.max(m, 1)) {
      floor++;
      openReg = t;
      kills = {}; realmOpen = null; rkill = null;
    }
    if (realmOpen === null && Object.keys(kills).length === 3 && t >= Math.max(...Object.values(kills)) + m) realmOpen = t;
    const free = [];
    for (let i = 0; i < n; i++) if (ready[i] <= t) free.push(i);
    if (!free.length) continue;
    free.sort(order);

    let alive = [];
    if (realmOpen === null) {
      if (t >= openReg) {
        for (const b of AUTO_REG) {
          if (!(b in kills) && free.length && fits(t, AUTO_REG_SEC)) {
            go(free.splice(narrowest(free, () => true), 1)[0], t, b, AUTO_REG_SEC, 1);
            kills[b] = t + lag + AUTO_REG_SEC;
          }
        }
        alive = AUTO_REG.filter((b) => t < (kills[b] ?? 0));
      }
    } else if (rkill === null) {
      const k = floor <= 20 ? 0 : 2;
      if (floor <= 10) {
        const sec = realmLow[floor - 1];
        const x = narrowest(free, (i) => can(i, floor));
        if (x >= 0 && fits(t, sec)) {
          go(free.splice(x, 1)[0], t, "Realm_boss", sec, 1);
          rkill = t + lag + sec;
        }
      } else if (!stuck[k / 2]) {
        const sec = realmSec(floor);
        const team = autoPickKillers(free.filter((i) => can(i, floor)), power, k, p.killer);
        if (team && fits(t, sec)) {
          for (const i of team) {
            free.splice(free.indexOf(i), 1);
            go(i, t, "Realm_boss", sec, Math.min(power[i][k], 1));
          }
          rkill = t + lag + sec;
        }
      }
      alive = (rkill !== null && t < rkill) || (floor > 10 && stuck[floor <= 20 ? 0 : 1]) ? ["Realm_boss"] : [];
    } else {
      alive = t < rkill ? ["Realm_boss"] : [];
    }

    if (floor < p.joinFrom || !alive.length) continue;
    // 合流 (稼ぎ役)。撃破役に向かない人から出す
    free.reverse();
    const events = autoUpcoming(t, floor, kills, realmOpen, rkill, cfg, need, realmSec);
    let j = 0;
    while (free.length) {
      const x = free.findIndex((i) => alive.some((b) => b !== "Realm_boss" || can(i, floor)) && autoSpare(i, ready, events, p.slack, can));
      if (x < 0) break;
      const i = free.splice(x, 1)[0];
      const opts = alive.filter((b) => b !== "Realm_boss" || can(i, floor));
      const b = opts[j++ % opts.length];
      let sec, rate;
      if (b !== "Realm_boss") [sec, rate] = [AUTO_REG_SEC, 1];
      else if (floor <= 10) [sec, rate] = [realmLow[floor - 1], 1];
      else if (floor <= 20) [sec, rate] = [grindSec, power[i][1]];
      else [sec, rate] = [topSec, power[i][2]];
      if (fits(t, sec)) go(i, t, b, sec, rate);
    }
  }
  autoFill(cfg, power, can, battles);
  return battles;
}

// 1 クール以上空いている所に、階層の進み (各ボスの撃破時刻) を変えない戦闘を足す。足した分だけ予定スコアが増える。
// calc_level と同じ数え方で、各階のボスに合流できる出撃時刻の範囲を求め、空きごとに一番点の高い戦闘を入れる
function autoFill(cfg, power, can, battles) {
  const { lag, cool, realmLow, grindSec, topSec } = cfg;
  const end = (b) => b.t + lag + b.sec;
  // floors[f] = {reg: {boss: 撃破の終了時刻}, realm: {push: 最初の出撃, end: 撃破の終了時刻}}
  const floors = [{ reg: {}, realm: { push: 0, end: 0 } }];
  const at = (f) => floors[f] || (floors[f] = { reg: {}, realm: null });
  let cur = 1;
  const sorted = battles.slice().sort((x, y) => x.t - y.t || end(x) - end(y) || (x.boss < y.boss ? -1 : x.boss > y.boss ? 1 : 0));
  for (const b of sorted) {
    if (b.boss === "Realm_boss") {
      const f = at(cur);
      if (AUTO_REG.some((r) => !(r in f.reg))) floors[cur - 1].realm.end = Math.min(floors[cur - 1].realm.end, end(b));
      else { f.realm = f.realm ? { push: f.realm.push, end: Math.min(f.realm.end, end(b)) } : { push: b.t, end: end(b) }; cur++; }
    } else if (b.t > floors[cur - 1].realm.end) {
      const f = at(cur);
      f.reg[b.boss] = Math.min(f.reg[b.boss] ?? Infinity, end(b));
    }
  }
  const ft = floors.map((f) => f.realm?.end ?? null);
  while (ft.length && ft[ft.length - 1] === null) ft.pop();
  const levelAt = (t) => { const f = ft.findIndex((x) => x !== null && t + lag < x); return f < 0 ? ft.length : f; };
  const lastRealm = (f) => sorted.some((b) => b.boss === "Realm_boss" && b.t > floors[f - 1].realm.end);

  // 戦闘を足せる範囲 [{f, boss, lo, hi}] (出撃は lo 以上 hi 未満)。撃破より先に終わると撃破役が変わるので、終了は撃破以降にする
  const spans = [];
  for (let f = 1; f < floors.length; f++) {
    const fl = floors[f], prev = floors[f - 1].realm;
    if (!prev) break;
    for (const r of AUTO_REG) {
      if (r in fl.reg) spans.push({ f, boss: r, lo: Math.max(prev.end + 1, fl.reg[r] - lag - AUTO_REG_SEC), hi: fl.reg[r] });
      // 最後の階でまだ倒していないボスは、Realm の出撃がなければ倒しても階層の数え方は変わらない
      else if (f === cur && !lastRealm(f)) spans.push({ f, boss: r, lo: prev.end + 1, hi: CHART_SEC });
    }
    if (fl.realm) spans.push({ f, boss: "Realm_boss", lo: fl.realm.push, hi: fl.realm.end });
  }

  // i が t に出撃して spans の s に合流する戦闘。できなければ null
  const make = (i, t, s) => {
    let sec = AUTO_REG_SEC, rate = 1;
    if (s.boss === "Realm_boss") {
      if (!can(i, s.f)) return null;
      if (s.f <= 10) sec = realmLow[s.f - 1];
      else [sec, rate] = s.f <= 20 ? [grindSec, power[i][1]] : [topSec, power[i][2]];
      // 時間切れになる稼ぎ役は、戦える秒数の分だけ与える見積もり
      const left = CHART_SEC - lag - t;
      if (left < sec && s.f > 10) { rate *= left / sec; sec = left; }
      if (t + lag + sec < s.hi) return null;
    }
    rate = Math.round(rate * 100) / 100; // 作戦には小数 2 桁で書くので、見積もりも合わせる
    if (sec < 1 || rate < 0.01 || t + lag + sec > CHART_SEC) return null;
    return { i, t, boss: s.boss, level: levelAt(t), sec, rate };
  };

  // b が撃破役でない合流の戦闘なら、その範囲 (後ろへずらしても撃破時刻は変わらない)。
  // 同じ時刻に倒す人がほかにもいれば、b は撃破役でなくてもよい
  const inSpan = (b, s) => s.boss === b.boss && s.lo <= b.t && b.t < s.hi && end(b) >= s.hi;
  const spanOf = (b) => spans.find((s) => inSpan(b, s) && (b.boss !== "Realm_boss" || b.t > s.lo) &&
    (end(b) > s.hi || battles.some((x) => x !== b && inSpan(x, s) && end(x) === s.hi)));

  for (let i = 0; i < power.length; i++) {
    for (;;) {
      const mine = battles.filter((b) => b.i === i).sort((x, y) => x.t - y.t);
      const memo = new Map(), spanOfMine = (b) => memo.has(b) ? memo.get(b) : memo.set(b, spanOf(b)).get(b);
      let best = null, bestScore = 0, moved = null;
      for (let k = 0; k <= mine.length; k++) {
        const lo = k ? mine[k - 1].t + cool : 1;
        // 隙間がなく、次の戦闘もずらせないなら入らない
        if (k < mine.length && lo > mine[k].t - cool && !spanOfMine(mine[k])) continue;
        for (const s of spans) {
          const t = Math.max(lo, s.lo);
          if (t >= s.hi) continue;
          const b = make(i, t, s);
          if (!b) continue;
          let sc = autoScore([b]), mv = [];
          // 後ろの戦闘が合流なら、それぞれの範囲の中で後ろへずらして隙間を作る (間は 1 クール空ける)
          for (let j = k, prevT = t; j < mine.length && mine[j].t < prevT + cool; j++) {
            const s2 = spanOfMine(mine[j]), t2 = prevT + cool;
            const to = s2 && t2 < s2.hi && make(i, t2, s2);
            if (!to) { mv = null; break; }
            sc += autoScore([to]) - autoScore([mine[j]]);
            mv.push({ from: mine[j], to });
            prevT = t2;
          }
          if (!mv) continue;
          if (sc > bestScore || (sc === bestScore && best && b.t < best.t)) { best = b; bestScore = sc; moved = mv; }
        }
      }
      if (!best) break;
      for (const m of moved) battles[battles.indexOf(m.from)] = m.to;
      battles.push(best);
    }
  }
}

// 担当できない階層帯の強さを 0 にする (Lv11–20 は tier 2 から、Lv21 以降は tier 3 だけ)
function autoMask(power, tier) {
  return power.map((x, i) => [tier[i] >= 2 ? x[0] : 0, tier[i] >= 2 ? x[1] : 0, tier[i] >= 3 ? x[2] : 0]);
}

// 担当できる人 (list) の k 番目の強さの平均で 100% に届く人数
function autoTeamSize(power, k, list) {
  const avg = list.length ? list.reduce((s, i) => s + power[i][k], 0) / list.length : 0;
  return avg > 0 ? Math.max(1, Math.ceil(1 / avg - 1e-9)) : power.length;
}

// これから 1 クールの間に撃破役が要る時刻と、その時刻までの累計人数 [[時刻, 全体の人数, Realm の人数, 階層]]
function autoUpcoming(t, floor, kills, realmOpen, rkill, cfg, need, realmSec) {
  const { lag, cool, margin: m } = cfg;
  const ev = [];
  let f = floor, tau;
  if (realmOpen === null) {
    // 3 体ともまだ出ていなければ、すぐ出る見込みとする
    tau = Object.keys(kills).length === 3 ? Math.max(Math.max(...Object.values(kills)) + m, t) : t + lag + AUTO_REG_SEC + m;
    ev.push([tau, need(f), f]);
    tau += lag + realmSec(f) + m;
  } else if (rkill === null) {
    ev.push([t, need(f), f]);
    tau = t + lag + realmSec(f) + m;
  } else {
    tau = Math.max(rkill + m, t);
  }
  while (tau < t + cool) {
    f++;
    ev.push([tau, 3, 0]);
    tau += lag + AUTO_REG_SEC + m;
    if (tau >= t + cool) break;
    ev.push([tau, need(f), f]);
    tau += lag + realmSec(f) + m;
  }
  let c = 0, r = 0;
  return ev.map(([at, d, f]) => [at, (c += d), (r += f ? d : 0), f]);
}

// i を今合流させても、ほかの人で先の撃破役が足りるか。Realm の分は、その階層を担当できる人で足りるか
function autoSpare(i, ready, events, slack, can) {
  for (const [tau, c, r, f] of events) {
    let k = 0, kr = 0;
    for (let j = 0; j < ready.length; j++) {
      if (j === i || ready[j] > tau) continue;
      k++;
      if (f && can(j, f)) kr++;
    }
    if (k < c + slack || (f && kr < r)) return false;
  }
  return true;
}

// 合計が 100% 以上になる最少人数の組。"weak" なら同じ人数で合計が最も小さい組に入れ替える
function autoPickKillers(free, power, k, pref) {
  const strong = free.slice().sort((a, b) => power[b][k] - power[a][k]);
  const team = [];
  let s = 0;
  for (const i of strong) {
    team.push(i);
    s += power[i][k];
    if (s >= 1 - 1e-9) break;
  }
  if (s < 1 - 1e-9) return null;
  if (pref !== "weak") return team;
  const sum = (list) => list.reduce((a, i) => a + power[i][k], 0);
  let best = team;
  for (const w of strong.slice().reverse()) {
    const cand = [w];
    for (const i of strong) {
      if (cand.length === team.length) break;
      if (i !== w) cand.push(i);
    }
    if (cand.length === team.length && sum(cand) >= 1 - 1e-9 && sum(cand) < sum(best)) best = cand;
  }
  return best;
}

// generate_detail と同じ式の予定スコア
function autoScore(battles) {
  let s = 0;
  for (const b of battles) {
    const base = 50000 * Math.min(Math.floor((b.level - 1) / 5) + 1, 5) * (b.boss === "Realm_boss" ? 1.2 : 1);
    s += Math.ceil(base * Math.max(Math.min(b.rate, 1), 0));
  }
  return s;
}

// ---------------------------------------------------------------- 探索

function autoRandom(seed) {
  // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// 方針の格子探索のあと、初回出撃のずらしなどを 1 か所ずつ動かす山登りを seconds 秒続ける。
// UI を止めないよう、少しずつ区切って計算する。run.stop が立ったら打ち切る
async function autoSearch(cfg, power, seconds, run, onProgress) {
  const n = power.length;
  const rnd = autoRandom(1);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  let best = -1, bp = null, count = 0;
  // 格子は同点なら先のもの (単純な方針) を残し、山登りは同点でも動いて平らな所を渡る
  const evaluate = (p, tie) => {
    count++;
    const s = autoScore(autoBuild(cfg, power, p));
    if (s > best || (tie && s === best)) { best = s; bp = p; }
  };
  const grid = [];
  for (const killer of ["strong", "weak"])
    for (let slack = 0; slack < 4; slack++)
      for (const kadd of [0, 1])
        for (const stagger of AUTO_STAGGER)
          for (const joinFrom of AUTO_JOIN_FROM)
            grid.push({ killer, slack, kadd, joinFrom, offset: Array.from({ length: n }, (_, i) => 1 + (i * stagger) % cfg.cool) });
  const t0 = performance.now();
  let g = 0;
  while (!run.stop) {
    const slice = performance.now();
    while (performance.now() - slice < 40) {
      if (g < grid.length) {
        evaluate(grid[g++], false);
        continue;
      }
      const q = { ...bp, offset: bp.offset.slice() };
      const r = rnd();
      if (r < 0.7) {
        const i = Math.floor(rnd() * n);
        q.offset[i] = clamp(q.offset[i] + pick([-30, -10, -3, -1, 1, 3, 10, 30]), 1, cfg.cool);
      } else if (r < 0.85) q.slack = Math.max(0, q.slack + pick([-1, 1]));
      else if (r < 0.9) q.kadd = Math.max(0, q.kadd + pick([-1, 1]));
      else if (r < 0.95) q.joinFrom = clamp(q.joinFrom + pick([-1, 1]), 1, 21);
      else q.killer = q.killer === "strong" ? "weak" : "strong";
      evaluate(q, true);
    }
    const elapsed = (performance.now() - t0) / 1000;
    onProgress(best, count, elapsed);
    if (g >= grid.length && elapsed >= seconds) break;
    await autoYield();
  }
  return { score: best, params: bp, count };
}

// ---------------------------------------------------------------- ダイアログ

// 作戦に使うプレイヤー [{id, name, temp}]。名前のある人がいなければ、先頭の列から人数分に仮の名前を付ける
function autoPlayers() {
  const named = state.players.filter((p) => p.name);
  if (named.length) return named.map((p) => ({ id: p.id, name: p.name, temp: false }));
  const count = clamp(Number(autoLoad().count) || state.players.length, 1, state.players.length);
  return state.players.slice(0, count).map((p, i) => ({ id: p.id, name: autoTempName(i), temp: true }));
}

function autoTempName(i) {
  return `プレイヤー${String(i + 1).padStart(2, "0")}`;
}

function autoNum(input, lo, hi) {
  const v = Number(input.value);
  return Number.isFinite(v) && input.value.trim() !== "" ? clamp(Math.round(v), lo, hi) : null;
}

function autoLog(msg, cls = "") {
  $("#auto-log").append(h("div", { class: cls }, msg));
  $("#auto-log").scrollTop = $("#auto-log").scrollHeight;
}

function autoPowerInput(value, title, onchange) {
  return h("input", { type: "number", min: 0, max: 100, step: 5, value, title, class: "auto-pct", onchange });
}

function autoTierSelect(value, onchange, blank) {
  const sel = h("select", { class: "auto-tier", title: "Realm を担当できる階層", onchange },
    blank ? h("option", { value: "" }, "(変えない)") : null,
    ...AUTO_TIERS.map((label, k) => h("option", { value: String(k) }, label)));
  sel.value = value;
  return sel;
}

// 担当できない階層帯の % 欄を無効にする
function autoTierApply(tr) {
  const t = Number(tr.querySelector(".auto-tier").value);
  tr.querySelectorAll(".auto-pct").forEach((el, k) => { el.disabled = t < (k < 2 ? 2 : 3); });
}

function autoTierOf(s, id) {
  const t = s.tier[id];
  return Number.isInteger(t) && t >= 0 && t < AUTO_TIERS.length ? t : AUTO_TIER;
}

function openAutoDialog() {
  const s = autoLoad();
  $("#auto-realm-low").value = s.realmLow.join(", ");
  $("#auto-kill-sec").value = s.killSec;
  $("#auto-grind-sec").value = s.grindSec;
  $("#auto-top-sec").value = s.topSec;
  $("#auto-margin").value = s.margin;
  $("#auto-seconds").value = String(s.seconds);
  $("#auto-count").max = state.players.length;
  $("#auto-count").value = clamp(Number(s.count) || state.players.length, 1, state.players.length);
  autoRenderPlayers();
  $("#auto-dialog").showModal();
}

// 強さの表を作り直す (開いたときと、仮の人数を変えたとき)
function autoRenderPlayers() {
  const s = autoLoad();
  const players = autoPlayers();
  $("#auto-count-row").style.display = players.some((p) => p.temp) ? "" : "none";
  const body = $("#auto-players");
  const labels = ["撃破役: Lv11–20 の Realm に撃破役の秒数で与えられる割合", "稼ぎ役: Lv11–20 の Realm に稼ぎ役の秒数で与えられる割合", "Lv21 以降の Realm に約 5 分で与えられる割合"];
  const rows = players.map((p) => {
    const v = s.power[p.id] || AUTO_POWER;
    const inputs = v.map((x, k) => autoPowerInput(x, labels[k], () => autoStore()));
    inputs.forEach((el, k) => { el.dataset.k = k; });
    const sel = autoTierSelect(String(autoTierOf(s, p.id)), () => { autoTierApply(tr); autoStore(); });
    const tr = h("tr", {}, h("td", {}, h("b", {}, p.name), " ", h("span", { class: "muted" }, p.temp ? "(仮)" : p.id)),
      h("td", {}, sel), ...inputs.map((el) => h("td", {}, el, "%")));
    tr.dataset.id = p.id;
    autoTierApply(tr);
    return tr;
  });
  const all = AUTO_POWER.map((x, k) => autoPowerInput(x, labels[k]));
  const allTier = autoTierSelect("", null, true);
  const allRow = h("tr", { class: "auto-all" },
    h("td", {}, h("button", { type: "button", title: "この行の値を全員に入れる", onclick: () => {
      body.querySelectorAll("tr[data-id]").forEach((tr) => {
        tr.querySelectorAll(".auto-pct").forEach((el) => { if (all[el.dataset.k].value !== "") el.value = all[el.dataset.k].value; });
        if (allTier.value !== "") tr.querySelector(".auto-tier").value = allTier.value;
        autoTierApply(tr);
      });
      autoStore();
    } }, "全員に入れる")),
    h("td", {}, allTier), ...all.map((el) => h("td", {}, el, "%")));
  body.replaceChildren(allRow, ...rows);
  $("#auto-run").disabled = !!autoRunning;
}

// 入力欄を読み、保存する。不正な値があればエラーの文字列を返す
function autoStore() {
  const s = autoLoad();
  const errors = [];
  for (const tr of $("#auto-players").querySelectorAll("tr[data-id]")) {
    s.power[tr.dataset.id] = [...tr.querySelectorAll(".auto-pct")].map((el, k) => autoNum(el, 0, 100) ?? AUTO_POWER[k]);
    s.tier[tr.dataset.id] = Number(tr.querySelector(".auto-tier").value);
  }
  const low = $("#auto-realm-low").value.split(/[\s,、]+/).filter(Boolean).map(Number);
  if (low.length === 10 && low.every((x) => Number.isInteger(x) && x >= 1 && x <= MAX_BATTLE)) s.realmLow = low;
  else errors.push(`Lv1–10 の Realm の秒数は、1〜${MAX_BATTLE} の整数を 10 個、カンマ区切りで入れてください`);
  for (const [key, id, lo, hi] of [["killSec", "#auto-kill-sec", 1, MAX_BATTLE], ["grindSec", "#auto-grind-sec", 1, MAX_BATTLE],
    ["topSec", "#auto-top-sec", 1, MAX_BATTLE], ["margin", "#auto-margin", 0, 60]]) {
    const v = autoNum($(id), lo, hi);
    if (v === null) errors.push("秒数の欄が空です");
    else s[key] = v;
  }
  s.seconds = Number($("#auto-seconds").value) || AUTO_DEFAULTS.seconds;
  const count = autoNum($("#auto-count"), 1, state.players.length);
  if (count !== null) s.count = count;
  autoSave(s);
  return { s, errors };
}

async function runAuto() {
  const { s, errors } = autoStore();
  $("#auto-log").replaceChildren();
  if (errors.length) { errors.forEach((e) => autoLog(e, "err")); return; }
  const players = autoPlayers();
  const power = players.map((p) => s.power[p.id].map((x) => x / 100));
  const tier = players.map((p) => autoTierOf(s, p.id));
  const cfg = { lag: timelag(), cool: blockLen(), margin: s.margin, realmLow: s.realmLow, killSec: s.killSec, grindSec: s.grindSec, topSec: s.topSec, tier };
  const masked = autoMask(power, tier);
  if (!tier.some((t) => t >= 1)) {
    autoLog("Realm を担当できる人がいないので、Lv1 の Realm から先へ進めません", "err");
  } else {
    for (const [k, band] of [[0, "Lv11–20"], [2, "Lv21 以降"]]) {
      if (masked.reduce((a, x) => a + x[k], 0) < 1 - 1e-9) {
        autoLog(`担当できる人の${k ? "Lv21 以降" : "撃破役"}の割合を足しても 100% に届かないので、${band}の Realm は倒せない前提で作ります`, "err");
      }
    }
  }

  const run = { stop: false };
  autoRunning = run;
  $("#auto-run").disabled = true;
  $("#auto-stop").disabled = false;
  const progress = h("div", {}, "探索中…");
  $("#auto-log").append(progress);
  try {
    const res = await autoSearch(cfg, power, s.seconds, run,
      (best, count, sec) => { progress.textContent = `探索中… ${sec.toFixed(1)} 秒、${fmt(count)} 通り、最良 ${fmt(best)}`; });
    progress.textContent = `${fmt(res.count)} 通りを試しました${run.stop ? " (中止)" : ""}`;
    if (!res.params) return;
    const battles = autoBuild(cfg, power, res.params);

    const st = JSON.parse(JSON.stringify(state));
    const byId = new Map(players.map((p, i) => [p.id, i]));
    for (const p of st.players) {
      p.actions = [];
      if (!byId.has(p.id)) continue;
      const i = byId.get(p.id);
      for (const b of battles.filter((x) => x.i === i).sort((x, y) => x.t - y.t)) {
        p.actions.push({ start: b.t, boss: b.boss, battle: b.sec, rate: Math.round(b.rate * 100) / 100 });
      }
    }
    // 列は最初の出撃が早い順に左から並べる。同時と出撃のない列は今の順のまま
    const first = (p) => (p.actions.length ? p.actions[0].start : Infinity);
    st.players = st.players.map((p, k) => ({ p, k }))
      .sort((x, y) => (first(x.p) === first(y.p) ? x.k - y.k : first(x.p) - first(y.p))).map((x) => x.p);
    // 仮の名前は並べ替えたあとの左から順に付ける
    let temp = 0;
    for (const p of st.players) if (byId.has(p.id) && players[byId.get(p.id)].temp) p.name = autoTempName(temp++);
    // サーバーの generate_detail で予定スコアを確かめる
    const j = await (await api("/api/detail", { text: toText(st) })).json();
    const est = j.detail.reduce((a, d) => a + d.est_score, 0);
    const maxLv = j.detail.reduce((a, d) => Math.max(a, d.level), 0);
    autoLog(`見積もり ${fmt(est)}、到達 Lv${maxLv}、${j.detail.length} 戦`, "ok");
    if (state.players.some((p) => p.actions.length) && !confirm(`今のブロックをすべて置き換えます (見積もり ${fmt(est)})。よろしいですか？（元に戻すで復元できます）`)) {
      autoLog("置き換えを取りやめました");
      return;
    }
    replaceState(st);
    autoLog("作戦を置き換えました。「元に戻す」で戻せます", "ok");
  } catch (e) {
    autoLog(`作成できませんでした: ${e.message}`, "err");
  } finally {
    autoRunning = null;
    $("#auto-run").disabled = false;
    $("#auto-stop").disabled = true;
  }
}

function bindAuto() {
  $("#btn-auto").addEventListener("click", openAutoDialog);
  $("#auto-close").addEventListener("click", () => $("#auto-dialog").close());
  $("#auto-run").addEventListener("click", runAuto);
  $("#auto-stop").addEventListener("click", () => { if (autoRunning) autoRunning.stop = true; });
  $("#auto-dialog").addEventListener("change", (e) => { if (e.target.closest(".auto-settings")) autoStore(); });
  $("#auto-count").addEventListener("change", () => { autoStore(); autoRenderPlayers(); });
}

bindAuto();
