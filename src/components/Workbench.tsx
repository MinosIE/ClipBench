import {
  Show,
  For,
  createSignal,
  onMount,
  onCleanup,
  createEffect,
} from "solid-js";
import {
  selectedId,
  regions,
  setRegions,
  busy,
  setBusy,
  pushToast,
  confirmModal,
  upsertTask,
} from "../store";
import { getVideoInfo, startDesubtitle, uploadUrl } from "../api";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ERASERS = [
  { key: "inpaint", label: "智能修复" },
  { key: "delogo", label: "边缘修复" },
  { key: "blur", label: "模糊" },
  { key: "mosaic", label: "马赛克" },
] as const;

export default function Workbench() {
  let videoRef: HTMLVideoElement | undefined;
  // 绘制状态
  let drawing = false;
  let startX = 0;
  let startY = 0;
  // 移动状态：正在拖动已提交区域
  let moving = false;
  let moveOffX = 0;
  let moveOffY = 0;
  // 拖拽中的临时预览框（不计入已提交区域），避免一次拖拽堆叠多个区域
  const [draft, setDraft] = createSignal<Rect | null>(null);
  const [info, setInfo] = createSignal<{
    width: number;
    height: number;
    fps: number;
  } | null>(null);
  const [progress, setProgress] = createSignal(0);
  const [eraser, setEraser] = createSignal<(typeof ERASERS)[number]["key"]>(
    "inpaint"
  );
  const [quality, setQuality] = createSignal<"standard" | "high">("standard");
  const [strength, setStrength] = createSignal(6);

  // 当切换视频时重新拉取信息
  createEffect(() => {
    const name = selectedId();
    if (!name) return;
    setRegions([]);
    setDraft(null);
    moving = false;
    drawing = false;
    // 防御性清理可能残留的全局监听
    window.removeEventListener("mousemove", onMoveDraw);
    window.removeEventListener("mousemove", onMoveRegion);
    window.removeEventListener("mouseup", onUpGlobal);
    setProgress(0);
    if (videoRef) videoRef.muted = true;
    getVideoInfo(name)
      .then((d) => setInfo({ width: d.width, height: d.height, fps: d.fps }))
      .catch(() => setInfo(null));
  });

  const onTimeUpdate = () => {
    if (videoRef && videoRef.duration) {
      setProgress(videoRef.currentTime / videoRef.duration);
    }
  };

  const onSeek = (e: MouseEvent) => {
    if (!videoRef || !videoRef.duration) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    videoRef.currentTime = ratio * videoRef.duration;
  };

  // 计算视频实际渲染内容区域（排除 object-fit: contain 的黑边），
  // 与原始 static/app.js 用 frame 图片显示尺寸换算的逻辑一致
  const contentRect = () => {
    const v = videoRef!;
    const rect = v.getBoundingClientRect();
    const vw = v.videoWidth || info()?.width || rect.width;
    const vh = v.videoHeight || info()?.height || rect.height;
    const s = Math.min(rect.width / vw, rect.height / vh); // contain 缩放比
    const dispW = vw * s;
    const dispH = vh * s;
    const offX = (rect.width - dispW) / 2;
    const offY = (rect.height - dispH) / 2;
    return { rect, offX, offY, scale: s, vw, vh };
  };

  // 在视频上框选区域（坐标换算为原视频分辨率，含黑边修正）
  const toVideoCoords = (clientX: number, clientY: number) => {
    const { rect, offX, offY, scale } = contentRect();
    const cx = clientX - rect.left - offX;
    const cy = clientY - rect.top - offY;
    return { x: cx / scale, y: cy / scale };
  };

  // 判断点(px,py)是否落在某区域内（视频分辨率坐标）
  const hitRegion = (px: number, py: number, r: Rect) =>
    px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;

  const onMoveDraw = (e: MouseEvent) => {
    if (!drawing) return;
    const p = toVideoCoords(e.clientX, e.clientY);
    setDraft({
      x: Math.min(startX, p.x),
      y: Math.min(startY, p.y),
      w: Math.abs(p.x - startX),
      h: Math.abs(p.y - startY),
    });
  };

  const onMoveRegion = (e: MouseEvent) => {
    if (!moving) return;
    const p = toVideoCoords(e.clientX, e.clientY);
    const rect = regions[0];
    if (!rect) return;
    const maxX = (info()?.width || rect.x + rect.w) - rect.w;
    const maxY = (info()?.height || rect.y + rect.h) - rect.h;
    const nx = Math.min(Math.max(p.x - moveOffX, 0), Math.max(0, maxX));
    const ny = Math.min(Math.max(p.y - moveOffY, 0), Math.max(0, maxY));
    setRegions([{ ...rect, x: nx, y: ny }]);
  };

  const onUpGlobal = () => {
    if (drawing) {
      drawing = false;
      const d = draft();
      // 仅支持一个区域：完成绘制后用新框替换旧框
      if (d && d.w >= 5 && d.h >= 5) {
        setRegions([d]);
      }
      setDraft(null);
    }
    if (moving) moving = false;
    window.removeEventListener("mousemove", onMoveDraw);
    window.removeEventListener("mousemove", onMoveRegion);
    window.removeEventListener("mouseup", onUpGlobal);
  };

  // 控件栏高度估算（视频底部），点在此区域内不触发框选，避免与播放控件冲突
  const CONTROLS_H = 48;

  const onDown = (e: MouseEvent) => {
    if (!selectedId() || !videoRef) return;
    const rect = videoRef.getBoundingClientRect();
    // 点在底部控件条上时不进入框选，交给原生控件处理
    if (e.clientY > rect.bottom - CONTROLS_H) return;
    const p = toVideoCoords(e.clientX, e.clientY);
    // 已有区域且点在区域内 -> 进入拖动模式
    const cur = regions[0];
    if (cur && hitRegion(p.x, p.y, cur)) {
      e.preventDefault();
      moving = true;
      moveOffX = p.x - cur.x;
      moveOffY = p.y - cur.y;
    } else {
      // 否则开始绘制新区域（仅支持一个）
      e.preventDefault();
      drawing = true;
      startX = p.x;
      startY = p.y;
      setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
    }
    // 选区交互时静音循环播放，便于选取代表帧
    if (videoRef) {
      videoRef.muted = true;
      videoRef.play().catch(() => {});
    }
    window.addEventListener("mousemove", drawing ? onMoveDraw : onMoveRegion);
    window.addEventListener("mouseup", onUpGlobal);
  };

  onCleanup(() => {
    window.removeEventListener("mousemove", onMoveDraw);
    window.removeEventListener("mousemove", onMoveRegion);
    window.removeEventListener("mouseup", onUpGlobal);
  });

  const removeRegion = (i: number) =>
    setRegions(regions.filter((_, idx) => idx !== i));

  const start = async () => {
    if (!selectedId() || regions.length === 0) {
      pushToast("请先选择视频并框选字幕区域", "error");
      return;
    }
    setBusy(true);
    try {
      // 后端当前接受一个区域；用第一个框选提交（多区域支持需后端改造）
      const region = regions[0];
      const { task_id } = await startDesubtitle(
        selectedId()!,
        region,
        quality(),
        eraser(),
        strength()
      );
      upsertTask({
        task_id,
        name: `去字幕(${ERASERS.find((x) => x.key === eraser())?.label}) ${
          region.w
        }x${region.h}@${Math.round(region.x)},${Math.round(region.y)}`,
        status: "running",
        progress: 0,
        created_at: Math.floor(Date.now() / 1000),
        output_name: undefined,
      });
      setRegions([]);
      pushToast("已提交去字幕任务", "success");
    } catch (e) {
      pushToast("提交失败：" + (e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="tab-panel">
      <h2>去字幕工作台</h2>
      <Show
        when={selectedId()}
        fallback={<div class="empty">请先在左侧选择一个视频文件</div>}
      >
        <div class="workbench">
        <div>
          <div class="video-wrap">
            <video
              ref={videoRef}
              src={uploadUrl(selectedId()!)}
              controls
              muted
              loop
              draggable={false}
              onTimeUpdate={onTimeUpdate}
              onMouseDown={onDown}
              style={{ cursor: "crosshair", "user-select": "none" }}
            />
            {/* 已提交区域（可拖拽移动） */}
            <For each={regions}>
              {(r) => (
                <div
                  onMouseDown={(ev) => {
                    // 在区域上按下时，交给 window 的 onDown 处理拖动
                    onDown(ev);
                  }}
                  style={{
                    position: "absolute",
                    left: `${(r.x / (info()?.width || 1)) * 100}%`,
                    top: `${(r.y / (info()?.height || 1)) * 100}%`,
                    width: `${(r.w / (info()?.width || 1)) * 100}%`,
                    height: `${(r.h / (info()?.height || 1)) * 100}%`,
                    border: "2px dashed #ff5c5c",
                    "background-color": "rgba(255,92,92,.18)",
                    "pointer-events": "auto",
                    cursor: "move",
                  }}
                />
              )}
            </For>
            {/* 拖拽中的实时预览框（不计入已提交区域） */}
            <Show when={draft()}>
              {(d) => (
                <div
                  style={{
                    position: "absolute",
                    left: `${(d().x / (info()?.width || 1)) * 100}%`,
                    top: `${(d().y / (info()?.height || 1)) * 100}%`,
                    width: `${(d().w / (info()?.width || 1)) * 100}%`,
                    height: `${(d().h / (info()?.height || 1)) * 100}%`,
                    border: "2px solid #36c5f0",
                    "background-color": "rgba(54,197,240,.2)",
                    "pointer-events": "none",
                  }}
                />
              )}
            </Show>
          </div>
            <div class="timeline">
              <div class="timeline-track" onClick={onSeek}>
                <div
                  class="timeline-fill"
                  style={{ width: `${Math.round(progress() * 100)}%` }}
                />
              </div>
              <div class="timeline-time">
                {progress() > 0
                  ? `${Math.round(progress() * 100)}% 进度`
                  : "点击进度条跳转"}
              </div>
            </div>
          </div>

          <div class="region-tools">
            <div class="field">
              <label>擦除方式</label>
              <div class="seg">
                <For each={ERASERS}>
                  {(e) => (
                    <button
                      class={eraser() === e.key ? "active" : ""}
                      onClick={() => setEraser(e.key)}
                    >
                      {e.label}
                    </button>
                  )}
                </For>
              </div>
            </div>

            <div class="field">
              <label>修复质量</label>
              <div class="seg">
                <button
                  class={quality() === "standard" ? "active" : ""}
                  onClick={() => setQuality("standard")}
                >
                  标准
                </button>
                <button
                  class={quality() === "high" ? "active" : ""}
                  onClick={() => setQuality("high")}
                >
                  高质量
                </button>
              </div>
            </div>

            <div class="field">
              <label>修复强度（强度越大字幕越干净，但边缘可能略糊）</label>
              <div class="range-row">
                <input
                  type="range"
                  min="1"
                  max="40"
                  value={strength()}
                  onInput={(e) => setStrength(+e.currentTarget.value)}
                />
                <span class="range-val">{strength()}</span>
              </div>
            </div>

            <div class="field">
              <label>已框选区域（{regions.length}/1）</label>
              <div class="region-list">
                <For each={regions}>
                  {(r, i) => (
                    <div class="region-row">
                      <span class="region-info">
                        <span class="region-name">区域 {i() + 1}</span>
                        {Math.round(r.x)},{Math.round(r.y)} ·{" "}
                        {Math.round(r.w)}×{Math.round(r.h)}
                        <span class="hint"> · 可直接拖动调整位置</span>
                      </span>
                      <button
                        class="btn danger small"
                        onClick={() => removeRegion(i())}
                      >
                        移除
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </div>

            <div class="actions">
              <button
                class="btn"
                onClick={start}
                disabled={busy() || regions.length === 0}
              >
                {busy() ? "提交中…" : "开始去字幕"}
              </button>
            </div>
            <p class="hint">
              在视频画面上按住拖拽框选字幕区域（仅一个）；在已有区域上按住可直接拖动调整位置。
            </p>
          </div>
        </div>
      </Show>
    </div>
  );
}
