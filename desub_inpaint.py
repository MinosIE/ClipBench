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


def _detect_text_mask(gray, x, y, w, h, pad=4, bright_thr=205, dilate=11,
                      dark_thr=45, dark_dilate=4, min_area=0):
    """在用户框选矩形 (x,y,w,h) 内**自适应检测字幕像素**，返回全图遮罩(255=要修)。

    为什么不再用整矩形遮罩：
      字幕通常只占框选区域里的一两行，而框选区域（常为底部 1/3）内同时存在
      大量真实背景（水面波纹、船体、暗色块）。整矩形把背景也一并 inpaint，
      既会破坏背景纹理，又会在「字幕占满整行/多行」时因时间中值取不到干净
      背景而残留白字/暗描边。

    新策略：**只遮罩真正的字幕像素**：
      1) 在框选范围内检测亮（白）像素 -> 膨胀 dilate 覆盖抗锯齿与细描边；
      2) 同时检测暗像素（黑描边/阴影），膨胀后并入，避免字幕边缘残留暗框；
      3) 两路都做连通域面积过滤（min_area），去掉水面反光/孤立噪点这类
         小亮斑，避免把它们误当字幕、修出突兀亮块；
      4) 其余背景像素一律保留，inpaint 用周围真实背景纹理自然重建。
    检测范围被严格限制在 (x,y,w,h) 内，不会误删画面上其他白色内容。
    """
    H, W = gray.shape
    x0 = max(0, x); y0 = max(0, y)
    x1 = min(W, x + w); y1 = min(H, y + h)
    mask = np.zeros((H, W), dtype=np.uint8)
    if x1 <= x0 or y1 <= y0:
        return mask
    sub = gray[y0:y1, x0:x1]
    # 白字幕
    bin_b = (sub > bright_thr).astype(np.uint8) * 255
    # 黑描边 / 阴影（字幕常带深色描边）
    bin_d = (sub < dark_thr).astype(np.uint8) * 255
    # 连通域面积过滤：去掉小亮斑/噪点（水面反光）
    if min_area > 0:
        nb, labs, stats, _ = cv2.connectedComponentsWithStats(bin_b, 8)
        for i in range(1, nb):
            if stats[i, cv2.CC_STAT_AREA] < min_area:
                bin_b[labs == i] = 0
        nd, labd, statd, _ = cv2.connectedComponentsWithStats(bin_d, 8)
        for i in range(1, nd):
            if statd[i, cv2.CC_STAT_AREA] < min_area:
                bin_d[labd == i] = 0
    # 膨胀：覆盖抗锯齿半透明边缘
    kb = cv2.getStructuringElement(cv2.MORPH_RECT, (dilate, dilate))
    bd = cv2.getStructuringElement(cv2.MORPH_RECT, (dark_dilate, dark_dilate))
    bin_b = cv2.dilate(bin_b, kb)
    bin_d = cv2.dilate(bin_d, bd)
    region = cv2.bitwise_or(bin_b, bin_d)
    mask[y0:y1, x0:x1] = region
    return mask


def _warp_with_flow(nbr, flow):
    """按光流场把 nbr 对齐到参考帧坐标。

    flow 由 calcOpticalFlowFarneback(prev=参考, next=nbr) 得到，
    表示参考帧上 (x,y) 处的像素在 nbr 中的位移 (dx,dy)。
    要采样回参考坐标，应取 nbr[(x+dx, y+dy)]，即 remap 用 +flow。
    """
    H, W = nbr.shape[:2]
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    mapx = (xs + flow[..., 0]).astype(np.float32)
    mapy = (ys + flow[..., 1]).astype(np.float32)
    return cv2.remap(nbr, mapx, mapy, cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_REFLECT)


def _temporal_fill(frames_buf, idx, mask, radius, use_flow=False):
    """时序填充：解决运动背景鬼影 + 残留字幕。

    frames_buf: 长度为 (2R+1) 的帧列表，idx 为中间帧下标 (BGR uint8)。
    mask: 由 _detect_text_mask 生成的**精确字幕遮罩**(255=要修)。

    标准模式（use_flow=False，默认）：
      1) 用滑动窗口（前后各 R 帧）的时间中值作为填充源——选取邻帧同一
         位置的非字幕背景像素，纹理来自真实帧，最自然；
      2) 把中值填入遮罩区域，再用半径足够的 NS inpaint 兜底，消除中值在
         字幕边缘留下的拼接痕迹/色块；
      3) 背景像素（mask==0）原样保留，不被破坏。

    高质量模式（use_flow=True）：
      光流对齐邻帧后再做一致性加权融合，运动剧烈时背景更连贯，但慢且易
      引入对齐伪影，故默认不推荐；此处在精确遮罩上同样只对字幕区动刀。
    """
    center = frames_buf[idx]
    if not np.any(mask):
        return center
    rmask = (mask > 0).astype(np.uint8) * 255

    # 标准模式：滑动窗口时间中值 + 强 inpaint 兜底
    stack = np.stack([b for b in frames_buf], axis=0)
    med = np.median(stack, axis=0).astype(np.uint8)
    out = center.copy()
    out[mask > 0] = med[mask > 0]
    out = cv2.inpaint(out, rmask, max(3, radius), cv2.INPAINT_NS)
    if not use_flow:
        return out

    # ---- 高质量模式：光流引导对齐融合（仅对字幕区）----
    H, W = center.shape[:2]
    gray_c = cv2.cvtColor(center, cv2.COLOR_BGR2GRAY)
    bg = (mask == 0).astype(np.uint8)

    sum_w = np.zeros((H, W), dtype=np.float32)
    sum_c = np.zeros((H, W, 3), dtype=np.float32)
    base_w = bg.astype(np.float32)
    sum_w += base_w
    sum_c += center.astype(np.float32) * base_w[:, :, None]

    for j in range(len(frames_buf)):
        if j == idx:
            continue
        nbr = frames_buf[j]
        gray_n = cv2.cvtColor(nbr, cv2.COLOR_BGR2GRAY)
        flow = cv2.calcOpticalFlowFarneback(
            gray_c, gray_n, None, 0.5, 3, 15, 3, 5, 1.2, 0)
        warped = _warp_with_flow(nbr, flow)
        warped_gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)

        diff = np.abs(gray_c.astype(np.float32) - warped_gray.astype(np.float32))
        diff_s = cv2.boxFilter(diff, -1, (5, 5))
        w = np.exp(-diff_s / 25.0) * bg.astype(np.float32)
        sum_w += w
        sum_c += warped.astype(np.float32) * w[:, :, None]

    fused = (sum_c / (sum_w[:, :, None] + 1e-6)).astype(np.uint8)
    out2 = center.copy()
    out2[mask > 0] = fused[mask > 0]
    out2 = cv2.inpaint(out2, rmask, max(3, radius), cv2.INPAINT_NS)
    return out2


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
                # 窗口未填满前：对精确字幕遮罩做单帧 inpaint 兜底
                m = buf[-1][1]
                if np.any(m):
                    out = cv2.inpaint(frame, m, radius, cv2.INPAINT_NS)
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
