"use strict";
// エディタ (app.js) と進捗管理 (tracker.js) で共有する定数。ChartLib.py の同名の定数と揃える。

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
