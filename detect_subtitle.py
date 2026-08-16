"""字幕区域检测分析工具

对一个视频，采样若干帧，分析给定矩形区域内：
  - 背景复杂度（梯度方差，高=复杂背景，inpaint 难度高）
  - 区域内文本像素占比（亮度异常高/低的像素）
  - 字幕是否在移动（相邻帧区域内像素差异）
  - 是否多行（纵向投影峰数）
仅用 cv2/numpy/ffmpeg，无外部模型依赖。
"""
import subprocess
import sys
import numpy as np
import cv2


def iter_frames(path, vw, vh, max_frames=30):
    reader = subprocess.Popen(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-i", path, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        stdout=subprocess.PIPE,
    )
    fs = vw * vh * 3
    n = 0
    while n < max_frames:
        raw = reader.stdout.read(fs)
        if not raw or len(raw) < fs:
            break
        yield np.frombuffer(raw, dtype=np.uint8).reshape((vh, vw, 3))
        n += 1
    reader.stdout.close()
    reader.wait()


def analyze(path, x, y, w, h, max_frames=30):
    cap = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,nb_frames,duration,r_frame_rate",
         "-of", "default=noprint_wrappers=1", path],
        capture_output=True, text=True,
    )
    info = {}
    for line in cap.stdout.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            info[k.strip()] = v.strip()
    vw = int(info.get("width", 0)); vh = int(info.get("height", 0))

    # 安全区域
    x = max(0, min(x, vw - 1)); y = max(0, min(y, vh - 1))
    w = max(1, min(w, vw - x)); h = max(1, min(h, vh - y))

    grads = []
    text_ratios = []
    prev_roi = None
    motion = []
    rows_peaks = []
    frames = list(iter_frames(path, vw, vh, max_frames))
    total = len(frames)
    for fr in frames:
        roi = fr[y:y + h, x:x + w]
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        # 背景复杂度：Sobel 梯度方差
        gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
        grad = np.sqrt(gx ** 2 + gy ** 2)
        grads.append(float(grad.var()))
        # 文本像素占比：离均值 ±2.5σ 之外的（字幕白字/描边）
        mean, std = gray.mean(), gray.std() + 1e-6
        text_mask = (gray > mean + 2.5 * std) | (gray < mean - 2.5 * std)
        text_ratios.append(float(text_mask.mean()))
        # 多行：纵向投影峰
        col_mean = gray.mean(axis=1)
        # 简单找局部峰
        peaks = 0
        for i in range(1, len(col_mean) - 1):
            if col_mean[i] > col_mean[i - 1] and col_mean[i] >= col_mean[i + 1] and \
               col_mean[i] > mean + std:
                peaks += 1
        rows_peaks.append(peaks)
        # 帧间运动（区域内像素绝对值差均值）
        if prev_roi is not None:
            motion.append(float(np.abs(gray.astype(int) - prev_roi.astype(int)).mean()))
        prev_roi = gray

    def stats(a):
        a = np.array(a)
        return float(a.mean()), float(a.min()), float(a.max())

    g_mean, g_min, g_max = stats(grads)
    t_mean, t_min, t_max = stats(text_ratios)
    m_mean, m_min, m_max = stats(motion) if motion else (0, 0, 0)
    r_mean, r_min, r_max = stats(rows_peaks)

    # 判定
    complexity = "复杂(高纹理/运动背景)" if g_mean > 400 else "简单(纯色/平滑背景)"
    has_text = "有" if t_mean > 0.01 else "弱/无"
    moving = "字幕在移动/背景在动" if m_mean > 8 else "基本静止"
    multilines = "可能多行" if r_mean >= 2 else "单行"

    print("=" * 50)
    print(f"视频: {path}")
    print(f"分辨率: {vw}x{vh}  采样帧数: {total}")
    print(f"分析区域: x={x} y={y} w={w} h={h}  (占画面 {100*w*x/(vw*vh):.1f}% 面积)")
    print("-" * 50)
    print(f"背景复杂度(梯度方差 均值={g_mean:.0f} 范围[{g_min:.0f},{g_max:.0f}]) -> {complexity}")
    print(f"文本像素占比(均值={t_mean*100:.1f}% 范围[{t_min*100:.1f}%,{t_max*100:.1f}%]) -> 字幕{has_text}")
    print(f"帧间运动(均值={m_mean:.1f} 范围[{m_min:.1f},{m_max:.1f}]) -> {moving}")
    print(f"行投影峰(均值={r_mean:.1f}) -> {multilines}")
    print("=" * 50)
    print("建议方案:")
    if g_mean > 400 or m_mean > 8:
        print("  -> 当前 cv2.inpaint 单帧空间修复在复杂/运动背景下效果差。")
        print("     推荐: A.时序修复(3D) 或 C.深度学习(ProPainter)，复杂背景收益大。")
    if r_mean >= 2 or m_mean > 8:
        print("  -> 字幕可能多行/在移动: 推荐 B.OCR 动态遮罩，避免固定矩形盖错/漏盖。")
    if g_mean <= 400 and m_mean <= 8 and r_mean < 2:
        print("  -> 简单背景单行静止字幕: 当前方案参数调优即可，无需大改。")
    print("=" * 50)
    return dict(g_mean=g_mean, t_mean=t_mean, m_mean=m_mean, r_mean=r_mean,
                complexity=complexity, has_text=has_text, moving=moving, multilines=multilines)


if __name__ == "__main__":
    # 默认用 uploads/source.mp4，区域取底部 720x304（之前任务用的）
    p = sys.argv[1] if len(sys.argv) > 1 else "uploads/source.mp4"
    x = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    y = int(sys.argv[3]) if len(sys.argv) > 3 else 608
    w = int(sys.argv[4]) if len(sys.argv) > 4 else 720
    hh = int(sys.argv[5]) if len(sys.argv) > 5 else 304
    analyze(p, x, y, w, hh)
