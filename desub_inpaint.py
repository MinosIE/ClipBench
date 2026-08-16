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


def _detect_text_mask(gray, x, y, w, h, pad=6):
    """在 (x,y,w,h) 区域内生成字幕遮罩(255=要修)，返回与画面同尺寸的遮罩。

    策略：
      - 动态检测：亮度离群(白字/深色描边) 像素 + 闭操作连块 + 扩张（盖住细笔画/抗锯齿）；
      - 矩形兜底：当动态检测覆盖率过低(可能漏检细描边字幕)时，退化为覆盖
        整个用户框选矩形，避免字幕残留。
    字幕在移动时，每帧只遮实际出现的字幕像素，避免固定矩形盖错/漏盖。
    """
    roi = gray[y:y + h, x:x + w]
    mean, std = float(roi.mean()), float(roi.std()) + 1e-6
    # 字幕通常是亮白字(远高于背景) 或 深色描边(远低于背景)
    text = (roi > mean + 1.8 * std) | (roi < mean - 1.8 * std)
    text = text.astype(np.uint8) * 255
    # 闭操作连成块，去掉噪点；核随区域大小自适应
    k = max(3, min(11, w // 40 | 1))
    text = cv2.morphologyEx(text, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    # 适度扩张，让 inpaint 拉到字幕边缘外纹理
    text = cv2.dilate(text, np.ones((3, 3), np.uint8), iterations=2)

    coverage = text.mean() / 255.0
    # 覆盖率过低(如 <0.5%) 视为漏检，直接用整矩形遮罩兜底，保证字幕被盖掉
    if coverage < 0.005:
        text = np.ones((h, w), dtype=np.uint8) * 255
    else:
        # 纵向"列填充"：对每一列，把含文本像素的上下边界之间全部填满，
        # 盖住细笔画/抗锯齿描边。横向只填充"文本密集"的列，避免孤立噪点列被整列填满。
        col_count = text.sum(axis=0) / 255  # 每列文本像素数
        dense = col_count >= max(3, h * 0.05)  # 至少覆盖列高 5% 才算字幕列
        # 向量化求每列文本像素的 [min_row, max_row]
        Hh, Ww = text.shape
        rows = np.arange(Hh)[:, None]
        # 用累积技巧求每列首个/末个非零行
        has = (text > 0).astype(np.int32)
        # 从顶向下第一个非零
        top = np.where(has.any(axis=0), (has.cumsum(axis=0) == 1).argmax(axis=0), -1)
        # 从底向上第一个非零
        bot = np.where(has.any(axis=0), Hh - 1 - (has[::-1].cumsum(axis=0) == 1).argmax(axis=0), -1)
        filled = np.zeros_like(text)
        for c in np.where(dense)[0]:
            t = max(0, int(top[c]) - 2)
            b = min(Hh - 1, int(bot[c]) + 2)
            filled[t:b + 1, c] = 255
        text = cv2.bitwise_or(text, filled)

    mask = np.zeros(gray.shape, dtype=np.uint8)
    mask[y:y + h, x:x + w] = text
    return mask


def _temporal_fill(frames_buf, idx, mask, radius, use_flow=False):
    """时序填充：解决运动背景鬼影。

    frames_buf: 长度为 (2R+1) 的帧列表，idx 为中间帧下标 (BGR uint8)。
    - use_flow=False: 时间中值填充 + 轻量 inpaint（快，适合静止/简单背景）
    - use_flow=True: 光流对齐前后帧后一致性加权填充（慢，运动背景更连贯）
    """
    center = frames_buf[idx]
    if not np.any(mask):
        return center
    if not use_flow:
        # 标准模式：滑动窗口时间中值
        stack = np.stack([b for b in frames_buf], axis=0)
        med = np.median(stack, axis=0).astype(np.uint8)
        out = center.copy()
        out[mask > 0] = med[mask > 0]
        residual = (out != center).any(axis=2)
        if np.any(residual):
            out = cv2.inpaint(out, residual.astype(np.uint8) * 255,
                              max(1, radius // 2), cv2.INPAINT_NS)
        return out

    # 高质量模式：光流引导
    H, W = center.shape[:2]
    gray_c = cv2.cvtColor(center, cv2.COLOR_BGR2GRAY)
    # 累积融合：权重图 + 加权和
    sum_w = np.zeros((H, W), dtype=np.float32)
    sum_c = np.zeros((H, W, 3), dtype=np.float32)
    # 当前帧本身作为基准（权重最高）
    sum_w += 1.0
    sum_c += center.astype(np.float32)

    # 计算当前帧→邻帧的光流，把邻帧 warp 回来
    for j in range(len(frames_buf)):
        if j == idx:
            continue
        nbr = frames_buf[j]
        gray_n = cv2.cvtColor(nbr, cv2.COLOR_BGR2GRAY)
        # 双向流：用 center 作参考，算 center->nbr 的流场，再反向 warp nbr
        flow = cv2.calcOpticalFlowFarneback(
            gray_c, gray_n, None, 0.5, 3, 15, 3, 5, 1.2, 0)
        # 反向：把 nbr 上每个像素按 -flow 采样回 center 坐标
        fx, fy = flow[..., 0], flow[..., 1]
        ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
        mapx = (xs - fx).astype(np.float32)
        mapy = (ys - fy).astype(np.float32)
        warped = cv2.remap(nbr, mapx, mapy, cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_REFLECT)
        # 一致性权重：warp 后与原图在非遮罩区的结构越一致，权重越高
        w = np.exp(-np.abs(gray_c.astype(np.float32) -
                           cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY).astype(np.float32)) / 40.0)
        sum_w += w
        sum_c += warped.astype(np.float32) * w[:, :, None]

    fused = (sum_c / (sum_w[:, :, None] + 1e-6)).astype(np.uint8)
    out = center.copy()
    out[mask > 0] = fused[mask > 0]
    # 轻量 inpaint 消除接缝/残影
    residual = (out != center).any(axis=2)
    if np.any(residual):
        rmask = residual.astype(np.uint8) * 255
        out = cv2.inpaint(out, rmask, max(1, radius // 2), cv2.INPAINT_NS)
    return out


def inpaint_video_temporal(src, dst, x, y, w, h, radius=6, on_progress=None,
                           window=5, use_flow=False):
    """时序 + 动态遮罩修复。

    - 动态遮罩: 逐帧检测字幕文本像素(字幕移动也能跟住)
    - 时序补偿: 滑动窗口内前后帧填充 + 轻量 inpaint 兜底
    - use_flow=True 时改用光流对齐(高质量，运动背景更连贯，但慢 3~5x)
    返回 (ok, msg)。
    """
    if cv2 is None:
        return False, "未安装 opencv-python，无法使用智能修复。请运行: pip install opencv-python-headless"

    vw, vh, fps_str, total = _probe_video(src)
    if not vw or not vh:
        return False, "无法获取视频尺寸"

    x = max(0, min(x, vw - 1)); y = max(0, min(y, vh - 1))
    w = max(1, min(w, vw - x)); h = max(1, min(h, vh - y))

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
    R = max(1, window // 2)
    buf = []
    done = 0
    last_saved = 0.0
    try:
        while True:
            raw = reader.stdout.read(frame_size)
            if not raw or len(raw) < frame_size:
                break
            frame = np.frombuffer(raw, dtype=np.uint8).reshape((vh, vw, 3))
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            mask = _detect_text_mask(gray, x, y, w, h)
            buf.append((frame, mask))
            if len(buf) <= 2 * R:
                # 窗口未填满前：用已有帧中值(退化) + 单帧 inpaint
                frames = [b[0] for b in buf]
                m = buf[-1][1]
                if np.any(m):
                    med = np.median(np.stack(frames, axis=0), axis=0).astype(np.uint8)
                    out = frame.copy()
                    out[m > 0] = med[m > 0]
                    out = cv2.inpaint(out, m, radius, cv2.INPAINT_NS)
                else:
                    out = frame
            else:
                if len(buf) > 2 * R + 1:
                    buf.pop(0)
                idx = R
                out = _temporal_fill([b[0] for b in buf], idx, buf[idx][1], radius, use_flow)
            writer.stdin.write(out.tobytes())
            done += 1
            if on_progress is not None:
                now = _time.time()
                if (now - last_saved) >= 0.5:
                    pct = max(0, min(99, int(done * 100 / total))) if total else max(0, min(99, int(now - started)))
                    on_progress(done, total, now - started)
                    last_saved = now
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
