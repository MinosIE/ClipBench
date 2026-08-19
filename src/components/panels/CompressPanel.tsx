import { createSignal, Show, For } from "solid-js";
import { selectedId, pushToast, upsertTask, faststartEnabled } from "../../store";
import { compressVideo } from "../../api";

const PRESETS = [
  { v: "veryslow", label: "极慢(最小)" },
  { v: "slow", label: "慢" },
  { v: "medium", label: "中" },
  { v: "fast", label: "快" },
  { v: "veryfast", label: "极快(最大)" },
] as const;

const SCALES = [
  { v: "original", label: "原始分辨率" },
  { v: "1080", label: "1080p" },
  { v: "720", label: "720p" },
  { v: "480", label: "480p" },
] as const;

export default function CompressPanel() {
  const [preset, setPreset] = createSignal<string>("medium");
  const [crf, setCrf] = createSignal(28);
  const [scale, setScale] = createSignal<"original" | "1080" | "720" | "480">(
    "original"
  );
  const [busy, setBusy] = createSignal(false);

  const submit = async () => {
    if (!selectedId()) {
      pushToast("请先在左侧选择一个视频", "error");
      return;
    }
    setBusy(true);
    try {
      const { task_id } = await compressVideo({
        file_id: selectedId()!,
        preset: preset(),
        crf: crf(),
        scale: scale(),
        faststart: faststartEnabled(),
      });
      upsertTask({
        task_id,
        name: `压缩 (${preset()}, CRF ${crf()}, ${scale()})`,
        status: "running",
        progress: 0,
        created_at: Math.floor(Date.now() / 1000),
      });
      pushToast("已提交压缩任务", "success");
    } catch (e) {
      pushToast("提交失败：" + (e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="tab-panel">
      <h2>压缩</h2>
      <p class="muted">降低码率/分辨率以减小文件体积，保持画质可控。</p>

      <div class="form-card">
        <div class="field">
          <label>压缩预设</label>
        <div class="seg">
          <For each={PRESETS}>
            {(p) => (
              <button
                class={preset() === p.v ? "active" : ""}
                onClick={() => setPreset(p.v)}
              >
                {p.label}
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="field">
        <label>质量 (CRF，越大文件越小)</label>
        <div class="range-row">
          <input
            type="range"
            min="18"
            max="34"
            value={crf()}
            onInput={(e) => setCrf(+e.currentTarget.value)}
          />
          <span class="range-val">{crf()}</span>
        </div>
      </div>

      <div class="field">
        <label>分辨率</label>
        <div class="seg">
          <For each={SCALES}>
            {(s) => (
              <button
                class={scale() === s.v ? "active" : ""}
                onClick={() => setScale(s.v as any)}
              >
                {s.label}
              </button>
            )}
          </For>
        </div>
      </div>

      </div>

      <div class="actions">
        <button class="btn" onClick={submit} disabled={busy()}>
          {busy() ? "提交中…" : "开始压缩"}
        </button>
      </div>
    </div>
  );
}
