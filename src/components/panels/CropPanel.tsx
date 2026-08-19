import { createSignal, Show, onMount, onCleanup, createEffect } from "solid-js";
import {
  selectedId,
  pushToast,
  upsertTask,
  faststartEnabled,
} from "../../store";
import { getVideoInfo, cropVideo, uploadUrl } from "../../api";

export default function CropPanel() {
  let videoRef: HTMLVideoElement | undefined;
  const [info, setInfo] = createSignal<{ width: number; height: number } | null>(
    null
  );
  const [rect, setRect] = createSignal({ x: 0, y: 0, w: 0, h: 0 });
  let drawing = false;
  let moving = false;
  let sx = 0;
  let sy = 0;
  let moveOffX = 0;
  let moveOffY = 0;

  createEffect(() => {
    const name = selectedId();
    if (!name) return;
    getVideoInfo(name)
      .then((d) => setInfo({ width: d.width, height: d.height }))
      .catch(() => setInfo(null));
  });

  const toCoords = (clientX: number, clientY: number) => {
    const v = videoRef!;
    const r = v.getBoundingClientRect();
    const k = (v.videoWidth || info()?.width || r.width) / r.width;
    return { x: (clientX - r.left) * k, y: (clientY - r.top) * k };
  };

  const clamp = (x: number, y: number, w: number, h: number) => {
    const vw = info()?.width || w;
    const vh = info()?.height || h;
    const cx = Math.max(0, Math.min(x, vw - w));
    const cy = Math.max(0, Math.min(y, vh - h));
    return { x: cx, y: cy };
  };

  const onDownDraw = (e: MouseEvent) => {
    if (!selectedId()) return;
    drawing = true;
    const p = toCoords(e.clientX, e.clientY);
    sx = p.x;
    sy = p.y;
    setRect({ x: p.x, y: p.y, w: 0, h: 0 });
    window.addEventListener("mousemove", onMoveGlobal);
    window.addEventListener("mouseup", onUpGlobal);
  };

  const onDownRegion = (e: MouseEvent) => {
    e.stopPropagation();
    if (!rect() || rect().w <= 0) return;
    moving = true;
    const p = toCoords(e.clientX, e.clientY);
    moveOffX = p.x - rect().x;
    moveOffY = p.y - rect().y;
    window.addEventListener("mousemove", onMoveGlobal);
    window.addEventListener("mouseup", onUpGlobal);
  };

  const onMoveGlobal = (e: MouseEvent) => {
    if (drawing) {
      const p = toCoords(e.clientX, e.clientY);
      setRect({
        x: Math.min(sx, p.x),
        y: Math.min(sy, p.y),
        w: Math.abs(p.x - sx),
        h: Math.abs(p.y - sy),
      });
    } else if (moving) {
      const p = toCoords(e.clientX, e.clientY);
      const next = clamp(p.x - moveOffX, p.y - moveOffY, rect().w, rect().h);
      setRect({ ...rect(), x: next.x, y: next.y });
    }
  };

  const onUpGlobal = () => {
    drawing = false;
    moving = false;
    window.removeEventListener("mousemove", onMoveGlobal);
    window.removeEventListener("mouseup", onUpGlobal);
  };

  onMount(() => {
    window.addEventListener("mouseup", onUpGlobal);
  });
  onCleanup(() => {
    window.removeEventListener("mousemove", onMoveGlobal);
    window.removeEventListener("mouseup", onUpGlobal);
  });

  const clearRect = () => setRect({ x: 0, y: 0, w: 0, h: 0 });

  const submit = async () => {
    if (!selectedId() || rect().w < 5 || rect().h < 5) {
      pushToast("请在视频上框选裁剪区域", "error");
      return;
    }
    const r = rect();
    const { task_id } = await cropVideo({
      file_id: selectedId()!,
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.w),
      h: Math.round(r.h),
      faststart: faststartEnabled(),
    });
    upsertTask({
      task_id,
      name: `裁剪 ${Math.round(r.w)}×${Math.round(r.h)}@${Math.round(
        r.x
      )},${Math.round(r.y)}`,
      status: "running",
      progress: 0,
      created_at: Math.floor(Date.now() / 1000),
    });
    pushToast("已提交裁剪任务", "success");
  };

  const hasRect = () => rect().w > 0 && rect().h > 0;
  const pct = (v: number, total?: number) =>
    `${(v / (total || 1)) * 100}%`;

  return (
    <div class="tab-panel">
      <h2>裁剪</h2>
      <p class="muted">在画面上拖拽框选保留区域；选中后可拖动调整位置，右上角 ✕ 删除选区。</p>
      <Show
        when={selectedId()}
        fallback={<div class="empty">请先在左侧选择一个视频</div>}
      >
        <div class="form-card">
          <div class="video-wrap" style={{ "max-width": "100%" }}>
          <video
            ref={videoRef}
            src={uploadUrl(selectedId()!)}
            controls
            onMouseDown={onDownDraw}
            style={{ cursor: "crosshair" }}
          />
          <Show when={hasRect()}>
            <div
              onMouseDown={onDownRegion}
              style={{
                position: "absolute",
                left: pct(rect().x, info()?.width),
                top: pct(rect().y, info()?.height),
                width: pct(rect().w, info()?.width),
                height: pct(rect().h, info()?.height),
                border: "2px solid #4f8cff",
                "background-color": "rgba(79,140,255,.18)",
                cursor: "move",
                "pointer-events": "auto",
              }}
            >
              <button
                class="crop-del"
                title="删除选区"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  clearRect();
                }}
              >
                ✕
              </button>
            </div>
          </Show>
        </div>
          <p class="hint">
            当前选区：{Math.round(rect().w)}×{Math.round(rect().h)} @{" "}
            {Math.round(rect().x)},{Math.round(rect().y)}
          </p>
        </div>

        <div class="actions">
          <button
            class="btn secondary"
            onClick={clearRect}
            disabled={!hasRect()}
          >
            清除选区
          </button>
          <button class="btn" onClick={submit}>
            开始裁剪
          </button>
        </div>
      </Show>
    </div>
  );
}
