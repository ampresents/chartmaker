# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

chartmaker renders a raid timeline chart as a PNG: one column per player, one pixel per second over a 60-minute window. It shows each boss battle, the 5-minute cooldown, the floor level, and the expected score. All logic lives in `ChartLib.py`. `time_chart.ipynb` is the driver. There is no build system or linter. `tests/` holds a pytest suite (see Tests). `requirements.txt` lists the dependencies for the browser GUI (see below).

## Running

Run the notebook cell in `time_chart.ipynb`. It uses Python 3.10. The equivalent code is:

```python
import json
from ChartLib import generate_chart
generate_chart("./src/<name>.txt", "./output/<name>.png", json.load(open("config.json")))
```

- Run it from the repo root. `ChartLib` defines `BASE_DIR` as its own directory (`app.py` imports it from there), and every asset path (fonts, images, logo) is `BASE_DIR` + a path that starts with `/`.
- `src/` (input schedules) and `output/` are not tracked by git, so create them locally. `output/` is only the destination of the notebook's PNGs.
- Dependencies: `opencv-python`, `numpy`, `Pillow`. Pillow is pinned to the major version the golden images were checked with (`>=12,<13`). Text width uses `textbbox(...)[2]`, which equals the old `textsize` width, so the output matches Pillow 9.5 pixel for pixel. OpenCV must be **< 5**: OpenCV 5 replaced the Hershey fonts in `putText` and ignores `thickness`, which changes the typeface and removes the text outlines (the thick `bgcolor` underlay).

## Tests (`tests/`)

```sh
.venv/Scripts/pip install -r requirements-dev.txt
.venv/Scripts/python -m pytest
```

- `test_chartlib.py`: `parse`, `calc_level` (floor rules, timelag/cooldown, the push-at-0 quirk), the score formula, `format_clock`, and `layout_time_labels`.
- `test_app.py`: the Flask API through the test client, including the tracker's kill/undo rules (409s) and the Discord notify/clear/pause/discard flow (`send_discord` and `delete_discord` are monkeypatched, so nothing reaches Discord). It imports `app` with `STORE` and `PLAN_BUCKET` unset, so it uses `MemoryStore` and saves nothing.
- `test_store.py`: version bumps, the 24h expiry (never extended), `CachedStore` reuse, and `delete`.
- `test_chart_image.py` renders `tests/fixtures/plan_full.txt` (all display flags, short and long battles, rates < 1, 11 floors) and `plan_plain.txt` (no flags, `display_remaining`), and compares them with `tests/golden/*.png` pixel for pixel. On a mismatch, it writes the actual image and a copy with the differing pixels painted red to pytest's tmp dir. After an intended drawing change, check the images by eye, then run with `UPDATE_GOLDEN=1` to rewrite the goldens. Run this test before bumping Pillow or OpenCV.
- The fixtures use fictional players. Never put real plans from `src/` (real player names) into `tests/`.
- `tests/` and `requirements-dev.txt` are excluded from the container (`.dockerignore`).

## Browser GUI (`app.py` + `web/`)

```sh
py -3.11 -m venv .venv
.venv/Scripts/pip install -r requirements.txt
.venv/Scripts/python app.py        # http://127.0.0.1:5000 (override with PORT)
```

- `app.py` is a thin, stateless Flask wrapper. It never modifies ChartLib's behaviour. Endpoints:
  - `GET /logo.png` serves the root `logo.png` for the GUI header. It is the same file as config.json's `logo_image`, which is drawn into the chart.
  - `GET /icon.png` serves the root `icon.png` as the browser-tab favicon. The page title is "ChartMaker".
  - `GET /image/<name>` serves a boss icon from `image/`, for the GUI thumbnails.
  - `GET /api/site` returns `{support_url}` from the `SUPPORT_URL` env var (only `https://` URLs; otherwise empty). `web/common.js` fetches it and unhides the `#support-link` ("♡ 開発を支援", the donation link) in the editor and tracker headers.
  - `GET /api/config` returns config.json and the list of `image/*.png` (as `/image/<name>` paths).
  - `POST /api/parse {text}` returns `ChartLib.parse`.
  - `POST /api/detail {text}` returns `generate_detail`, which the GUI uses for Lv/score.
  - `POST /api/render {text}` writes the txt to a temp dir and calls `generate_chart`, returning a PNG. When `PLAN_BUCKET` is set, it then saves the txt to that Cloud Storage bucket as `plans/YYYYMMDD_<seq>_<Max>_<Est>.txt` (`archive.py`; JST date, a 3-digit sequence per day, the chart footer's Max/Est totals). A failed save is only logged. Without `PLAN_BUCKET` (local runs) nothing is saved.
  - Validation errors are returned as 400 `{error}`.
- `web/app.js` (vanilla JS, no build step) stores each action as an absolute start second. It converts back to relative `wait_seconds` in `toText()`, and the output must stay parseable by the unchanged `parse`.
- Shared constants: `ChartLib.py` defines `BOSSES`, `REGULAR_BOSSES`, `IMAGE_KEYS`, `COOL_TIME` and `MAX_PLAYERS`, and `app.py` imports them. The browser side cannot import Python, so `web/common.js` mirrors `BOSSES`, `BOSS_LABEL`, `COOL_TIME` and `CHART_SEC` and is loaded before `app.js` and `tracker.js`. Keep the two in sync. Top-level `const`s in these classic scripts share one scope, so never redeclare a `common.js` name.
- Image file names are internal and are never shown in the UI. In the settings panel, each boss's current image appears as a thumbnail only. Clicking it opens a thumbnail grid (`openImagePicker`) that has no file names, tooltips, or filter. The thumbnails imitate the chart: CSS `object-fit: cover` crops the centre square, and the background shows the boss element color, or `icon_bgcolor` if it is set.
- Each timeline block shows at most 3 lines, so it still fits at the smallest zoom (0.15 px/sec, a block about 45 px tall). Line 1 is the battle's start–end time in bold. Line 2 is the boss, the battle seconds, and the rate when it is below 100%. Line 3 is the Lv and score from `/api/detail`.
- Saved files are named after today's date: `YYYYMMDD.txt` from the text panel and `YYYYMMDD.png` from the image preview (`dateStem()`).
- Undo/redo (Ctrl+Z / Ctrl+Y) keeps state snapshots. The working state is autosaved to `localStorage` in the browser only.
- Changing a block's boss without the settings panel: right-click a block to rotate it 1st → 2nd → 3rd → Realm → 1st, or press `1`–`4` with a block selected to set it directly. Each change is one undo step.
- `↑`/`↓` move the selected block by 1 s (`Shift` = 10 s) through `slideTo`, so pushes and locks behave as in a drag (`nudge`). Presses on the same block less than 1 s apart, with no other change in between, merge into one undo step. A press that moves nothing is ignored.
- Multi-select (stage 1):
  - `Ctrl`+click adds or removes a block. `Shift`+click selects a range in the anchor's column; in another column it selects the block alone. `Esc` or pointerdown on an empty column area clears the selection. A plain click or drag selects one block.
  - State: `multi` holds `[{p, a}]` only when 2+ blocks are selected. `selection` stays a block, which is the Shift anchor. Always change the selection through `setSelection`, and read it through `selectedBlocks()`.
  - Boss changes (1–4 keys, right-click, panel), lock (`L` locks all if any is unlocked, otherwise unlocks all), battle seconds, rate, and delete apply to every selected block. Empty "混在" (mixed) fields are ignored.
  - Group move (`shiftSelected`): dragging a selected block or pressing `↑`/`↓` shifts every selected block by the same seconds, keeping their spacing, and pushes unselected blocks like `slideTo`. The shift is clamped so that no selected block passes a lock or the chart edge (one stopping stops all), and a selection that contains a locked block does not move. Releasing a selected block without moving selects it alone. The panel hides the start/wait inputs while several blocks are selected.
- Timeline drag works like a sliding puzzle. A block moves alone through gaps and pushes touching neighbours. Pushed blocks stay where they were pushed.
- A block can be locked (`L` key or the checkbox in the side panel; shown with 🔒 and a dashed border). `slideTo` never moves a locked block, and pushes stop in front of it. The GUI state holds it as `locked: true` on the action. `toText()` writes it as a `#lock` comment line right after the locked action line, so `parse` ignores it and the chart is unchanged. `importText` reads it back from the raw text with `lockedInText` (because `/api/parse` drops comments): a `#lock` line locks the most recent action line, counted per player in the same way as `parse`. `setTimelag` still shifts locked blocks, because it keeps every wait_seconds.
- Share URL (`共有URL` button, `copyShareUrl`): `toText()` is compressed with `CompressionStream("deflate-raw")`, base64url-encoded, and put in the hash as `/#plan=<code>`. The hash never reaches the server, so the server stays stateless and stores nothing. On load (and on `hashchange`), `loadSharedPlan` removes the hash with `history.replaceState`, decodes it, and imports it through `importText` (one undo step). It asks for confirmation first only when the current draft has battles and differs from the shared plan. A broken code shows an error in `#status`.
- The plan is to deploy publicly on Google Cloud (Cloud Run with gunicorn). Keep the server stateless.

## Progress tracker (`/tracker`, `web/tracker.*`, `store.py`)

It replaces the old in-game app that read `cleartime.json` and `detail.json`. Operators press a kill button for each boss, and every device showing the same URL stays in sync.

- The editor's 進行管理 ("progress management") button hands the current `toText()` to `/tracker` through `localStorage` (`chartmaker.tracker.text`). The setup screen reads the date and `::start_time`, then calls `POST /api/sessions {text, start_epoch_ms}` and navigates to `/tracker/<id>`. The random 128-bit id is the only access control.
- The server builds the plan once: `cleartime` comes from `calc_level` (index = floor; index 0 is the sentinel; trailing empty floors are trimmed), and `detail` is a trimmed `generate_detail`. Boss images that don't exist locally are dropped, because `validate(..., check_images=False)` skips the image check.
- Endpoints:
  - `GET /api/sessions/<id>?since=<version>` returns only `{version, server_now}` when nothing has changed. Clients poll every second and use `server_now` to correct their clock.
  - `POST .../kill {floor, boss}` and `POST .../undo {count}` are validated on the server with the `calc_level` rules: floor = 1 + Realm kills, and Realm is allowed only after 1st/2nd/3rd are killed on that floor. A stale or duplicate press returns 409.
  - `DELETE /api/sessions/<id>` discards the session (see below). `POST .../notify`, `.../notify/clear` and `.../notify/pause` belong to the Discord reminder (see below).
- `store.py`: `MemoryStore` is the default and is lost on restart. Sessions expire 24h after creation and are never extended. `get`/`update` (and `CachedStore` hits) check `expired()` and raise `NotFound`, because Firestore's TTL deletion can lag by up to a day. With `STORE=firestore`, `FirestoreStore` is used (collection `tracker_sessions`, updates in a transaction) so that several Cloud Run instances share the state. `delete` removes the doc (in a transaction for Firestore; `CachedStore` drops its cache entry) and returns the removed doc.
- `DELETE /api/sessions/<id>` (the header's セッションを破棄 button, with a confirm) discards the session: `store.delete` removes the doc and returns it, and the server then deletes any Discord messages still in `messages`. Every other device gets 404 on its next poll and `endSession` hides the board, stops the render tick and sends no more notify requests. If a session is discarded while `notify` is sending, the `remember` update raises `NotFound` and the just-sent message is deleted at once.
- There is deliberately no list API (the id is the only access control). `deploy/list_sessions.py` lists sessions straight from Firestore for the admin (`PROJECT=<id>`, needs `gcloud auth application-default login`; `--all` includes expired ones, `--url=` prints tracker URLs). `deploy/` is excluded from the container.
- 挑戦中 (fighting) and 次に出撃 (next to sortie) follow the kill buttons, not the clock. `schedule()` in `tracker.js` replays each player's battles in plan order. Each battle's actual sortie time is the latest of these:
  - its planned `push_start`
  - the previous battle's actual push + timelag + 300 (the cooldown)
  - the kill time of the previous battle's boss
  - the time its own boss opened: the floor was reached (the previous floor's Realm kill), and for Realm, all 3 regular bosses on that floor were killed

  It uses the `level` field in `detail` to know the floor, so a delay carries over to every later battle. A battle stays 挑戦中 until its boss's kill button is pressed, and shows `N秒 超過` (N s over) once it passes its planned duration. A battle whose sortie time has passed but whose gate is still closed shows 待機中 (waiting) in 次に出撃. A battle whose boss was killed before it sortied is skipped. 次に出撃 shows only one entry per player and leaves out players who are fighting.
- "作戦との差" (difference from the plan) is the larger of: the last kill's delay against `cleartime[floor][boss]`, and the overdue time of any pending boss on the current floor. Late is red and early is green. The score is the sum of `est_score` over battles with `battle_end <= now`.
- Quirk inherited from `calc_level`: a regular-boss battle with `push_start == 0` is not counted toward 1F (`push_start > clear_time[0]["Realm_boss"]`), so a plan whose first pushes are at second 0 shows "作戦に予定なし" ("not in the plan") for 1F.
- Discord reminder (optional, read aloud or plain text): the setup screen takes a Discord webhook URL, a lead time (`notify_lead`, 5–120 s, default 30) and a 読み上げる (TTS) checkbox (`notify_tts`, bool, default true). The URL and the checkbox are remembered in localStorage (`chartmaker.tracker.webhook`, `chartmaker.tracker.tts`). Text-to-speech is done by the Discord clients, not the server: the message is sent with `tts: discord.tts`, so turning it off sends the same text as a plain message. Sessions created before the option have no `tts` key and still read aloud.
  - `POST /api/sessions` accepts only URLs matching `DISCORD_WEBHOOK` (SSRF guard), else 400. The webhook is stored at the doc top level (`discord = {webhook, lead, tts}`, `notified = []`), never inside `plan`, so `GET` does not leak it. `plan.notify_lead` holds only the seconds and `plan.notify_tts` the flag (both null when off); the board header shows which mode is on.
  - The server has no timers (min-instances=0). `notifyUpcoming` in `tracker.js` fires once any `upcoming` battle not yet sent by this tab (`notifySent`) has `at - now <= notify_lead`. It then POSTs `.../notify {battles}` (`plan.detail` indexes) for every such battle with `at - now <= notify_lead + NOTIFY_GROUP` (5 s), so players sortieing together are called in one message. It ignores `known`: `at` is then the earliest possible sortie (the plan time and cooldown, ignoring unresolved kill/floor gates), so the call goes out on schedule even if the current boss is still alive. The server records the indexes in `notified` inside the transaction, so every open device may ask but each battle is announced once (`sent` lists the newly announced ones; up to `MAX_NOTIFY_BATTLES`; any bad index is a 400). No notifications if nobody has the tracker open.
  - `send_discord` (urllib, 5 s timeout) runs after the transaction. A failure is only logged and never retried. The message is `<name>、<name>、準備して下さい` (the newly announced battles' names, deduplicated) with `allowed_mentions: {parse: []}`, so a name containing `@everyone` pings no one. 409 without a webhook.
  - The message is deleted again so the channel log doesn't fill up. `send_discord` posts with `?wait=true` and returns the message id, which a second `store.update` saves in `messages[str(battle)] = {id, at}` for each battle in the group (same id). Once the battle leaves `upcoming` (its sortie time, so the speech has finished), `notifyUpcoming` POSTs `.../notify/clear {battle}` once per tab (`notifyCleared`). The server pops every entry with that battle's message id (a grouped message goes when its first battle sorties) plus any older than `MESSAGE_KEEP` (max lead + 60 s, a sweep for missed clears) in a transaction, then calls `delete_discord` (`DELETE {webhook}/messages/{id}`; failures are only logged). It checks `store.get` first and skips the write when there is nothing to delete, because every `update` bumps `version`. Deletion also needs an open tracker.
  - Pause: the board header's 通知を止める / 通知を再開 button (confirm only when stopping) POSTs `.../notify/pause {paused}` (409 without a webhook), which sets the doc's top-level `notify_paused` for every device; the full `GET` returns it. While paused, `notifyUpcoming` sends nothing (clears still run), and the server's `notify` returns `sent: []` without recording `notified`, so after resuming, battles still `upcoming` within the lead are announced.
  - Discord-side limits: only users viewing that channel in the desktop client hear it, and each must allow /tts playback (User Settings → Accessibility → Text-to-speech). Mobile does not read it aloud.

## Deploying to Cloud Run (`Dockerfile`, `deploy/`)

Run these from the repo root in Git Bash, with `PROJECT=<id>` set:
- `deploy/setup.sh` runs once. It enables the APIs, creates Firestore with a TTL on `expire_at`, and creates the `chartmaker-run` service account with `roles/datastore.user`. It also creates the plan bucket (`PLAN_BUCKET`, default `chartmaker-output`) if missing and grants the service account only list + create on it (`objectViewer`, `objectCreator`), so the app cannot overwrite or delete saved plans.
- `.gcloudignore` only does `#!include:.dockerignore`, so edit the exclusions in `.dockerignore`.
- `deploy/deploy.sh` runs `gcloud run deploy --source .`. It uses `--max-instances` (default 1, which is the main cost cap), `--min-instances=0`, `--concurrency=32`, `STORE=firestore`, and `PLAN_BUCKET` (default `chartmaker-output`; `PLAN_BUCKET=` disables saving), and `SUPPORT_URL` (default the OFUSE page; `SUPPORT_URL=` hides the link). The env vars are passed with gcloud's `^@^` delimiter so a URL may contain commas. It also sets an Artifact Registry cleanup policy (keep the 2 newest images) and a lifecycle rule that deletes the uploaded source zips in `gs://run-sources-<project>-<region>` after 7 days.
- `deploy/budget.sh` creates a budget (default `BUDGET=1000JPY`) that publishes to Pub/Sub topic `billing-alerts`. The `stop-billing` function (`deploy/billing_guard/`) unlinks the project's billing account once cost exceeds the budget. Set `DRY_RUN=1` to deploy it in log-only mode.

The cost guards inside the app are per-process:
- `RateLimiter` limits requests per IP (`LIMIT_*` in `app.py`). On Cloud Run the client IP is the last `X-Forwarded-For` entry.
- `render_slots` caps concurrent renders at 2, and returns 503 after a 20 s wait.
- `CachedStore` reuses a Firestore `get` for 1 s, so tracker polling costs about 1 read per second per session per instance, instead of 1 per client.

gunicorn runs 1 worker × 16 threads, so these guards share one process.

## Input schedule format (`src/*.txt`, parsed by `parse`)

- A line starting with `#` is a comment.
- `::key=value` defines a constant. A bare `::key` sets that key to `None`, which is how the presence-only flags are turned on. Constants are merged over `config.json` (`setting = dict(config, **constants)`). Values stay strings, so numbers like `::timelag=3` are converted with `int()` at the point of use. Constants the chart relies on:
  - `::1st_boss=`, `::2nd_boss=`, `::3rd_boss=`, `::Realm_boss=` set each boss's element color (`blue`, `red`, `green`, `yellow`, or `white`). These are required because `setting[action]` is looked up for every battle.
  - The flags `display_party`, `display_boss`, `display_team`, and `display_remaining` are checked by presence only. `display_remaining` makes the per-battle time labels show the time left in the 60 minutes instead of the elapsed time. `format_clock` renders it, and shows `-mm:ss` past the end. The GUI's `clock()` mirrors this, including the timeline axis and the push-time input.
  - `image_1st`, `image_2nd`, `image_3rd`, and `image_realm` give the boss icon paths used when `display_boss` is set, for example `/image/LI_4002011.png`. The images can be any size or aspect ratio: `load_boss_icon` crops the centre square and resizes it to 100×100, keeping the alpha channel (premultiplied, so edges don't darken). `flatten_boss_icon` composites the icon over the chart already drawn beneath it, so transparent areas show the battle's boss color down to `battle_end` and the cooldown gray (or the score-rate checkerboard) below that. The optional `::icon_bgcolor=<color_table name>` instead fills transparent areas with a single color for every icon.
  - `::<player_id>=<display name>` sets a player's display name.
  - `::start_time=HH:MM` is the game's local start time, used only by the progress tracker. ChartLib ignores it, and the PNG is unchanged.
- An action line has the form `player_id,wait_seconds,boss,battle_seconds[,score_rate]`.
  - `boss` must be one of `1st_boss`, `2nd_boss`, `3rd_boss`, or `Realm_boss`.
  - `wait_seconds` is added to that player's running clock before the push. Each push then advances the clock by `timelag + 300` (the cooldown).
  - `score_rate` defaults to `1.0`. A value below 1 draws a checkered pattern and a percentage on the battle.
  - A player ID has the form `<Team><2 chars>`, for example `Alpha01`. The team name is `raw_name[:-2]`, and team colors come from `config.json` → `team.team_color`.

## Architecture (`ChartLib.py`)

The pipeline is `generate_chart` → `parse` → `generate_detail` → `calc_level`, then drawing.

- `calc_level` simulates floor progression. The three regular bosses must be cleared on the current floor before a `Realm_boss` clear advances to the next floor. It returns the clear time of each floor. `generate_detail` uses these times to assign each battle its `level`, and the level sets the score: `50000 * min((floor-1)//5+1, 5)`, times 1.2 for the Realm boss.
- Drawing happens in layers, all from one `generate_detail` result:
  1. OpenCV draws the battle and cooldown blocks behind the grid.
  2. OpenCV draws the grid and time labels.
  3. OpenCV draws the text labels in front of the grid.
  4. The image is converted to PIL for the Japanese-capable text (player and team names, the comment, in `font/NotoSansJP-Regular.otf`, SIL OFL 1.1, license in `font/OFL.txt`).
  5. The image is converted back to OpenCV for the party dots and the logo.
- The y positions of the time labels (battle start, battle end, `Nsec` duration, re-sortie time) come from `layout_time_labels`. For each player column it spreads the labels apart so they keep a minimum spacing while moving as little as possible from their default positions (least squares). This stops labels overlapping when a battle is very short or when blocks sit right next to each other.
- Layout constants are hardcoded. Columns are 246 px wide starting at x=120, with a maximum of `MAX_PLAYERS` (20) players. `margin_top` is 160, and y = seconds + `margin_top`. The score footer is at y≈3840–3980.
- All colors in `config.json` are in **BGR** order, because the arrays are OpenCV arrays and the PIL fills are written straight into them.
- Many draw calls read `config[...]` instead of `setting[...]`. A `::` constant in the txt file overrides only the keys read through `setting`: timelag, boss colors, the display flags, images, fonts, the comment, and the logo.
