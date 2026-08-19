import { createSignal, Show, For } from "solid-js";
import { selectedId, pushToast, upsertTask, faststartEnabled } from "../../store";
import { rotateVideo } from "../../api";

const ROTS = [
  { v: 0, label: "不旋转" },
  { v: 90, label: "顺时针 90°" },
  { v: 180, label: "180°" },
  { v: 270, label: "逆时针 90°" },
] as const;

export default function RotatePanel() {
  const [rotation, setRotation] = createSignal<number>(0);
  const [flipH, setFlipH] = createSignal(false);
  const [flipV, setFlipV] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const submit = async () => {
    if (!selectedId()) {
      pushToast("请先在左侧选择一个视频", "error");
      return;
    }
    if (rotation() === 0 && !flipH() && !flipV()) {
      pushToast("请选择旋转或翻转操作", "error");
      return;
    }
    setBusy(true);
    try {
      const { task_id } = await rotateVideo({
        file_id: selectedId()!,
        rotation: rotation(),
        flip_h: flipH(),
        flip_v: flipV(),
        faststart: faststartEnabled(),
      });
      upsertTask({
        task_id,
        name: `旋转 ${rotation()}°${flipH() ? " 水平翻转" : ""}${
          flipV() ? " 垂直翻转" : ""
        }`,
        status: "running",
        progress: 0,
        created_at: Math.floor(Date.now() / 1000),
      });
      pushToast("已提交旋转任务", "success");
    } catch (e) {
      pushToast("提交失败：" + (e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="tab-panel">
      <h2>旋转</h2>
      <p class="muted">旋转视频角度，或水平/垂直翻转画面。</p>

      <div class="form-card">
        <div class="field">
          <label>旋转角度</label>
        <div class="seg">
          <For each={ROTS}>
            {(r) => (
              <button
                class={rotation() === r.v ? "active" : ""}
                onClick={() => setRotation(r.v)}
              >
                {r.label}
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="row">
        <label class="check-row">
          <input
            type="checkbox"
            checked={flipH()}
            onChange={(e) => setFlipH(e.currentTarget.checked)}
          />
          水平翻转
        </label>
        <label class="check-row">
          <input
            type="checkbox"
            checked={flipV()}
            onChange={(e) => setFlipV(e.currentTarget.checked)}
          />
          垂直翻转
        </label>
      </div>

      </div>

      <div class="actions">
        <button class="btn" onClick={submit} disabled={busy()}>
          {busy() ? "提交中…" : "开始旋转"}
        </button>
      </div>
    </div>
  );
}
