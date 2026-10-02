"use strict";
// エディタ (app.js) と進行管理 (tracker.js) で共有する定数。ChartLib.py の同名の定数と揃える。

const BOSSES = ["1st_boss", "2nd_boss", "3rd_boss", "Realm_boss"];
const BOSS_LABEL = { "1st_boss": "1st", "2nd_boss": "2nd", "3rd_boss": "3rd", "Realm_boss": "Realm" };
const COOL_TIME = 300;     // 出撃からクールタイム明けまで (timelag を除く)
const CHART_SEC = 3600;    // 表示する時間

// 支援 (寄付) ページへのリンクと広告。サーバーに SUPPORT_URL / ADSENSE_* が設定されているときだけ出す
(async () => {
  let site;
  try {
    site = await (await fetch("/api/site")).json();
  } catch (e) {
    return;  // 出せなくても他の機能には影響しないので無視する
  }
  const link = document.getElementById("support-link");
  if (link && site.support_url) {
    link.href = site.support_url;
    link.hidden = false;
  }
  showAds(site.ad_client, site.ad_slots || {});
})();

// 広告は .ad-box[data-ad=枠の名前] にだけ、高さを固定した 1 枠ずつ出す。
// 自動広告は使わない (タイムラインへの差し込みや全画面広告で操作の邪魔になるため。AdSense の管理画面でもオフにしておく)。
// 枠が見えていない (幅 0) か、画面の高さが足りないときは出さない
function showAds(client, slots) {
  if (!client) return;
  const boxes = [...document.querySelectorAll(".ad-box[data-ad]")].filter((box) => {
    if (!slots[box.dataset.ad]) return false;
    box.hidden = false;
    if (box.offsetWidth > 0 && window.innerHeight >= Number(box.dataset.minHeight || 0)) return true;
    box.hidden = true;
    return false;
  });
  if (!boxes.length) return;
  const script = document.createElement("script");
  script.async = true;
  script.crossOrigin = "anonymous";
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`;
  script.onerror = () => boxes.forEach((box) => { box.hidden = true; });  // 広告ブロッカーなど
  document.head.appendChild(script);
  for (const box of boxes) {
    const ins = document.createElement("ins");
    ins.className = "adsbygoogle";
    ins.dataset.adClient = client;
    ins.dataset.adSlot = slots[box.dataset.ad];
    ins.dataset.fullWidthResponsive = "false";
    box.appendChild(ins);
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) { box.hidden = true; }
  }
}
