// 遅れに弱い撃破 (クリティカルパス)。サーバーは使わず、/api/detail の結果からブラウザで計算する。
// 撃破になる戦闘 (階層・ボスごとに battle_end が最も早い戦闘) を 1 つずつ CRIT_DELAYS 秒遅らせ、
// 進行管理 (tracker.js の schedule) と同じ規則で後の出撃をずらして、予定スコアがいくら減るかを見る。
// app.js と同じグローバルスコープなので、名前は crit / CRIT_ で始める。

const CRIT_DELAYS = [10, 30];  // 試す遅れ（秒）。目立たせるのは最初の値で減る撃破
let critShow = true;           // クリティカルパスを強調する（編集の好み。txt には出さない）
let critMap = new Map();       // "pi:ai" → {loss: [CRIT_DELAYS ごとの減点], moved: [ずれる出撃数], rank: 0|1|2}

// (階層, ボス) の番号。撃破時刻は配列で持つ (Map と文字列の key より速い)
const critKey = (level, boss) => level * BOSSES.length + BOSSES.indexOf(boss);

// 戦闘の一覧 xs ({push, lag, play, boss, rate, level, k}) を、xs[target] だけ extra 秒長くして進める。
// 出撃は tracker.js の schedule と同じく、作戦の出撃 / 前の戦闘のクールタイム明け / 前の戦闘のボスの撃破 /
// 挑戦先のボスの開放 のうち最も遅い時刻。撃破と開放は作戦との差だけずらす (作戦の余裕を保つ)。
// 撃破が出撃より前になった戦闘は出撃しない (skip)。撃破時刻は出撃に依存するので、変わらなくなるまで繰り返す。
function critRun(xs, byPlayer, planned, target, extra) {
  const R = BOSSES.indexOf("Realm_boss"), N = BOSSES.length;
  const regs = REGULAR_BOSSES.map((b) => BOSSES.indexOf(b));
  let kills = planned.slice();
  const at = xs.map((x) => x.push);
  const skip = xs.map(() => false);
  const get = (arr, k) => (arr[k] === undefined ? null : arr[k]);
  // 挑戦先のボスが開いた時刻 (a: 実際、p: 作戦)。1st/2nd/3rd は前の階の Realm 撃破、Realm はさらにその階の 3 体撃破
  const open = (lv, b) => {
    if (lv <= 1 && b !== R) return [0, 0];
    let a = lv <= 1 ? 0 : get(kills, (lv - 1) * N + R), p = lv <= 1 ? 0 : get(planned, (lv - 1) * N + R);
    if (b !== R || a === null || p === null) return [a, p];
    for (const r of regs) {
      const ka = get(kills, lv * N + r), kp = get(planned, lv * N + r);
      if (ka === null || kp === null) return [null, null];
      a = Math.max(a, ka); p = Math.max(p, kp);
    }
    return [a, p];
  };
  for (let iter = 0; iter < 200; iter++) {
    let changed = false;
    for (const list of byPlayer) {
      let prev = -1;
      for (const i of list) {
        const x = xs[i];
        let t = x.push;
        // 撃破されない (作戦にもない) ボスは待たない
        const gate = (a, p) => { if (a !== null) t = Math.max(t, p === null ? a : a + Math.max(0, x.push - p)); };
        if (prev >= 0) {
          t = Math.max(t, at[prev] + xs[prev].lag + COOL_TIME);
          gate(get(kills, xs[prev].k), get(planned, xs[prev].k));
        }
        const [ga, gp] = open(x.level, x.b);
        gate(ga, gp);
        const kt = get(kills, x.k);
        const sk = kt !== null && kt < t;
        if (t !== at[i] || sk !== skip[i]) { at[i] = t; skip[i] = sk; changed = true; }
        if (!sk) prev = i;
      }
    }
    const next = [];
    xs.forEach((x, i) => {
      if (skip[i]) return;
      const e = at[i] + x.lag + x.play + (i === target ? extra : 0);
      if (next[x.k] === undefined || e < next[x.k]) next[x.k] = e;
    });
    const same = next.length === kills.length && next.every((v, k) => kills[k] === v) && kills.every((v, k) => next[k] === v);
    kills = next;
    if (!changed && same) break;
  }
  // generate_detail と同じ規則で階層と得点を出す。60 分を過ぎた分は与ダメージ率を削る
  const ft = [0];
  for (let f = 1; kills[f * N + R] !== undefined; f++) ft.push(kills[f * N + R]);
  let score = 0;
  xs.forEach((x, i) => {
    if (skip[i]) return;
    const bs = at[i] + x.lag;
    let lv = ft.findIndex((t) => bs < t);
    if (lv < 0) lv = ft.length;
    const base = 50000 * Math.min(Math.floor((lv - 1) / 5) + 1, 5) * (x.boss === "Realm_boss" ? 1.2 : 1);
    const cut = x.play > 0 ? clamp((CHART_SEC - bs) / x.play, 0, 1) : 1;
    score += Math.ceil(base * clamp(x.rate, 0, 1) * cut);
  });
  return { score, at, skip };
}

// details から遅れに弱い撃破を計算して critMap に入れる（fetchDetail で details が更新されたときだけ呼ぶ）
function critUpdate() {
  critMap = new Map();
  const dmap = detailIndex();
  if (!dmap.size) return;
  const xs = [];
  const players = new Map();
  for (const [key, d] of dmap) {
    const pi = Number(key.split(":")[0]);
    if (!players.has(pi)) players.set(pi, []);
    players.get(pi).push(xs.length);
    xs.push({
      key, pi, push: d.push_start, lag: d.battle_start - d.push_start, play: d.play_time,
      boss: d.action, rate: Number(d.score_rate), level: d.level, end: d.battle_end,
      b: BOSSES.indexOf(d.action), k: critKey(d.level, d.action),
    });
  }
  const byPlayer = [...players.values()].map((l) => l.sort((a, b) => xs[a].push - xs[b].push));
  // 作戦上の撃破: 階層・ボスごとに最も早い battle_end。同着が複数なら 1 つ遅れても撃破は変わらない
  const planned = [], killers = [];
  xs.forEach((x, i) => {
    if (planned[x.k] === undefined || x.end < planned[x.k]) { planned[x.k] = x.end; killers[x.k] = [i]; }
    else if (x.end === planned[x.k]) killers[x.k].push(i);
  });
  const base = critRun(xs, byPlayer, planned, null, 0);
  for (const ids of killers) {
    if (!ids || ids.length !== 1) continue;
    const res = CRIT_DELAYS.map((dt) => critRun(xs, byPlayer, planned, ids[0], dt));
    critMap.set(xs[ids[0]].key, {
      loss: res.map((r) => Math.max(0, base.score - r.score)),
      moved: res.map((r) => r.at.filter((t, i) => t !== base.at[i] || r.skip[i] !== base.skip[i]).length),
    });
  }
  // 目立たせる強さ: 最大の減点の半分以上なら 2、減点があれば 1
  const max = Math.max(0, ...[...critMap.values()].map((c) => c.loss[0]));
  for (const c of critMap.values()) c.rank = c.loss[0] <= 0 ? 0 : c.loss[0] * 2 >= max ? 2 : 1;
}

// ブロックの class に足す名前
function critClass(key) {
  const c = critShow && critMap.get(key);
  return c && c.rank ? ` crit crit-${c.rank}` : "";
}

// ブロックの title と選択パネルに出す説明
function critText(key) {
  const c = critMap.get(key);
  if (!c) return null;
  if (!c.loss.some((v) => v > 0)) return `撃破: ${CRIT_DELAYS[CRIT_DELAYS.length - 1]}秒遅れても予定スコアは変わりません`;
  return "撃破が遅れると: " + CRIT_DELAYS.map((dt, i) => `${dt}秒で −${fmt(c.loss[i])}（出撃 ${c.moved[i]} 回がずれる）`).join("、");
}

// スタッツの「遅れに弱い撃破」。減点の大きい順に CRIT_TOP 件
const CRIT_TOP = 10;
function critStatsSection() {
  const rows = [...critMap].filter(([, c]) => c.loss[0] > 0).sort((x, y) => y[1].loss[0] - x[1].loss[0] || y[1].loss[1] - x[1].loss[1]);
  if (!rows.length) return null;
  const dmap = detailIndex();
  return h("section", {},
    h("h3", {}, "クリティカルパス"),
    h("p", { class: "hint" }, `この戦闘の撃破が ${CRIT_DELAYS[0]} 秒遅れたとき、後の出撃が進行管理と同じ規則でずれて予定スコアが減る順です。作戦の余裕を厚くする候補になります。`),
    h("ul", { class: "stats-list" }, rows.slice(0, CRIT_TOP).map(([key, c]) => {
      const [pi, ai] = key.split(":").map(Number);
      const p = state.players[pi], d = dmap.get(key);
      return h("li", {}, h("button", { type: "button", class: "link", onclick: () => statsJump({ pi, ai }) },
        `${p.name || p.id}  ${clock(d.battle_start)}–${clock(d.battle_end)}  Lv${d.level} ${BOSS_LABEL[d.action]}`),
      `  ${CRIT_DELAYS.map((dt, i) => `${dt}秒 −${fmt(c.loss[i])}`).join(" / ")}`);
    })));
}
