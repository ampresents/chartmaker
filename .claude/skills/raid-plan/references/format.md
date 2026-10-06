# 作戦 txt の書式

ChartMaker (`ChartLib.parse`) が読む形式。

```text
# コメント行 (# で始まる行は無視される)
::timelag=0
::1st_boss=blue
::2nd_boss=red
::3rd_boss=green
::Realm_boss=yellow
::display_party
::display_boss
::Alpha01=アリス
Alpha01,0,1st_boss,30
Alpha01,0,Realm_boss,280,0.6
```

## 定数 (`::key=value`)

- `::timelag=N`: 出撃から戦闘開始までの秒数。省略時は 0。
- `::1st_boss=` / `::2nd_boss=` / `::3rd_boss=` / `::Realm_boss=`: 各ボスの属性色。`blue` `red` `green` `yellow` `white` のどれか。**必須**。
- `::display_party` / `::display_boss` / `::display_team` / `::display_remaining`: 値なしで書くと表示が有効になる。
- `::<プレイヤーID>=<表示名>`: プレイヤーの表示名。
- `::start_time=HH:MM`: 開始時刻 (進行管理だけが使う)。

## 行動行

`プレイヤーID,待ち秒,ボス,戦闘秒[,割合]`

- **プレイヤーID**: `<チーム名><2 文字>` (例: `Alpha01`)。チーム名は末尾 2 文字を除いた部分。
- **待ち秒**: そのプレイヤーの前の出撃のクールタイム明け (最初の行は 0 秒) からの待ち。
  出撃時刻 = 前の出撃時刻 + timelag + 300 + 待ち秒。負にはできない。
- **ボス**: `1st_boss` `2nd_boss` `3rd_boss` `Realm_boss` のどれか。
- **戦闘秒**: 出撃してから戦闘が終わるまでの秒数 (timelag を除く)。
- **割合**: 0–1。省略時は 1.0 (倒し切る)。1 未満は、その割合だけ与えたものとして得点を数える。

同じプレイヤーの行は時刻順に並べる。プレイヤーどうしの行の順番は自由。

## コメントで書ける印 (グラフには影響しない)

- `#lock`: 直前の行動をロックする (エディタ用)。
- `#note <文>`: 直前の戦闘の注意点。
- `#note@<開始秒>-<終了秒> <文>`: 時間帯の注意点。定数の後、行動行の前に書く。
