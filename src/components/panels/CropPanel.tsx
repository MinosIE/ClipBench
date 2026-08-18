import { createSignal, Show, onMount, createEffect } from "solid-js";
import {
  selectedId,
  pushToast,
  upsertTask,
} from "../../store";
import { getVideoInfo, cropVideo, uploadUrl } from "../../api";

export default function CropPanel() {
  let videoRef: HTMLVideoElement | undefined;
  const [info, setInfo] = createSignal<{ width: number; height: number } | null>(
    null
  );
  const [rect, setRect] = createSignal({ x: 0, y: 0, w: 0, h: 0 });
  let drawing = false;
  let sx = 0;
  let sy = 0;

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

  const onDown = (e: MouseEvent) => {
    if (!selectedId()) return;
    drawing = true;
    const p = toCoords(e.clientX, e.clientY);
    sx = p.x;
    sy = p.y;
    setRect({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onMove = (e: MouseEvent) => {
    if (!drawing) return;
    const p = toCoords(e.clientX, e.clientY);
    setRect({
      x: Math.min(sx, p.x),
      y: Math.min(sy, p.y),
      w: Math.abs(p.x - sx),
      h: Math.abs(p.y - sy),
    });
  };
  const onUp = () => (drawing = false);

  onMount(() => window.addEventListener("mouseup", onUp));

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

  return (
    <div class="tab-panel">
      <h2>裁剪</h2>
      <p class="muted">在画面上拖拽框选保留区域。</p>
      <Show
        when={selectedId()}
        fallback={<div class="empty">请先在左侧选择一个视频</div>}
      >
        <div class="video-wrap" style={{ "max-width": "640px" }}>
          <video
            ref={videoRef}
            src={uploadUrl(selectedId()!)}
            controls
            onMouseDown={onDown}
            onMouseMove={onMove}
            style={{ cursor: "crosshair" }}
          />
          <Show when={rect().w > 0}>
            <div
              style={{
                position: "absolute",
                left: `${(rect().x / (info()?.width || 1)) * 100}%`,
                top: `${(rect().y / (info()?.height || 1)) * 100}%`,
                width: `${(rect().w / (info()?.width || 1)) * 100}%`,
                height: `${(rect().h / (info()?.height || 1)) * 100}%`,
                border: "2px solid #4f8cff",
                "background-color": "rgba(79,140,255,.18)",
                "pointer-events": "none",
              }}
            />
          </Show>
        </div>
        <p class="hint">
          当前选区：{Math.round(rect().w)}×{Math.round(rect().h)} @{" "}
          {Math.round(rect().x)},{Math.round(rect().y)}
        </p>
        <button class="btn" onClick={submit}>
          开始裁剪
        </button>
      </Show>
    </div>
  );
}
