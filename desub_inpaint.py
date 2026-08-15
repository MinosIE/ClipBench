"""去字幕 - 内容感知修复 (OpenCV inpaint)

对视频每一帧，在指定矩形区域内用 cv2.inpaint（基于周围纹理重建）抹除文字，
效果远比模糊/马赛克自然、接近无痕。需安装 opencv-python-headless。

处理采用流式管道：ffmpeg 解码原始帧 -> Python逐帧修复 -> ffmpeg 重新编码，
不落盘中间帧文件。
"""
import subprocess
import numpy as np

try:
    import cv2
except ImportError:
    cv2 = None


def _probe_video(path):
    """返回 (width, height, r_frame_rate, total_frames or None)。"""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate,nb_frames,duration",
         "-of", "default=noprint_wrappers=1", path],
        capture_output=True, text=True,
    )
    info = {}
    for line in probe.stdout.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            info[k.strip()] = v.strip()
    w = int(info.get("width", 0))
    h = int(info.get("height", 0))
    total = None
    if info.get("nb_frames") and info["nb_frames"].isdigit():
        try:
            total = int(info["nb_frames"])
        except Exception:
            total = None
    if total is None and info.get("duration"):
        try:
            fps_s = info.get("r_frame_rate", "0/1")
            num, den = (fps_s.split("/") + ["1"])[:2]
            fps = float(num) / float(den or 1)
            total = max(1, int(float(info["duration"]) * fps))
        except Exception:
            total = None
    return w, h, info.get("r_frame_rate", "30"), total


def inpaint_video(src, dst, x, y, w, h, radius=6, on_progress=None):
    """对 src 视频的 (x,y,w,h) 区域做 inpaint，输出到 dst。返回 (ok, msg)。

    on_progress(done_frames, total_frames or None, elapsed_sec) —— 进度回调，可选。
    """
    if cv2 is None:
        return False, "未安装 opencv-python，无法使用智能修复。请运行: pip install opencv-python-headless"

    vw, vh, fps_str, total = _probe_video(src)
    if not vw or not vh:
        return False, "无法获取视频尺寸"

    # 构造遮罩：向外扩张 4px 让 inpaint 能拉到边缘外纹理，
    # 再做高斯羽化避免硬边导致重建边界痕迹明显。
    pad = 4
    px0 = max(0, x - pad)
    py0 = max(0, y - pad)
    px1 = min(vw, x + w + pad)
    py1 = min(vh, y + h + pad)
    mask = np.zeros((vh, vw), dtype=np.uint8)
    mask[py0:py1, px0:px1] = 255
    # 边界羽化（柔和过渡）
    mask = cv2.GaussianBlur(mask, (15, 15), 0)
    # 归一化并二值化：内 255 / 外 0
    _, mask = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)

    reader = subprocess.Popen(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-i", src, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        stdout=subprocess.PIPE,
    )
    writer = subprocess.Popen(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{vw}x{vh}",
         "-r", fps_str, "-i", "-",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", dst],
        stdin=subprocess.PIPE,
    )

    frame_size = vw * vh * 3
    import time as _time
    started = _time.time()
    done = 0
    next_report = 0
    try:
        while True:
            raw = reader.stdout.read(frame_size)
            if not raw or len(raw) < frame_size:
                break
            frame = np.frombuffer(raw, dtype=np.uint8).reshape((vh, vw, 3))
            if np.any(mask):
                # 使用 NS（Navier-Stokes）算法 + 可调搜索半径（默认 6），
                # 对复杂纹理的重建效果优于 TELEA。
                frame = cv2.inpaint(frame, mask, radius, cv2.INPAINT_NS)
            writer.stdin.write(frame.tobytes())
            done += 1
            # 回调：每帧都调即可，回调里按时间节流避免写盘风暴
            if on_progress is not None:
                on_progress(done, total, _time.time() - started)
    except Exception as e:  # noqa
        reader.kill(); writer.kill()
        return False, f"修复过程出错: {e}"
    finally:
        reader.stdout.close()
        writer.stdin.close()
        reader.wait()
        writer.wait()

    if writer.returncode != 0:
        return False, "重新编码失败"

    # 合并原始音频
    tmp_audio = dst + ".aac"
    a = subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-i", src, "-vn", "-c:a", "copy", tmp_audio],
        capture_output=True,
    )
    if a.returncode == 0:
        final = dst.replace(".mp4", "_a.mp4")
        m = subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-i", dst, "-i", tmp_audio, "-c", "copy", "-map", "0:v:0", "-map", "1:a:0?", final],
            capture_output=True,
        )
        if m.returncode == 0:
            import os
            os.replace(final, dst)
            os.remove(tmp_audio)
    return True, ""
