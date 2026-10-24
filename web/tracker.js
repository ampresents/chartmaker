"use strict";
// chartmaker 進行管理
// サーバーのセッション (作戦 plan と討伐イベント events) を 1 秒ごとに取得し、表示はすべて手元で計算する。

const REGULAR = BOSSES.slice(0, 3);
const POLL_MS = 1000;
// 作戦の前後 (開始 10 分前より前、終了 30 分後より後) と、隠れた個人ビューはポーリングを遅くする。
// 閉じ忘れたタブが Firestore を毎秒読み続けないように
const IDLE_POLL_MS = 10000;
const IDLE_BEFORE = 600, IDLE_AFTER = 1800;
const TICK_MS = 200;
// 作戦画像 (ChartLib の固定レイアウト): 列の左端 120 + i*246、幅 240、y = 秒 + 160
const CHART_X0 = 120, CHART_COL = 246, CHART_COL_W = 240, CHART_TOP = 160;
// 固定する帯の高さ。パーティの丸 (〜130) までを含め、60:00 の目盛り (148〜) は含めない
const CHART_HEAD = 140;
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
let pollTimer = null;      // 次のポーリングを待っている間だけ setTimeout の id
const notifySent = new Set(); // この端末から Discord 通知を頼んだ戦闘 (plan.detail の添字)
const notifyCleared = new Set(); // そのうち、出撃したので通知の削除を頼んだ戦闘
const noteSent = new Set();     // この端末から Discord 通知を頼んだ全体の注意点 (plan.notes の添字)
const noteCleared = new Set();  // そのうち、始まったので通知の削除を頼んだもの
const NOTE_LEAD = 30;           // 通知なしのセッションで、注意点を何秒前から出すか
const RESORTIE_MARGIN = 1;      // クールタイム明けから実際に再出撃できるまでの秒 (操作の時間)
let starts = {};                // 手で補正した実際の出撃秒 { plan.detail の添字: 秒 } (サーバーに保存し全端末で共有)
let startShift = 0;             // 開始時刻を作成時から何秒ずらしたか (サーバーに保存し全端末で共有)
let serverStart = 0;            // サーバーにある開始時刻 (ms)。plan.start_epoch_ms はこれ + shiftLocal 秒
let shiftLocal = 0;             // 押したがまだサーバーに反映されていない秒 (送信中を含む)
let shiftQueued = 0;            // そのうちまだ送っていない秒
let shiftSending = false;
let shiftTimer = 0, shiftRepeat = 0;
const SHIFT_MAX = 600;          // app.py と同じ (作成時から ±10 分)
const SHIFT_HOLD_MS = 400, SHIFT_REPEAT_MS = 100; // 押し続けたときの繰り返し
const SHIFT_SEND_MS = 500;      // 最後に押してからまとめて送るまで
let fixPlayer = null;           // 補正ダイアログで開いているプレイヤー (raw_name)
// 個人ビュー (?p=<raw_name>): 1 人の出撃だけを大きく出す閲覧専用の画面。討伐・補正・破棄・Discord 通知はしない
const personal = new URLSearchParams(location.search).has("p");
let me = null;                  // 個人ビューで表示中のプレイヤー (raw_name)。見つからなければ null で選択欄を出す

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

// (階層, ボス) に挑戦できるようになった秒 (actual、まだなら null) と作戦上の秒 (planned、作戦の範囲外なら null)
function bossGate(floor, boss) {
  const open = floor === 1 ? 0 : killTime(floor - 1, "Realm_boss");
  const plannedOpen = floor === 1 ? 0 : planned(floor - 1, "Realm_boss");
  if (boss !== "Realm_boss") return { actual: open, planned: plannedOpen, reason: `LV${floor} 開放待ち` };
  if (open === null) return { actual: null, planned: null, reason: `LV${floor} 開放待ち` };
  const regular = REGULAR.map((b) => killTime(floor, b));
  const plannedRegular = REGULAR.map((b) => planned(floor, b));
  return {
    actual: regular.includes(null) ? null : Math.max(open, ...regular),
    planned: plannedOpen === null || plannedRegular.includes(null) ? null : Math.max(plannedOpen, ...plannedRegular),
    reason: "3体討伐待ち",
  };
}

// 出撃 s のあと、次に出撃できる秒 (クールタイム明け + 操作の 1 秒)
const readyAt = (s) => s.at + (s.x.battle_start - s.x.push_start) + COOL_TIME + RESORTIE_MARGIN;

// 討伐記録から各戦闘の実際の出撃を見積もる。出撃は次の条件がすべてそろった時点:
//   作戦の出撃時刻 / 前の戦闘の出撃からクールタイム明け (readyAt) / 前の戦闘のボスが討伐済み / 挑戦先のボスに挑戦可能
// 作戦は討伐から余裕を置いて出撃するように作られているので、討伐 (開放) が作戦より遅れたら、その余裕を保って
// 出撃も同じ秒数だけ遅らせる (作戦が 1:00 討伐・1:06 出撃で、討伐が 1:02 なら出撃は 1:08)。早まっても作戦より早めない。
// 手で補正した出撃 (starts) があればそれを実際の出撃とし、後の戦闘にも持ち越す。
// 戦闘は対象ボスの討伐ボタンが押されるまで続く (作戦の終了時刻では終わらない)。
// state: "done" 討伐済み, "skip" 出撃前に対象が討伐された, "fighting" 挑戦中,
//        "waiting" 作戦の出撃時刻を過ぎたが出撃できない, "upcoming" 出撃前
// at: 出撃した秒、または出撃できる最も早い秒 (waiting では未確定)。wait: 未確定の理由。fixed: 手で補正した
function schedule(now) {
  const out = [];
  for (const battles of plan.byPlayer) {
    let prev = null;
    for (const x of battles) {
      let at = x.push_start;
      let known = true;
      let wait = null;
      const gate = (actual, plannedAt, reason) => {
        if (actual === null) { if (known) wait = reason; known = false; return; }
        at = Math.max(at, plannedAt === null ? actual : actual + Math.max(0, x.push_start - plannedAt));
      };
      if (prev) {
        at = Math.max(at, readyAt(prev));
        if (!prev.known) { known = false; wait = prev.wait; }
        gate(killTime(prev.x.level, prev.x.action), planned(prev.x.level, prev.x.action),
          `${BOSS_LABEL[prev.x.action]} 討伐待ち`);
      }
      const g = bossGate(x.level, x.action);
      gate(g.actual, g.planned, g.reason);
      const fixed = String(x.id) in starts;
      if (fixed) { at = starts[x.id]; known = true; wait = null; }
      const kt = killTime(x.level, x.action);
      let state;
      // 補正した戦闘は出撃したと明示されているので、討伐がそれより前でもスキップにしない
      if (known && at <= now) state = kt === null ? "fighting" : kt < at && !fixed ? "skip" : "done";
      else if (kt !== null) state = "skip";
      else state = at <= now ? "waiting" : "upcoming";
      const s = { x, at, known, wait, fixed, state };
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
  setStartLabel();
  // ゲームのサーバーと時計がずれているとき用。+ で開始を遅らせる (開始まで・残り時間が増える)
  // 押し続けると繰り返す。押した分はまとめて 1 回で送る
  $("#shift-box").querySelectorAll("[data-shift]").forEach((b) => {
    const d = Number(b.dataset.shift);
    b.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      e.preventDefault();
      stopShiftRepeat();
      stepShift(d);
      shiftRepeat = setTimeout(function again() {
        stepShift(d);
        shiftRepeat = setTimeout(again, SHIFT_REPEAT_MS);
      }, SHIFT_HOLD_MS);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, stopShiftRepeat);
    // キーボード (Enter/Space) の click は detail が 0
    b.addEventListener("click", (e) => { if (!e.detail) stepShift(d); });
  });

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
  buildTimers();
  // 個人ビューでは作戦チャート (0.3〜1.4 MB) を読み込まない
  if (personal) buildPersonal();
  else { buildChart(); buildPeople(); reviewBuild(); }
  $("#board").hidden = false;
  $("#btn-share").hidden = false;
  $("#btn-end").hidden = personal;
  $("#btn-people").hidden = personal;
  $("#btn-board").hidden = !personal;
  if (plan.notify_lead) {
    $("#notify").hidden = false;
    $("#btn-notify").hidden = personal;
    renderNotify();
  }
}

// ---------------------------------------------------------------- 個人ビュー

const personalUrl = (name) => `${location.origin}/tracker/${sessionId()}?p=${encodeURIComponent(name)}`;

async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); showStatus(msg, true); } catch (e) { prompt("コピーしてください", text); }
}

// 全体の画面の「個人ビュー」ダイアログ: プレイヤーごとの URL を開く・コピーする (Discord に貼って配る用)
function buildPeople() {
  const dlg = $("#people-dialog");
  $("#people-list").replaceChildren(...plan.byPlayer.map((battles) => {
    const x = battles[0];
    const url = personalUrl(x.raw_name);
    return h("div", { class: "people-row" }, playerTag(x, false),
      h("a", { class: "btn", href: url, target: "_blank", rel: "noopener" }, "開く"),
      h("button", { type: "button", onclick: () => copyText(url, `${x.player_name} の URL をコピーしました`) }, "コピー"));
  }));
  $("#btn-people").addEventListener("click", () => dlg.showModal());
  $("#people-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  $("#people-copy-all").addEventListener("click", () => copyText(
    plan.byPlayer.map((b) => `${b[0].player_name} ${personalUrl(b[0].raw_name)}`).join("\n"),
    "全員分の URL をコピーしました"));
}

function buildPersonal() {
  document.body.classList.add("personal");
  const sel = $("#me-select");
  sel.replaceChildren(h("option", { value: "" }, "プレイヤーを選ぶ"),
    ...plan.byPlayer.map((b) => h("option", { value: b[0].raw_name }, b[0].player_name)));
  sel.addEventListener("change", () => { setMe(sel.value); render(); });
  $("#btn-board").href = `/tracker/${sessionId()}`;
  setMe(new URLSearchParams(location.search).get("p"));
  $("#me").hidden = false;
}

function setMe(name) {
  me = plan.column.has(name) ? name : null;
  $("#me-select").value = me || "";
  history.replaceState(null, "", `/tracker/${sessionId()}?p=${encodeURIComponent(me || "")}`);
  const x = me && plan.byPlayer[plan.column.get(me)][0];
  document.title = x ? `${x.player_name} - 進行管理` : "進行管理";
}

// 自分の挑戦中・次の出撃を大きく出し、その下に自分の戦闘をすべて並べる
function renderMe(sched, now) {
  if (!personal) return;
  $("#me-empty").hidden = !!me;
  $("#me-body").hidden = !me;
  if (!me) return;
  const mine = sched.filter((s) => s.x.raw_name === me);
  const { fighting, next } = playerStatus(sched, me);
  const target = fighting || next;
  let label, count, sub, cls = "";
  if (fighting) {
    const left = Math.ceil(fighting.at + (fighting.x.battle_end - fighting.x.push_start) - now);
    const ready = Math.ceil(readyAt(fighting) - now);
    label = "挑戦中";
    count = left >= 0 ? `残り ${left}秒` : `${-left}秒 超過`;
    cls = left >= 0 ? "m-fighting" : "m-fighting m-over";
    sub = (ready > 0 ? `再出撃まで ${mmss(ready)}` : "クールタイム明け")
      + (next ? `　次 LV${next.x.level} ${BOSS_LABEL[next.x.action]}` : "");
  } else if (next && next.state === "waiting") {
    label = "出撃待ち";
    count = "待機中";
    cls = "m-waiting";
    sub = next.wait || "前のボスの討伐待ち";
  } else if (next) {
    const left = Math.max(0, Math.ceil(next.at - now));
    const diff = Math.round(next.at - next.x.push_start);
    label = "次の出撃まで";
    count = mmss(left);
    cls = left <= noteLead() ? "m-soon" : "";
    sub = next.known
      ? `見込み ${mmss(next.at)}（作戦 ${mmss(next.x.push_start)}${diff > 0 ? ` +${diff}秒` : ""}）`
      : `${next.wait || "待機中"}（早くても ${mmss(next.at)}）`;
  } else {
    label = "作戦終了";
    count = "--:--";
    cls = "m-end";
    sub = "作戦の出撃はもうありません";
  }
  $("#me-card").className = `me-card ${cls}`;
  $("#me-card").style.setProperty("--boss", target ? bgr(plan.bosses[target.x.action].color) : "");
  setText($("#me-label"), label);
  setChildren($("#me-target"), target ? `${target.x.id}` : "", () =>
    target ? [h("span", { class: "muted" }, `LV${target.x.level}`), bossTag(target.x.action)] : []);
  setText($("#me-count"), count);
  setText($("#me-sub"), sub);
  setText($("#me-note"), target?.x.note ? `📝 ${target.x.note}` : "");
  $("#me-note").hidden = !target?.x.note;

  setChildren($("#me-list"), `${me}|${target?.x.id}|${mine.map((s) => s.state).join()}`, () => mine.map((s) =>
    h("div", { class: `me-row s-${s.state}${s === target ? " current" : ""}` },
      h("span", { class: "muted" }, `LV${s.x.level}`), bossTag(s.x.action),
      h("span", { class: "muted", title: "作戦の出撃時刻" }, mmss(s.x.push_start)),
      h("span", { class: "me-at" }), h("span", { class: "me-state" }), rowNote(s.x))));
  const rows = $("#me-list").children;
  mine.forEach((s, i) => {
    const at = rows[i].querySelector(".me-at"), st = rows[i].querySelector(".me-state");
    const wait = s.state === "waiting" || (s.state === "upcoming" && !s.known);
    setText(at, s.state === "skip" ? "" : wait ? s.wait || "待機中"
      : `${s.state === "upcoming" ? "見込み" : "出撃"} ${mmss(s.at)}${s.fixed ? " ✎" : ""}`);
    setText(st, {
      done: "済", skip: "中止（先に討伐）", fighting: "挑戦中", waiting: "待機中",
    }[s.state] || `あと ${mmss(Math.max(0, Math.ceil(s.at - now)))}`);
  });
}

function buildChart() {
  const img = $("#chart-img");
  ui.chartNow = h("div", { class: "chart-now" });
  img.addEventListener("load", () => { $("#chart-box").hidden = false; render(); }, { once: true });
  img.addEventListener("error", () => { $("#chart-box").hidden = true; }, { once: true });
  img.src = `/api/sessions/${sessionId()}/chart.png`;
  // チームと名前の帯 (画像の上端から CHART_HEAD まで) を同じ画像で重ね、縦スクロールしても上に固定する。
  // 帯の高さぶん本体を上にずらして、スクロールしていないときは本体とぴったり重なるようにする
  $("#chart-head-img").src = img.src;
  new ResizeObserver(() => {
    if (!img.naturalHeight) return;
    const head = `${img.offsetHeight * CHART_HEAD / img.naturalHeight}px`;
    $("#chart-head").style.height = head;
    $(".chart-wrap").style.marginTop = `-${head}`;
  }).observe(img);
  // クリックで、横幅に合わせた縮小表示と原寸 (横スクロール) を切り替える
  $("#chart-scroll").addEventListener("click", () => $("#chart-scroll").classList.toggle("full"));
}

// 作戦画像の上に重ねる矩形。位置は画像に対する % なので、縮小しても合う
// 終わった戦闘はクールタイム明け (cool_off = battle_start + 300) まで、それ以外は戦闘の終わりまで
function chartHit(x, cls, end = x.battle_end) {
  const img = $("#chart-img");
  const W = img.naturalWidth, H = img.naturalHeight;
  const col = plan.column.get(x.raw_name);
  return h("div", { class: `chart-hit ${cls}`, style: {
    left: `${(CHART_X0 + col * CHART_COL) / W * 100}%`,
    width: `${CHART_COL_W / W * 100}%`,
    top: `${(x.push_start + CHART_TOP) / H * 100}%`,
    height: `${Math.max(end - x.push_start, 1) / H * 100}%`,
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
    ...done.map((s) => chartHit(s.x, "done", s.x.battle_start + COOL_TIME)),
    ...upcoming.map((s) => chartHit(s.x, "next")),
    ...fighting.map((s) => chartHit(s.x, overdue(s) ? "fighting late" : "fighting")),
    ui.chartNow,
  ]);
  // 作戦上の現在時刻。挑戦中のブロックより上にあれば、その分だけ遅れている
  const line = ui.chartNow;
  line.hidden = now < 0 || now > CHART_SEC;
  line.style.top = `${(Math.floor(now) + CHART_TOP) / img.naturalHeight * 100}%`;
}

// 進行の段階: 階層ごとに 1st/2nd/3rd が 2n、Realm が 2n+1 (n = 階層 − 1)
const stageOf = (level, boss) => (level - 1) * 2 + (boss === "Realm_boss" ? 1 : 0);
function currentStage() {
  const floor = 1 + events.filter((e) => e.boss === "Realm_boss").length;
  return stageOf(floor, REGULAR.every((b) => killTime(floor, b) !== null) ? "Realm_boss" : REGULAR[0]);
}

// 次に出撃: 今の段階から次の次の段階まで (1st/2nd/3rd なら同じ階層の Realm と次の階層の 1st/2nd/3rd、
// Realm なら次の階層の 1st/2nd/3rd と Realm) の出撃前の戦闘。待機中を先に、あとは出撃の早い順
function nextBattles(sched) {
  const cur = currentStage();
  return sched.filter((s) => {
    if (s.state !== "waiting" && s.state !== "upcoming") return false;
    const st = stageOf(s.x.level, s.x.action);
    return st >= cur && st <= cur + 2;
  }).sort((a, b) => (a.state === "waiting" ? 0 : 1) - (b.state === "waiting" ? 0 : 1) || a.at - b.at || a.x.push_start - b.x.push_start);
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
    // 開始前は押せない (押し間違いで階層が進まないように。サーバーも 409 を返す)
    u.btn.disabled = busy || dead || locked || now < 0;
    u.btn.title = now < 0 ? "作戦の開始後に押せます" : "";
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
        h("span", { class: "in" }), playerTag(s.x, false), h("span", { class: "muted" }, `LV${s.x.level}`), bossTag(s.x.action),
        h("span", { class: "muted", title: "作戦の出撃時刻" }, mmss(s.x.push_start)), rowNote(s.x)))
      : [h("div", { class: "empty" }, "なし")]);
  $("#next").querySelectorAll(".in").forEach((el, i) => {
    const s = upcoming[i];
    const waiting = s.state === "waiting";
    el.classList.toggle("waiting", waiting);
    setText(el, waiting ? "待機中" : `あと ${Math.max(0, Math.ceil(s.at - now))}秒`);
  });

  renderNotes(sched, now);
  renderMe(sched, now);
  renderTimers(sched, now);
  renderChart(sched, fighting, upcoming, now);
  // 個人ビューは閲覧専用なので Discord 通知を頼まない (全体の画面を開いている端末が送る)
  if (!personal) notifyUpcoming(sched, now);

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
  if (!personal) reviewRefresh();

  // 10 秒おきのポーリング中は、その間隔を待ってから遅れと見なす
  // (delay という名前は遅れを求める関数 delay() と衝突し、render() 全体が ReferenceError になる)
  const pollMs = pollDelay();
  const stale = Date.now() - lastSync > pollMs + 5000;
  setText($("#sync"), stale ? "サーバーと同期できていません"
    : pollMs === POLL_MS ? "同期中"
    : now < -IDLE_BEFORE ? "待機中（開始 10 分前から毎秒同期します）" : "待機中（10 秒ごとに同期）");
  $("#sync").classList.toggle("late-text", stale);
}

// ---------------------------------------------------------------- 出撃タイマー

// プレイヤーの出撃の状況。started: 直近に出撃した戦闘 (挑戦中を含む)、fighting: 挑戦中、next: 次の戦闘
function playerStatus(sched, name) {
  const mine = sched.filter((s) => s.x.raw_name === name);
  const started = mine.filter((s) => s.state === "fighting" || s.state === "done");
  return {
    started: started[started.length - 1] || null,
    fighting: mine.find((s) => s.state === "fighting") || null,
    next: mine.find((s) => s.state === "waiting" || s.state === "upcoming") || null,
  };
}

// 作戦画像と同じ列順に、プレイヤーごとのカードを作り置きする。押すと補正ダイアログを開く
function buildTimers() {
  ui.timers = new Map();
  $("#timers").replaceChildren(...plan.byPlayer.map((battles) => {
    const x = battles[0];
    const count = h("div", { class: "timer-count" });
    const bar = h("div", { class: "timer-bar" });
    const sub = h("div", { class: "timer-sub" });
    const mark = h("span", { class: "timer-mark", title: "出撃時刻を手で補正しています" }, "✎");
    const card = h("button", { class: "timer", type: "button", onclick: () => openFix(x.raw_name) },
      h("div", { class: "timer-head" }, playerTag(x, false), mark), count,
      h("div", { class: "timer-track" }, bar), sub);
    ui.timers.set(x.raw_name, { card, count, bar, sub, mark });
    return card;
  }));
  const dlg = $("#fix-dialog");
  $("#fix-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener("close", () => { fixPlayer = null; });
  $("#fix-ready").addEventListener("click", () => { fixReady(); dlg.close(); });
  dlg.querySelectorAll("[data-d]").forEach((b) => b.addEventListener("click", () => fixNudge(Number(b.dataset.d))));
}

// 再出撃までのカウントダウン。クールタイムが明けたら「出撃可能」(次の相手がまだ開いていなければその理由も出す)
function renderTimers(sched, now) {
  for (const [name, u] of ui.timers) {
    const { started, fighting, next } = playerStatus(sched, name);
    const left = started ? Math.ceil(readyAt(started) - now) : 0;
    let state, count, sub;
    if (fighting && left > 0) {
      state = "t-fighting";
      count = `挑戦中 ${BOSS_LABEL[fighting.x.action]}`;
      sub = `再出撃まで ${mmss(Math.max(0, left))}`;
    } else if (fighting) {
      // 討伐ボタンが押されていなくても、クールタイムが明けていれば出撃可能
      state = "t-ready";
      count = "出撃可能";
      sub = `挑戦中 ${BOSS_LABEL[fighting.x.action]} (討伐待ち)`;
    } else if (!next) {
      state = left > 0 ? "t-cool t-end" : "t-end";
      count = left > 0 ? mmss(left) : "作戦終了";
      sub = "作戦の出撃はもうありません";
    } else {
      state = left > 0 ? "t-cool" : "t-ready";
      count = left > 0 ? mmss(left) : "出撃可能";
      sub = `次 ${BOSS_LABEL[next.x.action]}　` + (next.known ? `見込み ${mmss(next.at)}` : next.wait || "待機中");
    }
    u.card.className = `timer ${state}`;
    u.card.style.setProperty("--boss", fighting ? bgr(plan.bosses[fighting.x.action].color) : "");
    setText(u.count, count);
    setText(u.sub, sub);
    const span = COOL_TIME + RESORTIE_MARGIN;
    u.bar.style.width = `${left > 0 ? Math.max(0, Math.min(100, (1 - left / span) * 100)) : 100}%`;
    u.mark.hidden = !(started?.fixed || next?.fixed);
  }
  if (fixPlayer) renderFix(sched, now);
}

function openFix(name) {
  fixPlayer = name;
  renderFix(schedule(elapsed()), elapsed());
  $("#fix-dialog").showModal();
}

// 補正ダイアログ。どちらも直近の出撃 (挑戦中を含む) の時刻を動かし、カードのカウントダウンを直す
function renderFix(sched, now) {
  const { started, next } = playerStatus(sched, fixPlayer);
  const x = plan.byPlayer.find((b) => b[0].raw_name === fixPlayer)[0];
  const left = started ? Math.ceil(readyAt(started) - now) : 0;
  setText($("#fix-name"), x.player_name);
  // 開始前は補正しない (サーバーも 409 を返す)
  setText($("#fix-left"), now < 0 ? "作戦の開始後に補正できます" : left > 0 ? `出撃可能まで あと ${mmss(left)}` : "出撃可能");
  for (const el of $("#fix-dialog").querySelectorAll("[data-d]")) el.disabled = busy || now < 0 || !(started || next);
  $("#fix-ready").disabled = busy || now < 0 || left <= 0;
}
// 補正する戦闘: 直近の出撃 (挑戦中を含む)。まだ 1 度も出撃していなければ次の戦闘を今出撃したことにする
function fixTarget(now) {
  const { started, next } = playerStatus(schedule(now), fixPlayer);
  return started || next;
}
function setLeft(left) {
  const now = elapsed();
  const st = fixTarget(now);
  if (!st) return;
  // 出撃した直後 (残り = クールタイム) より前には戻せない。出撃が未来になると挑戦中から外れるため
  const cool = readyAt(st) - st.at;
  // 開始から 5 分以内は t が負になる (サーバーは START_RANGE で受け付ける)
  const t = Math.floor(now + Math.min(Math.max(0, left), cool) - cool);
  if (t !== st.at || !st.fixed) act("start", { battle: st.x.id, t });
}
function fixReady() { setLeft(0); }
// 表示中のカウントダウンを d 秒増減する。出撃可能から + すると今から数え直す
function fixNudge(d) {
  const now = elapsed();
  const { started } = playerStatus(schedule(now), fixPlayer);
  const left = started ? Math.max(0, Math.ceil(readyAt(started) - now)) : 0;
  if (left + d > 0 || left > 0) setLeft(left + d);
}

function rowNote(x) {
  return x.note ? h("span", { class: "row-note" }, `📝 ${x.note}`) : null;
}

const noteLead = () => plan.notify_lead || NOTE_LEAD;

// 注意点の欄。戦闘の注意点は出撃の noteLead 秒前から出撃待ち・挑戦中の間、
// 全体の注意点は作戦の開始秒ちょうどから終了秒まで出す
function renderNotes(sched, now) {
  const lead = noteLead();
  const battles = sched.filter((s) => s.x.note && (!personal || s.x.raw_name === me)
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

function setStartLabel() {
  const st = new Date(plan.start_epoch_ms);
  const sec = st.getSeconds() ? `:${pad2(st.getSeconds())}` : "";
  $("#clock-sub").dataset.start = `開始 ${st.getMonth() + 1}/${st.getDate()} ${pad2(st.getHours())}:${pad2(st.getMinutes())}${sec}`;
  const shift = startShift + shiftLocal;
  setText($("#shift-info"), shift ? `補正 ${shift > 0 ? "+" : ""}${shift}秒` : "");
}

// 開始時刻の微調整。押した分は先に表示へ反映し (shiftLocal)、少し待ってまとめて送る
function stepShift(d) {
  if (Math.abs(startShift + shiftLocal + d) > SHIFT_MAX) return;
  shiftLocal += d;
  shiftQueued += d;
  applyStart();
  render();
  clearTimeout(shiftTimer);
  shiftTimer = setTimeout(flushShift, SHIFT_SEND_MS);
}

function stopShiftRepeat() {
  if (!shiftRepeat) return;
  clearTimeout(shiftRepeat);
  shiftRepeat = 0;
  clearTimeout(shiftTimer);
  flushShift();
}

async function flushShift() {
  if (shiftSending || !shiftQueued || shiftRepeat) return;
  const delta = shiftQueued;
  shiftQueued = 0;
  shiftSending = true;
  let j = null;
  try {
    j = await api("POST", `/api/sessions/${sessionId()}/shift`, { delta });
  } catch (e) {
    showStatus(e.message);
    try { j = await api("GET", `/api/sessions/${sessionId()}`); } catch (e2) { /* 次のポーリングに任せる */ }
  }
  shiftLocal -= delta;
  shiftSending = false;
  if (j) applyResponse(j);
  applyStart();
  render();
  if (shiftQueued) flushShift();
}

function applyStart() {
  plan.start_epoch_ms = serverStart + shiftLocal * 1000;
  setStartLabel();
}

function applyResponse(j) {
  if (j.version < version) return;
  version = j.version;
  if ("start_shift" in j) startShift = j.start_shift;
  // 開始時刻は他の端末で微調整されることがある (shift の応答は start_epoch_ms だけを返す)
  const start = j.plan ? j.plan.start_epoch_ms : j.start_epoch_ms;
  if (start != null) serverStart = start;
  if (j.plan && !plan) { plan = j.plan; buildBoard(); }
  if (plan && start != null) applyStart();
  if (j.events) events = j.events;
  if (j.starts) starts = j.starts;
  if ("notify_paused" in j) notifyPaused = j.notify_paused;
  lastSync = Date.now();
}

function pollDelay() {
  if (!plan) return POLL_MS;
  const now = elapsed();
  if (now < -IDLE_BEFORE || now > CHART_SEC + IDLE_AFTER) return IDLE_POLL_MS;
  // 全体ボードは隠れていても Discord 通知を頼むので、作戦中は毎秒のまま
  if (document.hidden && personal) return IDLE_POLL_MS;
  return POLL_MS;
}

async function poll() {
  pollTimer = null;
  try {
    applyResponse(await api("GET", `/api/sessions/${sessionId()}?since=${plan ? version : 0}`));
  } catch (e) {
    if (e.status === 404) { endSession(plan ? "このセッションは破棄されました（または期限切れです）" : e.message); return; }
  }
  pollTimer = setTimeout(poll, pollDelay());
}

// 遅いポーリングの途中で表示されたら、待たずに取りに行く
document.addEventListener("visibilitychange", () => {
  if (document.hidden || ended || pollTimer === null) return;
  clearTimeout(pollTimer);
  poll();
});

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
  clearTimeout(pollTimer);
  for (const id of ["#board", "#btn-share", "#btn-end", "#btn-notify", "#notify", "#btn-people", "#btn-board", "#btn-review"]) $(id).hidden = true;
  if ($("#review-dialog").open) $("#review-dialog").close();
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
    e.target.value = "";
    if (!f) return;
    try { setupText(planTextOf(await f.text())); } catch (err) { showStatus(err.message); }
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
  $("#btn-share").addEventListener("click", () => copyText(location.href, "URL をコピーしました"));
  $("#btn-undo").addEventListener("click", undo);
  $("#btn-notify").addEventListener("click", toggleNotify);
  $("#btn-end").addEventListener("click", discard);
  if (!sessionId()) { showSetup(); return; }
  poll();
  tickTimer = setInterval(render, TICK_MS);
}

init();
