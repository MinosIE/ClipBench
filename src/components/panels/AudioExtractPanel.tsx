import { createSignal, Show, For } from "solid-js";
import { selectedId, pushToast, upsertTask } from "../../store";
import { extractAudio } from "../../api";

const FORMATS = [
  { v: "mp3", label: "MP3" },
  { v: "m4a", label: "M4A (AAC)" },
  { v: "wav", label: "WAV" },
  { v: "flac", label: "FLAC" },
] as const;

const BITRATES = ["128k", "192k", "320k"];

export default function AudioExtractPanel() {
  const [format, setFormat] = createSignal<string>("mp3");
  const [bitrate, setBitrate] = createSignal("192k");
  const [busy, setBusy] = createSignal(false);

  const lossless = () => format() === "wav" || format() === "flac";

  const submit = async () => {
    if (!selectedId()) {
      pushToast("请先在左侧选择一个媒体文件", "error");
      return;
    }
    setBusy(true);
    try {
      const { task_id } = await extractAudio({
        file_id: selectedId()!,
        format: format() as "mp3" | "m4a" | "wav" | "flac",
        bitrate: lossless() ? undefined : bitrate(),
      });
      upsertTask({
        task_id,
        name: `音频 .${format()}`,
        status: "running",
        progress: 0,
        created_at: Math.floor(Date.now() / 1000),
      });
      pushToast("已提交音频提取任务", "success");
    } catch (e) {
      pushToast("提交失败：" + (e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="tab-panel two-col">
      <h2>音频提取</h2>
      <p class="muted">从视频中提取音轨，或为纯音频文件转码导出。</p>

      <div class="form-card">
        <div class="field row col-span">
          <label>输出格式</label>
          <div class="seg">
            <For each={FORMATS}>
              {(f) => (
                <button
                  class={format() === f.v ? "active" : ""}
                  onClick={() => setFormat(f.v)}
                >
                  {f.label}
                </button>
              )}
            </For>
          </div>
        </div>

        <Show when={!lossless()}>
          <div class="field col-span">
            <label>码率</label>
            <div class="seg">
              <For each={BITRATES}>
                {(b) => (
                  <button
                    class={bitrate() === b ? "active" : ""}
                    onClick={() => setBitrate(b)}
                  >
                    {b}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={lossless()}>
          <p class="hint col-span">
            WAV / FLAC 为无损格式，不设置码率，体积较大。
          </p>
        </Show>

        <p class="hint col-span">
          MP3 兼容性最佳；M4A 同码率更小；WAV 无损但体积大；FLAC 无损压缩。
        </p>

        <div class="actions">
          <button class="btn" onClick={submit} disabled={busy()}>
            {busy() ? "提交中…" : "开始提取"}
          </button>
        </div>
      </div>

      <aside class="panel-aside">
        <h4>说明</h4>
        <ul>
          <li>仅提取第一条音轨（含双语配音时取主音轨）。</li>
          <li>源文件没有音频流时会提示错误。</li>
          <li>纯音频文件也可直接转码为目标格式。</li>
          <li>产物自动出现在左侧「媒体文件」列表。</li>
        </ul>
        <div class="aside-note">
          建议：通用场景选 MP3 192k；追求体积选 M4A；存档选 FLAC。
        </div>
      </aside>
    </div>
  );
}
