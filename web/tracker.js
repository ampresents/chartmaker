"use strict";
// chartmaker 進行管理
// サーバーのセッション (作戦 plan と討伐イベント events) を 1 秒ごとに取得し、表示はすべて手元で計算する。

const REGULAR = BOSSES.slice(0, 3);
const POLL_MS = 1000;
const TICK_MS = 200;
const NEXT_COUNT = 8;
// 作戦画像 (ChartLib の固定レイアウト): 列の左端 120 + i*246、幅 240、y = 秒 + 160
const CHART_X0 = 120, CHART_COL = 246, CHART_COL_W = 240, CHART_TOP = 160;
const HANDOFF_KEY = "chartmaker.tracker.text";
const WEBHOOK_KEY = "chartmaker.tracker.webhook";
const TTS_KEY = "chartmaker.tracker.tts"; // "0" なら読み上げなし

let plan = null;
let events = [];
let version = 0;
let offset = 0;            // サーバー時刻 − 手元の時刻 (ms)
let bestRtt = Infinity;
let busy = false;
let lastSync = 0;
let ui = {};               // 作り置きの要素
let notifyPaused = false;  // 全端末共通の Discord 通知の停止 (サーバーに保存)
let ended = false;         // セッションが破棄された (または見つからない)
let tickTimer = null;
const notifySent = new Set(); // この端末から Discord 通知を頼んだ戦闘 (plan.detail の添字)
const notifyCleared = new Set(); // そのうち、出撃したので通知の削除を頼んだ戦闘
const noteSent = new Set();     // この端末から Discord 通知を頼んだ全体の注意点 (plan.notes の添字)
const noteCleared = new Set();  // そのうち、始まったので通知の削除を頼んだもの
const NOTE_LEAD = 30;           // 通知なしのセッションで、注意点を何秒前から出すか

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

// ---------------------------------------------------------------- 進行状況の計算

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
  // 作戦画像の列は generate_detail に初めて出てきた順 (= players の順)
  plan.column = new Map([...players.keys()].map((name, i) => [name, i]));
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
  buildChart();
  $("#board").hidden = false;
  $("#btn-share").hidden = false;
  $("#btn-end").hidden = false;
  if (plan.notify_lead) {
    $("#notify").hidden = false;
    $("#btn-notify").hidden = false;
    renderNotify();
  }
}

function buildChart() {
  const img = $("#chart-img");
  ui.chartNow = h("div", { class: "chart-now" });
  img.addEventListener("load", () => { $("#chart-box").hidden = false; render(); }, { once: true });
  img.addEventListener("error", () => { $("#chart-box").hidden = true; }, { once: true });
  img.src = `/api/sessions/${sessionId()}/chart.png`;
  // クリックで、横幅に合わせた縮小表示と原寸 (横スクロール) を切り替える
  $("#chart-scroll").addEventListener("click", () => $("#chart-scroll").classList.toggle("full"));
}

// 作戦画像の上に重ねる矩形。位置は画像に対する % なので、縮小しても合う
function chartHit(x, cls) {
  const img = $("#chart-img");
  const W = img.naturalWidth, H = img.naturalHeight;
  const col = plan.column.get(x.raw_name);
  return h("div", { class: `chart-hit ${cls}`, style: {
    left: `${(CHART_X0 + col * CHART_COL) / W * 100}%`,
    width: `${CHART_COL_W / W * 100}%`,
    top: `${(x.push_start + CHART_TOP) / H * 100}%`,
    height: `${Math.max(x.battle_end - x.push_start, 1) / H * 100}%`,
  } });
}

function renderChart(sched, fighting, upcoming, now) {
  const img = $("#chart-img");
  if ($("#chart-box").hidden || !img.naturalHeight) return;
  const overdue = (s) => s.at + (s.x.battle_end - s.x.push_start) < now;
  const done = sched.filter((s) => s.state === "done" || s.state === "skip");
  const key = [
    done.map((s) => s.x.id).join(),
    fighting.map((s) => `${s.x.id}${overdue(s) ? "!" : ""}`).join(),
    upcoming.map((s) => s.x.id).join(),
  ].join("|");
  setChildren($("#chart-overlay"), key, () => [
    ...done.map((s) => chartHit(s.x, "done")),
    ...upcoming.map((s) => chartHit(s.x, "next")),
    ...fighting.map((s) => chartHit(s.x, overdue(s) ? "fighting late" : "fighting")),
    ui.chartNow,
  ]);
  // 作戦上の現在時刻。挑戦中のブロックより上にあれば、その分だけ遅れている
  const line = ui.chartNow;
  line.hidden = now < 0 || now > CHART_SEC;
  line.style.top = `${(Math.floor(now) + CHART_TOP) / img.naturalHeight * 100}%`;
}

// 次に出撃: プレイヤーごとに次の 1 戦だけ。待機中を先に、あとは出撃の早い順
function nextBattles(sched) {
  const seen = new Set();
  return sched.filter((s) => {
    if (s.state !== "waiting" && s.state !== "upcoming") return false;
    if (seen.has(s.x.raw_name)) return false;
    seen.add(s.x.raw_name);
    return !sched.some((o) => o.state === "fighting" && o.x.raw_name === s.x.raw_name);
  }).sort((a, b) => (a.state === "waiting" ? 0 : 1) - (b.state === "waiting" ? 0 : 1) || a.at - b.at || a.x.push_start - b.x.push_start)
    .slice(0, NEXT_COUNT);
}

function renderNotify() {
  if (!plan?.notify_lead) return;
  $("#notify").textContent = notifyPaused ? "🔇 Discord 通知: 停止中"
    : plan.notify_tts === false ? `💬 Discord 通知 (読み上げなし): ${plan.notify_lead}秒前`
    : `🔊 Discord 読み上げ: ${plan.notify_lead}秒前`;
  $("#notify").classList.toggle("late-text", notifyPaused);
  $("#btn-notify").textContent = notifyPaused ? "通知を再開" : "通知を止める";
  $("#btn-notify").disabled = busy;
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
  if (!plan || ended) return;
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
        bossTag(s.x.action), playerTag(s.x, true), h("span", { class: "left" }), rowNote(s.x)))
      : [h("div", { class: "empty" }, "なし")]);
  $("#fighting").querySelectorAll(".left").forEach((el, i) => {
    // 作戦の戦闘時間に対する残り。過ぎたら超過として赤字
    const s = fighting[i];
    const left = Math.ceil(s.at + (s.x.battle_end - s.x.push_start) - now);
    el.classList.toggle("late-text", left < 0);
    setText(el, left >= 0 ? `残り ${left}秒` : `${-left}秒 超過`);
  });

  const upcoming = nextBattles(sched);
  setChildren($("#next"), upcoming.map((s) => s.x.id).join(), () =>
    upcoming.length
      ? upcoming.map((s) => h("div", { class: "next-row" },
        h("span", { class: "in" }), playerTag(s.x, false), bossTag(s.x.action),
        h("span", { class: "muted", title: "作戦の出撃時刻" }, mmss(s.x.push_start)), rowNote(s.x)))
      : [h("div", { class: "empty" }, "なし")]);
  $("#next").querySelectorAll(".in").forEach((el, i) => {
    const s = upcoming[i];
    const waiting = s.state === "waiting";
    el.classList.toggle("waiting", waiting);
    setText(el, waiting ? "待機中" : `あと ${Math.max(0, Math.ceil(s.at - now))}秒`);
  });

  renderNotes(sched, now);
  renderChart(sched, fighting, upcoming, now);
  notifyUpcoming(sched, now);

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
  renderNotify();

  const stale = Date.now() - lastSync > 5000;
  setText($("#sync"), stale ? "サーバーと同期できていません" : "同期中");
  $("#sync").classList.toggle("late-text", stale);
}

function rowNote(x) {
  return x.note ? h("span", { class: "row-note" }, `📝 ${x.note}`) : null;
}

const noteLead = () => plan.notify_lead || NOTE_LEAD;

// 注意点の欄。戦闘の注意点は出撃の noteLead 秒前から出撃待ち・挑戦中の間、
// 全体の注意点は作戦の開始秒ちょうどから終了秒まで出す
function renderNotes(sched, now) {
  const lead = noteLead();
  const battles = sched.filter((s) => s.x.note
    && (s.state === "fighting" || s.state === "waiting" || (s.state === "upcoming" && s.at - now <= lead)));
  const ranges = (plan.notes || []).map((n, i) => ({ ...n, i })).filter((n) => n.start <= now && now < n.end);
  const items = [
    ...ranges.map((n) => ({ key: `n${n.i}`, at: n.start, make: () => h("div", { class: "note" },
      h("span", { class: "when" }, `${mmss(n.start)}–${mmss(n.end)}`), h("span", { class: "text" }, n.text)) })),
    ...battles.map((s) => ({ key: `b${s.x.id}`, at: s.at, make: () => h("div", { class: "note" },
      playerTag(s.x, false), bossTag(s.x.action), h("span", { class: "text" }, s.x.note)) })),
  ].sort((a, b) => a.at - b.at);
  $("#notes-box").hidden = !items.length;
  setChildren($("#notes"), items.map((x) => x.key).join(), () => items.map((x) => x.make()));
}

// 全体の注意点は開始秒ちょうどに「注意: 本文」として 1 件ずつ送り、NOTE_SPEAK 秒後 (読み終えたころ) に消させる。
// 開始から NOTE_SPEAK 秒を過ぎてから開いた端末は、古い注意点を送らない。
// 戦闘の注意点はサーバーが出撃の呼び出しに追記するので、ここでは扱わない
const NOTE_SPEAK = 30;
function notifyNotes(now) {
  (plan.notes || []).forEach((n, i) => {
    if (noteSent.has(i) && now >= n.start + NOTE_SPEAK && !noteCleared.has(i)) {
      noteCleared.add(i);
      api("POST", `/api/sessions/${sessionId()}/notify/clear`, { note: i })
        .catch((e) => console.warn("Discord 通知の削除に失敗しました", e));
    }
  });
  if (notifyPaused) return;
  const due = (plan.notes || []).map((n, i) => ({ ...n, i }))
    .filter((n) => !noteSent.has(n.i) && n.start <= now && now < Math.min(n.end, n.start + NOTE_SPEAK));
  if (!due.length) return;
  for (const n of due) noteSent.add(n.i);
  api("POST", `/api/sessions/${sessionId()}/notify`, { notes: due.map((n) => n.i) })
    .catch((e) => console.warn("Discord 通知に失敗しました", e));
}

// 出撃 N 秒前になった戦闘をサーバー経由で Discord に読み上げさせ、出撃したらそのメッセージを消させる。
// 出撃時刻は討伐待ちを無視した最も早い見込み (at) で判断するので、前のボスが倒れていなくても呼びかける。
// その時点で NOTIFY_GROUP 秒以内に続けて出撃する人は 1 通にまとめる。
// 開いている端末がそれぞれ送るが、サーバーが 1 戦 1 回にまとめる。
// 止めている間も、送り済みのメッセージの削除は続ける
const NOTIFY_GROUP = 5;
function notifyUpcoming(sched, now) {
  if (!plan.notify_lead || ended) return;
  for (const s of sched) {
    if (notifySent.has(s.x.id) && s.state !== "upcoming" && !notifyCleared.has(s.x.id)) {
      notifyCleared.add(s.x.id);
      api("POST", `/api/sessions/${sessionId()}/notify/clear`, { battle: s.x.id })
        .catch((e) => console.warn("Discord 通知の削除に失敗しました", e));
    }
  }
  notifyNotes(now);
  if (notifyPaused) return;
  const pending = sched.filter((s) => s.state === "upcoming" && !notifySent.has(s.x.id));
  if (!pending.some((s) => s.at - now <= plan.notify_lead)) return;
  const group = pending.filter((s) => s.at - now <= plan.notify_lead + NOTIFY_GROUP)
    .sort((a, b) => a.at - b.at);
  for (const s of group) notifySent.add(s.x.id);
  api("POST", `/api/sessions/${sessionId()}/notify`, { battles: group.map((s) => s.x.id) })
    .catch((e) => console.warn("Discord 通知に失敗しました", e));
}

// ---------------------------------------------------------------- 操作

function applyResponse(j) {
  if (j.version < version) return;
  version = j.version;
  if (j.plan && !plan) { plan = j.plan; buildBoard(); }
  if (j.events) events = j.events;
  if ("notify_paused" in j) notifyPaused = j.notify_paused;
  lastSync = Date.now();
}

async function poll() {
  try {
    applyResponse(await api("GET", `/api/sessions/${sessionId()}?since=${plan ? version : 0}`));
  } catch (e) {
    if (e.status === 404) { endSession(plan ? "このセッションは破棄されました（または期限切れです）" : e.message); return; }
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

function toggleNotify() {
  if (!notifyPaused && !confirm("全端末の Discord 通知を止めますか？ (再開するまで読み上げもテキストも送りません)")) return;
  act("notify/pause", { paused: !notifyPaused });
}

async function discard() {
  if (!confirm("このセッションを破棄しますか？\n全端末で進行管理が終わり、Discord 通知も止まります。元に戻せません。")) return;
  try {
    await api("DELETE", `/api/sessions/${sessionId()}`);
    endSession("セッションを破棄しました");
  } catch (e) {
    if (e.status === 404) endSession("このセッションは既に破棄されています（または期限切れです）");
    else showStatus(e.message);
  }
}

// 破棄・期限切れになったら盤面を閉じ、通知の依頼も含めて何もしなくなる
function endSession(msg) {
  ended = true;
  clearInterval(tickTimer);
  for (const id of ["#board", "#btn-share", "#btn-end", "#btn-notify", "#notify"]) $(id).hidden = true;
  clearTimeout(showStatus.timer);
  $("#status").classList.remove("ok");
  $("#status").textContent = msg;
  $("#status").hidden = false;
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
  try {
    $("#setup-webhook").value = localStorage.getItem(WEBHOOK_KEY) || "";
    $("#setup-tts").checked = localStorage.getItem(TTS_KEY) !== "0";
  } catch (e) { /* 覚えていない */ }
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
    const webhook = $("#setup-webhook").value.trim();
    try {
      const j = await api("POST", "/api/sessions", {
        text: $("#setup-text").value, start_epoch_ms: start,
        discord_webhook: webhook, notify_lead: Number($("#setup-lead").value),
        notify_tts: $("#setup-tts").checked,
      });
      try {
        localStorage.setItem(TTS_KEY, $("#setup-tts").checked ? "1" : "0");
        if (webhook) localStorage.setItem(WEBHOOK_KEY, webhook);
        else localStorage.removeItem(WEBHOOK_KEY);
      } catch (e) { /* 覚えなくてよい */ }
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
  $("#btn-notify").addEventListener("click", toggleNotify);
  $("#btn-end").addEventListener("click", discard);
  if (!sessionId()) { showSetup(); return; }
  poll();
  tickTimer = setInterval(render, TICK_MS);
}

init();
