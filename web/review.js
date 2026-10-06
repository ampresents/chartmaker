"use strict";
// 振り返り: 討伐記録 (events) と作戦 (plan.cleartime) を比べ、階ごとの撃破時刻、遅れの推移、
// 遅れが大きく増えたボスを出す。進行中も討伐のたびに更新する。JSON で保存できる。
// tracker.js の後に読み込み、その関数 (planned, killTime, bossGate, h, mmss など) を使う。

const REVIEW_W = 760, REVIEW_H = 240, REVIEW_PAD = { l: 56, r: 12, t: 14, b: 26 };
const REVIEW_SVG_NS = "http://www.w3.org/2000/svg";
const REVIEW_TOP = 10;      // 遅れが増えたボスの表示数
const REVIEW_GAIN = 3;      // 取り戻したボスの表示数
let reviewKey = null;       // 最後に描いた討伐記録 (変わったときだけ描き直す)
let reviewHl = null;        // 強調中の表のセル ("floor:boss")

function reviewSvg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(REVIEW_SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const reviewClock = (t) => (t === null || t === undefined ? "–" : (t < 0 ? "-" : "") + mmss(t));
const reviewDiff = (d) => (d === null ? "—" : d === 0 ? "±0秒" : d > 0 ? `+${d}秒` : `${d}秒`);
const reviewTone = (d) => (d === null || d === 0 ? "" : d > 0 ? "late-text" : "ok-text");
const reviewLabel = (k) => `Lv${k.floor} ${BOSS_LABEL[k.boss]}`;

// 討伐ごとの差 (実際 − 予定) と、開放された時点の差からの増え方
function reviewKills() {
  return events.map((e) => {
    const t = Math.round(e.t);
    const p = planned(e.floor, e.boss);
    const g = bossGate(e.floor, e.boss);
    const diff = p === null ? null : t - p;
    const gateDiff = g.actual === null || g.planned === null ? null : Math.round(g.actual) - g.planned;
    return {
      floor: e.floor, boss: e.boss, t, planned: p, diff, gateDiff,
      added: diff === null || gateDiff === null ? null : diff - gateDiff,
    };
  });
}

function reviewTable(kills) {
  // 到達した階まで並べ、その先の作戦の階は 1 行にまとめる
  const reached = 1 + events.filter((e) => e.boss === "Realm_boss").length;
  const planFloors = plan.cleartime.length - 1;
  const last = reached;
  const byKey = new Map(kills.map((k) => [`${k.floor}:${k.boss}`, k]));
  const rows = [];
  for (let f = 1; f <= last; f++) {
    const open = f === 1 ? 0 : killTime(f - 1, "Realm_boss");
    const realm = killTime(f, "Realm_boss");
    const cells = BOSSES.map((b) => {
      const k = byKey.get(`${f}:${b}`);
      const p = planned(f, b);
      const title = p === null ? "作戦に予定なし" : `予定 ${reviewClock(p)}`;
      if (!k) return h("td", { class: "dim", title }, p === null ? "" : "未討伐");
      return h("td", { class: "review-cell" + (reviewHl === `${f}:${b}` ? " hl" : ""), title, dataset: { key: `${f}:${b}` } },
        reviewClock(k.t), " ", h("span", { class: reviewTone(k.diff) }, `(${reviewDiff(k.diff)})`));
    });
    rows.push(h("tr", { class: open === null ? "dim" : "" },
      h("th", {}, `${f}F`),
      h("td", {}, reviewClock(open === null ? null : Math.round(open))),
      ...cells,
      h("td", { class: "num" }, open !== null && realm !== null ? mmss(Math.round(realm - open)) : "")));
  }
  if (planFloors > last) {
    rows.push(h("tr", { class: "dim" }, h("td", { colSpan: BOSSES.length + 3 },
      `${last + 1 === planFloors ? "" : `${last + 1}F〜`}${planFloors}F は未到達`)));
  }
  return h("div", { class: "stats-table-wrap" }, h("table", { class: "stats-table" },
    h("thead", {}, h("tr", {}, ["階", "開放", ...BOSSES.map((b) => BOSS_LABEL[b]), "かかった時間"].map((c) => h("th", {}, c)))),
    h("tbody", {}, rows)));
}

function reviewChart(kills) {
  const pts = kills.filter((k) => k.diff !== null);
  const { l, r, t, b } = REVIEW_PAD;
  const pw = REVIEW_W - l - r, ph = REVIEW_H - t - b;
  const lo = Math.min(0, ...pts.map((k) => k.diff)), hi = Math.max(0, ...pts.map((k) => k.diff));
  const step = [10, 20, 30, 60, 120, 300, 600].find((s) => (hi - lo) / s <= 6) || 1200;
  const ymin = Math.floor(lo / step) * step, ymax = Math.max(Math.ceil(hi / step) * step, ymin + step);
  const tmax = Math.max(CHART_SEC, ...kills.map((k) => k.t));
  const X = (s) => l + (Math.max(s, 0) / tmax) * pw;
  const Y = (v) => t + ph - ((v - ymin) / (ymax - ymin)) * ph;

  const g = reviewSvg("svg", { viewBox: `0 0 ${REVIEW_W} ${REVIEW_H}`, class: "stats-chart review-chart", role: "img" });
  for (let v = ymin; v <= ymax; v += step) {
    g.append(reviewSvg("line", { x1: l, x2: l + pw, y1: Y(v), y2: Y(v), class: v === 0 ? "zero" : "grid" }));
    g.append(reviewSvg("text", { x: l - 6, y: Y(v) + 4, class: "axis", "text-anchor": "end" }, v > 0 ? `+${v}` : v));
  }
  for (let m = 0; m * 60 <= tmax; m += 10) {
    g.append(reviewSvg("line", { x1: X(m * 60), x2: X(m * 60), y1: t, y2: t + ph, class: "grid" }));
    g.append(reviewSvg("text", { x: X(m * 60), y: REVIEW_H - 8, class: "axis", "text-anchor": "middle" }, mmss(m * 60)));
  }
  for (const k of kills) {
    if (k.boss === "Realm_boss") g.append(reviewSvg("line", { x1: X(k.t), x2: X(k.t), y1: t + ph - 6, y2: t + ph, class: "kill" }));
  }
  if (pts.length) g.append(reviewSvg("path", { d: pts.map((k, i) => `${i ? "L" : "M"}${X(k.t)},${Y(k.diff)}`).join(""), class: "line" }));
  const dots = pts.map((k) => {
    const c = reviewSvg("circle", { cx: X(k.t), cy: Y(k.diff), r: 3.5, class: k.diff > 0 ? "dot late" : "dot ok" });
    g.append(c);
    return c;
  });

  const cursor = reviewSvg("circle", { r: 6, class: "cursor-dot", visibility: "hidden" });
  g.append(cursor);
  const tip = h("div", { class: "stats-tip", hidden: true });
  g.addEventListener("pointermove", (e) => {
    if (!pts.length) return;
    const box = g.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width * REVIEW_W;
    let best = 0;
    pts.forEach((k, i) => { if (Math.abs(X(k.t) - x) < Math.abs(X(pts[best].t) - x)) best = i; });
    const k = pts[best];
    cursor.setAttribute("cx", dots[best].getAttribute("cx"));
    cursor.setAttribute("cy", dots[best].getAttribute("cy"));
    cursor.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.textContent = `${reviewClock(k.t)}  ${reviewLabel(k)}  差 ${reviewDiff(k.diff)}` +
      (k.added === null ? "" : `  増えた遅れ ${reviewDiff(k.added)}`);
    tip.style.left = `${Math.min(Math.max(X(k.t) / REVIEW_W * box.width + 12, 0), box.width - 280)}px`;
  });
  g.addEventListener("pointerleave", () => { cursor.setAttribute("visibility", "hidden"); tip.hidden = true; });
  return h("div", { class: "stats-chart-wrap" }, g, tip);
}

function reviewJump(k) {
  reviewHl = `${k.floor}:${k.boss}`;
  const body = $("#review-body");
  body.querySelectorAll(".review-cell.hl").forEach((el) => el.classList.remove("hl"));
  const cell = body.querySelector(`.review-cell[data-key="${reviewHl}"]`);
  if (!cell) return;
  cell.classList.add("hl");
  cell.scrollIntoView({ block: "center", behavior: "smooth" });
}

function reviewItem(k) {
  return h("li", {},
    h("button", { type: "button", class: "link", onclick: () => reviewJump(k) }, reviewLabel(k)),
    `　予定 ${reviewClock(k.planned)} → 実際 ${reviewClock(k.t)}　`,
    h("span", { class: reviewTone(k.added) }, reviewDiff(k.added)),
    h("span", { class: "muted" }, `（開放時 ${reviewDiff(k.gateDiff)}、討伐時 ${reviewDiff(k.diff)}）`));
}

function reviewTopList(kills) {
  const known = kills.filter((k) => k.added !== null);
  const worse = known.filter((k) => k.added > 0).sort((a, b) => b.added - a.added).slice(0, REVIEW_TOP);
  const better = known.filter((k) => k.added < 0).sort((a, b) => a.added - b.added).slice(0, REVIEW_GAIN);
  return h("section", {},
    h("h3", {}, "遅れが大きく増えたボス"),
    worse.length ? h("ol", { class: "stats-list" }, worse.map(reviewItem)) : h("p", { class: "hint" }, "開放から討伐までに遅れが増えたボスはありません。"),
    h("p", { class: "hint" }, "増えた遅れ = 討伐時の差 − 開放された時点の差。そのボスの戦闘で生じた遅れです（前のボスから持ち越した遅れは含みません）。"),
    better.length ? h("h3", {}, "遅れを取り戻したボス") : null,
    better.length ? h("ol", { class: "stats-list" }, better.map(reviewItem)) : null);
}

function reviewCards(kills) {
  const known = kills.filter((k) => k.diff !== null);
  const last = known[known.length - 1];
  const worst = known.reduce((m, k) => (m === null || k.diff > m.diff ? k : m), null);
  const card = (label, value, tone, sub) => h("div", { class: "stats-card" },
    h("span", {}, label), h("b", { class: tone }, value), sub ? h("small", {}, sub) : null);
  return h("div", { class: "stats-cards" },
    card("討伐", `${kills.length}`, "", `到達 LV${1 + events.filter((e) => e.boss === "Realm_boss").length}`),
    card("直近の討伐の差", last ? reviewDiff(last.diff) : "—", last ? reviewTone(last.diff) : "", last ? reviewLabel(last) : ""),
    card("最大の遅れ", worst && worst.diff > 0 ? reviewDiff(worst.diff) : "—", worst && worst.diff > 0 ? "late-text" : "",
      worst && worst.diff > 0 ? reviewLabel(worst) : ""));
}

function reviewRender() {
  const kills = reviewKills();
  const body = $("#review-body");
  const scroll = body.scrollTop;
  body.replaceChildren(...[
    kills.length ? null : h("p", { class: "hint" }, "まだ討伐の記録がありません。討伐ボタンを押すと、ここに作戦との差が出ます。"),
    reviewCards(kills),
    h("section", {}, h("h3", {}, "階ごとの撃破時刻"), reviewTable(kills),
      h("p", { class: "hint" }, "経過時間と、かっこ内は作戦との差（赤は遅れ、緑は早い）。セルにカーソルを置くと予定の時刻が出ます。")),
    h("section", {}, h("h3", {}, "作戦との差の推移"), reviewChart(kills),
      h("p", { class: "hint" }, "討伐ごとの差（秒）です。上ほど遅れています。下の短い線は Realm の討伐です。")),
    reviewTopList(kills)].filter(Boolean));
  body.scrollTop = scroll;
}

// tracker.js の render() から毎回呼ばれる。開いていて、討伐記録が変わったときだけ描き直す
function reviewRefresh() {
  const dlg = $("#review-dialog");
  if (!dlg.open) return;
  const key = JSON.stringify(events);
  if (key === reviewKey) return;
  reviewKey = key;
  reviewRender();
}

const reviewDate = () => {
  const d = new Date(plan.start_epoch_ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
};

async function reviewSave() {
  let text = null;
  try {
    text = (await api("GET", `/api/sessions/${sessionId()}/text`)).text;
  } catch (e) {
    if (e.status !== 404) { showStatus(`保存できませんでした: ${e.message}`); return; }
  }
  const data = {
    kind: "chartmaker-review",
    version: 1,
    start_epoch_ms: plan.start_epoch_ms,
    saved_at: new Date().toISOString(),
    events,
    starts,
    plan: { cleartime: plan.cleartime, detail: plan.detail.map(({ id, ...x }) => x), notes: plan.notes || [] },
    text,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  const a = h("a", { href: url, download: `${reviewDate()}_review.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showStatus(text === null ? "保存しました（作戦テキストはこのセッションに残っていないため含めていません）" : "保存しました", text !== null);
}

// 振り返りの JSON を検証する。不正なら Error を投げる
function reviewParse(raw) {
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error("JSON として読めませんでした"); }
  if (data?.kind !== "chartmaker-review") throw new Error("振り返りで保存した JSON ではありません");
  if (!(data.version >= 1)) throw new Error("振り返りの JSON の形式が正しくありません");
  if (data.version > 1) throw new Error("新しい形式の振り返りです。ページを再読み込みしてから開いてください");
  const ok = Number.isFinite(data.start_epoch_ms) && Array.isArray(data.plan?.cleartime) && Array.isArray(data.plan?.detail) &&
    Array.isArray(data.events) && data.events.every((e) => Number.isInteger(e?.floor) && e.floor >= 1 &&
      BOSSES.includes(e.boss) && Number.isFinite(e.t));
  if (!ok) throw new Error("振り返りの JSON の形式が正しくありません");
  return data;
}

// 保存した振り返りをセッションなしで開く (作成画面から)。tracker.js の plan/events/starts を差し替えて同じ画面を描く
function reviewOpenFile(data) {
  plan = { ...data.plan, start_epoch_ms: data.start_epoch_ms };
  events = data.events;
  starts = data.starts && typeof data.starts === "object" ? data.starts : {};
  const st = new Date(data.start_epoch_ms);
  $("#review-title").textContent = `振り返り（${st.getFullYear()}/${st.getMonth() + 1}/${st.getDate()} ` +
    `${pad2(st.getHours())}:${pad2(st.getMinutes())} 開始）`;
  $("#review-hint").textContent = "保存した振り返りファイルの内容です。討伐時刻は討伐ボタンを押した時刻です。" +
    "作戦は、エディタの「テキストを開く」でこのファイルを開くと読み込めます。";
  $("#review-save").hidden = true;
  reviewHl = null;
  reviewKey = null;
  showStatus(null);
  $("#review-dialog").showModal();
  reviewRender();
  $("#review-body").scrollTop = 0;
}

function reviewBuild() {
  $("#btn-review").hidden = false;
  $("#btn-review").addEventListener("click", () => {
    reviewKey = null;
    reviewHl = null;
    $("#review-dialog").showModal();
    reviewRefresh();
  });
}

// ダイアログと作成画面の「振り返りファイルを開く」は、セッションの有無によらずここで一度だけつなぐ
(() => {
  const dlg = $("#review-dialog");
  $("#review-close").addEventListener("click", () => dlg.close());
  $("#review-save").addEventListener("click", reviewSave);
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  $("#review-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try { reviewOpenFile(reviewParse(await f.text())); } catch (err) { showStatus(err.message); }
  });
})();
