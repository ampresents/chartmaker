"use strict";
// エディタ (app.js) と進行管理 (tracker.js) で共有する定数。ChartLib.py の同名の定数と揃える。

const BOSSES = ["1st_boss", "2nd_boss", "3rd_boss", "Realm_boss"];
const BOSS_LABEL = { "1st_boss": "1st", "2nd_boss": "2nd", "3rd_boss": "3rd", "Realm_boss": "Realm" };
const COOL_TIME = 300;     // 出撃からクールタイム明けまで (timelag を除く)
const CHART_SEC = 3600;    // 表示する時間

// 支援 (寄付) ページへのリンク。サーバーに SUPPORT_URL が設定されているときだけ出す
(async () => {
  const link = document.getElementById("support-link");
  if (!link) return;
  try {
    const { support_url } = await (await fetch("/api/site")).json();
    if (support_url) {
      link.href = support_url;
      link.hidden = false;
    }
  } catch (e) {
    // 出せなくても他の機能には影響しないので無視する
  }
})();

// 「テキストを開く」で読んだファイルの中身から作戦の txt を取り出す。振り返りの JSON (review.js の保存形式) なら
// 中の text を返す。作戦テキストを含まない JSON や、知らない JSON は Error を投げる
function planTextOf(raw) {
  if (!/^\s*\{/.test(raw)) return raw;
  let data;
  try { data = JSON.parse(raw); } catch (e) { return raw; }
  if (data?.kind !== "chartmaker-review") throw new Error("ChartMaker の作戦テキストか振り返りの JSON を開いてください");
  if (typeof data.text !== "string") throw new Error("この振り返りの JSON には作戦テキストが含まれていません");
  return data.text;
}
