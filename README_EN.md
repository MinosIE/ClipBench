# ClipBench

English | [简体中文](README.md)

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg) ![Python](https://img.shields.io/badge/python-3.10%2B-blue) ![ffmpeg](https://img.shields.io/badge/ffmpeg-required-orange) ![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)

**ClipBench** is a self-hosted **video processing toolbox** — an open-source **ffmpeg GUI** that gives you **video compression**, **hardsub / subtitle removal**, video transcoding, splitting, frame capture, cropping, merging, rotation, watermarking, speed change and **audio extraction** in a single local web app. Everything runs on your own machine; nothing is ever uploaded.

`video-compression` `subtitle-removal` `hardsub-remover` `ffmpeg-gui` `ffmpeg-wrapper` `video-transcoding` `video-cutter` `video-merger` `self-hosted` `local-video-editor` `flask` `solidjs`

- **Port:** `8080` (override with the `PORT` env var; 8080 avoids the 5000 port that macOS AirPlay Receiver occupies)
- **Stack:** Python 3.10+ / TypeScript
- **Getting started:** run `./start.sh` — it creates the venv, installs dependencies, builds the frontend and starts the server

---

## Features

| Module | Description | Options |
| --- | --- | --- |
| **De-subtitle** | Remove burned-in (hard) subtitles from a region | Mode: `delogo` (edge repair) / blur / mosaic / `inpaint` (content-aware); region: full row or custom top / bottom band. `inpaint` is CPU + IO heavy and runs serially through a mutex |
| **Split** | Split by fixed duration or custom segments; GIF output supported | Mode: by duration / by segments; segment timeline input; output: `video` (mp4) / `gif`; encode: `reencode` H.264 (default, forced keyframe at segment start to avoid black frames) / `copy` (fastest, lossless) |
| **Screenshot** | Capture a single frame or frames at a fixed interval | Timestamp / interval in seconds; output jpg / png / webp / avif |
| **Convert** | Convert between containers and codecs | Target: mp4 / mkv / webm / mov / avi / gif …; optional re-encode with CRF quality, audio toggle, `-movflags +faststart` for web playback |
| **Compress** | Shrink file size with **automatic source codec detection** | H.264 source → `libx264` + adaptive CRF; HEVC/H.265 source → `libx265` + adaptive CRF (preserves HDR10+ and `master-display` metadata); optional downscale (none / 1080p / 720p / 480p), `+faststart` |
| **Crop** | Drag a selection on the preview to crop | Free region, or fixed 16:9 / 9:16 / 1:1 / 4:3 |
| **Merge** | Concatenate 2 or more videos in order | Encode: H.264 (default, best compatibility) / HEVC (smaller) / `copy` (fastest, lossless — requires identical source parameters, validated client-side before any request) |
| **Rotate** | Rotate and flip, with live preview | 90° / 180° / 270° / horizontal flip / vertical flip |
| **Watermark** | Text or image watermark | Type: text / image (transparent PNG supported); 5 corner or center positions; font size, color, outline; image scale and opacity |
| **Speed** | Change playback speed 0.5x–4x, reverse supported | Speed (0.5–4.0, step 0.1); reverse toggle |
| **Audio extract** | Extract the audio track or transcode to pure audio | Format: mp3 / m4a / wav / flac; bitrate (128k / 192k / 320k for mp3 & m4a; wav & flac are lossless) |

### Output filename template

A global template at the bottom of the sidebar controls how every output file is named:

| Placeholder | Meaning | Example |
| --- | --- | --- |
| `{name}` | Source filename without extension | `demo` |
| `{ext}` | Extension including the dot | `.mp4` |
| `{ts}` | Unix timestamp | `1787801543` |
| `{date}` | Date | `20260827` |
| `{time}` | Time | `113200` |

Leave it empty to fall back to `{name}_{ts}{ext}` (e.g. `demo_1787801543.mp4`). Templates may contain non-ASCII text (e.g. `{name}_nosub{ext}`); only path traversal characters are stripped.

### Sending outputs back to the media list

Finished videos do **not** appear in the left media list automatically. For any finished task whose output is a **single video file**, the task card shows an **Add** button — click it and the file appears in the sidebar (tagged as an output) ready for further processing. The ✕ on a media card deletes that output file. Task cards also display output size, codec and resolution.

### Media info panel

The file detail card shows everything ffprobe detects:

- **Codec** as a readable tag (`H.264 (h264)` / `HEVC (hevc)`), so you can tell what you're feeding into compress / convert
- Resolution, duration, frame rate, bitrate, file size, and audio info (codec / channels / sample rate)

---

## Tech stack

- **Frontend:** SolidJS + Vite + TypeScript; fine-grained reactivity (`createStore`), inline SVG icons, single-page app without a router
- **Backend:** Flask, local filesystem storage, task list persisted in `tasks.json`
- **Media:** `ffmpeg` / `ffprobe` (system install preferred; falls back to the static binaries shipped with `imageio-ffmpeg`, so it works out of the box)
- **Content-aware repair:** OpenCV (`cv2.inpaint`) for the de-subtitle `inpaint` mode
- **Live progress:** Server-Sent Events (SSE) stream consumed via `EventSource`

---

## Quick start

```bash
git clone https://github.com/MinosIE/ClipBench.git
cd ClipBench
./start.sh          # venv + pip deps + pnpm build + start server
open http://localhost:8080
```

### Manual start (development)

```bash
# 1) Backend dependencies
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# 2) Frontend (dev server on 5173 with HMR)
pnpm install
pnpm dev            # or `pnpm build` for a production build into dist/

# 3) Start the backend (serves dist/ in production mode)
python app.py
```

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Port the server listens on |
| `FFMPEG_PATH` | auto-detect | Path to the ffmpeg executable |
| `FFPROBE_PATH` | auto-detect | Path to the ffprobe executable |
| `CLIPBENCH_FFMPEG_SLOTS` | half the logical cores (min 1) | Number of concurrent ffmpeg tasks; set to `1` to serialize |

---

## API overview

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/files` | List files with media info. Pass `?outputs=0` to exclude processing outputs |
| POST | `/api/upload` | Upload a media file (form field `file`; 4 GB per file limit) |
| POST | `/api/delete_uploads` | Batch delete uploaded files by name (path traversal safe) |
| POST | `/api/desubtitle` | Remove hard subs: `{file_id, mode, x, y, w, h, quality?, radius?, strength?}` — `mode`: `delogo` / `blur` / `mosaic` / `inpaint` |
| POST | `/api/split` | Split: `{file_id, mode, segment?, segments?, start?, end?, output?, encode?, mute?, gif_fps?, gif_width?}` — `mode`: `segment` / `time`; `output`: `video` / `gif`; `encode`: `reencode` (default) / `copy` |
| POST | `/api/screenshot` | Capture frames: `{file_id, mode, time?, interval?, format?}` — `mode`: `single` / `every`; `format`: jpg / png / webp / avif |
| POST | `/api/convert` | Transcode: `{file_id, target, crf?, vcodec?, faststart?}` — `target`: mp4 / mkv / webm / mov / avi / gif … (gif / webm, or passing `crf`, forces re-encode) |
| POST | `/api/compress` | Compress: `{file_id, preset?, crf?, scale?, vcodec?, faststart?}` — picks x264/x265 automatically; `preset`: veryslow → veryfast; `scale`: original / 1080 / 720 / 480; `vcodec`: h264 / hevc |
| POST | `/api/compress_suggest` | Compression advice: `{file_id, vcodec}` → recommended CRF, resolution and estimated size (the single source of truth for the UI suggestions) |
| POST | `/api/crop` | Crop: `{file_id, x, y, w, h, faststart?}` |
| POST | `/api/merge` | Merge: `{file_ids, encode?, faststart?}` (≥ 2 files) — `encode`: `h264` (default) / `hevc` / `copy` (requires identical source parameters) |
| POST | `/api/rotate` | Rotate / flip: `{file_id, rotation, flip_h?, flip_v?, faststart?}` — `rotation`: 0 / 90 / 180 / 270 |
| POST | `/api/watermark` | Watermark: `{file_id, type, position, text?, fontsize?, color?, alpha?, watermark_id?, scale_w?, margin?, faststart?}` — `type`: text / image; `position`: tl / tr / bl / br / c |
| POST | `/api/upload_watermark` | Upload a watermark image, returns `watermark_id` |
| POST | `/api/speed` | Speed: `{file_id, speed, reverse?, faststart?}` — `speed`: 0.5–4.0 |
| POST | `/api/extract_audio` | Extract audio: `{file_id, format, bitrate?}` — `format`: mp3 / m4a / wav / flac (source may come from the upload or output directory) |
| GET | `/api/tasks` | All tasks and their status |
| GET | `/api/tasks/stream` | SSE stream of task status |
| GET | `/api/task/<task_id>` | Single task detail (404 if not found) |
| POST | `/api/task/<task_id>/cancel` | Cancel a running task |
| POST | `/api/task/<task_id>/delete` | Delete a task and clean up its output files (running tasks are cancelled first) |
| POST | `/api/tasks/delete` | Batch delete tasks (requires a `task_ids` list; running ones are cancelled first) |
| GET | `/api/version` | Server and ffmpeg / ffprobe version info |
| GET | `/api/download/<file_id>` | Download an output file |
| GET | `/api/download_dir/<task_id>` | Download multi-file output as a zip |
| GET | `/media/<path>` | Preview a media file |
| GET | `/api/file/<file_id>` `/api/thumbnail/<file_id>` `/api/frame/<file_id>` | File detail / first-frame thumbnail / frame at timestamp |

> Every task-creating endpoint also accepts an optional `filename_template` to customize the output filename (see [Output filename template](#output-filename-template)).

Task fields: `task_id`, `name`, `kind` (compress / split / merge …), `status` (queued / running / finished / failed / cancelled), `progress` (0–100), `duration`, `elapsed`, `output_name` / `output_dir`, `out_size` / `out_size_human`, `out_codec` / `out_resolution`, `out_count`, `error`, `log`, `created_at`.

---

## Project structure

```
clipbench/
├── app.py                 # Flask backend: all APIs + ffmpeg task queue
├── detect_subtitle.py     # Automatic subtitle region detection
├── desub_inpaint.py       # Content-aware repair (cv2.inpaint)
├── requirements.txt       # Python dependencies (Flask, imageio-ffmpeg)
├── requirements-dev.txt   # Test dependencies (pytest)
├── start.sh               # One-shot start script
├── package.json           # Frontend dependencies and scripts
├── vite.config.js         # Vite config
├── LICENSE                # MIT license
├── llms.txt               # Machine-readable project summary (llmstxt.org)
├── src/                   # SolidJS + TypeScript frontend
│   ├── App.tsx            # Entry / tab layout
│   ├── store.ts           # Global state (files, tasks, tab definitions)
│   ├── api.ts             # Backend API wrapper
│   ├── sse.ts             # SSE progress subscription
│   ├── addedOutputs.ts    # Added-outputs set (localStorage)
│   ├── filenameTemplate.ts # Global output filename template (localStorage)
│   ├── components/        # Sidebar, Workbench, panels/ (11 feature panels)
│   └── styles.css         # All styles (dark theme)
├── static/                # Static assets (favicon, …)
├── uploads/               # Uploaded files (created at runtime)
├── outputs/               # Processing outputs (created at runtime)
├── tasks.json             # Task persistence (generated at runtime)
└── tests/                 # Automated tests (pytest) + manual test checklist
```

---

## Key design notes

- **Codec visibility:** `/api/files` returns the ffprobe-detected `video_codec` (lowercase `h264` / `hevc`), highlighted in the media card so you know the source codec before transcoding or compressing.
- **Smart HEVC compression:** the source codec is read automatically — H.264 sources go through `libx264`, HEVC sources through `libx265` with `hdr10_plus` / `master_display` metadata preserved. CRF starts from a sane value derived from the source codec.
- **faststart:** transcode and compress can add `-movflags +faststart`, moving the moov atom to the front so browsers can start playback while downloading.
- **SSE progress:** each task broadcasts status and progress to `/api/tasks/stream`; tasks run in parallel and a daemon thread collects results.
- **inpaint mutex:** content-aware repair is CPU and disk-IO heavy, so only one runs at a time and the rest queue — parallel runs would starve each other.
- **Task lifecycle:** persisted in `tasks.json`; you can cancel running tasks (terminates the child process), delete tasks and clean up their outputs, and orphaned tasks are swept on startup.
- **Output size recording:** every finished task records output size, codec, resolution and duration (with a backfill pass on startup for tasks created by older versions).
- **Security:** extension allow-list for uploads, path traversal protection (`secure_filename` + normalized path checks), 4 GB upload limit.

---

## Testing

```bash
. .venv/bin/activate
pip install -r requirements-dev.txt

# Run everything
python -m pytest tests/ -v

# API integration tests only (skipped automatically when ffmpeg is unavailable)
python -m pytest tests/test_app.py -v
```

`tests/test_app.py` covers unit tests (size formatting, time parsing, segment validation, extension allow-list, faststart logic), API tests against an isolated temp directory (file listing, upload / delete, version detection, parameter validation for all 11 features, task query / cancel / delete, SSE stream, download 404), and an end-to-end flow (upload → split → wait for success → verify output).

Manual test checklist: [`tests/manual-test.md`](tests/manual-test.md).

---

## FAQ

- **Why port 8080 instead of 5000?** On macOS, 5000 is usually taken by AirPlay Receiver. Use `PORT=9000 python app.py` to change it.
- **Do I need to install ffmpeg?** No. `imageio-ffmpeg` is a dependency and provides static ffmpeg / ffprobe binaries; a system installation is preferred when present.
- **The UI looks stale / didn't update.** In dev mode run `pnpm dev` with the backend already running. In production you must run `pnpm build` to regenerate `dist/`, which the backend serves.

---

## License

[MIT](LICENSE) © 2026 yuxing.wang

Free to use, copy, modify, merge, publish, distribute, sublicense and sell — including commercially — as long as the copyright and permission notice are retained. The software is provided "as is", without warranty of any kind.
