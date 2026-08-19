"""ClipBench 后端自动化测试：单元测试 + Flask API 集成测试。

运行：
    . .venv/bin/activate
    pip install -r requirements-dev.txt
    python -m pytest tests/ -v
"""
import io
import pathlib
import subprocess
import time

import pytest

import app as app_module
from app import (
    ALLOWED_EXT,
    TASKS,
    _finalize,
    allowed_file,
    app,
    human_size,
    new_task,
    parse_time_to_seconds,
    validate_segments,
)

app.config["TESTING"] = True


# ---------- 公共工具 ----------

def _upload(client, path):
    with path.open("rb") as f:
        return client.post(
            "/api/upload",
            data={"file": (f, path.name)},
            content_type="multipart/form-data",
        )


def _wait_task(task_id, timeout=60.0):
    """轮询等待任务结束，返回最终任务字典（超时返回 None）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        t = TASKS.get(task_id)
        if t and t.get("status") not in ("running", "queued"):
            return t
        time.sleep(0.2)
    return TASKS.get(task_id)


@pytest.fixture()
def client():
    return app.test_client()


@pytest.fixture(scope="session")
def sample_video(tmp_path_factory):
    """生成一段 2 秒 160x90 的测试视频（无可用 ffmpeg 时跳过）。"""
    try:
        ff = app_module.get_ffmpeg()
    except Exception as exc:
        pytest.skip(f"未找到可用的 ffmpeg：{exc}")
    p = tmp_path_factory.mktemp("media") / "sample.mp4"
    # 首选 libx264 + aac；精简版 ffmpeg 缺少编码器时回退到 mpeg4
    attempts = [
        [ff, "-y", "-hide_banner", "-loglevel", "error",
         "-f", "lavfi", "-i", "testsrc=duration=2:size=160x90:rate=10",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-shortest", str(p)],
        [ff, "-y", "-hide_banner", "-loglevel", "error",
         "-f", "lavfi", "-i", "testsrc=duration=2:size=160x90:rate=10",
         "-c:v", "mpeg4", str(p)],
    ]
    last_err = ""
    for cmd in attempts:
        r = subprocess.run(cmd, capture_output=True, timeout=120)
        if r.returncode == 0 and p.exists() and p.stat().st_size > 0:
            return p
        last_err = r.stderr.decode("utf-8", errors="ignore")[:300]
    pytest.skip(f"无法生成测试视频: {last_err}")


# ---------- 单元测试 ----------

def test_human_size():
    assert human_size(None) == "0 B"
    assert human_size(0) == "0.0 B"
    assert human_size(1023) == "1023.0 B"
    assert human_size(1536) == "1.5 KB"
    assert human_size(5 * 1024 * 1024) == "5.0 MB"
    assert human_size(2 * 1024**3) == "2.0 GB"


def test_parse_time_to_seconds():
    assert parse_time_to_seconds(None) is None
    assert parse_time_to_seconds("") is None
    assert parse_time_to_seconds("abc") is None
    assert parse_time_to_seconds("90") == 90.0
    assert parse_time_to_seconds("01:30") == 90.0
    assert parse_time_to_seconds("1:02:03.5") == 3723.5
    assert parse_time_to_seconds(45) == 45.0


def test_validate_segments():
    clean, err = validate_segments([], 10)
    assert err == "请至少添加一个片段"
    assert clean == []

    clean, err = validate_segments([{"start": "0:00", "end": "0:05"}], 10)
    assert err is None
    assert clean == [(0.0, 5.0)]

    _, err = validate_segments([{"start": "bad", "end": "1"}], 10)
    assert "格式不正确" in err

    # 负数字符串无法被解析为时间，按格式错误处理
    _, err = validate_segments([{"start": "-1", "end": "2"}], 10)
    assert "格式不正确" in err

    _, err = validate_segments([{"start": "5", "end": "5"}], 10)
    assert "结束时间需大于开始时间" in err

    _, err = validate_segments([{"start": "0", "end": "20"}], 10)
    assert "超过视频总时长" in err

    _, err = validate_segments([{"start": "30", "end": ""}], 10)
    assert "超过视频总时长" in err


def test_allowed_file():
    assert allowed_file("a.mp4")
    assert allowed_file("a.MP4")  # 大小写不敏感
    assert not allowed_file("a.exe")
    assert not allowed_file("noext")
    assert {"mp4", "mov", "mkv", "webm"} <= ALLOWED_EXT


def test_finalize_faststart():
    base = ["-i", "in.mp4", "-c", "copy"]
    res = _finalize(list(base), pathlib.Path("out.mp4"), faststart=True)
    assert res[-1] == str(pathlib.Path("out.mp4"))
    assert "-movflags" in res and "+faststart" in res

    res = _finalize(list(base), pathlib.Path("out.mkv"), faststart=True)
    assert "-movflags" not in res  # mkv 为流式容器，不适用

    res = _finalize(list(base), pathlib.Path("out2.mp4"))
    assert "-movflags" not in res  # 默认不开启


# ---------- 基础 API ----------

def test_api_version(client):
    r = client.get("/api/version")
    assert r.status_code == 200
    data = r.get_json()
    assert "ffmpeg" in data  # 包含 ffmpeg 版本信息


def test_api_files_empty(client):
    r = client.get("/api/files")
    assert r.status_code == 200
    data = r.get_json()
    assert "files" in data
    assert data["files"] == []


def test_api_tasks_empty(client):
    r = client.get("/api/tasks")
    assert r.status_code == 200
    data = r.get_json()
    assert "tasks" in data


def test_upload_requires_file(client):
    r = client.post("/api/upload", data={}, content_type="multipart/form-data")
    assert r.status_code == 400


def test_upload_rejects_bad_extension(client):
    r = client.post(
        "/api/upload",
        data={"file": (io.BytesIO(b"hello"), "evil.exe")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 400


def test_upload_and_meta(client, sample_video):
    r = _upload(client, sample_video)
    assert r.status_code == 200, r.get_data(as_text=True)
    data = r.get_json()
    fid = data["file_id"]
    assert data["meta"]["has_video"] is True
    assert data["meta"]["video_codec"] in ("h264", "mpeg4", "hevc")

    # 文件列表中也应包含相同信息
    r2 = client.get("/api/files")
    files = r2.get_json()["files"]
    assert any(f["file_id"] == fid for f in files)


def test_upload_duplicate_renames(client, sample_video):
    r1 = _upload(client, sample_video)
    r2 = _upload(client, sample_video)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.get_json()["file_id"] != r2.get_json()["file_id"]


def test_file_info_404(client):
    assert client.get("/api/file/nope.mp4").status_code == 404


def test_delete_uploads(client, sample_video):
    r = _upload(client, sample_video)
    fid = r.get_json()["file_id"]
    r = client.post("/api/delete_uploads", json={"file_ids": [fid]})
    assert r.status_code == 200
    files = client.get("/api/files").get_json()["files"]
    assert all(f["file_id"] != fid for f in files)


# ---------- 任务 / SSE ----------

def test_task_404(client):
    assert client.get("/api/task/nonexistent").status_code == 404


def test_task_cancel(client):
    tid = new_task("测试任务")
    r = client.post(f"/api/task/{tid}/cancel")
    assert r.status_code == 200
    assert TASKS[tid]["status"] == "cancelled"


def test_task_delete(client):
    tid = new_task("测试任务")
    r = client.post(f"/api/task/{tid}/delete")
    assert r.status_code == 200
    assert r.get_json()["ok"] is True
    assert tid not in TASKS


def test_tasks_stream_sse(client):
    r = client.get("/api/tasks/stream", buffered=False)
    assert r.status_code == 200
    assert r.mimetype == "text/event-stream"
    # 首帧立即返回当前任务快照
    chunk = next(iter(r.response))
    assert chunk.startswith(b"data: ")
    r.close()


# ---------- 各功能参数校验 ----------

def test_split_requires_existing_file(client):
    r = client.post("/api/split", json={"file_id": "nope.mp4", "mode": "time"})
    assert r.status_code == 404


def test_split_invalid_interval(client, sample_video):
    fid = _upload(client, sample_video).get_json()["file_id"]
    r = client.post("/api/split", json={"file_id": fid, "mode": "segment", "segment": 0})
    assert r.status_code == 400


def test_split_invalid_segment(client, sample_video):
    fid = _upload(client, sample_video).get_json()["file_id"]
    r = client.post("/api/split", json={
        "file_id": fid, "mode": "time",
        "segments": [{"start": "5", "end": "1"}],
    })
    assert r.status_code == 400


def test_screenshot_requires_file(client):
    assert client.post("/api/screenshot", json={"file_id": "nope.mp4"}).status_code == 404


def test_screenshot_invalid_interval(client, sample_video):
    fid = _upload(client, sample_video).get_json()["file_id"]
    r = client.post("/api/screenshot", json={
        "file_id": fid, "mode": "every", "interval": 0,
    })
    assert r.status_code == 400


def test_convert_requires_file(client):
    assert client.post("/api/convert", json={"file_id": "nope.mp4"}).status_code == 404


def test_compress_requires_file(client):
    assert client.post("/api/compress", json={"file_id": "nope.mp4"}).status_code == 404


def test_crop_requires_file(client):
    assert client.post("/api/crop", json={"file_id": "nope.mp4"}).status_code == 404


def test_merge_requires_two(client):
    r = client.post("/api/merge", json={"file_ids": ["a.mp4"]})
    assert r.status_code == 400


def test_merge_requires_existing_files(client, sample_video):
    fid = _upload(client, sample_video).get_json()["file_id"]
    r = client.post("/api/merge", json={"file_ids": [fid, "missing.mp4"]})
    assert r.status_code == 404


def test_rotate_requires_choice(client, sample_video):
    fid = _upload(client, sample_video).get_json()["file_id"]
    # 未选旋转角度也未选翻转 -> 400
    r = client.post("/api/rotate", json={"file_id": fid})
    assert r.status_code == 400


def test_speed_invalid(client, sample_video):
    fid = _upload(client, sample_video).get_json()["file_id"]
    r = client.post("/api/speed", json={"file_id": fid, "speed": 0})
    assert r.status_code == 400


def test_watermark_image_requires_watermark_id(client, sample_video):
    fid = _upload(client, sample_video).get_json()["file_id"]
    r = client.post("/api/watermark", json={"file_id": fid, "type": "image"})
    assert r.status_code == 400


def test_watermark_image_not_found(client, sample_video):
    fid = _upload(client, sample_video).get_json()["file_id"]
    r = client.post("/api/watermark", json={
        "file_id": fid, "type": "image", "watermark_id": "nope.png",
    })
    assert r.status_code == 404


def test_upload_watermark_requires_file(client):
    r = client.post("/api/upload_watermark", data={}, content_type="multipart/form-data")
    assert r.status_code == 400


def test_upload_watermark_ok(client, sample_video):
    # 1x1 透明 PNG
    png = io.BytesIO(
        b"\x89PNG\r\n\x1a\n" + b"\x00" * 200
    )
    r = client.post(
        "/api/upload_watermark",
        data={"file": (png, "logo.png")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 200
    assert r.get_json()["watermark_id"]


def test_download_404(client):
    assert client.get("/api/download/nope.mp4").status_code == 404


# ---------- 端到端流程（需 ffmpeg，不可用时自动跳过） ----------

def test_split_end_to_end(client, sample_video):
    fid = _upload(client, sample_video).get_json()["file_id"]
    r = client.post("/api/split", json={
        "file_id": fid, "mode": "segment", "segment": 1,
    })
    assert r.status_code == 200
    tid = r.get_json()["task_id"]
    task = _wait_task(tid, timeout=90)
    assert task is not None, "任务超时未结束"
    assert task["status"] == "finished", task.get("error")
    out_dir = pathlib.Path(task["output_dir"])
    parts = list(out_dir.glob("*.mp4"))
    assert len(parts) >= 1
    assert all(p.stat().st_size > 0 for p in parts)


def test_screenshot_end_to_end(client, sample_video):
    fid = _upload(client, sample_video).get_json()["file_id"]
    r = client.post("/api/screenshot", json={
        "file_id": fid, "mode": "single", "time": "00:00:00.5", "format": "jpg",
    })
    assert r.status_code == 200
    tid = r.get_json()["task_id"]
    task = _wait_task(tid, timeout=90)
    assert task is not None, "任务超时未结束"
    assert task["status"] == "finished", task.get("error")
    out = pathlib.Path(app_module.OUTPUT_DIR) / task["output_name"]
    assert out.exists() and out.stat().st_size > 0
