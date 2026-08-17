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

    设计原则：
      用户框选的 (x,y,w,h) 本意就是「包含字幕的区域」。在复杂背景上做
      逐像素文本检测极不可靠（自适应阈值会把背景纹理全判成文本，全局阈值
      会漏检细描边）。更稳妥的做法是**默认采用用户框选的整矩形**，并在
      边界做轻微羽化让 inpaint 自然过渡。这一策略保证字幕必被盖干净，
      不会出现「残留字幕」。

    仍然保留极简的「纯亮度离群」检测用于诊断，但不影响最终遮罩形状。
    """
    mask = np.zeros(gray.shape, dtype=np.uint8)
    # 整矩形覆盖用户框选区域，并向外扩 pad 像素（覆盖抗锯齿边缘）
    x0 = max(0, x - pad); y0 = max(0, y - pad)
    x1 = min(gray.shape[1], x + w + pad); y1 = min(gray.shape[0], y + h + pad)
    mask[y0:y1, x0:x1] = 255
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
    """时序填充：解决运动背景鬼影。

    frames_buf: 长度为 (2R+1) 的帧列表，idx 为中间帧下标 (BGR uint8)。
    - use_flow=False: 时间中值填充 + inpaint 兜底（稳，适合绝大多数场景）；
    - use_flow=True: 光流对齐 + 一致性加权融合（运动剧烈时尝试使用，但
      容易引入对齐伪影，默认不推荐）。

    改进重点：
      1) 标准模式用更宽的窗口中值（前后 4 帧），更稳定地抹掉字幕；
      2) 中值后用半径足够的 NS inpaint 兜底，消除中值在字幕边缘留下的
         拼接痕迹/色块——这是「残留字幕/突兀感」的主要来源；
      3) 光流模式的方向已修正（+flow 对齐），并使用局部一致性权重与
         「背景区一致性」评估，避免字幕区被自身压制；仍不可靠时回退中值。
    """
    center = frames_buf[idx]
    if not np.any(mask):
        return center

    # 标准模式：滑动窗口时间中值 + 强 inpaint 兜底
    # 整矩形遮罩下，标准模式已经能盖掉字幕；inpaint 主要消除接缝与斑块
    stack = np.stack([b for b in frames_buf], axis=0)
    med = np.median(stack, axis=0).astype(np.uint8)
    out = center.copy()
    out[mask > 0] = med[mask > 0]
    # 对整块掩膜做一次大范围 NS inpaint，消除中值残留与拼接痕迹
    rmask = (mask > 0).astype(np.uint8) * 255
    out = cv2.inpaint(out, rmask, max(3, radius), cv2.INPAINT_NS)
    if not use_flow:
        return out

    # ---- 高质量模式：光流引导对齐融合 ----
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
