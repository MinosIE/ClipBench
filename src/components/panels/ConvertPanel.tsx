import { createSignal, Show, For } from "solid-js";
import { selectedId, pushToast, upsertTask, faststartEnabled } from "../../store";
import { convertVideo } from "../../api";

const TARGETS = [
  { v: "mp4", label: "MP4 (H.264)" },
  { v: "mkv", label: "MKV" },
  { v: "mov", label: "MOV" },
  { v: "webm", label: "WebM (VP9)" },
  { v: "gif", label: "GIF" },
  { v: "mp3", label: "MP3 (仅音频)" },
  { v: "m4a", label: "M4A (仅音频)" },
] as const;

export default function ConvertPanel() {
  const [target, setTarget] = createSignal<string>("mp4");
  const [crf, setCrf] = createSignal(23);
  const [vcodec, setVcodec] = createSignal<string>("libx264");
  const [busy, setBusy] = createSignal(false);

  const isAudio = () => target() === "mp3" || target() === "m4a";

  const submit = async () => {
    if (!selectedId()) {
      pushToast("请先在左侧选择一个视频", "error");
      return;
    }
    setBusy(true);
    try {
      const { task_id } = await convertVideo({
        file_id: selectedId()!,
        target: target(),
        crf: crf(),
        vcodec: isAudio() ? undefined : vcodec(),
        faststart: faststartEnabled(),
      });
      upsertTask({
        task_id,
        name: `转换 → .${target()}`,
        status: "running",
        progress: 0,
        created_at: Math.floor(Date.now() / 1000),
      });
      pushToast("已提交转换任务", "success");
    } catch (e) {
      pushToast("提交失败：" + (e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="tab-panel two-col">
      <h2>格式转换</h2>
      <p class="muted">将视频转换为目标封装/编码格式，或单独抽取音频。</p>

      <div class="form-card">
        <div class="field col-span">
          <label>目标格式</label>
        <select
          value={target()}
          onChange={(e) => setTarget(e.currentTarget.value)}
        >
          <For each={TARGETS}>
            {(t) => <option value={t.v}>{t.label}</option>}
          </For>
        </select>
      </div>

      <Show when={!isAudio()}>
        <div class="field">
          <label>视频编码器</label>
          <select
            value={vcodec()}
            onChange={(e) => setVcodec(e.currentTarget.value)}
          >
            <option value="libx264">H.264 (libx264)</option>
            <option value="libx265">H.265 (libx265)</option>
            <option value="vp9">VP9</option>
            <option value="copy">直接复制 (copy)</option>
          </select>
        </div>

        <div class="field col-span">
          <label>质量 (CRF，越小越好，18~28)</label>
          <div class="range-row">
            <input
              type="range"
              min="18"
              max="28"
              value={crf()}
              onInput={(e) => setCrf(+e.currentTarget.value)}
            />
            <span class="range-val">{crf()}</span>
          </div>
        </div>
      </Show>

      <div class="actions">
        <button class="btn" onClick={submit} disabled={busy()}>
          {busy() ? "提交中…" : "开始转换"}
        </button>
      </div>

      </div>

      <aside class="panel-aside">
        <h4>格式速查</h4>
        <ul>
          <li><b>MP4/H.264</b>：兼容性最佳，通用首选。</li>
          <li><b>MKV</b>：封装自由，适合多音轨/字幕。</li>
          <li><b>WebM/VP9</b>：网页友好，体积更小。</li>
          <li><b>MOV</b>：苹果生态编辑首选。</li>
          <li><b>MP3/M4A</b>：仅抽取音频。</li>
        </ul>
        <div class="aside-note">
          选「直接复制」可秒级封装，但不改变编码与体积。
        </div>
      </aside>
    </div>
  );
}
