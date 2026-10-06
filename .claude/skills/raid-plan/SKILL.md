---
name: raid-plan
description: レイドの作戦 (60 分のタイムチャート用 txt) を作る・直す・評価する。「作戦を作って」「この作戦のスコアを上げて」「この txt を検証して」のように、プレイヤーの強さや要望から出撃の順番と時刻を決めるときに使う。
---

# レイド作戦の作成

プレイヤーの強さと要望から、ChartMaker で読める作戦 txt を作る。
作戦は手で暗算せず、必ず `scripts/simulate.py` で検証してから出す。

## 最初に読むもの

- [references/rules.md](references/rules.md): ゲームのルール (階層の進み方、クールタイム、出撃の制約)
- [references/scoring.md](references/scoring.md): 得点の計算方法
- [references/strategy.md](references/strategy.md): 作戦の作り方と定石
- [references/format.md](references/format.md): txt の書式
- [examples/](examples/): 作戦の例 (架空のプレイヤー)

<!-- TODO: 毎回必ず読ませたいものと、必要なときだけ読ませるものを分ける -->

## 手順

1. **要望を整理する。** 次がそろっているか確かめ、足りなければユーザーに聞く。
   - 参加プレイヤー (ID と表示名、最大 20 人)
   - 各プレイヤーの強さ (ボスと階層ごとの戦闘秒数、倒し切れない場合の割合)
   - Realm を担当できる範囲
   - ボスの属性色 (`::1st_boss=` など)
   - そのほかの要望 (「最後の 5 分は空ける」など)
   <!-- TODO: 強さの入力形式を決める (表、CSV、言葉) -->
2. **骨組みを作る。** strategy.md の定石に沿って、各階の撃破役と稼ぎ役を決める。
3. **txt に書き出す。** 書式は format.md のとおり。作業用ファイルは scratchpad に置く。
4. **検証する。**
   ```sh
   python .claude/skills/raid-plan/scripts/simulate.py <plan.txt>
   ```
   - `ERROR` が 0 件になるまで直す。
   - `WARN` (範囲外、階層 0 の戦闘) は原則なくす。
   - 「空き」(300 秒以上何もしない時間) は、戦闘を足せないか考える。
5. **改善する。** スコアが上がる変更を試し、そのたびに simulate.py で比べる。
   <!-- TODO: 何回まで試すか、どこで打ち切るか -->
6. **出力する。** 完成した txt と、simulate.py の要約 (予定スコア、到達 Lv、各階の撃破時刻) を見せる。
   保存先を聞かれたら `src/<名前>.txt` に置く (git 管理外)。

## 守ること

- スコアや階層は simulate.py の結果だけを根拠にする。自分で計算した値を出さない。
- simulate.py の規則と references の記述が食い違ったら、ユーザーに確認する。
- 例やテストには架空のプレイヤー名を使う。`src/` の実在の作戦を `tests/` や examples に入れない。
<!-- TODO: そのほかの禁止事項や好み -->
