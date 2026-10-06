"use strict";
// 作戦のスタッツ（層域ごとの戦闘数、予定スコアの推移、階ごとの撃破時刻、プレイヤーごとの出撃と空き）
// すべてブラウザで、/api/detail の結果 (details) と simulateFloors から集計する。サーバーは変えない。

const STATS_BANDS = ["Lv1–5", "Lv6–10", "Lv11–15", "Lv16–20", "Lv21–"];
const STATS_MIN_BATTLE = 30;   // 空きに入れられる最短の戦闘（秒）
const STATS_W = 760, STATS_H = 240, STATS_PAD = { l: 64, r: 12, t: 22, b: 26 };
const STATS_SVG_NS = "http://www.w3.org/2000/svg";

const statsBand = (lv) => clamp(Math.floor((lv - 1) / 5), 0, STATS_BANDS.length - 1);

function statsSvg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(STATS_SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

// details と state の戦闘を 1 対 1 に並べ、集計に使う形にする。ずれていれば null（再計算待ち）
function statsCollect() {
  const dmap = detailIndex();
  if (!details.length || dmap.size !== details.length) return null;
  const floors = simulateFloors(new Set());
  const battles = [];
  state.players.forEach((p, pi) => p.actions.forEach((a, ai) => {
    const d = dmap.get(`${pi}:${ai}`);
    battles.push({ pi, ai, p, a, d, level: d.level, boss: d.action, score: d.est_score, full: d.score, push: d.push_start, end: d.battle_end });
  }));
  // 撃破済みのボスへの出撃（calc_level は得点に数えるが、実際には出られない）
  for (const b of battles) {
    const f = floors[b.level];
    const k = !f ? null : b.boss === "Realm_boss" ? f.realm : f.kills[b.boss];
    b.dead = !!k && b.push >= k.t && k.key !== `${b.pi}:${b.ai}`;
  }
  return { floors, battles };
}

// ---------------------------------------------------------------- 集計

function statsBands({ floors, battles }) {
  const rows = STATS_BANDS.map((label) => ({ label, count: Object.fromEntries(BOSSES.map((b) => [b, 0])), n: 0, score: 0, partial: 0 }));
  for (const b of battles) {
    if (b.level < 1) continue;
    const r = rows[statsBand(b.level)];
    r.count[b.boss]++; r.n++; r.score += b.score;
    if (b.a.rate < 1) r.partial++;
  }
  // 層域の時間帯: 最初の階が開いた時刻 (前の階の Realm 撃破) から、最後の階の Realm 撃破 (なければ作戦の終わり) まで
  const realmAt = (f) => (f === 0 ? 0 : floors[f] && floors[f].realm ? floors[f].realm.t : null);
  rows.forEach((r, i) => {
    const first = i * 5 + 1;
    const from = realmAt(first - 1);
    if (from === null || from >= CHART_SEC) return;
    let to = CHART_SEC;
    if (i < STATS_BANDS.length - 1) { const t = realmAt(first + 4); if (t !== null) to = Math.min(t, CHART_SEC); }
    r.from = from; r.to = to;
  });
  return rows;
}

function statsFloorRows({ floors, battles }) {
  const rows = [];
  for (let f = 1; f < floors.length; f++) {
    const fl = floors[f];
    const open = floors[f - 1].realm ? floors[f - 1].realm.t : null;
    const mine = battles.filter((b) => b.level === f);
    rows.push({
      f, open,
      kills: Object.fromEntries(REGULAR_BOSSES.map((b) => [b, fl.kills[b] ? fl.kills[b].t : null])),
      realm: fl.realm ? fl.realm.t : null,
      n: mine.length, score: mine.reduce((s, b) => s + b.score, 0),
    });
  }
  return rows;
}

// プレイヤーごとの出撃数と、時間的にあと何回出撃を入れられるか（ボスが生きているかは見ない）
function statsPlayers({ battles }) {
  const len = blockLen();
  const fit = (from, to) => Math.max(0, Math.floor((to - from) / len));
  return state.players.map((p, pi) => {
    const mine = battles.filter((b) => b.pi === pi).sort((x, y) => x.push - y.push);
    if (!mine.length && !p.name) return null;
    let ready = 0, room = 0;
    const gaps = [];
    for (const b of mine) {
      const k = fit(ready, b.push);
      if (k) { room += k; gaps.push([ready, b.push]); }
      ready = b.push + len;
    }
    if (ready + STATS_MIN_BATTLE <= CHART_SEC) {
      room += Math.floor((CHART_SEC - STATS_MIN_BATTLE - ready) / len) + 1;
      gaps.push([ready, CHART_SEC]);
    }
    return {
      pi, name: p.name || p.id, n: mine.length,
      realm: mine.filter((b) => b.boss === "Realm_boss").length,
      score: mine.reduce((s, b) => s + b.score, 0),
      first: mine.length ? mine[0].push : null,
      room, gaps,
    };
  }).filter(Boolean);
}

// ---------------------------------------------------------------- 描画

function statsCard(label, value, sub) {
  return h("div", { class: "stats-card" }, h("span", {}, label), h("b", {}, value), sub ? h("small", {}, sub) : null);
}

function statsTable(head, rows, foot) {
  return h("div", { class: "stats-table-wrap" }, h("table", { class: "stats-table" },
    h("thead", {}, h("tr", {}, head.map((c) => h("th", {}, c)))),
    h("tbody", {}, rows),
    foot ? h("tfoot", {}, foot) : null));
}

const statsClock = (t) => (t === null || t === undefined ? "–" : clock(t));
const statsSpan = (t) => (t === null || t === undefined ? "–" : mmss(t));
const statsPct = (v, total) => (total ? `${Math.round((v / total) * 100)}%` : "–");

function statsBandSection(data, total) {
  const rows = statsBands(data);
  const sum = { count: Object.fromEntries(BOSSES.map((b) => [b, 0])), n: 0, score: 0, partial: 0 };
  for (const r of rows) { BOSSES.forEach((b) => (sum.count[b] += r.count[b])); sum.n += r.n; sum.score += r.score; sum.partial += r.partial; }
  const cells = (r) => [
    ...BOSSES.map((b) => h("td", { class: "num" + (r.count[b] ? "" : " zero") }, r.count[b])),
    h("td", { class: "num" }, h("b", {}, r.n)),
    h("td", { class: "num" }, r.partial || ""),
    h("td", { class: "num" }, fmt(r.score)),
    h("td", { class: "num" }, statsPct(r.score, total)),
  ];
  const body = rows.map((r, i) => h("tr", { class: r.from === undefined ? "dim" : "" },
    h("th", {}, h("i", { class: `stats-sw b${i}` }), r.label),
    ...cells(r),
    h("td", {}, r.from === undefined ? "未到達" : `${statsClock(r.from)}–${statsClock(r.to)}`),
    h("td", { class: "num" }, r.from === undefined ? "" : statsSpan(r.to - r.from))));
  const foot = h("tr", {}, h("th", {}, "合計"), ...cells(sum), h("td", {}), h("td", {}));
  return h("section", {},
    h("h3", {}, "層域ごとの戦闘数"),
    statsTable(["層域", ...BOSSES.map((b) => BOSS_LABEL[b]), "計", "割合<100%", "予定スコア", "比率", "時間帯", "滞在"], body, foot),
    h("p", { class: "hint" }, "時間帯は、層域の最初の階が開いてから最後の階の Realm を倒すまで。上の層域ほど 1 戦の得点が高いので、下の層域の滞在を縮めると後半の戦闘が増えます。"));
}

function statsChart(data, rows) {
  const { l, r, t, b } = STATS_PAD;
  const pw = STATS_W - l - r, ph = STATS_H - t - b;
  // 得点は戦闘が終わった時刻に入る（進行管理と同じ）
  const ev = data.battles.map((x) => [Math.min(x.end, CHART_SEC), x.score]).sort((x, y) => x[0] - y[0]);
  const pts = [[0, 0]];
  let acc = 0;
  for (const [tm, s] of ev) { acc += s; pts.push([tm, acc]); }
  const top = Math.max(acc, 1);
  const step = [1e6, 2e6, 5e6, 1e7, 2e7].find((s) => top / s <= 6) || 5e7;
  const ymax = Math.ceil(top / step) * step;
  const X = (s) => l + (s / CHART_SEC) * pw;
  const Y = (v) => t + ph - (v / ymax) * ph;

  const g = statsSvg("svg", { viewBox: `0 0 ${STATS_W} ${STATS_H}`, class: "stats-chart", role: "img" });
  rows.forEach((row, i) => {
    if (row.from === undefined) return;
    g.append(statsSvg("rect", { x: X(row.from), y: t, width: Math.max(X(row.to) - X(row.from), 0), height: ph, class: `band b${i}` }));
    if (X(row.to) - X(row.from) > 40) g.append(statsSvg("text", { x: X(row.from) + 4, y: t - 6, class: "band-label" }, row.label));
  });
  for (let v = 0; v <= ymax; v += step) {
    g.append(statsSvg("line", { x1: l, x2: l + pw, y1: Y(v), y2: Y(v), class: "grid" }));
    g.append(statsSvg("text", { x: l - 6, y: Y(v) + 4, class: "axis", "text-anchor": "end" }, `${v / 1e6}M`));
  }
  for (let m = 0; m <= 60; m += 10) {
    g.append(statsSvg("line", { x1: X(m * 60), x2: X(m * 60), y1: t, y2: t + ph, class: "grid" }));
    g.append(statsSvg("text", { x: X(m * 60), y: STATS_H - 8, class: "axis", "text-anchor": "middle" }, clock(m * 60)));
  }
  // 階の Realm 撃破
  data.floors.forEach((f, n) => {
    if (n && f.realm && f.realm.t <= CHART_SEC) g.append(statsSvg("line", { x1: X(f.realm.t), x2: X(f.realm.t), y1: t + ph - 6, y2: t + ph, class: "kill" }));
  });
  let d = `M${X(0)},${Y(0)}`;
  for (let i = 1; i < pts.length; i++) d += `H${X(pts[i][0])}V${Y(pts[i][1])}`;
  d += `H${X(CHART_SEC)}`;
  g.append(statsSvg("path", { d, class: "line" }));

  const cursor = statsSvg("line", { y1: t, y2: t + ph, class: "cursor", visibility: "hidden" });
  g.append(cursor);
  const tip = h("div", { class: "stats-tip", hidden: true });
  const lvAt = (s) => {
    let lv = 1;
    data.floors.forEach((f, n) => { if (n && f.realm && f.realm.t <= s) lv = n + 1; });
    return lv;
  };
  g.addEventListener("pointermove", (e) => {
    const box = g.getBoundingClientRect();
    const s = clamp(Math.round(((e.clientX - box.left) / box.width * STATS_W - l) / pw * CHART_SEC), 0, CHART_SEC);
    let v = 0;
    for (const [tm, y] of pts) if (tm <= s) v = y;
    cursor.setAttribute("x1", X(s)); cursor.setAttribute("x2", X(s)); cursor.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.textContent = `${clock(s)}  Lv${lvAt(s)}  ${fmt(v)}`;
    tip.style.left = `${clamp(e.clientX - box.left + 12, 0, box.width - 160)}px`;
  });
  g.addEventListener("pointerleave", () => { cursor.setAttribute("visibility", "hidden"); tip.hidden = true; });
  return h("section", {},
    h("h3", {}, "予定スコアの推移"),
    h("div", { class: "stats-chart-wrap" }, g, tip),
    h("p", { class: "hint" }, "得点は戦闘が終わった時刻に足しています。下の短い線は各階の Realm 撃破です。傾きが緩い時間帯は、出撃が少ないか、下の層域に留まっています。"));
}

function statsFloorSection(data) {
  const rows = statsFloorRows(data);
  const body = rows.map((r) => h("tr", { class: r.realm === null ? "dim" : "" },
    h("th", {}, h("i", { class: `stats-sw b${statsBand(r.f)}` }), `${r.f}F`),
    h("td", {}, statsClock(r.open)),
    ...REGULAR_BOSSES.map((b) => h("td", {}, statsClock(r.kills[b]))),
    h("td", {}, statsClock(r.realm)),
    h("td", { class: "num" }, r.realm !== null && r.open !== null ? statsSpan(r.realm - r.open) : ""),
    h("td", { class: "num" }, r.n),
    h("td", { class: "num" }, fmt(r.score))));
  return h("section", {},
    h("h3", {}, "階ごとの撃破時刻"),
    statsTable(["階", "開放", ...REGULAR_BOSSES.map((b) => BOSS_LABEL[b]), "Realm", "所要", "戦闘", "予定スコア"], body));
}

function statsPlayerSection(data) {
  const rows = statsPlayers(data);
  const max = Math.floor((CHART_SEC - STATS_MIN_BATTLE) / blockLen()) + 1;
  const body = rows.map((r) => h("tr", {},
    h("th", {}, r.name),
    h("td", { class: "num" }, `${r.n} / ${max}`),
    h("td", { class: "num" }, r.realm),
    h("td", { class: "num" }, fmt(r.score)),
    h("td", {}, statsClock(r.first)),
    h("td", { class: "num" + (r.room ? " warn" : "") }, r.room || ""),
    h("td", { class: "gaps" }, r.room ? r.gaps.map(([a, z]) => `${statsClock(a)}–${statsClock(z)}`).join(", ") : "")));
  return h("section", {},
    h("h3", {}, "プレイヤーごとの出撃"),
    statsTable(["プレイヤー", "出撃", "Realm", "予定スコア", "初出撃", "空き", "空いている時間"], body),
    h("p", { class: "hint" }, `「空き」は、クールタイム明けから次の出撃までに、あと何回出撃を入れられるか (${STATS_MIN_BATTLE} 秒の戦闘で数え、ボスが生きているかは見ない)。`));
}

function statsDeadSection(data) {
  const dead = data.battles.filter((b) => b.dead);
  if (!dead.length) return null;
  return h("section", {},
    h("h3", { class: "warn" }, `撃破後の出撃 ${dead.length} 件`),
    h("p", { class: "hint" }, "そのボスが倒れた後に出撃しています。予定スコアには数えていますが、実際には出撃できません。"),
    h("ul", { class: "stats-list" }, dead.map((b) =>
      h("li", {}, h("button", { type: "button", class: "link", onclick: () => statsJump(b) },
        `${b.p.name || b.p.id}  ${clock(b.push)}  Lv${b.level} ${BOSS_LABEL[b.boss]}`)))));
}

// 一覧の戦闘を選択して、タイムラインのその位置を見せる
function statsJump(b) {
  $("#stats-dialog").close();
  setSelection([{ p: b.pi, a: b.ai }]);
  render(); renderSide(); switchTab("select");
  const el = document.querySelector(".block.selected");
  if (el) el.scrollIntoView({ block: "center", inline: "center" });
}

function renderStats() {
  const body = $("#stats-body");
  if (!state.players.some((p) => p.actions.length)) { body.replaceChildren(h("p", { class: "hint" }, "まだ戦闘がありません。")); return; }
  const data = statsCollect();
  if (!data) { body.replaceChildren(h("p", { class: "hint" }, "計算中…")); return; }
  const total = data.battles.reduce((s, b) => s + b.score, 0);
  const full = data.battles.reduce((s, b) => s + b.full, 0);
  const maxLv = data.battles.reduce((m, b) => Math.max(m, b.level), 0);
  const players = statsPlayers(data);
  const room = players.reduce((s, r) => s + r.room, 0);
  const n = data.battles.length;
  const realm = data.battles.filter((b) => b.boss === "Realm_boss").length;
  body.replaceChildren(...[
    h("div", { class: "stats-cards" },
      statsCard("予定スコア", fmt(total), full > total ? `すべて 100% なら ${fmt(full)}` : null),
      statsCard("到達", `Lv${maxLv}`, `${data.floors.filter((f, i) => i && f.realm).length} 階を突破`),
      statsCard("戦闘", `${n} 回`, `${players.length} 人 / Realm ${realm} 回`),
      statsCard("空き", `${room} 回`, room ? "出撃を足せる余地" : "なし")),
    statsBandSection(data, total),
    statsChart(data, statsBands(data)),
    statsDeadSection(data),
    critStatsSection(),
    statsFloorSection(data),
    statsPlayerSection(data)].filter(Boolean));
}

// 開いている間に計算が終わったら描き直す（renderSummary から呼ぶ）
function refreshStats() {
  if ($("#stats-dialog").open) renderStats();
}

$("#btn-stats").addEventListener("click", () => {
  renderStats();
  $("#stats-dialog").showModal();
});
$("#stats-close").addEventListener("click", () => $("#stats-dialog").close());
