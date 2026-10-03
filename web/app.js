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
const REGULAR_BOSSES = BOSSES.slice(0, 3);
const SNAP_PX = 10;        // ドラッグがこの px 以内に近づいたら推定位置に吸着する
const SNAP_MARGIN = 6;     // 撃破の何秒後に吸着させるかの既定値

let CONFIG = null;
let IMAGES = [];
let state = null;
let undoStack = [];
let redoStack = [];
let selection = null;      // {p, a}  a は null ならプレイヤー選択。複数選択中は Shift+クリックの起点
let multi = [];            // 複数選択中の戦闘 [{p, a}, ...]（2 個以上のときだけ使い、1 個以下なら空）
let scale = 0.25;          // px / 秒
let snapMargin = SNAP_MARGIN;  // 撃破から次の出撃までの余裕（秒）。作戦ではなく編集の好みなので txt には出さない
let details = [];          // /api/detail の結果 (出力順)
let detailTimer = null;
let textDirty = false;
let lastNudge = null;      // {key, t, after}  連続した矢印キー移動を 1 回の Undo にまとめる
let snapGuide = null;      // {t, src: Set}  ドラッグ中に吸着している位置と、その根拠のブロック ("p:a")

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

// ゲーム開始のローカル時刻 HH:MM（進行管理で使う）
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
    players: fillPlayers([]),  // 常に MAX_PLAYERS 人 {id, name, actions: [{start, boss, battle, rate, locked?}]}
  };
}

// プレイヤーの追加・削除はなく、列は常に MAX_PLAYERS 人。足りない分を空の列 (ID は P01〜) で埋める
const DEFAULT_ID = /^P\d{2}$/;
function fillPlayers(players) {
  const used = new Set(players.map((p) => p.id));
  for (let n = 1; players.length < MAX_PLAYERS; n++) {
    const id = "P" + String(n).padStart(2, "0");
    if (!used.has(id)) players.push({ id, name: "", actions: [] });
  }
  return players;
}

function looksLikePlayer(key) {
  return key.length > 2 && teamOf(key) in CONFIG.team.team_color;
}

// ChartLib.parse の結果から状態を作る (calc_level と同じ手順で絶対秒に戻す)
function stateFromParsed(commands, constants) {
  const st = defaultState();
  st.players = [];
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
    // ::ID=表示名 で ID と表示名が同じもの（ID 空欄で名前を付けた人）や空の列の ID (P01〜) も、戦闘がなくてもプレイヤーとみなす
    if (looksLikePlayer(k) || k === v || DEFAULT_ID.test(k)) {
      byId[k] = { id: k, name: v ?? "", actions: [] };
      st.players.push(byId[k]);
    } else {
      st.extras.push([k, v]);
    }
  }
  fillPlayers(st.players);
  return st;
}

// ロックは直前の行動行に付く「#lock」コメント行として txt に残す (parse はコメントとして読み飛ばす)
const LOCK_MARK = "#lock";

// txt の #lock 行を読み、ロックする行動を「ID → 何番目の行動か」の集合で返す (行の判定は ChartLib.parse と同じ)
function lockedInText(text) {
  const locked = new Set();
  const count = {};
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#")) {
      if (line.trim() === LOCK_MARK && last) locked.add(last);
      continue;
    }
    if (line.startsWith("::")) continue;
    const item = line.split(",");
    if (item.length <= 1) continue;
    const id = item[0];
    count[id] = (count[id] || 0) + 1;
    last = `${id}:${count[id] - 1}`;
  }
  return locked;
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
      if (a.locked) out.push(LOCK_MARK);
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
  if (!selection || selection.a === null) multi = [];
  if (multi.length) {
    const list = multi.filter((s) => state.players[s.p] && state.players[s.p].actions[s.a]);
    if (list.length !== multi.length) setSelection(list, selection);
  }
  if (!selection) return;
  const p = state.players[selection.p];
  if (!p) selection = null;
  else if (selection.a !== null && !p.actions[selection.a]) selection.a = null;
}

// ---------------------------------------------------------------- 選択

// 選択中の戦闘の一覧。単独選択なら 1 個、プレイヤー選択や未選択なら空
function selectedBlocks() {
  if (multi.length) return multi;
  return selection && selection.a !== null ? [selection] : [];
}

// 選択を list にする。2 個以上なら複数選択で、anchor が含まれていればそれを Shift+クリックの起点に残す
function setSelection(list, anchor) {
  if (list.length > 1) {
    multi = list.map(({ p, a }) => ({ p, a }));
    const keep = anchor && list.find((s) => s.p === anchor.p && s.a === anchor.a);
    selection = { ...(keep || list[list.length - 1]) };
  } else {
    multi = [];
    selection = list.length ? { p: list[0].p, a: list[0].a } : null;
  }
}

function clearSelection() { setSelection([]); }

// Ctrl+クリック: 1 個ずつ追加・解除
function toggleSelect(pi, ai) {
  const list = selectedBlocks().slice();
  const i = list.findIndex((s) => s.p === pi && s.a === ai);
  if (i >= 0) list.splice(i, 1);
  else list.push({ p: pi, a: ai });
  setSelection(list, i >= 0 ? selection : { p: pi, a: ai });
}

// Shift+クリック: 起点と同じ列ならその間をすべて選ぶ。別の列なら単独選択
function rangeSelect(pi, ai) {
  const from = selection;
  if (!from || from.a === null || from.p !== pi) { setSelection([{ p: pi, a: ai }]); return; }
  const list = [];
  for (let a = Math.min(from.a, ai); a <= Math.max(from.a, ai); a++) list.push({ p: pi, a });
  setSelection(list, from);
}

// 選択中の戦闘すべてに fn を適用する
function eachSelected(fn) {
  selectedBlocks().forEach(({ p, a }) => fn(state.players[p].actions[a]));
}

// ロック: 1 個でも未ロックがあれば全部ロック、全部ロック済みなら全部解除
function toggleLockSelected() {
  const lock = selectedBlocks().some(({ p, a }) => !state.players[p].actions[a].locked);
  eachSelected((x) => { if (lock) x.locked = true; else delete x.locked; });
}

// 後ろの戦闘から消して、残りの番号がずれないようにする。1 個だけならそのプレイヤーの選択に戻す
function deleteSelected() {
  const list = selectedBlocks().slice().sort((x, y) => x.p - y.p || y.a - x.a);
  list.forEach(({ p, a }) => state.players[p].actions.splice(a, 1));
  setSelection([]);
  if (list.length === 1) selection = { p: list[0].p, a: null };
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, scale, snapMargin })); } catch (e) { /* 保存できなくても動作は続ける */ }
}

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (d && d.state && Array.isArray(d.state.players)) {
      if (d.scale) scale = d.scale;
      if (Number.isInteger(d.snapMargin)) snapMargin = d.snapMargin;
      fillPlayers(d.state.players);
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

// 複数選択中の戦闘を、互いの間隔を保ったまま dt 秒ずらす。選択外のブロックは押し出す。
// 選択中のどれか 1 個でもロックや端で止まるなら全体がそこで止まり、ロック中の戦闘を含むなら動かない。
// 実際にずらした秒数を返す
function shiftSelected(dt) {
  const len = blockLen();
  const byP = new Map();
  selectedBlocks().forEach(({ p, a }) => {
    if (!byP.has(p)) byP.set(p, new Set());
    byP.get(p).add(a);
  });
  let lo = -Infinity, hi = Infinity;
  for (const [p, sel] of byP) {
    const acts = state.players[p].actions;
    for (const k of sel) {
      if (acts[k].locked) return 0;
      // 後ろへ: 次の選択中の戦闘より手前にロックがあればそこまで、なければ最後の戦闘が終端に着くまで押せる
      let j = k + 1;
      while (j < acts.length && !sel.has(j) && !acts[j].locked) j++;
      if (j === acts.length) hi = Math.min(hi, CHART_SEC - (acts.length - 1 - k) * len - acts[k].start);
      else if (!sel.has(j)) hi = Math.min(hi, acts[j].start - (j - k) * len - acts[k].start);
      // 前へ: 同様にロックか 0 秒まで
      j = k - 1;
      while (j >= 0 && !sel.has(j) && !acts[j].locked) j--;
      if (j < 0) lo = Math.max(lo, k * len - acts[k].start);
      else if (!sel.has(j)) lo = Math.max(lo, acts[j].start + (k - j) * len - acts[k].start);
    }
  }
  if (lo > hi) return 0;
  const d = clamp(dt, lo, hi);
  if (!d) return 0;
  for (const [p, sel] of byP) {
    const acts = state.players[p].actions;
    sel.forEach((k) => { acts[k].start += d; });
    if (d > 0) {
      for (let j = 1; j < acts.length; j++) {
        if (!sel.has(j) && !acts[j].locked) acts[j].start = Math.max(acts[j].start, acts[j - 1].start + len);
      }
    } else {
      for (let j = acts.length - 2; j >= 0; j--) {
        if (!sel.has(j) && !acts[j].locked) acts[j].start = Math.min(acts[j].start, acts[j + 1].start - len);
      }
    }
  }
  return d;
}

// 矢印キーで選択中のブロックを dt 秒ずらす（1 個なら slideTo、複数なら shiftSelected と同じ押し出し）。
// 同じ選択への連続操作（1 秒以内、間に他の変更なし）は 1 回の Undo にまとめる
function nudge(dt) {
  const key = selectedBlocks().map((x) => `${x.p}:${x.a}`).join(",");
  const before = snapshot();
  const now = Date.now();
  const merge = lastNudge && lastNudge.key === key && now - lastNudge.t < 1000 && lastNudge.after === before;
  if (multi.length) shiftSelected(dt);
  else {
    const { p, a } = selection;
    const act = state.players[p].actions[a];
    if (act.locked) return;
    slideTo(state.players[p].actions, a, act.start + dt);
  }
  const after = snapshot();
  if (after === before) return;  // 端やロックで動けなかった
  if (!merge) commit(before);
  lastNudge = { key, t: now, after };
  afterChange();
}

// ロックは GUI の状態（下書き・Undo）にだけ持ち、txt には出力しない。false は持たずにキーごと消す
function toggleLock(a) {
  if (a.locked) delete a.locked;
  else a.locked = true;
}

// ---------------------------------------------------------------- スナップ（推定位置への吸着）

// ChartLib.calc_level の JS 版。exclude ("p:a" の Set) を除いた戦闘で階の進行を再現し、
// 階ごとの撃破 {kills: {ボス: {t, key}}, realm: {t, key}} を返す（t は battle_end、key は根拠のブロック）
function simulateFloors(exclude) {
  const lag = timelag();
  const items = [];
  state.players.forEach((p, pi) => p.actions.forEach((a, ai) => {
    const key = `${pi}:${ai}`;
    if (!exclude.has(key)) items.push({ push: a.start, end: a.start + lag + a.battle, boss: a.boss, key });
  }));
  // Python の sorted((push_start, battle_end, action)) と同じ順
  items.sort((x, y) => x.push - y.push || x.end - y.end || (x.boss < y.boss ? -1 : x.boss > y.boss ? 1 : 0));
  const floors = [{ kills: {}, realm: { t: 0, key: null } }];
  const floor = (f) => floors[f] || (floors[f] = { kills: {}, realm: null });
  const earlier = (cur, it) => (!cur || it.end < cur.t ? { t: it.end, key: it.key } : cur);
  let cur = 1;
  for (const it of items) {
    if (it.boss === "Realm_boss") {
      const f = floor(cur);
      if (REGULAR_BOSSES.some((b) => !f.kills[b])) floors[cur - 1].realm = earlier(floors[cur - 1].realm, it);
      else { f.realm = earlier(f.realm, it); cur++; }
    } else if (it.push > floors[cur - 1].realm.t) {
      const f = floor(cur);
      f.kills[it.boss] = earlier(f.kills[it.boss], it);
    }
  }
  return floors;
}

// boss のブロックを列 pi に置くときの吸着先 [{t, label, src: [key]}]（t は push_start）
// - 1st/2nd/3rd: 他の列の 1st/2nd/3rd と同時出撃、または Realm 撃破で次の階が開いた snapMargin 秒後
//   （calc_level は push_start > Realm 撃破 で数えるので、余裕 0 でも最低 1 秒あける）
// - Realm: その階の 1st/2nd/3rd が 3 体とも撃破された snapMargin 秒後
function snapCandidates(pi, boss, exclude) {
  const floors = simulateFloors(exclude);
  const out = [];
  if (boss === "Realm_boss") {
    floors.forEach((f, n) => {
      if (!n || REGULAR_BOSSES.some((b) => !f.kills[b])) return;
      const ks = REGULAR_BOSSES.map((b) => f.kills[b]);
      out.push({ t: Math.max(...ks.map((k) => k.t)) + snapMargin, label: `${n}F 1st/2nd/3rd 撃破 +${snapMargin}秒`, src: ks.map((k) => k.key) });
    });
    return out;
  }
  state.players.forEach((p, pj) => {
    if (pj === pi) return;
    p.actions.forEach((a, aj) => {
      const key = `${pj}:${aj}`;
      if (a.boss === "Realm_boss" || exclude.has(key)) return;
      out.push({ t: a.start, label: `${p.name || p.id} の ${BOSS_LABEL[a.boss]} と同時`, src: [key] });
    });
  });
  floors.forEach((f, n) => {
    if (n && f.realm) out.push({ t: f.realm.t + Math.max(snapMargin, 1), label: `${n + 1}F 開放 +${Math.max(snapMargin, 1)}秒`, src: [f.realm.key] });
  });
  return out;
}

// raw 秒に画面上で SNAP_PX 以内の候補があれば、いちばん近いものを返す
function snapTo(raw, cands) {
  let best = null;
  for (const c of cands) {
    const d = Math.abs(c.t - raw);
    if (d <= SNAP_PX / scale && (!best || d < Math.abs(best.t - raw))) best = c;
  }
  return best;
}

function addActionAt(p, t, noSnap = false) {
  const acts = state.players[p].actions;
  const len = blockLen();
  let i = acts.findIndex((a) => a.start > t);
  if (i < 0) i = acts.length;
  const prev = acts[i - 1] || acts[i];
  const boss = prev ? prev.boss : "1st_boss";
  const s = noSnap ? null : snapTo(t, snapCandidates(p, boss, new Set()));
  if (s) {
    t = s.t;
    i = acts.findIndex((a) => a.start > t);
    if (i < 0) i = acts.length;
  }
  const lo = i > 0 ? acts[i - 1].start + len : 0;
  const hi = (i < acts.length ? acts[i].start : CHART_SEC + len) - len;
  if (hi < lo) { showStatus("ここには入る余地がありません（前後のブロックと重なります）"); return; }
  const a = { start: clamp(t, lo, hi), boss, battle: prev ? prev.battle : 30, rate: 1 };
  mutate(() => { acts.splice(i, 0, a); setSelection([{ p, a: i }]); });
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
    const st = stateFromParsed(j.commands, j.constants);
    const locked = lockedInText(text);
    st.players.forEach((p) => p.actions.forEach((a, i) => { if (locked.has(`${p.id}:${i}`)) a.locked = true; }));
    replaceState(st);
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
  const selKeys = new Set(selectedBlocks().map((s) => `${s.p}:${s.a}`));

  state.players.forEach((p, pi) => {
    const selP = selection && selection.p === pi;
    const teamColor = CONFIG.team.team_color[teamOf(p.id)];
    const head = h("div", {
      class: "col-head" + (selP && selection.a === null ? " selected" : ""),
      title: p.id,
      onclick: () => { setSelection([]); selection = { p: pi, a: null }; render(); renderSide(); switchTab("select"); },
    },
    h("div", { class: "team", style: { color: teamColor ? bgr(teamColor) : "" } }, teamColor ? teamOf(p.id) : " "),
    h("div", { class: "name" }, p.name || p.id));

    const body = h("div", {
      class: "col-body",
      style: { height: `${bodyH}px` },
      // 空いた場所を押すと選択を解除する
      onpointerdown: (e) => {
        if (e.target !== body || e.button !== 0 || !selection) return;
        clearSelection();
        render();
        renderSide();
      },
      ondblclick: (e) => {
        if (e.target !== body) return;
        addActionAt(pi, Math.round((e.offsetY / scale) - lag), e.altKey);
      },
    },
    h("div", { class: "hline half", style: { top: `${1800 * scale}px` } }),
    h("div", { class: "hline end", style: { top: `${CHART_SEC * scale}px` } }),
    snapGuide ? h("div", { class: "hline snap", style: { top: `${snapGuide.t * scale}px` } }) : null);

    p.actions.forEach((a, ai) => {
      const d = dmap.get(`${pi}:${ai}`);
      const bossColor = colors[state.constants[a.boss]];
      const block = h("div", {
        class: "block" + (selKeys.has(`${pi}:${ai}`) ? " selected" : "") + (a.locked ? " locked" : "")
          + (snapGuide && snapGuide.src.has(`${pi}:${ai}`) ? " snap-src" : ""),
        style: { top: `${a.start * scale}px`, height: `${len * scale}px` },
        onpointerdown: (e) => startDrag(e, pi, ai, "move"),
        // 右クリックでボスを 1st → 2nd → 3rd → Realm → 1st の順に切り替える。
        // 複数選択中のブロックなら、選択中すべてをこのブロックの次のボスにそろえる
        oncontextmenu: (e) => {
          e.preventDefault();
          const next = BOSSES[(BOSSES.indexOf(a.boss) + 1) % BOSSES.length];
          if (!multi.length || !selKeys.has(`${pi}:${ai}`)) setSelection([{ p: pi, a: ai }]);
          mutate(() => eachSelected((x) => { x.boss = next; }));
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
  tl.replaceChildren(...cols);
  $("#guide").hidden = state.players.some((p) => p.actions.length);
}

function startDrag(e, pi, ai, mode) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  // Ctrl+クリックで追加・解除、Shift+クリックで同じ列の範囲選択（ドラッグはしない）
  if (mode === "move" && (e.ctrlKey || e.metaKey || e.shiftKey)) {
    if (e.shiftKey) rangeSelect(pi, ai);
    else toggleSelect(pi, ai);
    render();
    renderSide();
    switchTab("select");
    return;
  }
  const before = snapshot();
  const acts = state.players[pi].actions;
  const a = acts[ai];
  // 複数選択中のブロックをつかんだら選択全体を動かす（動かさずに離したらそのブロックだけの選択にする）
  const group = mode === "move" && multi.some((x) => x.p === pi && x.a === ai);
  const groupLocked = group && multi.some((x) => state.players[x.p].actions[x.a].locked);
  const y0 = e.clientY;
  const start0 = a.start;
  const battle0 = a.battle;
  let moved = false;
  // 吸着先はつかんだ時点の配置から 1 回だけ求める（動かすブロック自身は根拠にしない）
  const cands = mode === "move" && !groupLocked
    ? snapCandidates(pi, a.boss, new Set((group ? multi : [{ p: pi, a: ai }]).map((x) => `${x.p}:${x.a}`)))
    : [];
  const tip = h("div", { class: "drag-tip", hidden: true });
  document.body.append(tip);

  const onMove = (ev) => {
    if (!moved && Math.abs(ev.clientY - y0) < 3) return;
    moved = true;
    const dt = Math.round((ev.clientY - y0) / scale);
    // Alt を押している間は吸着しない
    const snap = ev.altKey ? null : snapTo(start0 + dt, cands);
    const target = snap ? snap.t : start0 + dt;
    if (group) shiftSelected(target - a.start);
    else if (mode === "move") slideTo(acts, ai, target);
    else a.battle = clamp(battle0 + dt, 1, MAX_BATTLE);
    if (!group) setSelection([{ p: pi, a: ai }]);
    // ロックや端で止まって届かなかったときは吸着を表示しない
    const snapped = snap && a.start === snap.t ? snap : null;
    snapGuide = snapped ? { t: snapped.t, src: new Set(snapped.src) } : null;
    render();
    tip.hidden = false;
    tip.style.left = `${ev.clientX + 14}px`;
    tip.style.top = `${ev.clientY + 10}px`;
    const shift = a.start - start0;
    tip.textContent = groupLocked ? "ロック中の戦闘を含むため動かせません（L キーで解除）"
      : group ? `${multi.length} 個の戦闘を ${shift > 0 ? "+" : ""}${shift}秒`
      : mode === "move" && a.locked ? "ロック中（L キーで解除）"
      : mode === "move"
      ? `戦闘開始 ${clock(a.start + timelag())}（待機 ${a.start - (ai ? acts[ai - 1].start + blockLen() : 0)}秒）`
      : `戦闘 ${a.battle}秒（終了 ${clock(a.start + timelag() + a.battle)}）`;
    if (snapped) tip.textContent += ` ⇢ ${snapped.label}`;
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    tip.remove();
    snapGuide = null;
    if (moved) { commit(before); afterChange(); }
    else { setSelection([{ p: pi, a: ai }]); render(); renderSide(); switchTab("select"); }
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

// 複数選択中のサイドパネル。値がそろっていない欄は空欄（ボスは「混在」）で表示し、入力した値を全部に設定する
function renderMultiSide() {
  const acts = selectedBlocks().map(({ p, a }) => state.players[p].actions[a]);
  const same = (k) => (acts.every((x) => x[k] === acts[0][k]) ? acts[0][k] : null);
  const locked = acts.filter((x) => x.locked).length;
  const boss = same("boss");
  const bossSel = bossSelect(boss);
  if (boss === null) bossSel.prepend(h("option", { value: "", selected: true, disabled: true }, "（混在）"));
  bossSel.title = "1〜4 キー、またはブロックの右クリックでも切り替えられます";
  bossSel.addEventListener("change", () => mutate(() => eachSelected((x) => { x.boss = bossSel.value; })));
  const battle = same("battle");
  const rate = same("rate");
  return [
    h("h3", {}, `${acts.length} 個の戦闘を選択中`),
    h("label", { class: "row", title: "1 個でも未ロックがあれば全部ロック、全部ロック済みなら全部解除します (L)" },
      h("input", { type: "checkbox", checked: locked === acts.length, indeterminate: locked > 0 && locked < acts.length,
        onchange: () => mutate(toggleLockSelected) }), "🔒 位置をロック (L)"),
    field("ボス", bossSel),
    field("戦闘秒数", h("input", {
      type: "number", min: 1, max: MAX_BATTLE, value: battle ?? "", placeholder: battle === null ? "混在" : "",
      onchange: (e) => {
        if (e.target.value === "") return;
        const v = clamp(parseInt(e.target.value) || 1, 1, MAX_BATTLE);
        mutate(() => eachSelected((x) => { x.battle = v; }));
      },
    })),
    field("与ダメージ率", h("input", {
      type: "number", min: 0, max: 1, step: 0.05, value: rate ?? "", placeholder: rate === null ? "混在" : "",
      title: "ワンパンは 1 となります。1.0 未満なら市松模様と % を表示します",
      onchange: (e) => {
        if (e.target.value === "") return;
        const r = parseFloat(e.target.value);
        mutate(() => eachSelected((x) => { x.rate = Number.isFinite(r) ? r : 1; }));
      },
    })),
    h("p", { class: "hint" }, "ボス・ロック・戦闘秒数・与ダメージ率・削除は選択中の戦闘すべてに適用します。ドラッグか ↑↓ キー（Shift で 10 秒）で間隔を保ったまままとめて動かせます。ロックや端で 1 個でも止まると全体が止まります。Ctrl+クリックで追加・解除、Shift+クリックで同じ列の範囲選択、Esc か空いた場所のクリックで解除します。"),
    h("div", { class: "row" },
      h("span", { class: "grow" }),
      h("button", { class: "danger", onclick: () => mutate(deleteSelected) }, `${acts.length} 個の戦闘を削除 (Del)`)),
  ];
}

function renderSide() {
  const panel = $("#panel-select");
  const parts = [];

  if (multi.length) {
    parts.push(...renderMultiSide());
  } else if (selection) {
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
        h("button", { disabled: pi === state.players.length - 1, onclick: () => mutate(() => { state.players.splice(pi + 1, 0, ...state.players.splice(pi, 1)); selection.p = pi + 1; }) }, "右へ →")),
      h("p", { class: "hint" }, "列の空いた場所をダブルクリックすると戦闘を追加します。"));

    if (selection.a !== null) {
      const ai = selection.a;
      const a = p.actions[ai];
      const d = detailIndex().get(`${pi}:${ai}`);
      const len = blockLen();
      const wait = a.start - (ai ? p.actions[ai - 1].start + len : 0);
      parts.push(h("h3", {}, `戦闘 #${ai + 1}`),
        field("戦闘開始", h("input", {
          value: clock(a.start), disabled: !!a.locked, title: (remaining() ? "残り時間がこの時にバトル開始の予定" : "経過時間がこの時にバトル開始の予定") + "。↑↓ キーで 1 秒ずつ（Shift で 10 秒）動かせます",
          onchange: (e) => {
            let t = parseTime(e.target.value);
            if (t === null) { showStatus("時刻は mm:ss か秒数で入力してください"); renderSide(); return; }
            if (remaining()) t = CHART_SEC - t;
            mutate(() => slideTo(p.actions, ai, t));
          },
        })),
        field("待機時間(秒)", h("input", {
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
        h("p", { class: "hint" }, "↑↓ キーで 1 秒ずつ（Shift で 10 秒）動かせます。ブロックの右クリックでボスを順に切り替え、1〜4 キーで直接指定できます。Ctrl+クリックで複数選択、Shift+クリックで同じ列の範囲選択ができます。"),
        h("div", { class: "row" },
          h("span", { class: "grow" }),
          h("button", { class: "danger", onclick: () => mutate(deleteSelected) }, "戦闘を削除 (Del)")));
    }
  } else {
    parts.push(h("p", { class: "hint" },
      "列の空いた場所をダブルクリックすると戦闘を追加できます。ブロックをドラッグすると時刻を変えられます。隙間があればそのブロックだけが動き、隣に当たると押し出します。下端のドラッグで戦闘時間を変えられます。右クリックでボスを順に切り替え、選択中に 1〜4 キーで直接指定、↑↓ キーで 1 秒ずつ（Shift で 10 秒）動かせます。Ctrl+クリックで複数選択、Shift+クリックで同じ列の範囲選択ができ、Esc か空いた場所のクリックで解除します。"));
  }

  panel.replaceChildren(...parts.filter((x) => x));  // Lv/スコアの取得前は null が入る
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
      title: "ゲームの開始時刻。進行管理で使います",
      onchange: (e) => mutate(() => { c.start_time = e.target.value; }),
    })),
    field("スナップの余裕(秒)", h("input", {
      type: "number", min: 0, max: 60, value: snapMargin,
      title: "ドラッグで Realm や次の階の 1st/2nd/3rd を置くとき、直前のボスの撃破から何秒あけた位置に吸着させるか。このブラウザにだけ保存し、作戦には含めません",
      onchange: (e) => { snapMargin = clamp(parseInt(e.target.value) || 0, 0, 60); e.target.value = snapMargin; save(); },
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

// ---------------------------------------------------------------- 共有 URL
// 作戦の txt を deflate して base64url にし、URL の #plan= に入れる。
// ハッシュはサーバーに送られないので、共有してもサーバーには何も残らない

const SHARE_PREFIX = "#plan=";

async function pipeBytes(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

async function encodePlan(text) {
  const bytes = await pipeBytes(new TextEncoder().encode(text), new CompressionStream("deflate-raw"));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function decodePlan(code) {
  const bin = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(await pipeBytes(bytes, new DecompressionStream("deflate-raw")));
}

async function copyShareUrl() {
  const btn = $("#btn-share");
  const url = `${location.origin}${location.pathname}${SHARE_PREFIX}${await encodePlan(toText())}`;
  await navigator.clipboard.writeText(url);
  showStatus(null);
  btn.textContent = "コピーしました";
  setTimeout(() => { btn.textContent = "共有URL"; }, 1500);
}

// URL に #plan= があれば読み込み、ハッシュは消す (再読み込みで何度も取り込まないように)
async function loadSharedPlan() {
  if (!location.hash.startsWith(SHARE_PREFIX)) return;
  const code = location.hash.slice(SHARE_PREFIX.length);
  history.replaceState(null, "", location.pathname + location.search);
  let text;
  try {
    text = await decodePlan(code);
  } catch (e) {
    showStatus("共有URLの作戦を読み込めませんでした（URLが途中で切れている可能性があります）");
    return;
  }
  if (text === toText()) return;
  const hasPlan = state.players.some((p) => p.actions.length);
  if (hasPlan && !confirm("共有URLの作戦を開きますか？ 今の作戦は「元に戻す」で復元できます。")) return;
  await importText(text);
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
  // 進行管理の作成画面へ今の作戦を引き継ぐ
  $("#btn-tracker").addEventListener("click", () => {
    try { localStorage.setItem("chartmaker.tracker.text", toText()); } catch (e) { /* 引き継げなくても画面は開く */ }
    window.open("/tracker", "_blank");
  });
  $("#btn-share").addEventListener("click", () => copyShareUrl().catch((e) => showStatus(`共有URLを作れませんでした: ${e.message}`)));
  // 開いたままのタブに別の共有URLを貼った場合
  window.addEventListener("hashchange", loadSharedPlan);
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
    else if ((key === "delete" || key === "backspace") && selectedBlocks().length) {
      e.preventDefault();
      mutate(deleteSelected);
    } else if (/^[1-4]$/.test(key) && !e.ctrlKey && !e.metaKey && !e.altKey && selectedBlocks().length) {
      // 選択中のブロックのボスを 1=1st 2=2nd 3=3rd 4=Realm で直接指定する
      e.preventDefault();
      const boss = BOSSES[Number(key) - 1];
      mutate(() => eachSelected((x) => { x.boss = boss; }));
    } else if (key === "l" && !e.ctrlKey && !e.metaKey && !e.altKey && selectedBlocks().length) {
      e.preventDefault();
      mutate(toggleLockSelected);
    } else if ((key === "arrowup" || key === "arrowdown") && !e.ctrlKey && !e.metaKey && !e.altKey && selection && selection.a !== null) {
      // ↑ で 1 秒早く、↓ で 1 秒遅く。Shift で 10 秒
      e.preventDefault();
      nudge((key === "arrowup" ? -1 : 1) * (e.shiftKey ? 10 : 1));
    } else if (key === "escape") {
      if (!$("#modal").hidden) $("#modal").hidden = true;
      else if (selection) { clearSelection(); render(); renderSide(); }
    }
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
  await loadSharedPlan();
}

init().catch((e) => showStatus(`初期化に失敗しました: ${e.message}`));
