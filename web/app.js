"use strict";
// chartmaker GUI
// 状態は絶対秒 (push_start) で持ち、txt を出力するときに待機秒数 (相対) へ変換する。

const IMAGE_KEYS = { "1st_boss": "image_1st", "2nd_boss": "image_2nd", "3rd_boss": "image_3rd", "Realm_boss": "image_realm" };
const FLAGS = { display_team: "チーム名を表示", display_boss: "ボス画像を表示", display_party: "有利属性を表示", display_remaining: "時刻を残り時間で表示" };
const KNOWN_KEYS = new Set(["comment", "start_time", "timelag", ...BOSSES, ...Object.values(IMAGE_KEYS), ...Object.keys(FLAGS)]);
const MAX_PLAYERS = 20;
const MAX_BATTLE = 300;
const STORAGE_KEY = "chartmaker.draft.v1";
const SEP = "################################";

let CONFIG = null;
let IMAGES = [];
let state = null;
let undoStack = [];
let redoStack = [];
let selection = null;      // {p, a}  a は null ならプレイヤー選択
let scale = 0.25;          // px / 秒
let details = [];          // /api/detail の結果 (出力順)
let detailTimer = null;
let textDirty = false;

const $ = (sel) => document.querySelector(sel);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style" && typeof v === "object") Object.assign(el.style, v);
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
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const mmss = (s) => `${s < 0 ? "-" : ""}${String(Math.floor(Math.abs(s) / 60)).padStart(2, "0")}:${String(Math.abs(s) % 60).padStart(2, "0")}`;
// 画面に出す時刻。「残り時間で表示」なら 60 分からの残り（ChartLib.format_clock と同じ）
const remaining = () => !!state.constants.display_remaining;
const clock = (s) => mmss(remaining() ? CHART_SEC - s : s);
const fmt = (n) => n.toLocaleString("en-US");
const teamOf = (id) => id.slice(0, -2);
// txt の構文を壊さないよう「=」と改行を置き換える
const sanitize = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").replace(/=/g, "＝");

function parseTime(v) {
  v = String(v).trim();
  const m = v.match(/^(\d+):(\d{1,2})$/);
  if (m) return parseInt(m[1]) * 60 + parseInt(m[2]);
  if (/^\d+$/.test(v)) return parseInt(v);
  return null;
}

// ゲーム開始のローカル時刻 HH:MM（進捗管理で使う）
const validStartTime = (v) => /^\d{1,2}:\d{2}$/.test(String(v ?? ""));

function timelag(st = state) { return parseInt(st.constants.timelag) || 0; }
function blockLen(st = state) { return timelag(st) + COOL_TIME; }

// ---------------------------------------------------------------- 状態

function defaultState() {
  const blank = IMAGES.includes("/image/blank.png") ? "/image/blank.png" : IMAGES[0] || "";
  return {
    constants: {
      comment: CONFIG.comment,
      start_time: "",
      timelag: String(CONFIG.timelag),
      "1st_boss": "blue", "2nd_boss": "red", "3rd_boss": "green", "Realm_boss": "yellow",
      image_1st: blank, image_2nd: blank, image_3rd: blank, image_realm: blank,
      display_team: false, display_boss: false, display_party: false,
    },
    extras: [],   // GUI が扱わない定数 [key, value]
    players: [],  // {id, name, actions: [{start, boss, battle, rate, locked?}]}
  };
}

function looksLikePlayer(key) {
  return key.length > 2 && teamOf(key) in CONFIG.team.team_color;
}

// ChartLib.parse の結果から状態を作る (calc_level と同じ手順で絶対秒に戻す)
function stateFromParsed(commands, constants) {
  const st = defaultState();
  for (const f of Object.keys(FLAGS)) st.constants[f] = f in constants;
  for (const [k, v] of Object.entries(constants)) {
    if (KNOWN_KEYS.has(k) && !(k in FLAGS)) st.constants[k] = v ?? "";
  }
  const len = blockLen(st);
  const byId = {};
  const clock = {};
  for (const [id, wait, boss, battle, rate] of commands) {
    if (!byId[id]) {
      byId[id] = { id, name: constants[id] ?? "", actions: [] };
      st.players.push(byId[id]);
      clock[id] = 0;
    }
    clock[id] += parseInt(wait);
    byId[id].actions.push({ start: clock[id], boss, battle: parseInt(battle), rate: parseFloat(rate) });
    clock[id] += len;
  }
  for (const [k, v] of Object.entries(constants)) {
    if (KNOWN_KEYS.has(k) || byId[k]) continue;
    // ::ID=表示名 で ID と表示名が同じもの（ID 空欄で追加した人）も戦闘がなくてもプレイヤーとみなす
    if (looksLikePlayer(k) || k === v) {
      byId[k] = { id: k, name: v ?? "", actions: [] };
      st.players.push(byId[k]);
    } else {
      st.extras.push([k, v]);
    }
  }
  return st;
}

// 状態から今のルールどおりの txt を作る
function toText(st = state) {
  const c = st.constants;
  const out = [SEP, `::comment=${sanitize(c.comment)}`, SEP];
  const named = st.players.filter((p) => p.name);
  if (named.length) {
    for (const p of named) out.push(`::${p.id}=${sanitize(p.name)}`);
    out.push(SEP);
  }
  if (validStartTime(c.start_time)) out.push(`::start_time=${c.start_time}`);
  out.push(`::timelag=${timelag(st)}`);
  for (const b of BOSSES) out.push(`::${b}=${c[b]}`);
  out.push(SEP);
  for (const b of BOSSES) out.push(`::${IMAGE_KEYS[b]}=${c[IMAGE_KEYS[b]]}`);
  out.push(SEP);
  const flags = Object.keys(FLAGS).filter((f) => c[f]);
  if (flags.length) {
    for (const f of flags) out.push(`::${f}`);
    out.push(SEP);
  }
  if (st.extras.length) {
    for (const [k, v] of st.extras) out.push(v === null ? `::${k}` : `::${k}=${v}`);
    out.push(SEP);
  }
  const len = blockLen(st);
  for (const p of st.players) {
    if (!p.actions.length) continue;
    out.push("");
    let prevEnd = 0;
    for (const a of p.actions) {
      let line = `${p.id},${a.start - prevEnd},${a.boss},${a.battle}`;
      if (a.rate !== 1) line += `,${a.rate}`;
      out.push(line);
      prevEnd = a.start + len;
    }
  }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- 変更と履歴

function snapshot() { return JSON.stringify(state); }

function commit(before) {
  if (before === snapshot()) return;
  undoStack.push(before);
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
}

function mutate(fn) {
  const before = snapshot();
  fn();
  commit(before);
  afterChange();
}

function afterChange() {
  fixSelection();
  save();
  render();
  renderSide();
  updateText();
  scheduleDetail();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  state = JSON.parse(undoStack.pop());
  afterChange();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  state = JSON.parse(redoStack.pop());
  afterChange();
}

function replaceState(st) {
  const before = snapshot();
  state = st;
  selection = null;
  commit(before);
  afterChange();
}

function fixSelection() {
  if (!selection) return;
  const p = state.players[selection.p];
  if (!p) selection = null;
  else if (selection.a !== null && !p.actions[selection.a]) selection.a = null;
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, scale })); } catch (e) { /* 保存できなくても動作は続ける */ }
}

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (d && d.state && Array.isArray(d.state.players)) {
      if (d.scale) scale = d.scale;
      return d.state;
    }
  } catch (e) { /* 壊れた下書きは無視 */ }
  return null;
}

// ---------------------------------------------------------------- 編集操作

// 木製スライドパズル方式: k 番目を t へ動かし、接触したブロックだけを押し出す。
// ロック中のブロックは動かず、押し出されもしない（間のブロックごと手前で止まる）
function slideTo(actions, k, t) {
  if (actions[k].locked) return;
  const len = blockLen();
  let lo = k * len;
  let hi = CHART_SEC - (actions.length - 1 - k) * len;
  let pinned = false;
  actions.forEach((a, j) => {
    if (!a.locked) return;
    pinned = true;
    if (j < k) lo = Math.max(lo, a.start + (k - j) * len);
    else hi = Math.min(hi, a.start - (j - k) * len);
  });
  if (hi < lo && pinned) return;
  actions[k].start = hi < lo ? lo : clamp(t, lo, hi);
  for (let j = k + 1; j < actions.length && !actions[j].locked; j++) {
    actions[j].start = Math.max(actions[j].start, actions[j - 1].start + len);
  }
  for (let j = k - 1; j >= 0 && !actions[j].locked; j--) {
    actions[j].start = Math.min(actions[j].start, actions[j + 1].start - len);
  }
}

// ロックは GUI の状態（下書き・Undo）にだけ持ち、txt には出力しない。false は持たずにキーごと消す
function toggleLock(a) {
  if (a.locked) delete a.locked;
  else a.locked = true;
}

// 待機秒数を保ったまま timelag を変える (txt を手で書き換えたのと同じ結果)
function setTimelag(v) {
  const oldLen = blockLen();
  const waits = state.players.map((p) => p.actions.map((a, i) => a.start - (i ? p.actions[i - 1].start + oldLen : 0)));
  state.constants.timelag = String(v);
  const len = blockLen();
  state.players.forEach((p, pi) => {
    let clock = 0;
    p.actions.forEach((a, i) => { clock += waits[pi][i]; a.start = clock; clock += len; });
  });
}

function addActionAt(p, t) {
  const acts = state.players[p].actions;
  const len = blockLen();
  let i = acts.findIndex((a) => a.start > t);
  if (i < 0) i = acts.length;
  const lo = i > 0 ? acts[i - 1].start + len : 0;
  const hi = (i < acts.length ? acts[i].start : CHART_SEC + len) - len;
  if (hi < lo) { showStatus("ここには入る余地がありません（前後のブロックと重なります）"); return; }
  const prev = acts[i - 1] || acts[i];
  const a = { start: clamp(t, lo, hi), boss: prev ? prev.boss : "1st_boss", battle: prev ? prev.battle : 30, rate: 1 };
  mutate(() => { acts.splice(i, 0, a); selection = { p, a: i }; });
}

function nextFreeId(team) {
  const used = new Set(state.players.map((p) => p.id));
  for (let n = 1; n < 100; n++) {
    const id = team + String(n).padStart(2, "0");
    if (!used.has(id)) return id;
  }
  return null;
}

// ID は ::ID=表示名 の定数キーにもなるため、txt の区切り文字と既存の設定キーは使えない
// （途中の半角スペースは parse 上問題ないので許可。前後の空白は trim 済み）
function validId(id, self) {
  if (!/^[^,=#:\t\r\n]+$/.test(id)) return `ID「${id}」に , = # : とタブは使えません`;
  if (KNOWN_KEYS.has(id) || id in CONFIG || state.extras.some(([k]) => k === id)) return `ID「${id}」は設定名と重なるため使えません`;
  if (state.players.some((p, i) => i !== self && p.id === id)) return `ID ${id} はすでに使われています`;
  return null;
}

// ---------------------------------------------------------------- サーバー連携

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error || msg; } catch (e) { /* JSON 以外のエラー */ }
    throw new Error(msg);
  }
  return res;
}

function scheduleDetail() {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(fetchDetail, 300);
}

async function fetchDetail() {
  const text = toText();
  if (!state.players.some((p) => p.actions.length)) {
    details = [];
    showStatus(null);
    render(); renderSummary();
    return;
  }
  try {
    const j = await (await api("/api/detail", { text })).json();
    if (text !== toText()) return; // 取得中に変更された
    details = j.detail;
    showStatus(null);
  } catch (e) {
    details = [];
    showStatus(e.message);
  }
  render();
  renderSummary();
  // 入力中のフォームを作り直さない
  if (!$("#side").contains(document.activeElement)) renderSide();
}

async function importText(text) {
  try {
    const j = await (await api("/api/parse", { text })).json();
    replaceState(stateFromParsed(j.commands, j.constants));
    textDirty = false;
    updateText();
    showStatus(null);
    return true;
  } catch (e) {
    showStatus(e.message);
    return false;
  }
}

async function renderImage() {
  const btn = $("#btn-render");
  btn.disabled = true;
  btn.textContent = "生成中…";
  try {
    const blob = await (await api("/api/render", { text: toText() })).blob();
    const url = URL.createObjectURL(blob);
    const old = $("#preview").src;
    if (old.startsWith("blob:")) URL.revokeObjectURL(old);
    $("#preview").src = url;
    $("#download-png").href = url;
    $("#download-png").download = `${dateStem()}.png`;
    $("#modal").hidden = false;
    showStatus(null);
  } catch (e) {
    showStatus(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "画像生成";
  }
}

function showStatus(msg) {
  const el = $("#status");
  el.hidden = !msg;
  el.textContent = msg || "";
}

// ---------------------------------------------------------------- 描画: タイムライン

function detailIndex() {
  // details は toText の出力順 = プレイヤー順 × 行動順
  const map = new Map();
  let i = 0;
  state.players.forEach((p, pi) => p.actions.forEach((_, ai) => map.set(`${pi}:${ai}`, details[i++])));
  return i === details.length ? map : new Map();
}

function render() {
  const tl = $("#timeline");
  tl.style.setProperty("--min", `${60 * scale}px`);
  tl.style.setProperty("--five", `${300 * scale}px`);
  const bodyH = (CHART_SEC + 120) * scale;
  const dmap = detailIndex();
  const len = blockLen();
  const lag = timelag();
  const colors = CONFIG.color_table;

  const axisBody = h("div", { class: "col-body", style: { height: `${bodyH}px` } });
  for (let m = 0; m <= 60; m += 5) {
    axisBody.append(h("div", { class: "tick" + (m === 30 ? " half" : ""), style: { top: `${m * 60 * scale}px` } }, `${String(remaining() ? 60 - m : m).padStart(2, "0")}:00`));
  }
  const cols = [h("div", { class: "axis" }, h("div", { class: "col-head" }), axisBody)];

  state.players.forEach((p, pi) => {
    const selP = selection && selection.p === pi;
    const teamColor = CONFIG.team.team_color[teamOf(p.id)];
    const head = h("div", {
      class: "col-head" + (selP && selection.a === null ? " selected" : ""),
      title: p.id,
      onclick: () => { selection = { p: pi, a: null }; render(); renderSide(); switchTab("select"); },
    },
    h("div", { class: "team", style: { color: teamColor ? bgr(teamColor) : "" } }, teamColor ? teamOf(p.id) : " "),
    h("div", { class: "name" }, p.name || p.id));

    const body = h("div", {
      class: "col-body",
      style: { height: `${bodyH}px` },
      ondblclick: (e) => {
        if (e.target !== body) return;
        addActionAt(pi, Math.round((e.offsetY / scale) - lag));
      },
    },
    h("div", { class: "hline half", style: { top: `${1800 * scale}px` } }),
    h("div", { class: "hline end", style: { top: `${CHART_SEC * scale}px` } }));

    p.actions.forEach((a, ai) => {
      const d = dmap.get(`${pi}:${ai}`);
      const bossColor = colors[state.constants[a.boss]];
      const block = h("div", {
        class: "block" + (selP && selection.a === ai ? " selected" : "") + (a.locked ? " locked" : ""),
        style: { top: `${a.start * scale}px`, height: `${len * scale}px` },
        onpointerdown: (e) => startDrag(e, pi, ai, "move"),
        // 右クリックでボスを 1st → 2nd → 3rd → Realm → 1st の順に切り替える
        oncontextmenu: (e) => {
          e.preventDefault();
          selection = { p: pi, a: ai };
          mutate(() => { a.boss = BOSSES[(BOSSES.indexOf(a.boss) + 1) % BOSSES.length]; });
          switchTab("select");
        },
      });
      block.append(h("div", { class: "fill" },
        h("div", { class: "lag", style: { height: `${lag * scale}px` } }),
        a.rate < 1 ? h("div", { class: "checker", style: { top: `${lag * scale}px` } }) : null,
        h("div", { class: "battle", style: { top: `${lag * scale}px`, height: `${a.battle * scale}px`, background: bgr(bossColor) } })));
      block.append(h("div", {
        class: "resize",
        style: { top: `${(lag + a.battle) * scale - 3}px`, bottom: "auto" },
        title: "ドラッグで戦闘時間を変更",
        onpointerdown: (e) => startDrag(e, pi, ai, "resize"),
      }));
      // 1行目: いつ（開始–終了）、2行目: 何を（ボス・戦闘時間・撃破率）、3行目: 結果（Lv・スコア）
      // 最小倍率でもブロックに収まるよう 3 行に抑える
      const bs = a.start + lag;
      block.append(h("div", { class: "info", style: { top: `${lag * scale + 1}px` } },
        h("div", { class: "time" }, a.locked ? "🔒" : null, `${clock(bs)}–${clock(bs + a.battle)}`),
        h("div", {}, `${BOSS_LABEL[a.boss]} ${a.battle}s`,
          a.rate < 1 ? h("span", { class: "rate" }, ` ${Math.round(Math.max(a.rate, 0) * 100)}%`) : null),
        d ? h("div", {}, h("span", { class: "lv" }, `Lv${String(d.level).padStart(2, "0")} `), h("span", { class: "score" }, fmt(d.est_score))) : null));
      body.append(block);
    });

    cols.push(h("div", { class: "col" }, head, body));
  });

  if (state.players.length < MAX_PLAYERS) {
    cols.push(h("div", { class: "col add" }, h("button", { title: "プレイヤーを追加", onclick: () => { selection = null; renderSide(); switchTab("select"); $("#add-name")?.focus(); } }, "＋")));
  }
  tl.replaceChildren(...cols);
}

function startDrag(e, pi, ai, mode) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const before = snapshot();
  const acts = state.players[pi].actions;
  const a = acts[ai];
  const y0 = e.clientY;
  const start0 = a.start;
  const battle0 = a.battle;
  let moved = false;
  const tip = h("div", { class: "drag-tip", hidden: true });
  document.body.append(tip);

  const onMove = (ev) => {
    if (!moved && Math.abs(ev.clientY - y0) < 3) return;
    moved = true;
    const dt = Math.round((ev.clientY - y0) / scale);
    if (mode === "move") slideTo(acts, ai, start0 + dt);
    else a.battle = clamp(battle0 + dt, 1, MAX_BATTLE);
    selection = { p: pi, a: ai };
    render();
    tip.hidden = false;
    tip.style.left = `${ev.clientX + 14}px`;
    tip.style.top = `${ev.clientY + 10}px`;
    tip.textContent = mode === "move" && a.locked ? "ロック中（L キーで解除）"
      : mode === "move"
      ? `戦闘開始 ${clock(a.start + timelag())}（待機 ${a.start - (ai ? acts[ai - 1].start + blockLen() : 0)}秒）`
      : `戦闘 ${a.battle}秒（終了 ${clock(a.start + timelag() + a.battle)}）`;
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    tip.remove();
    if (moved) { commit(before); afterChange(); }
    else { selection = { p: pi, a: ai }; render(); renderSide(); switchTab("select"); }
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

function renderSummary() {
  const el = $("#summary");
  if (!details.length) { el.textContent = ""; return; }
  const max = details.reduce((s, d) => s + d.score, 0);
  const est = details.reduce((s, d) => s + d.est_score, 0);
  const maxLv = details.reduce((m, d) => Math.max(m, d.level), 0);
  el.replaceChildren("到達 ", h("b", {}, `Lv${maxLv}`), "　最大 ", h("b", {}, fmt(max)),
    ...(est < max ? ["　見積もり ", h("b", {}, fmt(est))] : []));
}

// ---------------------------------------------------------------- 描画: サイドパネル

function field(label, input) {
  return h("label", { class: "field" }, h("span", {}, label), input);
}

// チーム名は ChartLib と同じく「ID の末尾2文字を除いた部分」で判定される
function idHint() {
  const teams = Object.keys(CONFIG.team.team_color);
  return h("p", { class: "hint" }, `ID が「チーム名＋2文字」（例: ${teams[0]}01）のときはチーム名も表示されます。チーム名: ${teams.join(", ")}`);
}

function bossSelect(value) {
  return h("select", {}, BOSSES.map((b) =>
    h("option", { value: b, selected: b === value }, `${BOSS_LABEL[b]} (${state.constants[b]})`)));
}

function renderSide() {
  const panel = $("#panel-select");
  const parts = [];

  if (selection) {
    const pi = selection.p;
    const p = state.players[pi];
    // 空欄なら表示名を ID にする
    const applyId = (e) => {
      const id = e.target.value.trim() || p.name;
      if (!id) { showStatus("ID を空欄にするには表示名を入力してください"); renderSide(); return; }
      if (id === p.id) return;
      const err = validId(id, pi);
      if (err) { showStatus(err); renderSide(); return; }
      showStatus(null);
      mutate(() => { p.id = id; });
    };

    parts.push(h("h3", {}, "プレイヤー"),
      field("表示名", h("input", { value: p.name, placeholder: p.id, onchange: (e) => mutate(() => { p.name = sanitize(e.target.value).trim(); }) })),
      field("ID", h("input", { value: p.id, placeholder: "空欄なら表示名", onchange: applyId })),
      idHint(),
      h("div", { class: "row" },
        h("button", { disabled: pi === 0, onclick: () => mutate(() => { state.players.splice(pi - 1, 0, ...state.players.splice(pi, 1)); selection.p = pi - 1; }) }, "← 左へ"),
        h("button", { disabled: pi === state.players.length - 1, onclick: () => mutate(() => { state.players.splice(pi + 1, 0, ...state.players.splice(pi, 1)); selection.p = pi + 1; }) }, "右へ →"),
        h("span", { class: "grow" }),
        h("button", { class: "danger", onclick: () => { if (confirm(`${p.name || p.id} を削除しますか？`)) mutate(() => { state.players.splice(pi, 1); selection = null; }); } }, "プレイヤー削除")),
      h("p", { class: "hint" }, "列の空いた場所をダブルクリックすると戦闘を追加します。"));

    if (selection.a !== null) {
      const ai = selection.a;
      const a = p.actions[ai];
      const d = detailIndex().get(`${pi}:${ai}`);
      const len = blockLen();
      const wait = a.start - (ai ? p.actions[ai - 1].start + len : 0);
      parts.push(h("h3", {}, `戦闘 #${ai + 1}`),
        field("出撃 (push)", h("input", {
          value: clock(a.start), disabled: !!a.locked, title: remaining() ? "残り時間を mm:ss または秒数で" : "mm:ss または秒数",
          onchange: (e) => {
            let t = parseTime(e.target.value);
            if (t === null) { showStatus("時刻は mm:ss か秒数で入力してください"); renderSide(); return; }
            if (remaining()) t = CHART_SEC - t;
            mutate(() => slideTo(p.actions, ai, t));
          },
        })),
        field("待機秒数", h("input", {
          type: "number", min: 0, value: wait, disabled: !!a.locked,
          onchange: (e) => mutate(() => slideTo(p.actions, ai, a.start + (parseInt(e.target.value) || 0) - wait)),
        })),
        h("label", { class: "row", title: "ドラッグで動かせず、他のブロックにも押し出されなくなります (L)" },
          h("input", { type: "checkbox", checked: !!a.locked, onchange: () => mutate(() => toggleLock(a)) }), "🔒 位置をロック (L)"),
        field("ボス", (() => { const s = bossSelect(a.boss); s.title = "1〜4 キー、またはブロックの右クリックでも切り替えられます"; s.addEventListener("change", () => mutate(() => { a.boss = s.value; })); return s; })()),
        field("戦闘秒数", h("input", {
          type: "number", min: 1, max: MAX_BATTLE, value: a.battle,
          onchange: (e) => mutate(() => { a.battle = clamp(parseInt(e.target.value) || 1, 1, MAX_BATTLE); }),
        })),
        field("与ダメージ率", h("input", {
          type: "number", min: 0, max: 1, step: 0.05, value: a.rate, title: "ワンパンは 1 となります。1.0 未満なら市松模様と % を表示します",
          onchange: (e) => mutate(() => { const r = parseFloat(e.target.value); a.rate = Number.isFinite(r) ? r : 1; }),
        })),
        d ? h("p", { class: "hint" }, `戦闘 ${clock(d.battle_start)}–${clock(d.battle_end)}　再出撃 ${clock(d.cool_off)}　Lv${d.level}　${fmt(d.est_score)} / ${fmt(d.score)}`) : null,
        h("p", { class: "hint" }, "ブロックの右クリックでボスを順に切り替え、1〜4 キーで直接指定できます。"),
        h("div", { class: "row" },
          h("span", { class: "grow" }),
          h("button", { class: "danger", onclick: () => mutate(() => { p.actions.splice(ai, 1); selection.a = null; }) }, "戦闘を削除 (Del)")));
    }
  } else {
    parts.push(h("p", { class: "hint" },
      "ブロックをドラッグすると時刻を変えられます。隙間があればそのブロックだけが動き、隣に当たると押し出します。下端のドラッグで戦闘時間を変えられます。右クリックでボスを順に切り替え、選択中に 1〜4 キーで直接指定できます。"));
  }

  // プレイヤー追加
  const full = state.players.length >= MAX_PLAYERS;
  const autoId = nextFreeId(Object.keys(CONFIG.team.team_color)[0]);
  const nameInput = h("input", { id: "add-name", placeholder: "例: シャドウ" });
  const idInput = h("input", { id: "add-id", placeholder: "空欄なら表示名" });
  parts.push(h("h3", {}, "プレイヤー追加"),
    field("表示名", nameInput),
    field("ID（任意）", idInput),
    idHint(),
    h("div", { class: "row" },
      h("span", { class: "hint" }, `${state.players.length} / ${MAX_PLAYERS} 人`),
      h("span", { class: "grow" }),
      h("button", {
        disabled: full,
        onclick: () => {
          // ID が空欄なら表示名を ID にする。両方空欄なら Alpha0N を振る
          const name = sanitize(nameInput.value).trim();
          const id = idInput.value.trim() || name || autoId;
          if (!id) { showStatus("表示名か ID を入力してください"); return; }
          const err = validId(id, -1);
          if (err) { showStatus(err); return; }
          showStatus(null);
          mutate(() => {
            state.players.push({ id, name, actions: [] });
            selection = { p: state.players.length - 1, a: null };
          });
        },
      }, "追加")));

  panel.replaceChildren(...parts);
  renderSettings();
}

function renderSettings() {
  const c = state.constants;
  const colors = Object.keys(CONFIG.color_table);
  const parts = [
    h("h3", {}, "全般"),
    field("コメント", h("input", { value: c.comment, onchange: (e) => mutate(() => { c.comment = sanitize(e.target.value); }) })),
    field("開始時刻", h("input", {
      type: "time", value: validStartTime(c.start_time) ? c.start_time.padStart(5, "0") : "",
      title: "ゲームの開始時刻。進捗管理で使います",
      onchange: (e) => mutate(() => { c.start_time = e.target.value; }),
    })),
    field("ギャップ(秒)", h("input", {
      type: "number", min: 0, value: timelag(),
      title: "戦闘開始ボタン押下と再出撃可能時間のカウント開始のズレを見積もる。（推奨 0～3秒）",
      onchange: (e) => mutate(() => setTimelag(Math.max(0, parseInt(e.target.value) || 0))),
    })),
    h("h3", {}, "ボス（属性色・画像）"),
  ];
  for (const b of BOSSES) {
    const colorSel = h("select", {}, colors.map((k) => h("option", { value: k, selected: k === c[b] }, k)));
    colorSel.addEventListener("change", () => mutate(() => { c[b] = colorSel.value; }));
    const key = IMAGE_KEYS[b];
    const pick = h("button", { class: "icon-pick", title: "クリックして画像を選ぶ", onclick: () => openImagePicker(b) },
      c[key] ? iconThumb(c[key], b) : h("span", { class: "icon-empty" }, "未設定"));
    parts.push(h("div", { class: "boss-row" },
      h("span", {}, h("span", { class: "swatch", style: { background: bgr(CONFIG.color_table[c[b]]) } }), BOSS_LABEL[b]),
      colorSel, pick));
  }
  parts.push(h("h3", {}, "表示"));
  for (const [f, label] of Object.entries(FLAGS)) {
    parts.push(h("label", { class: "row" },
      h("input", { type: "checkbox", checked: !!c[f], onchange: (e) => mutate(() => { c[f] = e.target.checked; }) }), label));
  }
  if (state.extras.length) {
    parts.push(h("h3", {}, "その他の定数（そのまま出力）"),
      h("p", { class: "hint", style: { whiteSpace: "pre-wrap" } }, state.extras.map(([k, v]) => (v === null ? `::${k}` : `::${k}=${v}`)).join("\n")));
  }
  $("#panel-settings").replaceChildren(...parts);
}

// ---------------------------------------------------------------- ボス画像の選択


// 透過部分の色。ChartLib と同じく、::icon_bgcolor があればその色、なければボスの属性色
function iconBg(boss) {
  const fixed = state.extras.find(([k]) => k === "icon_bgcolor");
  return bgr(CONFIG.color_table[(fixed && fixed[1]) || state.constants[boss]]);
}

// 画像生成と同じく中央を正方形に切り出したサムネイル
function iconThumb(src, boss, lazy = false) {
  return h("img", { class: "icon-thumb", src: src || "", alt: "", loading: lazy ? "lazy" : "eager",
    style: { background: iconBg(boss) } });
}

function openImagePicker(boss) {
  const key = IMAGE_KEYS[boss];
  const current = state.constants[key];
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey, true); };
  const choose = (src) => { close(); if (src !== current) mutate(() => { state.constants[key] = src; }); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  };

  const tiles = IMAGES.map((src) => h("button", {
    class: "icon-tile" + (src === current ? " current" : ""), onclick: () => choose(src),
  }, iconThumb(src, boss, true)));
  const grid = h("div", { class: "icon-grid" }, tiles);
  const overlay = h("div", { id: "picker", onclick: (e) => { if (e.target === overlay) close(); } },
    h("div", { class: "picker-box" },
      h("div", { class: "row" },
        h("b", {}, `${BOSS_LABEL[boss]} の画像を選択`),
        h("span", { class: "hint" }, `${IMAGES.length} 件`),
        h("span", { class: "grow" }),
        h("button", { onclick: close }, "閉じる")),
      grid));
  document.body.append(overlay);
  document.addEventListener("keydown", onKey, true);
  const cur = grid.querySelector(".current");
  (cur || tiles[0])?.focus({ preventScroll: true });
  if (cur) cur.scrollIntoView({ block: "center" });
}

function updateText() {
  if (textDirty) return;
  $("#text").value = toText();
}

function switchTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => { p.hidden = p.id !== `panel-${name}`; });
}

// ---------------------------------------------------------------- 初期化

// 保存ファイル名の日付部分（YYYYMMDD）
function dateStem() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bindUI() {
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  $("#btn-new").addEventListener("click", () => { if (confirm("今の作戦を破棄して新規作成しますか？（元に戻すで復元できます）")) replaceState(defaultState()); });
  $("#file-open").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) await importText(await f.text());
  });
  $("#btn-undo").addEventListener("click", undo);
  $("#btn-redo").addEventListener("click", redo);
  $("#zoom").value = String(scale);
  $("#zoom").addEventListener("change", (e) => { scale = parseFloat(e.target.value); save(); render(); });
  $("#btn-render").addEventListener("click", renderImage);
  // 進捗管理の作成画面へ今の作戦を引き継ぐ
  $("#btn-tracker").addEventListener("click", () => {
    try { localStorage.setItem("chartmaker.tracker.text", toText()); } catch (e) { /* 引き継げなくても画面は開く */ }
    window.open("/tracker", "_blank");
  });
  $("#btn-close-modal").addEventListener("click", () => { $("#modal").hidden = true; });
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").hidden = true; });

  const text = $("#text");
  text.addEventListener("input", () => {
    textDirty = true;
    text.classList.add("dirty");
    $("#btn-apply-text").disabled = false;
  });
  $("#btn-apply-text").addEventListener("click", async () => {
    if (await importText(text.value)) {
      text.classList.remove("dirty");
      $("#btn-apply-text").disabled = true;
    }
  });
  $("#btn-copy").addEventListener("click", () => navigator.clipboard.writeText(text.value));
  $("#btn-save-text").addEventListener("click", () => {
    download(`${dateStem()}.txt`, new Blob([text.value], { type: "text/plain" }));
  });

  bindSplitter();

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select, #splitter, #picker")) return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && (key === "y" || (key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
    else if ((key === "delete" || key === "backspace") && selection && selection.a !== null) {
      e.preventDefault();
      const { p, a } = selection;
      mutate(() => { state.players[p].actions.splice(a, 1); selection.a = null; });
    } else if (/^[1-4]$/.test(key) && !e.ctrlKey && !e.metaKey && !e.altKey && selection && selection.a !== null) {
      // 選択中のブロックのボスを 1=1st 2=2nd 3=3rd 4=Realm で直接指定する
      e.preventDefault();
      const act = state.players[selection.p].actions[selection.a];
      const boss = BOSSES[Number(key) - 1];
      if (act.boss !== boss) mutate(() => { act.boss = boss; });
    } else if (key === "l" && !e.ctrlKey && !e.metaKey && !e.altKey && selection && selection.a !== null) {
      e.preventDefault();
      const act = state.players[selection.p].actions[selection.a];
      mutate(() => toggleLock(act));
    } else if (key === "escape") { $("#modal").hidden = true; }
  });
}

// 作戦ビューと設定ビューの境界。幅は閲覧者ごとの好みとして localStorage に残す
const SIDE_KEY = "chartmaker.sideWidth";
const SIDE_DEFAULT = 340;

function bindSplitter() {
  const bar = $("#splitter");
  const root = document.documentElement;
  const setWidth = (w, persist) => {
    const max = Math.max(260, window.innerWidth - 240);
    w = clamp(Math.round(w), 260, max);
    root.style.setProperty("--side-w", `${w}px`);
    bar.setAttribute("aria-valuenow", w);
    if (persist) preferred = w;
    if (persist) try { localStorage.setItem(SIDE_KEY, String(w)); } catch (e) { /* 保存できなくても動作は続ける */ }
    return w;
  };
  const current = () => $("#side").getBoundingClientRect().width;

  let saved = null;
  try { saved = parseInt(localStorage.getItem(SIDE_KEY)); } catch (e) { /* 既定幅を使う */ }
  let preferred = Number.isFinite(saved) ? saved : SIDE_DEFAULT;
  setWidth(preferred, false);

  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("active");
    document.body.classList.add("resizing");
    const startX = e.clientX;
    const startW = current();
    const onMove = (ev) => setWidth(startW - (ev.clientX - startX), false);
    const onUp = () => {
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", onUp);
      bar.removeEventListener("pointercancel", onUp);
      bar.classList.remove("active");
      document.body.classList.remove("resizing");
      setWidth(current(), true);
    };
    bar.addEventListener("pointermove", onMove);
    bar.addEventListener("pointerup", onUp);
    bar.addEventListener("pointercancel", onUp);
  });
  bar.addEventListener("dblclick", () => setWidth(SIDE_DEFAULT, true));
  bar.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 80 : 20;
    if (e.key === "ArrowLeft") setWidth(current() + step, true);
    else if (e.key === "ArrowRight") setWidth(current() - step, true);
    else return;
    e.preventDefault();
  });
  // ウィンドウを狭めても作戦ビューが潰れないよう縮め、広げたら好みの幅に戻す
  window.addEventListener("resize", () => setWidth(preferred, false));
}

async function init() {
  const j = await (await fetch("/api/config")).json();
  CONFIG = j.config;
  IMAGES = j.images;
  state = load() || defaultState();
  bindUI();
  afterChange();
}

init().catch((e) => showStatus(`初期化に失敗しました: ${e.message}`));
