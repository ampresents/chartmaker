"use strict";
// エディタ (app.js) と進捗管理 (tracker.js) で共有する定数。ChartLib.py の同名の定数と揃える。

const BOSSES = ["1st_boss", "2nd_boss", "3rd_boss", "Realm_boss"];
const BOSS_LABEL = { "1st_boss": "1st", "2nd_boss": "2nd", "3rd_boss": "3rd", "Realm_boss": "Realm" };
const COOL_TIME = 300;     // 出撃からクールタイム明けまで (timelag を除く)
const CHART_SEC = 3600;    // 表示する時間
