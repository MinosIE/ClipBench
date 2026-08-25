"""
ClipBench - 后端服务
基于 Flask + 本地 ffmpeg，提供视频拆分、截图、格式转换、压缩、裁剪等功能的 UI 操作台。
"""

import os
import re
import json
import time
import uuid
import shutil
import subprocess
import threading
from pathlib import Path

from flask import (
    Flask, request, jsonify, send_file,
    send_from_directory, abort, Response
)
from werkzeug.utils import secure_filename

# 尝试引入 imageio-ffmpeg 作为 ffmpeg 的自动兜底来源（开箱即用，无需本地安装）
try:
    import imageio_ffmpeg
    _HAS_IMAGEIO_FFMPEG = True
except Exception:
    _HAS_IMAGEIO_FFMPEG = False

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "outputs"
STATIC_DIR = BASE_DIR / "static"
DIST_DIR = BASE_DIR / "dist"  # Vite 构建产物（Solid 前端）

for d in (UPLOAD_DIR, OUTPUT_DIR, STATIC_DIR):
    d.mkdir(exist_ok=True)

app = Flask(__name__, static_folder=str(STATIC_DIR))
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024 * 1024  # 4GB


@app.after_request
def _no_cache_static(resp):
    # 开发期：静态资源禁用缓存，刷新即取最新（避免 JS/CSS 改动不生效）
    p = request.path
    if p.endswith(".js") or p.endswith(".css") or p.endswith(".html"):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp

# 任务存储: task_id -> task info
TASKS = {}
TASKS_FILE = BASE_DIR / "tasks.json"

# 去字幕(inpaint)互斥闸门：同一时刻只跑 1 个，多个串行排队
# 原因：inpaint 是 CPU 密集型 + 占大量磁盘 IO，并发会互相饿死导致全部卡死
_INPAINT_SLOTS = 1
_inpaint_sem = threading.BoundedSemaphore(_INPAINT_SLOTS)
_inpaint_lock = threading.Lock()
_inpaint_waiting = 0  # 当前正在等待闸门的任务数（用于 UI 提示）

# ffmpeg 任务并发闸门：压缩/合并/拆分/转换/截图等转码均为 CPU 密集型，
# 并行数超过核心数会互相抢核反而更慢。默认 = 逻辑核心数的一半（至少 1），
# 可用环境变量 CLIPBENCH_FFMPEG_SLOTS 覆盖（例如设为 1 即完全串行）。
def _default_ffmpeg_slots() -> int:
    v = os.environ.get("CLIPBENCH_FFMPEG_SLOTS")
    if v:
        try:
            return max(1, int(v))
        except (TypeError, ValueError):
            pass
    return max(1, (os.cpu_count() or 2) // 2)


_FFMPEG_SLOTS = _default_ffmpeg_slots()
_ffmpeg_sem = threading.BoundedSemaphore(_FFMPEG_SLOTS)
_ffmpeg_lock = threading.Lock()
_ffmpeg_waiting = 0  # 当前正在等待闸门的任务数（用于 UI 提示）


def inpaint_acquire(task_id):
    """inpaint 任务开始时调用：拿不到闸门就排队阻塞，并更新任务文案展示"排队中"。"""
    global _inpaint_waiting
    with _inpaint_lock:
        _inpaint_waiting += 1
    if _inpaint_waiting > 1:
        try:
            t = TASKS.get(task_id)
            if t:
                t["status"] = "queued"
                save_tasks()
        except Exception:
            pass
    with _inpaint_lock:
        _inpaint_waiting = max(0, _inpaint_waiting - 1)
    _inpaint_sem.acquire()


def inpaint_release():
    try:
        _inpaint_sem.release()
    except Exception:
        pass


def ffmpeg_acquire(task_id):
    """ffmpeg 任务开始时调用：拿不到闸门就排队阻塞，并更新任务文案展示"排队中"。"""
    global _ffmpeg_waiting
    with _ffmpeg_lock:
        _ffmpeg_waiting += 1
    if _ffmpeg_waiting > _FFMPEG_SLOTS:
        try:
            t = TASKS.get(task_id)
            if t:
                t["status"] = "queued"
                save_tasks()
        except Exception:
            pass
    _ffmpeg_sem.acquire()
    with _ffmpeg_lock:
        _ffmpeg_waiting = max(0, _ffmpeg_waiting - 1)


def ffmpeg_release():
    try:
        _ffmpeg_sem.release()
    except Exception:
        pass


def load_tasks():
    if TASKS_FILE.exists():
        try:
            data = json.loads(TASKS_FILE.read_text(encoding="utf-8"))
            TASKS.update(data)
        except Exception:
            pass


# ---------------- 孤儿任务巡检 ----------------
# 场景：服务重启后，磁盘上 tasks.json 里残留的 "running" 任务并没有对应线程在跑，
# 进度永远停在 0%、且前端不允许删除（防误删正在运行的任务）。
# 解法：启动时 + 每 60s，把任何残留的 "running"/"queued" 标记为 "failed" 并附原因，
# 这样用户在前端就能正常勾选删除。后台线程通过 Thread 句柄的 is_alive() 持续跟踪，
# 进程内任务有真实线程在跑则不会被误杀。
import threading as _thr

_TASKS_LOCK = _thr.Lock()
_ACTIVE_THREADS: dict = {}  # task_id -> Thread
_TASK_PROCS: dict = {}  # task_id -> subprocess.Popen（运行中的 ffmpeg 句柄）


def register_task_thread(task_id: str, thread: _thr.Thread) -> None:
    _ACTIVE_THREADS[task_id] = thread


def register_task_proc(task_id: str, proc) -> None:
    _TASK_PROCS[task_id] = proc


def cancel_task(task_id: str) -> bool:
    """强制取消一个运行中的任务：终止其 ffmpeg 子进程并标记 cancelled。

    返回 True 表示成功触发取消（或任务本就不在运行）。
    """
    with _TASKS_LOCK:
        t = TASKS.get(task_id)
        if t is None:
            return False
        if t.get("status") not in ("running", "queued"):
            return True  # 非运行态，直接删除即可
        proc = _TASK_PROCS.get(task_id)
        if proc is not None:
            try:
                proc.terminate()
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            _TASK_PROCS.pop(task_id, None)
        _ACTIVE_THREADS.pop(task_id, None)
        t["status"] = "cancelled"
        t["error"] = "任务已被手动取消。"
        t["finished_at"] = int(time.time())
        save_tasks()
    return True


def sweep_orphan_tasks() -> int:
    """清理没有真实线程在跑的 running/queued 任务，返回处理数。

    这些多半是服务重启/崩溃后残留的孤儿任务，把状态置为 cancelled
    （可删除、可重试），而不是 failed（避免与真实失败混淆）。
    """
    n = 0
    with _TASKS_LOCK:
        for tid, t in list(TASKS.items()):
            if t.get("status") not in ("running", "queued"):
                continue
            th = _ACTIVE_THREADS.get(tid)
            if th is not None and th.is_alive():
                continue
            # 进程中已无对应线程在跑 -> 视为孤儿，标记为可取消状态
            t["status"] = "cancelled"
            t["error"] = "任务已中断（可删除后重试）。"
            t["finished_at"] = int(time.time())
            n += 1
        if n:
            save_tasks()
    return n


def _sweep_loop():
    while True:
        try:
            sweep_orphan_tasks()
        except Exception:
            pass
        time.sleep(60)


_thr.Thread(target=_sweep_loop, daemon=True).start()
# 启动时立即执行一次，清理残留的孤儿任务
sweep_orphan_tasks()


# SSE 推送：save_tasks 时通知订阅者，由泵线程节流后推送最新 TASKS
_SSE_COND = _thr.Condition()
_SSE_DIRTY = False


def _notify_tasks_changed():
    global _SSE_DIRTY
    with _SSE_COND:
        _SSE_DIRTY = True
        _SSE_COND.notify_all()


def save_tasks():
    try:
        TASKS_FILE.write_text(
            json.dumps(TASKS, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception:
        pass
    # 触发 SSE 推送（前端实时进度，无需轮询）
    _notify_tasks_changed()


def _sse_pump():
    """SSE 泵：等待变更通知，节流后把最新 TASKS 推给所有订阅者。"""
    global _SSE_DIRTY
    while True:
        with _SSE_COND:
            _SSE_COND.wait(timeout=0.5)
            dirty = _SSE_DIRTY
            _SSE_DIRTY = False
        if not dirty:
            continue
        # 节流：两次推送至少间隔 0.25s，避免进度高频更新刷爆连接
        payload = json.dumps(
            sorted(TASKS.values(), key=lambda t: t.get("created_at", 0), reverse=True),
            ensure_ascii=False,
        )
        # 注意：消费者慢导致队列满时，只丢弃当前帧，绝不移除订阅者，
        # 否则慢客户端（如 curl 缓冲）会被永久踢出，再也收不到推送。
        for q in list(_SSE_SUBSCRIBERS):
            try:
                q.put_nowait(payload)
            except Exception:
                pass


_SSE_SUBSCRIBERS = set()
_thr.Thread(target=_sse_pump, daemon=True).start()


# 测试模式（CLIPBENCH_TEST=1，由 tests/conftest.py 设置）下跳过加载真实任务状态，
# 避免 pytest 进程写入/污染线上 tasks.json；测试内部会使用隔离的临时目录。
if not os.environ.get("CLIPBENCH_TEST"):
    load_tasks()


# ---------------- ffmpeg 二进制解析 ----------------
# 优先使用系统 PATH 中的 ffmpeg/ffprobe；未安装时回退到 imageio-ffmpeg
# 提供的静态二进制（pip 安装 imageio-ffmpeg 时会自动下载对应平台版本），
# 这样克隆仓库后即可直接运行，无需本地预先安装 ffmpeg。
_FFMPEG_BIN = None
_FFPROBE_BIN = None


def _resolve_ffmpeg() -> str:
    """返回可用的 ffmpeg 可执行文件路径"""
    global _FFMPEG_BIN
    if _FFMPEG_BIN is not None:
        return _FFMPEG_BIN
    # 1. 系统 PATH
    found = shutil.which("ffmpeg")
    # 2. imageio-ffmpeg 兜底
    if not found and _HAS_IMAGEIO_FFMPEG:
        try:
            found = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            found = None
    _FFMPEG_BIN = found or "ffmpeg"  # 仍给个名字，便于报错时提示
    return _FFMPEG_BIN


def _resolve_ffprobe() -> str:
    """返回可用的 ffprobe 可执行文件路径"""
    global _FFPROBE_BIN
    if _FFPROBE_BIN is not None:
        return _FFPROBE_BIN
    found = shutil.which("ffprobe")
    if not found and _HAS_IMAGEIO_FFMPEG:
        # imageio-ffmpeg 不附带 ffprobe，但同目录通常会有，尝试查找
        try:
            ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
            candidate = str(Path(ffmpeg_exe).parent / "ffprobe")
            if Path(candidate).exists():
                found = candidate
        except Exception:
            found = None
    _FFPROBE_BIN = found or "ffprobe"
    return _FFPROBE_BIN


def ensure_ffmpeg() -> bool:
    """启动自检：至少 ffmpeg 必须可用，否则打印友好提示并返回 False"""
    exe = _resolve_ffmpeg()
    if exe == "ffmpeg" or not Path(exe).exists():
        print("\n❌ 未检测到 ffmpeg。")
        if _HAS_IMAGEIO_FFMPEG:
            print("   已安装 imageio-ffmpeg，但未能定位二进制，请检查安装。")
        else:
            print("   请安装 ffmpeg 后重试：")
            print("     macOS : brew install ffmpeg")
            print("     Linux : sudo apt install ffmpeg  (Debian/Ubuntu)")
            print("             sudo dnf install ffmpeg  (Fedora)")
            print("     Win   : scoop install ffmpeg   或   choco install ffmpeg")
            print("   或者执行: pip install imageio-ffmpeg  （自动下载静态二进制）\n")
        return False
    return True


def get_ffmpeg() -> str:
    return _resolve_ffmpeg()


def get_ffprobe() -> str:
    return _resolve_ffprobe()


ALLOWED_EXT = {
    "mp4", "mov", "avi", "mkv", "flv", "wmv", "webm", "m4v",
    "mp3", "wav", "aac", "m4a", "flac", "ogg",
}


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXT


def ffprobe(path: str) -> dict:
    """获取媒体文件信息"""
    cmd = [
        get_ffprobe(), "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ]
    try:
        out = subprocess.check_output(cmd, timeout=60)
        return json.loads(out.decode("utf-8"))
    except Exception:
        return {}


def human_size(n):
    if n is None:
        return "0 B"
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PB"


def _pretty_format_name(raw: str) -> str:
    """把 'mov,mp4,m4a,3gp,3g2,mj2' 这类长串格式化为更易读的主格式"""
    if not raw:
        return ""
    parts = [p.strip() for p in raw.split(",")]
    # 取前 2-3 个常见项
    seen = []
    for p in parts:
        if p not in seen:
            seen.append(p)
        if len(seen) >= 3:
            break
    # 常见映射
    name_map = {
        "mov,mp4,m4a,3gp,3g2,mj2": "MP4 / MOV",
        "matroska,webm": "MKV / WEBM",
        "avi": "AVI",
        "flv": "FLV",
        "wmv": "WMV",
        "mp3": "MP3",
        "wav": "WAV",
        "ogg": "OGG",
        "flac": "FLAC",
        "aac": "AAC",
    }
    return name_map.get(raw, ", ".join(seen).upper())


def get_media_meta(path: str) -> dict:
    info = ffprobe(path)
    fmt = info.get("format", {})
    duration = float(fmt.get("duration", 0) or 0)
    size = int(fmt.get("size", 0) or 0)
    video_stream = next(
        (s for s in info.get("streams", []) if s.get("codec_type") == "video"),
        None,
    )
    audio_stream = next(
        (s for s in info.get("streams", []) if s.get("codec_type") == "audio"),
        None,
    )
    meta = {
        "duration": round(duration, 2),
        "size": size,
        "size_human": human_size(size),
        "format_name": _pretty_format_name(fmt.get("format_name", "")),
        "has_video": video_stream is not None,
        "has_audio": audio_stream is not None,
    }
    if video_stream:
        meta["width"] = video_stream.get("width")
        meta["height"] = video_stream.get("height")
        meta["video_codec"] = video_stream.get("codec_name")
        try:
            meta["video_bitrate"] = int(video_stream.get("bit_rate") or 0)
        except Exception:
            meta["video_bitrate"] = 0
        fr = video_stream.get("avg_frame_rate", "0/1")
        try:
            a, b = fr.split("/")
            meta["fps"] = round(float(a) / float(b), 2) if float(b) else 0
        except Exception:
            meta["fps"] = 0
    if audio_stream:
        meta["audio_codec"] = audio_stream.get("codec_name")
        try:
            meta["audio_bitrate"] = int(audio_stream.get("bit_rate") or 0)
        except Exception:
            meta["audio_bitrate"] = 0
    return meta


def get_ffmpeg_version() -> str:
    try:
        out = subprocess.check_output([get_ffmpeg(), "-version"], timeout=10)
        first = out.decode("utf-8", errors="ignore").splitlines()[0]
        return first.strip()
    except Exception:
        return "未检测到 ffmpeg"


def _finalize(args, out, faststart=False):
    """在输出文件名前按需追加 -movflags +faststart（仅对渐进式容器有效）"""
    if faststart and out.suffix.lower() in (".mp4", ".mov", ".m4v"):
        args += ["-movflags", "+faststart"]
    args += [str(out)]
    return args


def run_ffmpeg(args, task_id, workdir):
    """执行 ffmpeg，将进度写入任务（受并发闸门限流，排队时状态为 queued）"""
    ffmpeg_acquire(task_id)
    try:
        _run_ffmpeg_locked(args, task_id, workdir)
    finally:
        ffmpeg_release()


def _run_ffmpeg_locked(args, task_id, workdir):
    """执行 ffmpeg，将进度写入任务（须已持有 ffmpeg 并发闸门）"""
    task = TASKS.get(task_id)
    # 排队期间可能已被手动取消，拿到闸门后检查，取消则直接放弃
    if task is None or task.get("status") == "cancelled":
        return
    task["status"] = "running"
    save_tasks()
    cmd = [get_ffmpeg(), "-y", "-hide_banner", "-progress", "pipe:1"] + args
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(workdir),
            text=True,
            bufsize=1,
        )
        register_task_proc(task_id, proc)
    except Exception as e:
        task["status"] = "failed"
        task["error"] = str(e)
        save_tasks()
        return

    duration = task.get("duration", 0) or 0
    out_lines = []
    progress = {"out_time_ms": 0, "speed": 0}
    for line in proc.stdout:
        line = line.strip()
        if "=" in line:
            k, _, v = line.partition("=")
            progress[k.strip()] = v.strip()
        out_lines.append(line)
        if duration > 0:
            try:
                ms = int(progress.get("out_time_ms", 0) or 0)
                pct = min(100, (ms / 1_000_000) / duration * 100)
                task["progress"] = round(pct, 1)
            except Exception:
                pass
        else:
            task["progress"] = None
        save_tasks()

    proc.wait()
    if proc.returncode == 0:
        task["status"] = "finished"
        task["progress"] = 100
        # 压缩任务：完成后探测输出文件，记录对比信息（源 vs 输出）
        if task.get("kind") == "compress" and task.get("output_name"):
            _record_compress_result(task, Path(workdir) / task["output_name"])
    else:
        task["status"] = "failed"
        task["error"] = "\n".join(out_lines[-30:])[:2000]
    task["elapsed"] = int(time.time() - (task.get("created_at") or time.time()))
    save_tasks()


def _record_compress_result(task: dict, out_path) -> None:
    """压缩任务完成后，探测输出文件并记录源/输出对比信息（仅追加，不覆盖已有字段）。"""
    try:
        if not out_path.exists():
            return
        om = get_media_meta(str(out_path))
        out_size = int(om.get("size") or 0)
        src_size = int(task.get("src_size") or 0)
        saving = 0.0
        if src_size > 0 and out_size > 0:
            saving = round((1 - out_size / src_size) * 100, 1)
        res = f'{om.get("width")}x{om.get("height")}' if om.get("width") else ""
        task["out_size"] = out_size
        task["out_size_human"] = om.get("size_human", "")
        task["out_codec"] = om.get("video_codec", "")
        task["out_resolution"] = res
        task["out_bitrate"] = om.get("video_bitrate", 0)
        task["saving"] = saving
    except Exception as e:
        print(f"[compress] 记录对比信息失败: {e}", flush=True)


def _generate_gif_clips(src, segments, fps, width, base, task_id, duration):
    """逐片段生成调色板优化的 GIF（后台线程）"""
    task = TASKS.get(task_id)
    total = len(segments)
    try:
        for i, (start, end) in enumerate(segments):
            pal = base / f"pal_{i+1}.png"
            ss = ["-ss", fmt_dur(start)]
            if end is not None:
                ss += ["-to", fmt_dur(end)]
            vf_scale = f"fps={fps},scale={width}:-1:flags=lanczos"
            # 注意: -ss/-to 必须放在 -i 之前(input seeking), 否则 palettegen
            # 在 output seeking 下会丢帧导致空输出(exit 254)
            p1 = [get_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error"] + ss + [
                "-i", src, "-vf", f"{vf_scale},palettegen", str(pal)]
            p2 = [get_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error"] + ss + [
                "-i", src, "-i", str(pal),
                "-lavfi", f"{vf_scale}[x];[x][1:v]paletteuse",
                str(base / f"clip_{i+1:03d}.gif")]
            subprocess.run(p1, timeout=120, check=True)
            subprocess.run(p2, timeout=120, check=True)
            if pal.exists():
                pal.unlink()
            if task and duration:
                task["progress"] = round((i + 1) / total * 100, 1)
                save_tasks()
        if task:
            task["status"] = "finished"
            task["progress"] = 100
            save_tasks()
    except Exception as e:
        if task:
            task["status"] = "failed"
            task["error"] = str(e)[:2000]
            save_tasks()


# ---------------- API ----------------

@app.route("/api/version")
def api_version():
    return jsonify({"ffmpeg": get_ffmpeg_version()})


@app.route("/api/upload", methods=["POST"])
def api_upload():
    if "file" not in request.files:
        print("[upload] 400: request.files 中没有 file 字段", flush=True)
        return jsonify({"error": "未找到文件"}), 400
    f = request.files["file"]
    if f.filename == "":
        print("[upload] 400: filename 为空", flush=True)
        return jsonify({"error": "文件名为空"}), 400
    if not allowed_file(f.filename):
        print(f"[upload] 400: 扩展名不在白名单 filename={f.filename!r}", flush=True)
        return jsonify({"error": "不支持的文件类型"}), 400
    print(f"[upload] 通过校验: filename={f.filename!r} content_length={f.content_length}", flush=True)
    filename = secure_filename(f.filename)
    # 避免重名
    stem = Path(filename).stem
    suffix = Path(filename).suffix
    target = UPLOAD_DIR / filename
    i = 1
    while target.exists():
        target = UPLOAD_DIR / f"{stem}_{i}{suffix}"
        i += 1
    f.save(str(target))
    meta = get_media_meta(str(target))
    file_id = target.name
    return jsonify({
        "file_id": file_id,
        "filename": target.name,
        "meta": meta,
    })


def _is_ignored_file(name: str) -> bool:
    """跳过版本控制占位文件和隐藏文件"""
    if name.startswith("."):
        return True
    if name.lower() in {".gitkeep", ".gitignore", ".ds_store"}:
        return True
    return False


@app.route("/api/files")
def api_files():
    files = []
    for p in sorted(UPLOAD_DIR.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        if p.is_file() and not _is_ignored_file(p.name):
            try:
                meta = get_media_meta(str(p))
            except Exception:
                meta = {}
            files.append({
                "file_id": p.name,
                "filename": p.name,
                "size": p.stat().st_size,
                "size_human": human_size(p.stat().st_size),
                "meta": meta,
            })
    return jsonify({"files": files})


@app.route("/api/file/<file_id>")
def api_file_info(file_id):
    p = UPLOAD_DIR / secure_filename(file_id)
    if not p.exists():
        abort(404)
    meta = get_media_meta(str(p))
    return jsonify({"file_id": p.name, "filename": p.name, "meta": meta})


@app.route("/api/thumbnail/<file_id>")
def api_thumbnail(file_id):
    """生成并返回视频首帧缩略图"""
    p = UPLOAD_DIR / secure_filename(file_id)
    if not p.exists():
        abort(404)
    thumb = OUTPUT_DIR / f"thumb_{p.stem}.jpg"
    if not thumb.exists():
        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(p), "-ss", "00:00:01", "-vframes", "1",
            "-vf", "scale=320:-1", str(thumb),
        ]
        try:
            subprocess.run(cmd, timeout=30, check=False)
        except Exception:
            pass
    if thumb.exists():
        return send_file(str(thumb), mimetype="image/jpeg")
    abort(404)


@app.route("/api/frame/<file_id>")
def api_frame(file_id):
    """返回视频在指定时间点的原始分辨率帧（JPEG），用于去字幕选区预览"""
    p = UPLOAD_DIR / secure_filename(file_id)
    if not p.exists():
        abort(404)
    try:
        t = float(request.args.get("t", 1))
    except (TypeError, ValueError):
        t = 1
    if t < 0:
        t = 0
    meta = get_media_meta(str(p))
    dur = meta.get("duration") or 0
    if dur and t > dur:
        t = dur - 0.1
    # 原始分辨率截图，避免缩放导致选区坐标换算误差
    ts = f"{int(t // 3600):02d}:{int(t % 3600 // 60):02d}:{t % 60:06.3f}"
    import tempfile
    tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
    tmp.close()
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-ss", ts, "-i", str(p), "-vframes", "1", tmp.name,
    ]
    try:
        subprocess.run(cmd, timeout=30, check=False)
        if os.path.exists(tmp.name):
            return send_file(tmp.name, mimetype="image/jpeg")
    except Exception:
        pass
    finally:
        try:
            os.remove(tmp.name)
        except OSError:
            pass
    abort(404)


def start_task(task_id, args, duration, workdir):
    import threading
    t = threading.Thread(
        target=run_ffmpeg, args=(args, task_id, workdir), daemon=True
    )
    register_task_thread(task_id, t)
    t.start()


def run_inpaint(src, out, x, y, w, h, radius, task_id, quality="standard"):
    """后台执行 OpenCV inpaint 去字幕，并更新任务进度。

    内部使用互斥闸门，多个 inpaint 任务串行执行；排队期间任务状态显示为 'queued'。
    quality: 'standard'(时序裸中值) / 'high'(时序+光流对齐)。
    """
    from desub_inpaint import inpaint_video_temporal, inpaint_video

    # 注册当前线程，避免被 sweep_orphan_tasks 误判为孤儿任务而中断
    register_task_thread(task_id, threading.current_thread())

    inpaint_acquire(task_id)
    try:
        if quality == "high":
            _run_inpaint_impl(src, out, x, y, w, h, radius, task_id,
                              func=inpaint_video_temporal, use_flow=True)
        else:
            _run_inpaint_impl(src, out, x, y, w, h, radius, task_id,
                              func=inpaint_video_temporal, use_flow=False)
    finally:
        inpaint_release()


def _run_inpaint_impl(src, out, x, y, w, h, radius, task_id, func=None, use_flow=False):
    from desub_inpaint import inpaint_video_temporal
    inpaint_video = func or inpaint_video_temporal

    # 拿到闸门后把状态切回 running
    if task_id in TASKS:
        TASKS[task_id]["status"] = "running"
        save_tasks()

    last_saved = 0.0
    PROGRESS_EVERY = 0.2  # 秒：进度节流，避免每帧写盘

    def _on_progress(done, total, elapsed):
        nonlocal last_saved
        now = time.time()
        # 节流：每 0.2s 才落盘一次；以及完成/失败时强制落盘
        if (now - last_saved) >= PROGRESS_EVERY or done == total:
            if total and total > 0:
                # 用浮点(1位小数)进度，前端插值动画可更细腻地衔接
                pct = max(0.0, min(100.0, round(done * 100 / total, 1)))
            else:
                # 没有总帧数时，按 elapsed 推一个下限百分比，1s 走 1%，最多 99
                pct = max(0, min(99, int(elapsed)))
            t = TASKS.get(task_id)
            if t:
                t["progress"] = pct
                t["duration"] = float(total) if total else t.get("duration", 0)
                save_tasks()
            last_saved = now

    try:
        ok, msg = inpaint_video(src, out, x, y, w, h, radius, on_progress=_on_progress)
    except ImportError:
        TASKS[task_id]["status"] = "failed"
        TASKS[task_id]["error"] = "未安装 opencv-python，无法使用智能修复。请运行: pip install opencv-python-headless"
        save_tasks()
        return
    if not ok:
        TASKS[task_id]["status"] = "failed"
        TASKS[task_id]["error"] = msg
        TASKS[task_id]["progress"] = 0
    else:
        TASKS[task_id]["status"] = "finished"
        TASKS[task_id]["progress"] = 100
    TASKS[task_id]["elapsed"] = int(time.time() - (TASKS[task_id].get("created_at") or time.time()))
    save_tasks()


def new_task(name, duration=0, output_name=None, extra=None):
    task_id = uuid.uuid4().hex[:12]
    TASKS[task_id] = {
        "task_id": task_id,
        "name": name,
        "status": "running",
        "progress": 0 if duration else None,
        "duration": duration,
        "created_at": int(time.time()),
        "output_name": output_name,
        "error": None,
    }
    if extra:
        TASKS[task_id].update(extra)
    save_tasks()
    return task_id


def parse_time_to_seconds(value):
    """将 HH:MM:SS、MM:SS 或纯秒数解析为秒；非法返回 None"""
    if value is None:
        return None
    value = str(value).strip()
    if value == "":
        return None
    # 纯数字（支持小数）
    if re.fullmatch(r"\d+(\.\d+)?", value):
        return float(value)
    # HH:MM:SS 或 MM:SS
    m = re.fullmatch(r"(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)", value)
    if m:
        h = int(m.group(1) or 0)
        mm = int(m.group(2))
        ss = float(m.group(3))
        return h * 3600 + mm * 60 + ss
    return None


def validate_segments(segments, duration):
    """校验多个片段，返回 (clean_segments, error)。clean_segments 为 [(start,end), ...]"""
    if not segments:
        return [], "请至少添加一个片段"
    clean = []
    for i, seg in enumerate(segments):
        start = parse_time_to_seconds(seg.get("start"))
        end = parse_time_to_seconds(seg.get("end"))
        if start is None:
            return [], f"第 {i+1} 个片段：开始时间格式不正确"
        if start < 0:
            return [], f"第 {i+1} 个片段：开始时间不能为负"
        if end is not None:
            if end <= start:
                return [], f"第 {i+1} 个片段：结束时间需大于开始时间"
            if duration and end > duration + 1:
                return [], f"第 {i+1} 个片段：结束时间超过视频总时长 {fmt_dur(duration)}"
        if duration and start > duration + 1:
            return [], f"第 {i+1} 个片段：开始时间超过视频总时长 {fmt_dur(duration)}"
        clean.append((start, end))
    return clean, None


def fmt_dur(s):
    s = int(s)
    h = s // 3600
    m = (s % 3600) // 60
    sec = s % 60
    return f"{h:02d}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


# 各功能接口 -------------------------------------------------

@app.route("/api/split", methods=["POST"])
def api_split():
    data = request.json
    file_id = secure_filename(data["file_id"])
    src = UPLOAD_DIR / file_id
    if not src.exists():
        return jsonify({"error": "源文件不存在"}), 404
    mode = data.get("mode", "segment")  # segment | time
    mute = bool(data.get("mute", False))
    meta = get_media_meta(str(src))
    out_paths = []
    args_list = []
    if mode == "segment":
        seg = float(data.get("segment", 60))
        if seg <= 0:
            return jsonify({"error": "每段时长需大于0"}), 400
        # 按固定时长拆分，输出为多个文件
        base = OUTPUT_DIR / f"split_{src.stem}"
        base.mkdir(exist_ok=True)
        args = ["-i", str(src), "-f", "segment",
                "-segment_time", str(seg), "-reset_timestamps", "1",
                "-c", "copy"]
        if mute:
            args += ["-an"]
        args += [str(base / f"{src.stem}_%03d{src.suffix}")]
        task_id = new_task(f"按时长拆分 {src.name} ({seg}s){' · 静音' if mute else ''}",
                           duration=meta.get("duration", 0))
        TASKS[task_id]["output_dir"] = str(base)
        save_tasks()
        start_task(task_id, args, meta.get("duration", 0), OUTPUT_DIR)
        return jsonify({"task_id": task_id})
    else:
        # 按指定时间截取一个或多个片段
        duration = meta.get("duration", 0) or 0
        output = data.get("output", "video")  # video | gif
        raw_segments = data.get("segments")
        # 兼容旧版单片段传参
        if not raw_segments:
            start = data.get("start", "00:00:00")
            end = data.get("end", "")
            raw_segments = [{"start": start, "end": end}]

        clean, err = validate_segments(raw_segments, duration)
        if err:
            return jsonify({"error": err}), 400

        # GIF 输出: 单片段/多片段都打包到目录(使用调色板优化画质)
        if output == "gif":
            gif_fps = float(data.get("gif_fps", 12))
            gif_width = int(data.get("gif_width", 480))
            base = OUTPUT_DIR / f"clips_{src.stem}_{int(time.time())}"
            base.mkdir(exist_ok=True)
            count = len(clean)
            task_id = new_task(f"截取 {count} 个片段 → GIF {gif_width}px", duration=duration)
            TASKS[task_id]["output_dir"] = str(base)
            save_tasks()
            import threading
            t = threading.Thread(
                target=_generate_gif_clips,
                args=(str(src), clean, gif_fps, gif_width, base, task_id, duration),
                daemon=True,
            )
            t.start()
            return jsonify({"task_id": task_id})

        # 多个片段用单次调用、stream copy 输出多个文件
        count = len(clean)
        if count == 1:
            start, end = clean[0]
            out = OUTPUT_DIR / f"clip_{src.stem}_{int(time.time())}{src.suffix}"
            args = ["-i", str(src), "-ss", fmt_dur(start)]
            if end is not None:
                args += ["-to", fmt_dur(end)]
            args += ["-c", "copy"]
            if mute:
                args += ["-an"]
            args += [str(out)]
            task_id = new_task(f"截取片段 {src.name} [{fmt_dur(start)}~{fmt_dur(end) if end is not None else '结尾'}]{' · 静音' if mute else ''}",
                               duration=duration)
            TASKS[task_id]["output_name"] = out.name
            save_tasks()
            start_task(task_id, args, duration, OUTPUT_DIR)
            return jsonify({"task_id": task_id})
        else:
            base = OUTPUT_DIR / f"clips_{src.stem}_{int(time.time())}"
            base.mkdir(exist_ok=True)
            args = ["-i", str(src)]
            for i, (start, end) in enumerate(clean):
                args += ["-ss", fmt_dur(start)]
                if end is not None:
                    args += ["-to", fmt_dur(end)]
                if mute:
                    args += ["-map", "0:v", "-c", "copy"]
                else:
                    args += ["-map", "0", "-c", "copy"]
                args += [str(base / f"clip_{i+1:03d}{src.suffix}")]
            task_id = new_task(f"截取 {count} 个片段 {src.name}{' · 静音' if mute else ''}", duration=duration)
            TASKS[task_id]["output_dir"] = str(base)
            save_tasks()
            start_task(task_id, args, duration, OUTPUT_DIR)
            return jsonify({"task_id": task_id})


@app.route("/api/screenshot", methods=["POST"])
def api_screenshot():
    data = request.json
    file_id = secure_filename(data["file_id"])
    src = UPLOAD_DIR / file_id
    if not src.exists():
        return jsonify({"error": "源文件不存在"}), 404
    mode = data.get("mode", "single")  # single | every
    meta = get_media_meta(str(src))
    if mode == "single":
        time_pos = data.get("time", "00:00:01")
        fmt = data.get("format", "jpg")
        out = OUTPUT_DIR / f"shot_{src.stem}_{int(time.time())}.{fmt}"
        args = ["-i", str(src), "-ss", str(time_pos), "-vframes", "1"]
        vf = data.get("vf")
        if vf:
            args += ["-vf", vf]
        args += [str(out)]
        task_id = new_task(f"截图 @ {time_pos}", duration=meta.get("duration", 0))
        TASKS[task_id]["output_name"] = out.name
        save_tasks()
        start_task(task_id, args, meta.get("duration", 0), OUTPUT_DIR)
        return jsonify({"task_id": task_id})
    else:
        interval = float(data.get("interval", 1))
        if interval <= 0:
            return jsonify({"error": "间隔需大于0"}), 400
        fmt = data.get("format", "jpg")
        base = OUTPUT_DIR / f"shots_{src.stem}_{int(time.time())}"
        base.mkdir(exist_ok=True)
        args = ["-i", str(src), "-vf",
                f"fps=1/{interval}", str(base / f"shot_%05d.{fmt}")]
        task_id = new_task(f"每 {interval}s 截图", duration=meta.get("duration", 0))
        TASKS[task_id]["output_dir"] = str(base)
        save_tasks()
        start_task(task_id, args, meta.get("duration", 0), OUTPUT_DIR)
        return jsonify({"task_id": task_id})


@app.route("/api/convert", methods=["POST"])
def api_convert():
    data = request.json
    file_id = secure_filename(data["file_id"])
    src = UPLOAD_DIR / file_id
    if not src.exists():
        return jsonify({"error": "源文件不存在"}), 404
    target = data.get("target", "mp4")
    meta = get_media_meta(str(src))
    out = OUTPUT_DIR / f"conv_{src.stem}_{int(time.time())}.{target}"
    faststart = bool(data.get("faststart", False))
    crf = data.get("crf")
    # 需要强制重编码的容器/格式
    force_reencode = target in ("gif", "webm")
    if crf:
        force_reencode = True

    if target == "gif":
        # GIF 无音频，且必须重编码为 gif 编码器
        args = ["-i", str(src), "-vf", "fps=10,scale=-1:-1", "-loop", "0", str(out)]
        task_id = new_task(f"格式转换 → {target}", duration=meta.get("duration", 0))
        TASKS[task_id]["output_name"] = out.name
        save_tasks()
        start_task(task_id, args, meta.get("duration", 0), OUTPUT_DIR)
        return jsonify({"task_id": task_id})

    if force_reencode:
        args = ["-i", str(src), "-c:v", "libx264", "-crf", str(crf or 23)]
        if target in ("mp4", "mov", "m4v"):
            args += ["-c:a", "aac", "-b:a", "128k"]
        elif target in ("webm",):
            args = ["-i", str(src), "-c:v", "libvpx-vp9", "-crf", str(crf or 30),
                    "-b:v", "0", "-c:a", "libopus"]
        else:
            args += ["-c:a", "copy"]
        args = _finalize(args, out, faststart)
        task_id = new_task(f"格式转换 → {target}", duration=meta.get("duration", 0))
        TASKS[task_id]["output_name"] = out.name
        save_tasks()
        start_task(task_id, args, meta.get("duration", 0), OUTPUT_DIR)
        return jsonify({"task_id": task_id})

    args = ["-i", str(src)]
    vcodec = data.get("vcodec", "copy")
    if vcodec and vcodec != "copy":
        args += ["-c:v", vcodec]
    else:
        args += ["-c:v", "copy"]
    # 某些容器(如 mp4)对 copy 音频可能不支持, 默认 aac
    if target in ("mp4", "mov", "m4v") and meta.get("audio_codec") not in ("aac", "mp3"):
        args += ["-c:a", "aac", "-b:a", "128k"]
    else:
        args += ["-c:a", "copy"]
    args = _finalize(args, out, faststart)
    task_id = new_task(f"格式转换 → {target}", duration=meta.get("duration", 0))
    TASKS[task_id]["output_name"] = out.name
    save_tasks()
    start_task(task_id, args, meta.get("duration", 0), OUTPUT_DIR)
    return jsonify({"task_id": task_id})


def suggest_compress(meta: dict, vcodec_out: str) -> dict:
    """压缩智能建议 + 预估的权威计算（前端智能建议的唯一来源，避免前后端两套阈值漂移）。

    与 api_compress 使用同一套编码推导逻辑（CRF 偏移、编码选择）。
    预估输出体积基于真实源码率，比前端经验公式更可信。
    """
    vcodec = (meta.get("video_codec") or "").lower()
    src_is_hevc = vcodec in ("hevc", "h265", "h.265")
    vb = int(meta.get("video_bitrate") or 0)
    w = int(meta.get("width") or 0)
    h = int(meta.get("height") or 0)
    dur = float(meta.get("duration") or 0)
    size = int(meta.get("size") or 0)

    # 1) 推荐 CRF（与 api_compress 的偏移逻辑同源）
    if vcodec_out == "hevc":
        codec_label = "HEVC"
        if src_is_hevc:
            offset = 6 + (10 if vb < 2000000 else 0)
            rec_crf = 22
            actual_crf = rec_crf + offset
        else:
            rec_crf = 22
            actual_crf = rec_crf
    else:
        codec_label = "H.264"
        rec_crf = 23
        actual_crf = rec_crf

    # 2) 推荐分辨率（与前端原逻辑同源，但用真实分辨率判断）
    is_4k = w >= 3000 or h >= 2000
    is_1080 = (w >= 1600 or h >= 1000) and not is_4k
    low_rate = vb > 0 and vb < 2000000
    high_rate = vb >= 8000000
    if is_4k:
        rec_scale = "1080"
    elif is_1080 and high_rate:
        rec_scale = "720"
    else:
        rec_scale = "original"

    # 3) 预估输出体积（经验，基于真实源码率）
    src_area = w * h
    target_area = src_area
    if rec_scale == "1080":
        target_area = 1920 * 1080
    elif rec_scale == "720":
        target_area = 1280 * 720
    elif rec_scale == "480":
        target_area = 854 * 480
    scale_factor = target_area / src_area if src_area else 1
    crf_factor = 2 ** ((23 - actual_crf) / 6)
    codec_factor = 1.0
    if vcodec_out == "hevc" and not src_is_hevc:
        codec_factor = 0.6
    elif vcodec_out == "h264" and src_is_hevc:
        codec_factor = 1.6
    vol_factor = scale_factor * crf_factor * codec_factor
    vol_factor = max(0.03, min(1.6, vol_factor))
    est_saving = round((1 - vol_factor) * 100)
    if vb > 0 and dur > 0:
        est_out_bytes = int(vb * vol_factor * dur / 8)
    else:
        est_out_bytes = int(size * vol_factor)

    # 4) 建议文案（唯一来源，前端只负责渲染）
    mbps = (vb / 1_000_000) if vb > 0 else None
    scale_label = {"original": "原始分辨率", "1080": "1080p", "720": "720p", "480": "480p"}.get(rec_scale, "原始分辨率")
    tips: list[str] = []
    if low_rate:
        tips.append(f"源码率仅 {mbps:.2f} Mbps，已很紧凑，建议轻微压缩或保持原画质")
    elif high_rate:
        tips.append(f"源码率 {mbps:.2f} Mbps，压缩空间大，可放心压到 CRF {rec_crf}")
    else:
        tips.append(f"质量滑块设为 {rec_crf} 可兼顾清晰度与体积")
    if src_is_hevc and vcodec_out != "hevc":
        tips.append("HEVC 源将转码为 H.264 以保证浏览器/设备通用播放，体积可能略有增大")
    elif not src_is_hevc and vcodec_out == "hevc":
        tips.append("H.264 源转 HEVC，体积可再减约 30%，但仅 Safari/部分设备可播")
    elif src_is_hevc and vcodec_out == "hevc" and actual_crf != rec_crf:
        tips.append(f"后端自动等效偏移 +{actual_crf - rec_crf}，实际编码 CRF ≈ {actual_crf}")
    if is_4k:
        tips.append("4K 源建议降到 1080p，体积可减 60% 以上，观感几乎不变")
    elif rec_scale == "720":
        tips.append("建议降到 720p，画质损失小，体积再减约 40%")
    if dur > 600:
        tips.append("长视频建议用「慢」或更高预设，编码更充分且文件更小")

    # 条内一句话摘要（优先级：分辨率建议 > 码率提示 > 转码说明）
    if is_4k:
        summary = "4K 源建议降到 1080p，体积可减 60% 以上"
    elif rec_scale == "720":
        summary = "建议降到 720p，体积再减约 40%"
    elif low_rate:
        summary = f"源码率仅 {mbps:.2f} Mbps，建议轻微压缩或保持原画质"
    elif high_rate:
        summary = f"源码率 {mbps:.2f} Mbps，可放心压到 CRF {rec_crf}"
    elif src_is_hevc and vcodec_out != "hevc":
        summary = f"转 H.264 保证浏览器通用，CRF {rec_crf} 兼顾体积"
    else:
        summary = f"设为 CRF {rec_crf} 可兼顾清晰度与体积"

    return {
        "codec_label": codec_label,
        "src_is_hevc": src_is_hevc,
        "out_is_hevc": vcodec_out == "hevc",
        "rec_crf": rec_crf,
        "actual_crf": actual_crf,
        "rec_scale": rec_scale,
        "rec_scale_label": scale_label,
        "est_saving": est_saving,
        "est_up": est_saving < 0,
        "est_out_size": est_out_bytes,
        "est_out_human": human_size(est_out_bytes),
        "src_size": size,
        "src_size_human": meta.get("size_human", ""),
        "low_rate": low_rate,
        "high_rate": high_rate,
        "is_4k": is_4k,
        "tips": tips,
        "summary": summary,
    }


@app.route("/api/compress", methods=["POST"])
def api_compress():
    data = request.json
    file_id = secure_filename(data["file_id"])
    src = UPLOAD_DIR / file_id
    if not src.exists():
        return jsonify({"error": "源文件不存在"}), 404
    meta = get_media_meta(str(src))
    preset = data.get("preset", "medium")
    crf = int(data.get("crf", 23))
    scale = data.get("scale", "original")  # original | 1080 | 720 | 480
    faststart = bool(data.get("faststart", False))
    vcodec = (meta.get("video_codec") or "").lower()
    src_is_hevc = vcodec in ("hevc", "h265", "h.265")
    # 输出编码：默认 h264 —— 所有浏览器(Chrome/Firefox/Safari/Edge)与设备都能播，
    # 兼容性最好；可选 hevc —— 体积更小，但仅 Safari/iOS/部分浏览器可解码。
    vcodec_out = (data.get("vcodec") or "h264").lower()
    if vcodec_out == "hevc":
        enc = "libx265"
        codec_label = "HEVC"
        # HEVC 源同编码再压：x265 同 CRF 比 x264 更保真，基础偏移 +6 才接近同视觉
        # 质量；源码率已很低(< 2Mbps)时再 +10，避免重新编码后文件反增。
        # H.264→HEVC 转码本身更省空间，直接用用户 CRF 即可，无需偏移。
        if src_is_hevc:
            offset = 6 + (10 if int(meta.get("video_bitrate") or 0) < 2000000 else 0)
            use_crf = crf + offset
        else:
            use_crf = crf
        # libx265 默认输出 hev1 codec tag，Apple 播放器(QuickTime/Safari)解不出
        # 画面(表现为只有音频)，强制 hvc1 保证 macOS/iOS 兼容。
        force_tag = True
    else:
        enc = "libx264"
        use_crf = crf
        codec_label = "H.264"
        force_tag = False
    out = OUTPUT_DIR / f"comp_{src.stem}_{int(time.time())}.mp4"
    args = ["-i", str(src), "-c:v", enc, "-preset", preset,
            "-crf", str(use_crf)]
    if force_tag:
        args += ["-tag:v", "hvc1"]
    if scale != "original":
        args += ["-vf", f"scale=-2:{scale}"]
    # 音频：源音频码率已低于 128k 时直接 copy，避免强行升码率导致文件反增；
    # 否则统一重编码为 AAC 128k。
    src_a_bitrate = int(meta.get("audio_bitrate") or 0)
    if src_a_bitrate and src_a_bitrate < 128000:
        args += ["-c:a", "copy"]
    else:
        args += ["-c:a", "aac", "-b:a", "128k"]
    args = _finalize(args, out, faststart)
    task_id = new_task(
        f"压缩 {codec_label} (CRF {use_crf})",
        duration=meta.get("duration", 0),
        output_name=out.name,
        extra={
            "kind": "compress",
            "src_name": file_id,  # 源文件名称，用于任务卡片展示
            # 源信息：压缩完成后用于与输出做对比展示
            "src_size": int(meta.get("size") or 0),
            "src_size_human": meta.get("size_human", ""),
            "src_codec": meta.get("video_codec", ""),
            "src_resolution": f'{meta.get("width")}x{meta.get("height")}'
            if meta.get("width")
            else "",
        },
    )
    start_task(task_id, args, meta.get("duration", 0), OUTPUT_DIR)
    return jsonify({"task_id": task_id})


@app.route("/api/compress_suggest", methods=["POST"])
def api_compress_suggest():
    """返回压缩智能建议与预估（前端智能建议的唯一权威来源）。"""
    data = request.json or {}
    file_id = secure_filename(data.get("file_id", ""))
    src = UPLOAD_DIR / file_id
    if not src.exists():
        return jsonify({"error": "源文件不存在"}), 404
    meta = get_media_meta(str(src))
    vcodec_out = (data.get("vcodec") or "h264").lower()
    return jsonify(suggest_compress(meta, vcodec_out))


@app.route("/api/crop", methods=["POST"])
def api_crop():
    data = request.json
    file_id = secure_filename(data["file_id"])
    src = UPLOAD_DIR / file_id
    if not src.exists():
        return jsonify({"error": "源文件不存在"}), 404
    meta = get_media_meta(str(src))
    x = data.get("x", 0)
    y = data.get("y", 0)
    w = data.get("w") or meta.get("width")
    h = data.get("h") or meta.get("height")
    faststart = bool(data.get("faststart", False))
    out = OUTPUT_DIR / f"crop_{src.stem}_{int(time.time())}{src.suffix}"
    vf = f"crop={w}:{h}:{x}:{y}"
    args = ["-i", str(src), "-vf", vf, "-c:a", "copy"]
    args = _finalize(args, out, faststart)
    task_id = new_task(f"裁剪 {w}x{h}", duration=meta.get("duration", 0))
    TASKS[task_id]["output_name"] = out.name
    save_tasks()
    start_task(task_id, args, meta.get("duration", 0), OUTPUT_DIR)
    return jsonify({"task_id": task_id})


# ---------------- 合并拼接 ----------------
@app.route("/api/merge", methods=["POST"])
def api_merge():
    data = request.json
    faststart = bool(data.get("faststart", False))
    file_ids = [secure_filename(f) for f in data.get("file_ids", [])]
    if len(file_ids) < 2:
        return jsonify({"error": "请至少选择 2 个文件进行合并"}), 400
    paths = [UPLOAD_DIR / f for f in file_ids]
    for p in paths:
        if not p.exists():
            return jsonify({"error": f"文件不存在: {p.name}"}), 404
    # 生成 concat 列表文件
    list_file = OUTPUT_DIR / f"merge_list_{int(time.time())}.txt"
    list_file.write_text(
        "\n".join(f"file '{p.resolve()}'" for p in paths), encoding="utf-8"
    )
    suffix = Path(file_ids[0]).suffix or ".mp4"
    out = OUTPUT_DIR / f"merge_{int(time.time())}{suffix}"
    # 统一编码避免拼接黑屏/音画不同步: 重编码为 h264+aac
    args = ["-f", "concat", "-safe", "0", "-i", str(list_file),
            "-c:v", "libx264", "-c:a", "aac", "-b:a", "128k"]
    args = _finalize(args, out, faststart)
    duration = sum(get_media_meta(str(p)).get("duration", 0) for p in paths)
    task_id = new_task(f"合并 {len(file_ids)} 个文件", duration=duration)
    TASKS[task_id]["output_name"] = out.name
    save_tasks()
    start_task(task_id, args, duration, OUTPUT_DIR)
    return jsonify({"task_id": task_id})


# ---------------- 旋转 / 翻转 ----------------
@app.route("/api/rotate", methods=["POST"])
def api_rotate():
    data = request.json
    file_id = secure_filename(data["file_id"])
    src = UPLOAD_DIR / file_id
    if not src.exists():
        return jsonify({"error": "源文件不存在"}), 404
    meta = get_media_meta(str(src))
    rot = int(data.get("rotation", 0))  # 0 90 180 270
    flip_h = bool(data.get("flip_h", False))
    flip_v = bool(data.get("flip_v", False))
    faststart = bool(data.get("faststart", False))
    # 转置矩阵: transpose 需要配rotation
    vf_parts = []
    # ffmpeg transpose: 0=90CW, 1=90CCW, 2=90CW+flipV, 3=90CCW+flipV
    if rot == 90:
        vf_parts.append("transpose=1")
    elif rot == 180:
        vf_parts.append("transpose=1,transpose=1")
    elif rot == 270:
        vf_parts.append("transpose=2")
    if flip_h:
        vf_parts.append("hflip")
    if flip_v:
        vf_parts.append("vflip")
    if not vf_parts:
        return jsonify({"error": "请选择旋转或翻转操作"}), 400
    out = OUTPUT_DIR / f"rot_{src.stem}_{int(time.time())}{src.suffix}"
    vf = ",".join(vf_parts)
    args = ["-i", str(src), "-vf", vf, "-c:a", "copy"]
    args = _finalize(args, out, faststart)
    task_id = new_task(f"旋转 {rot}°" + ("+翻转" if (flip_h or flip_v) else ""),
                       duration=meta.get("duration", 0))
    TASKS[task_id]["output_name"] = out.name
    save_tasks()
    start_task(task_id, args, meta.get("duration", 0), OUTPUT_DIR)
    return jsonify({"task_id": task_id})


# ---------------- 加水印 ----------------
@app.route("/api/watermark", methods=["POST"])
def api_watermark():
    data = request.json
    file_id = secure_filename(data["file_id"])
    src = UPLOAD_DIR / file_id
    if not src.exists():
        return jsonify({"error": "源文件不存在"}), 404
    meta = get_media_meta(str(src))
    wm_type = data.get("type", "text")  # text | image
    pos = data.get("position", "br")    # tl tr bl br c
    margin = int(data.get("margin", 20))
    faststart = bool(data.get("faststart", False))
    # 位置映射为 overlay 表达式
    pos_map = {
        "tl": f"{margin}:{margin}",
        "tr": f"W-w-{margin}:{margin}",
        "bl": f"{margin}:H-h-{margin}",
        "br": f"W-w-{margin}:H-h-{margin}",
        "c": "(W-w)/2:(H-h)/2",
    }
    out = OUTPUT_DIR / f"wm_{src.stem}_{int(time.time())}{src.suffix}"
    if wm_type == "text":
        text = data.get("text", "Watermark")
        fontsize = int(data.get("fontsize", 36))
        color = data.get("color", "white")
        alpha = float(data.get("alpha", 0.7))
        # 转义单引号
        text = text.replace("'", "'\\''")
        # drawtext 内部的 x/y 坐标中的 ':' 在 filtergraph 中必须转义为 '\:'
        # 注意：先按裸 ':' 拆分 x/y，再各自转义，避免把已转义的 '\:' 误判为分隔符
        x_expr, _, y_expr = pos_map.get(pos, pos_map["br"]).partition(":")
        x_expr = x_expr.replace(":", r"\:")
        y_expr = y_expr.replace(":", r"\:")
        draw = (f"drawtext=text='{text}':fontsize={fontsize}"
                f":fontcolor={color}@{alpha}:x={x_expr}:y={y_expr}")
        args = ["-i", str(src), "-vf", draw, "-c:a", "copy"]
        args = _finalize(args, out, faststart)
        task_id = new_task(f"文字水印: {text[:12]}", duration=meta.get("duration", 0))
    else:
        wm_file = request.files.get("watermark") if False else None
        # 图片水印通过单独上传接口
        wm_id = data.get("watermark_id")
        if not wm_id:
            return jsonify({"error": "请先上传水印图片"}), 400
        wmp = UPLOAD_DIR / secure_filename(wm_id)
        if not wmp.exists():
            return jsonify({"error": "水印图片不存在"}), 404
        scale_w = data.get("scale_w")
        # 图片作为第二个输入流 [1:v], 用 filter_complex 叠加
        # scale_w 需为 >0 的整数；空字符串 / "0" / 非法值时回退为不缩放，
        # 否则 scale=0:-1 会触发 "Picture size 0x0 is invalid"
        if scale_w:
            try:
                sw = int(scale_w)
            except (TypeError, ValueError):
                sw = 0
            if sw > 0:
                filt = (f"[1:v]scale={sw}:-1[wm];"
                        f"[0:v][wm]overlay={overlay}")
            else:
                filt = f"[0:v][1:v]overlay={overlay}"
        else:
            filt = f"[0:v][1:v]overlay={overlay}"
        args = ["-i", str(src), "-i", str(wmp), "-filter_complex",
                filt, "-c:a", "copy"]
        args = _finalize(args, out, faststart)
        task_id = new_task(f"图片水印", duration=meta.get("duration", 0))
    TASKS[task_id]["output_name"] = out.name
    save_tasks()
    start_task(task_id, args, meta.get("duration", 0), OUTPUT_DIR)
    return jsonify({"task_id": task_id})


# 水印图片上传（复用 uploads 目录）
@app.route("/api/upload_watermark", methods=["POST"])
def api_upload_watermark():
    if "file" not in request.files:
        return jsonify({"error": "未找到文件"}), 400
    f = request.files["file"]
    if f.filename == "":
        return jsonify({"error": "文件名为空"}), 400
    filename = secure_filename(f.filename)
    target = UPLOAD_DIR / filename
    i = 1
    while target.exists():
        target = UPLOAD_DIR / f"{Path(filename).stem}_{i}{Path(filename).suffix}"
        i += 1
    f.save(str(target))
    return jsonify({"watermark_id": target.name, "filename": target.name})


# ---------------- 调速 / 倒放 ----------------
@app.route("/api/speed", methods=["POST"])
def api_speed():
    data = request.json
    file_id = secure_filename(data["file_id"])
    src = UPLOAD_DIR / file_id
    if not src.exists():
        return jsonify({"error": "源文件不存在"}), 404
    meta = get_media_meta(str(src))
    speed = float(data.get("speed", 1.0))
    if speed <= 0:
        return jsonify({"error": "速度需大于 0"}), 400
    reverse = bool(data.get("reverse", False))
    faststart = bool(data.get("faststart", False))
    out = OUTPUT_DIR / f"speed_{src.stem}_{int(time.time())}{src.suffix}"
    # setpts 控制视频速度，atempo 控制音频速度（最大2x，可链式）
    pts = 1.0 / speed
    vf = f"setpts={pts:.4f}*PTS"
    # atempo 链
    atempo = speed
    chain = []
    while atempo > 2.0:
        chain.append(2.0)
        atempo /= 2.0
    while atempo < 0.5:
        chain.append(0.5)
        atempo *= 2.0
    chain.append(round(atempo, 4))
    af = "atempo=" + ",atempo=".join(str(c) for c in chain)
    if reverse:
        af = "areverse," + af
        vf = "reverse," + vf
    args = ["-i", str(src), "-vf", vf, "-af", af]
    args = _finalize(args, out, faststart)
    task_id = new_task(f"调速 {speed}x" + (" · 倒放" if reverse else ""),
                       duration=meta.get("duration", 0) / speed)
    TASKS[task_id]["output_name"] = out.name
    save_tasks()
    start_task(task_id, args, meta.get("duration", 0), OUTPUT_DIR)
    return jsonify({"task_id": task_id})


# ---------------- 去除字幕/硬字幕 ----------------
@app.route("/api/desubtitle", methods=["POST"])
def api_desubtitle():
    data = request.json
    file_id = secure_filename(data["file_id"])
    src = UPLOAD_DIR / file_id
    if not src.exists():
        return jsonify({"error": "源文件不存在"}), 404
    meta = get_media_meta(str(src))
    vw = meta.get("width") or 0
    vh = meta.get("height") or 0
    mode = data.get("mode", "delogo")
    # 字幕多位于画面中下部，默认遮盖底部 1/3 区域；坐标/尺寸可手动指定
    x = int(data.get("x", 0) or 0)
    y = int(data.get("y", 0) or (vh * 2 // 3 if vh else 0))
    w = int(data.get("w", 0) or vw)
    h = int(data.get("h", 0) or (vh // 3 if vh else 0))
    # 保证区域不越界且为偶数（部分滤镜要求）
    w = max(2, min(w, vw - x)) if vw else w
    h = max(2, min(h, vh - y)) if vh else h
    w -= w % 2
    h -= h % 2

    if mode == "inpaint":
        # 内容感知修复：逐帧用 OpenCV inpaint 重建被遮盖区域（最接近无痕）
        radius = max(1, int(data.get("radius", 6) or 6))
        quality = data.get("quality", "standard")
        if quality not in ("standard", "high"):
            quality = "standard"
        out = OUTPUT_DIR / f"desub_{src.stem}_{int(time.time())}{src.suffix}"
        qlabel = "智能修复" if quality == "standard" else "智能修复(高质量)"
        task_id = new_task(f"去字幕({qlabel}) {w}x{h}@{x},{y}",
                           duration=meta.get("duration", 0),
                           output_name=out.name,
                           extra={"quality": quality})
        save_tasks()
        import threading
        threading.Thread(
            target=run_inpaint,
            args=(str(src), str(out), x, y, w, h, radius, task_id, quality),
            daemon=True,
        ).start()
        return jsonify({"task_id": task_id})

    if mode == "mosaic":
        block = max(2, int(data.get("strength", 16) or 16))
        region = (f"crop={w}:{h}:{x}:{y},"
                  f"scale=iw/{block}:ih/{block},"
                  f"scale={w}:{h}:flags=neighbor")
        tag = f"马赛克块{block}"
    elif mode == "blur":
        sigma = max(1.0, float(data.get("strength", 12) or 12))
        region = f"crop={w}:{h}:{x}:{y},gblur=sigma={sigma:.1f}"
        tag = f"模糊σ{sigma:.0f}"
    else:  # delogo：基于周边像素平滑插值，比模糊自然
        # strength 作为向外扩展的羽化边距（像素），让边缘过渡更自然
        pad = max(0, int(data.get("strength", 8) or 8))
        # delogo 要求区域四周至少留 2px 余量（否则报 outside of frame）
        dx = max(2, x - pad)
        dy = max(2, y - pad)
        dw = min((vw - 2 - dx) if vw else (w + pad * 2), w + pad * 2)
        dh = min((vh - 2 - dy) if vh else (h + pad * 2), h + pad * 2)
        dw = max(4, dw); dh = max(4, dh)
        vf = f"delogo=x={dx}:y={dy}:w={dw}:h={dh}"
        tag = f"边缘修复{pad}"
        out = OUTPUT_DIR / f"desub_{src.stem}_{int(time.time())}{src.suffix}"
        args = ["-i", str(src), "-vf", vf, "-c:a", "copy", str(out)]
        task_id = new_task(f"去字幕({tag}) {w}x{h}@{x},{y}",
                           duration=meta.get("duration", 0))
        TASKS[task_id]["output_name"] = out.name
        save_tasks()
        start_task(task_id, args, meta.get("duration", 0), OUTPUT_DIR)
        return jsonify({"task_id": task_id})

    vf = f"[0:v]split=2[full][r];[r]{region}[proc];[full][proc]overlay={x}:{y}"
    out = OUTPUT_DIR / f"desub_{src.stem}_{int(time.time())}{src.suffix}"
    args = ["-i", str(src), "-vf", vf, "-c:a", "copy", str(out)]
    task_id = new_task(f"去字幕({tag}) {w}x{h}@{x},{y}",
                       duration=meta.get("duration", 0))
    TASKS[task_id]["output_name"] = out.name
    save_tasks()
    start_task(task_id, args, meta.get("duration", 0), OUTPUT_DIR)
    return jsonify({"task_id": task_id})


@app.route("/api/tasks")
def api_tasks():
    tasks = sorted(TASKS.values(), key=lambda t: t.get("created_at", 0), reverse=True)
    return jsonify({"tasks": tasks})


@app.route("/api/tasks/stream")
def api_tasks_stream():
    """SSE 端点：实时推送任务列表变更，替代前端轮询。"""
    import queue as _queue

    q = _queue.Queue(maxsize=512)
    _SSE_SUBSCRIBERS.add(q)

    def gen():
        try:
            # 首帧立即推送当前状态
            yield "data: " + json.dumps(
                sorted(TASKS.values(), key=lambda t: t.get("created_at", 0), reverse=True),
                ensure_ascii=False,
            ) + "\n\n"
            last = None
            while True:
                try:
                    payload = q.get(timeout=15)
                except _queue.Empty:
                    # 心跳保活
                    yield ": ping\n\n"
                    continue
                if payload == last:
                    continue
                last = payload
                yield "data: " + payload + "\n\n"
        finally:
            _SSE_SUBSCRIBERS.discard(q)

    return Response(
        gen(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/task/<task_id>")
def api_task(task_id):
    task = TASKS.get(task_id)
    if not task:
        abort(404)
    return jsonify(task)


@app.route("/api/task/<task_id>/cancel", methods=["POST"])
def api_task_cancel(task_id):
    """取消运行中的任务（前端取消按钮入口）。"""
    task = TASKS.get(task_id)
    if not task:
        return jsonify({"error": "任务不存在"}), 404
    if task.get("status") in ("running", "queued"):
        cancel_task(task_id)
    return jsonify({"ok": True})


@app.route("/api/task/<task_id>/delete", methods=["POST"])
def api_task_delete(task_id):
    """删除任务记录，可选一并删除输出文件。运行中的任务会先被强制取消。"""
    task = TASKS.get(task_id)
    if not task:
        return jsonify({"error": "任务不存在"}), 404
    # 进行中/排队的任务：先强制取消其 ffmpeg 子进程，再删除
    if task.get("status") in ("running", "queued"):
        cancel_task(task_id)
    # 删除输出文件（仅限 outputs 目录内，防越权）
    out_name = task.get("output_name")
    if out_name:
        p = (OUTPUT_DIR / secure_filename(out_name))
        if p.exists() and p.parent == OUTPUT_DIR:
            try:
                p.unlink()
            except OSError:
                pass
    out_dir = task.get("output_dir")
    if out_dir:
        d = pathlib.Path(out_dir)
        if d.exists() and str(d).startswith(str(OUTPUT_DIR)):
            try:
                shutil.rmtree(d, ignore_errors=True)
            except OSError:
                pass
    TASKS.pop(task_id, None)
    save_tasks()
    return jsonify({"ok": True})


@app.route("/api/download/<file_id>")
def api_download(file_id):
    # file_id 可以是 outputs 下的文件名
    p = OUTPUT_DIR
    target = p / secure_filename(file_id)
    if not target.exists():
        abort(404)
    return send_file(str(target), as_attachment=True)


@app.route("/api/download_dir/<task_id>")
def api_download_dir(task_id):
    """将某个任务输出的目录打包为 zip 下载"""
    import zipfile
    task = TASKS.get(task_id)
    if not task or not task.get("output_dir"):
        abort(404)
    d = Path(task["output_dir"])
    if not d.exists():
        abort(404)
    zip_path = OUTPUT_DIR / f"{task_id}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in d.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(d))
    return send_file(str(zip_path), as_attachment=True)


@app.route("/api/delete_upload/<file_id>", methods=["POST"])
def api_delete_upload(file_id):
    # file_id 来自可信的 api/files 列表，直接用 base 名拼接并防目录穿越
    name = os.path.basename(file_id)
    p = UPLOAD_DIR / name
    if p.exists() and p.parent == UPLOAD_DIR:
        p.unlink()
    return jsonify({"ok": True})


@app.route("/api/delete_uploads", methods=["POST"])
def api_delete_uploads():
    """批量删除上传文件"""
    data = request.json or {}
    ids = data.get("file_ids", [])
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "请选择要删除的文件"}), 400
    removed = []
    for fid in ids:
        name = os.path.basename(fid)
        p = UPLOAD_DIR / name
        if p.exists() and p.is_file() and p.parent == UPLOAD_DIR:
            try:
                p.unlink()
                removed.append(fid)
            except OSError:
                pass
    # 若当前选中的被删文件正好在删除列表，则清空当前选择
    return jsonify({"ok": True, "removed": removed, "count": len(removed)})


@app.route("/api/tasks/delete", methods=["POST"])
def api_tasks_delete():
    """批量删除任务。运行中的任务会先被强制取消，再删除。"""
    data = request.json or {}
    ids = data.get("task_ids", [])
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "请选择要删除的任务"}), 400
    deleted = []
    for task_id in ids:
        task = TASKS.get(task_id)
        if not task:
            continue
        # 进行中/排队的任务：先强制取消，再删除
        if task.get("status") in ("running", "queued"):
            cancel_task(task_id)
        out_name = task.get("output_name")
        if out_name:
            p = (OUTPUT_DIR / secure_filename(out_name))
            if p.exists() and p.parent == OUTPUT_DIR:
                try:
                    p.unlink()
                except OSError:
                    pass
        out_dir = task.get("output_dir")
        if out_dir:
            d = Path(out_dir)
            if d.exists() and str(d).startswith(str(OUTPUT_DIR)):
                try:
                    shutil.rmtree(d, ignore_errors=True)
                except OSError:
                    pass
        TASKS.pop(task_id, None)
        deleted.append(task_id)
    save_tasks()
    return jsonify({"ok": True, "deleted": deleted, "count": len(deleted)})


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_static(path):
    # 仅服务 Vite 构建产物（dist/，文件名带内容哈希，天然无缓存问题）。
    # 旧的原生 JS 前端（static/index.html 等）已废弃移除，不再回退。
    if not DIST_DIR.exists():
        abort(404)
    dist_file = DIST_DIR / path
    if path and dist_file.exists() and dist_file.is_file():
        return send_from_directory(str(DIST_DIR), path)
    # SPA fallback：仅对「无扩展名」的路径（真正的应用路由）返回
    # index.html。带扩展名但缺失的资源（如旧哈希 JS）必须返回 404，
    # 否则会错误地返回 HTML，导致浏览器报
    # "Expected a JavaScript module ... but got text/html" 的 MIME 错误。
    index = DIST_DIR / "index.html"
    if index.exists() and not Path(path).suffix:
        resp = send_from_directory(str(DIST_DIR), "index.html")
        resp.headers["Cache-Control"] = "no-cache"
        return resp
    abort(404)


# 直接以文件路径形式提供上传/输出文件，供 <video src>、直接下载等场景使用。
# 仅允许访问对应目录下的真实文件（防目录穿越）。
@app.route("/favicon.ico")
@app.route("/favicon.svg")
def serve_favicon():
    fav = STATIC_DIR / "favicon.svg"
    if not fav.exists():
        abort(404)
    return send_from_directory(str(STATIC_DIR), "favicon.svg", mimetype="image/svg+xml")


@app.route("/uploads/<path:filename>")
def serve_upload(filename: str):
    safe = os.path.basename(filename)
    return send_from_directory(str(UPLOAD_DIR), safe, as_attachment=False)


@app.route("/outputs/<path:filename>")
def serve_output(filename: str):
    safe = os.path.basename(filename)
    return send_from_directory(str(OUTPUT_DIR), safe, as_attachment=False)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    if not ensure_ffmpeg():
        # 启动自检失败：给出安装指引后退出（非 0 退出码便于 start.sh 感知）
        raise SystemExit(1)
    print(f"ClipBench 已启动: http://127.0.0.1:{port}")
    # 注意：macOS 的「隔空播放接收器」默认占用 5000 端口，会与本服务冲突，
    # 导致浏览器访问根路径收到 403（AirPlay 拦截）。如遇 403，请到
    # 系统设置 → 通用 → 隔空播放接收器 中关闭，或改用其他端口（PORT 环境变量）。
    if _HAS_IMAGEIO_FFMPEG and _FFMPEG_BIN and "imageio" in _FFMPEG_BIN:
        print("ffmpeg: 使用 imageio-ffmpeg 提供的静态二进制（无需本地安装）")
    else:
        print(f"ffmpeg: {get_ffmpeg_version()}")
    app.run(host="127.0.0.1", port=port, debug=False)
