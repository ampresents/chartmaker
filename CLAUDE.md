# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

chartmaker renders a raid timeline chart as a PNG: one column per player, one pixel per second over a 60-minute window. It shows each boss battle, the 5-minute cooldown, the floor level, and the expected score. All logic lives in `ChartLib.py`. `time_chart.ipynb` is the driver. There is no build system, test suite, or linter. `requirements.txt` lists the dependencies for the browser GUI (see below).

## Running

Run the notebook cell in `time_chart.ipynb`. It uses Python 3.10. The equivalent code is:

```python
import json
from ChartLib import generate_chart
generate_chart("./src/<name>.txt", "./output/<name>.png", json.load(open("config.json")))
```

- Run it from the repo root. `ChartLib` imports `BASE_DIR` from `mysite/settings.py`, and every asset path (fonts, images, logo) is `BASE_DIR` + a path that starts with `/`.
- `src/` (input schedules) and `output/` are not tracked by git, so create them locally. `output/` must exist: `generate_detail` also writes `output/cleartime.json` and `output/detail.json` there as debug dumps.
- Dependencies: `opencv-python`, `numpy`, `Pillow`. Pillow must be **< 10** because the code calls `ImageDraw.textsize`, which was removed in Pillow 10. OpenCV must be **< 5**: OpenCV 5 replaced the Hershey fonts in `putText` and ignores `thickness`, which changes the typeface and removes the text outlines (the thick `bgcolor` underlay).
- `mysite/` holds only a leftover Django `settings.py` (the site ran at chartmaker.shop). There is no Django app in this repo. Only `BASE_DIR` is used.

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
  - `GET /api/config` returns config.json and the list of `image/*.png` (as `/image/<name>` paths).
  - `POST /api/parse {text}` returns `ChartLib.parse`.
  - `POST /api/detail {text}` returns `generate_detail`, which the GUI uses for Lv/score.
  - `POST /api/render {text}` writes the txt to a temp dir and calls `generate_chart`, returning a PNG.
  - Validation errors are returned as 400 `{error}`.
- `web/app.js` (vanilla JS, no build step) stores each action as an absolute start second. It converts back to relative `wait_seconds` in `toText()`, and the output must stay parseable by the unchanged `parse`.
- Image file names are internal and are never shown in the UI. In the settings panel, each boss's current image appears as a thumbnail only. Clicking it opens a thumbnail grid (`openImagePicker`) that has no file names, tooltips, or filter. The thumbnails imitate the chart: CSS `object-fit: cover` crops the centre square, and the background shows the boss element color, or `icon_bgcolor` if it is set.
- Each timeline block shows at most 3 lines, so it still fits at the smallest zoom (0.15 px/sec, a block about 45 px tall). Line 1 is the battle's start–end time in bold. Line 2 is the boss, the battle seconds, and the rate when it is below 100%. Line 3 is the Lv and score from `/api/detail`.
- Saved files are named after today's date: `YYYYMMDD.txt` from the text panel and `YYYYMMDD.png` from the image preview (`dateStem()`).
- Undo/redo (Ctrl+Z / Ctrl+Y) keeps state snapshots. The working state is autosaved to `localStorage` in the browser only.
- Timeline drag works like a sliding puzzle. A block moves alone through gaps and pushes touching neighbours. Pushed blocks stay where they were pushed.
- The plan is to deploy publicly on Google Cloud (Cloud Run with gunicorn). Keep the server stateless.

## Progress tracker (`/tracker`, `web/tracker.*`, `store.py`)

It replaces the old in-game app that read `cleartime.json` and `detail.json`. Operators press a kill button for each boss, and every device showing the same URL stays in sync.

- The editor's 進捗管理 ("progress tracking") button hands the current `toText()` to `/tracker` through `localStorage` (`chartmaker.tracker.text`). The setup screen reads the date and `::start_time`, then calls `POST /api/sessions {text, start_epoch_ms}` and navigates to `/tracker/<id>`. The random 128-bit id is the only access control.
- The server builds the plan once: `cleartime` comes from `calc_level` (index = floor; index 0 is the sentinel; trailing empty floors are trimmed), and `detail` is a trimmed `generate_detail`. Boss images that don't exist locally are dropped, because `validate(..., check_images=False)` skips the image check.
- Endpoints:
  - `GET /api/sessions/<id>?since=<version>` returns only `{version, server_now}` when nothing has changed. Clients poll every second and use `server_now` to correct their clock.
  - `POST .../kill {floor, boss}` and `POST .../undo {count}` are validated on the server with the `calc_level` rules: floor = 1 + Realm kills, and Realm is allowed only after 1st/2nd/3rd are killed on that floor. A stale or duplicate press returns 409.
- `store.py`: `MemoryStore` is the default and is lost on restart. Sessions expire after 24h. With `STORE=firestore`, `FirestoreStore` is used (collection `tracker_sessions`, updates in a transaction) so that several Cloud Run instances share the state.
- 挑戦中 (fighting) and 次に出撃 (next to sortie) follow the kill buttons, not the clock. `schedule()` in `tracker.js` replays each player's battles in plan order. Each battle's actual sortie time is the latest of these:
  - its planned `push_start`
  - the previous battle's actual push + timelag + 300 (the cooldown)
  - the kill time of the previous battle's boss
  - the time its own boss opened: the floor was reached (the previous floor's Realm kill), and for Realm, all 3 regular bosses on that floor were killed

  It uses the `level` field in `detail` to know the floor, so a delay carries over to every later battle. A battle stays 挑戦中 until its boss's kill button is pressed, and shows `N秒 超過` (N s over) once it passes its planned duration. A battle whose sortie time has passed but whose gate is still closed shows 待機中 (waiting) in 次に出撃. A battle whose boss was killed before it sortied is skipped. 次に出撃 shows only one entry per player and leaves out players who are fighting.
- "作戦との差" (difference from the plan) is the larger of: the last kill's delay against `cleartime[floor][boss]`, and the overdue time of any pending boss on the current floor. Late is red and early is green. The score is the sum of `est_score` over battles with `battle_end <= now`.
- Quirk inherited from `calc_level`: a regular-boss battle with `push_start == 0` is not counted toward 1F (`push_start > clear_time[0]["Realm_boss"]`), so a plan whose first pushes are at second 0 shows "作戦に予定なし" ("not in the plan") for 1F.

## Deploying to Cloud Run (`Dockerfile`, `deploy/`)

Run these from the repo root in Git Bash, with `PROJECT=<id>` set:
- `deploy/setup.sh` runs once. It enables the APIs, creates Firestore with a TTL on `expire_at`, and creates the `chartmaker-run` service account with `roles/datastore.user`.
- `deploy/deploy.sh` runs `gcloud run deploy --source .`. It uses `--max-instances` (default 1, which is the main cost cap), `--min-instances=0`, `--concurrency=32`, and `STORE=firestore`. It also sets an Artifact Registry cleanup policy.
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
  - `image_1st`, `image_2nd`, `image_3rd`, and `image_realm` give the boss icon paths used when `display_boss` is set, for example `/image/LI_3009011.png`. The images can be any size or aspect ratio: `load_boss_icon` crops the centre square and resizes it to 100×100, keeping the alpha channel (premultiplied, so edges don't darken). `flatten_boss_icon` fills transparent areas with that battle's boss element color from `color_table`; the optional `::icon_bgcolor=<color_table name>` forces a single color for every icon.
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
- Drawing happens in layers, and `generate_detail` is called twice (once per pass):
  1. OpenCV draws the battle and cooldown blocks behind the grid.
  2. OpenCV draws the grid and time labels.
  3. OpenCV draws the text labels in front of the grid.
  4. The image is converted to PIL for the Japanese-capable text (player and team names, the comment, in `font/meiryo.ttc`).
  5. The image is converted back to OpenCV for the party dots and the logo.
- The y positions of the time labels (battle start, battle end, `Nsec` duration, re-sortie time) come from `layout_time_labels`. For each player column it spreads the labels apart so they keep a minimum spacing while moving as little as possible from their default positions (least squares). This stops labels overlapping when a battle is very short or when blocks sit right next to each other.
- Layout constants are hardcoded. Columns are 246 px wide starting at x=120, with a maximum of 20 players. `margin_top` is 160, and y = seconds + `margin_top`. The score footer is at y≈3840–3980.
- All colors in `config.json` are in **BGR** order, because the arrays are OpenCV arrays and the PIL fills are written straight into them.
- Many draw calls read `config[...]` instead of `setting[...]`. A `::` constant in the txt file overrides only the keys read through `setting`: timelag, boss colors, the display flags, images, fonts, the comment, and the logo.
