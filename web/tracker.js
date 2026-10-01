"use strict";
// chartmaker 進捗管理
// サーバーのセッション (作戦 plan と討伐イベント events) を 1 秒ごとに取得し、表示はすべて手元で計算する。

const REGULAR = BOSSES.slice(0, 3);
const POLL_MS = 1000;
const TICK_MS = 200;
const NEXT_COUNT = 8;
const HANDOFF_KEY = "chartmaker.tracker.text";

let plan = null;
let events = [];
let version = 0;
let offset = 0;            // サーバー時刻 − 手元の時刻 (ms)
let bestRtt = Infinity;
let busy = false;
let lastSync = 0;
let ui = {};               // 作り置きの要素

const $ = (sel) => document.querySelector(sel);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style" && typeof v === "object") {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith("--")) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    } else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v !== undefined && v !== null && v !== false) el[k] = v;
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const bgr = (c) => (c ? `rgb(${c[2]},${c[1]},${c[0]})` : "transparent");
const fmt = (n) => n.toLocaleString("en-US");
const mmss = (s) => {
  s = Math.abs(Math.trunc(s));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const pad2 = (n) => String(n).padStart(2, "0");
const sessionId = () => (location.pathname.match(/^\/tracker\/([\w-]+)/) || [])[1];

function showStatus(msg, ok = false) {
  const el = $("#status");
  el.textContent = msg;
  el.hidden = !msg;
  el.classList.toggle("ok", ok);
  clearTimeout(showStatus.timer);
  if (msg) showStatus.timer = setTimeout(() => { el.hidden = true; }, 5000);
}

async function api(method, url, body) {
  const t0 = Date.now();
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const t1 = Date.now();
  const j = await res.json().catch(() => ({}));
  if (j.server_now && t1 - t0 <= bestRtt) {
    // 往復が最も短かったときの値で時計を合わせる
    bestRtt = t1 - t0;
    offset = j.server_now - (t0 + t1) / 2;
  }
  if (!res.ok) {
    const err = new Error(j.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return j;
}

// ---------------------------------------------------------------- 進捗の計算

// ゲーム開始からの経過秒
const elapsed = () => (Date.now() + offset - plan.start_epoch_ms) / 1000;

function progress() {
  const floor = 1 + events.filter((e) => e.boss === "Realm_boss").length;
  const killed = new Set(events.filter((e) => e.floor === floor).map((e) => e.boss));
  const realmOpen = REGULAR.every((b) => killed.has(b));
  return { floor, killed, realmOpen };
}

// 作戦上の (階層, ボス) の討伐予定秒。作戦の範囲外は null
const planned = (floor, boss) => plan.cleartime[floor]?.[boss] ?? null;

// 正なら遅れ、負なら早い。直近の討伐の差と、現階層の未討伐ボスの予定超過のうち大きい方
function delay(now, pr) {
  const cands = [];
  const last = events[events.length - 1];
  if (last) {
    const p = planned(last.floor, last.boss);
    if (p !== null) cands.push(last.t - p);
  }
  for (const b of BOSSES) {
    if (pr.killed.has(b)) continue;
    const p = planned(pr.floor, b);
    if (p !== null && now > p) cands.push(now - p);
  }
  return cands.length ? Math.round(Math.max(...cands)) : null;
}

const killTime = (floor, boss) => events.find((e) => e.floor === floor && e.boss === boss)?.t ?? null;

// (階層, ボス) に挑戦できるようになった秒。まだなら null
function bossOpenAt(floor, boss) {
  const open = floor === 1 ? 0 : killTime(floor - 1, "Realm_boss");
  if (open === null || boss !== "Realm_boss") return open;
  const regular = REGULAR.map((b) => killTime(floor, b));
  return regular.includes(null) ? null : Math.max(open, ...regular);
}

// 討伐記録から各戦闘の実際の出撃を見積もる。出撃は次の条件がすべてそろった時点:
//   作戦の出撃時刻 / 前の戦闘の出撃からクールタイム明け / 前の戦闘のボスが討伐済み / 挑戦先のボスに挑戦可能
// 戦闘は対象ボスの討伐ボタンが押されるまで続く (作戦の終了時刻では終わらない)。
// state: "done" 討伐済み, "skip" 出撃前に対象が討伐された, "fighting" 挑戦中,
//        "waiting" 作戦の出撃時刻を過ぎたが出撃できない, "upcoming" 出撃前
// at: 出撃した秒、または出撃できる最も早い秒 (waiting では未確定)
function schedule(now) {
  const out = [];
  for (const battles of plan.byPlayer) {
    let prev = null;
    for (const x of battles) {
      let at = x.push_start;
      let known = true;
      const gate = (t) => { if (t === null) known = false; else at = Math.max(at, t); };
      if (prev) {
        at = Math.max(at, prev.at + (prev.x.battle_start - prev.x.push_start) + COOL_TIME);
        if (!prev.known) known = false;
        gate(killTime(prev.x.level, prev.x.action));
      }
      gate(bossOpenAt(x.level, x.action));
      const kt = killTime(x.level, x.action);
      let state;
      if (known && at <= now) state = kt === null ? "fighting" : kt < at ? "skip" : "done";
      else if (kt !== null) state = "skip";
      else state = at <= now ? "waiting" : "upcoming";
      const s = { x, at, known, state };
      out.push(s);
      if (state !== "skip") prev = s;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 画面

function buildBoard() {
  $("#comment").textContent = plan.comment;
  const players = new Map();
  plan.detail.forEach((x, i) => {
    x.id = i;
    if (!players.has(x.raw_name)) players.set(x.raw_name, []);
    players.get(x.raw_name).push(x);
  });
  plan.byPlayer = [...players.values()].map((v) => v.sort((a, b) => a.push_start - b.push_start));
  const st = new Date(plan.start_epoch_ms);
  $("#clock-sub").dataset.start = `開始 ${st.getMonth() + 1}/${st.getDate()} ${pad2(st.getHours())}:${pad2(st.getMinutes())}`;

  ui.bosses = {};
  $("#bosses").replaceChildren(...BOSSES.map((b) => {
    const info = plan.bosses[b];
    const count = h("div", { class: "count" });
    const sub = h("div", { class: "count-sub" });
    const btn = h("button", { class: "kill", onclick: () => kill(b) }, "討伐");
    const card = h("div", { class: "boss", style: { "--boss": bgr(info.color) } },
      h("div", { class: "boss-head" },
        info.image
          ? h("img", { class: "boss-img", src: info.image, alt: "", style: { background: bgr(info.icon_bg) } })
          : h("div", { class: "boss-img", style: { background: bgr(info.icon_bg) } }),
        h("div", { class: "boss-name" }, BOSS_LABEL[b])),
      count, sub, btn);
    ui.bosses[b] = { card, count, sub, btn };
    return card;
  }));
  $("#board").hidden = false;
  $("#btn-share").hidden = false;
}

function playerTag(d, big) {
  const team = plan.team_color[d.team];
  return h("span", { class: "player" + (big ? " big" : ""), style: { borderColor: bgr(team) } }, d.player_name);
}

function bossTag(boss) {
  return h("span", { class: "boss-tag", style: { background: bgr(plan.bosses[boss].color) } }, BOSS_LABEL[boss]);
}

// 同じ内容なら DOM を作り直さない (ちらつきとクリック取りこぼしを防ぐ)
function setChildren(el, key, make) {
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.replaceChildren(...make());
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function render() {
  if (!plan) return;
  const now = elapsed();
  const pr = progress();

  // 上段
  setText($("#floor"), `LV${pr.floor}`);
  if (now < 0) {
    setText($("#clock-label"), "開始まで");
    setText($("#clock"), mmss(Math.ceil(-now)));
  } else {
    setText($("#clock-label"), now <= CHART_SEC ? "残り時間" : "終了から");
    setText($("#clock"), mmss(Math.abs(CHART_SEC - Math.floor(now))));
  }
  setText($("#clock-sub"), `経過 ${now < 0 ? "--:--" : mmss(Math.floor(now))}　${$("#clock-sub").dataset.start}`);

  const d = delay(now, pr);
  const box = $("#delay-box");
  document.body.classList.toggle("late", d !== null && d > 0);
  document.body.classList.toggle("ontime", d === null || d <= 0);
  box.classList.toggle("late", d !== null && d > 0);
  setText($("#delay"), d === null || d === 0 ? "±0秒" : d > 0 ? `${d}秒 遅れ` : `${-d}秒 早い`);
  const nextFloorPlan = planned(pr.floor, "Realm_boss");
  setText($("#delay-sub"), nextFloorPlan === null
    ? "作戦の範囲外の階層です"
    : `LV${pr.floor} 突破予定 ${mmss(nextFloorPlan)}`);

  let score = 0;
  let total = 0;
  for (const x of plan.detail) {
    total += x.est_score;
    if (x.battle_end <= now) score += x.est_score;
  }
  setText($("#score"), fmt(score));
  setText($("#score-sub"), `作戦の最終値 ${fmt(total)}`);

  // ボス
  for (const b of BOSSES) {
    const u = ui.bosses[b];
    const dead = pr.killed.has(b);
    const locked = b === "Realm_boss" && !pr.realmOpen;
    const p = planned(pr.floor, b);
    u.card.classList.toggle("dead", dead);
    u.card.classList.toggle("locked", locked);
    let text, sub, over = false;
    if (dead) {
      const e = events.find((x) => x.floor === pr.floor && x.boss === b);
      text = "✕";
      sub = `討伐 ${mmss(e.t)}` + (p !== null ? `（${e.t > p ? "+" : "-"}${Math.abs(e.t - p)}秒）` : "");
    } else if (p === null) {
      text = "--:--";
      sub = "作戦に予定なし";
    } else {
      const left = Math.ceil(p - now);
      over = left < 0;
      text = (over ? "+" : "") + mmss(left);
      sub = `予定 ${mmss(p)}` + (locked ? "　3体討伐で挑戦可" : "");
    }
    u.card.classList.toggle("over", over);
    setText(u.count, text);
    setText(u.sub, sub);
    u.btn.disabled = busy || dead || locked;
  }

  // 挑戦中・次に出撃 (討伐ボタンが押されるまで挑戦者は入れ替わらず、遅れは後続に持ち越す)
  const sched = schedule(now);
  const fighting = sched.filter((s) => s.state === "fighting")
    .sort((a, b) => BOSSES.indexOf(a.x.action) - BOSSES.indexOf(b.x.action) || a.at - b.at);
  setChildren($("#fighting"), fighting.map((s) => s.x.id).join(), () =>
    fighting.length
      ? fighting.map((s) => h("div", { class: "fight", style: { "--boss": bgr(plan.bosses[s.x.action].color) } },
        bossTag(s.x.action), playerTag(s.x, true), h("span", { class: "left" })))
      : [h("div", { class: "empty" }, "なし")]);
  $("#fighting").querySelectorAll(".left").forEach((el, i) => {
    // 作戦の戦闘時間に対する残り。過ぎたら超過として赤字
    const s = fighting[i];
    const left = Math.ceil(s.at + (s.x.battle_end - s.x.push_start) - now);
    el.classList.toggle("late-text", left < 0);
    setText(el, left >= 0 ? `残り ${left}秒` : `${-left}秒 超過`);
  });

  // プレイヤーごとに次の 1 戦だけ。待機中を先に、あとは出撃の早い順
  const seen = new Set();
  const upcoming = sched.filter((s) => {
    if (s.state !== "waiting" && s.state !== "upcoming") return false;
    if (seen.has(s.x.raw_name)) return false;
    seen.add(s.x.raw_name);
    return !sched.some((o) => o.state === "fighting" && o.x.raw_name === s.x.raw_name);
  }).sort((a, b) => (a.state === "waiting" ? 0 : 1) - (b.state === "waiting" ? 0 : 1) || a.at - b.at || a.x.push_start - b.x.push_start)
    .slice(0, NEXT_COUNT);
  setChildren($("#next"), upcoming.map((s) => s.x.id).join(), () =>
    upcoming.length
      ? upcoming.map((s) => h("div", { class: "next-row" },
        h("span", { class: "in" }), playerTag(s.x, false), bossTag(s.x.action),
        h("span", { class: "muted", title: "作戦の出撃時刻" }, mmss(s.x.push_start))))
      : [h("div", { class: "empty" }, "なし")]);
  $("#next").querySelectorAll(".in").forEach((el, i) => {
    const s = upcoming[i];
    const waiting = s.state === "waiting";
    el.classList.toggle("waiting", waiting);
    setText(el, waiting ? "待機中" : `あと ${Math.max(0, Math.ceil(s.at - now))}秒`);
  });

  // 履歴 (新しい順)
  setChildren($("#history"), `${version}`, () =>
    events.length
      ? events.slice().reverse().map((e) => {
        const p = planned(e.floor, e.boss);
        const diff = p === null ? null : e.t - p;
        return h("div", { class: "hist-row" },
          h("span", {}, `LV${e.floor}`), bossTag(e.boss), h("span", {}, mmss(e.t)),
          h("span", { class: diff === null ? "muted" : diff > 0 ? "late-text" : "ok-text" },
            diff === null ? "予定なし" : diff > 0 ? `${diff}秒 遅れ` : `${-diff}秒 早い`));
      })
      : [h("div", { class: "empty" }, "まだ討伐はありません")]);
  $("#btn-undo").disabled = busy || !events.length;

  const stale = Date.now() - lastSync > 5000;
  setText($("#sync"), stale ? "サーバーと同期できていません" : "同期中");
  $("#sync").classList.toggle("late-text", stale);
}

// ---------------------------------------------------------------- 操作

function applyResponse(j) {
  if (j.version < version) return;
  version = j.version;
  if (j.plan && !plan) { plan = j.plan; buildBoard(); }
  if (j.events) events = j.events;
  lastSync = Date.now();
}

async function poll() {
  try {
    applyResponse(await api("GET", `/api/sessions/${sessionId()}?since=${plan ? version : 0}`));
  } catch (e) {
    if (e.status === 404) { showStatus(e.message); return; }
  }
  setTimeout(poll, POLL_MS);
}

async function act(path, body) {
  busy = true;
  render();
  try {
    applyResponse(await api("POST", `/api/sessions/${sessionId()}/${path}`, body));
  } catch (e) {
    showStatus(e.message);
    try { applyResponse(await api("GET", `/api/sessions/${sessionId()}`)); } catch (e2) { /* 次のポーリングに任せる */ }
  } finally {
    busy = false;
    render();
  }
}

function kill(boss) {
  return act("kill", { floor: progress().floor, boss });
}

function undo() {
  const last = events[events.length - 1];
  if (!last || !confirm(`LV${last.floor} ${BOSS_LABEL[last.boss]} の討伐を取り消しますか？`)) return;
  act("undo", { count: events.length });
}

// ---------------------------------------------------------------- セッション作成

function startTimeOf(text) {
  const m = text.match(/^::start_time=(\d{1,2}):(\d{2})\s*$/m);
  return m ? `${pad2(m[1])}:${m[2]}` : "";
}

function setupText(text) {
  $("#setup-text").value = text;
  const t = startTimeOf(text);
  if (t) $("#setup-time").value = t;
}

function showSetup() {
  const d = new Date();
  $("#setup-date").value = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  let text = "";
  try {
    text = localStorage.getItem(HANDOFF_KEY) || "";
    localStorage.removeItem(HANDOFF_KEY);
  } catch (e) { /* 引き継ぎなし */ }
  setupText(text);
  $("#setup-text").addEventListener("change", (e) => setupText(e.target.value));
  $("#setup-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) setupText(await f.text());
    e.target.value = "";
  });
  $("#btn-create").addEventListener("click", async () => {
    const date = $("#setup-date").value;
    const time = $("#setup-time").value;
    if (!date || !time) { showStatus("開始日と開始時刻を指定してください"); return; }
    const start = new Date(`${date}T${time}:00`).getTime();
    try {
      const j = await api("POST", "/api/sessions", { text: $("#setup-text").value, start_epoch_ms: start });
      location.href = `/tracker/${j.id}`;
    } catch (e) {
      showStatus(e.message);
    }
  });
  $("#setup").hidden = false;
}

function init() {
  $("#btn-share").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); showStatus("URL をコピーしました", true); } catch (e) { prompt("この URL を共有してください", location.href); }
  });
  $("#btn-undo").addEventListener("click", undo);
  if (!sessionId()) { showSetup(); return; }
  poll();
  setInterval(render, TICK_MS);
}

init();
