import { createSignal, Show, For } from "solid-js";
import { selectedId, pushToast, confirmModal, upsertTask } from "../../store";
import { splitVideo } from "../../api";

interface Seg {
  start: string;
  end: string;
}

export default function SplitPanel() {
  const [mode, setMode] = createSignal<"segment" | "time">("segment");
  const [segment, setSegment] = createSignal(60);
  const [mute, setMute] = createSignal(false);
  const [output, setOutput] = createSignal<"video" | "gif">("video");
  const [segments, setSegments] = createSignal<Seg[]>([
    { start: "00:00:00", end: "00:00:10" },
  ]);
  const [gifFps, setGifFps] = createSignal(15);
  const [gifWidth, setGifWidth] = createSignal(480);
  const [busy, setBusy] = createSignal(false);

  const addSeg = () =>
    setSegments([...segments(), { start: "00:00:00", end: "00:00:10" }]);
  const updateSeg = (i: number, key: keyof Seg, val: string) =>
    setSegments(segments().map((s, idx) => (idx === i ? { ...s, [key]: val } : s)));
  const removeSeg = (i: number) =>
    setSegments(segments().filter((_, idx) => idx !== i));

  const submit = async () => {
    if (!selectedId()) {
      pushToast("请先在左侧选择一个视频", "error");
      return;
    }
    setBusy(true);
    try {
      const { task_id } = await splitVideo({
        file_id: selectedId()!,
        mode: mode(),
        segment: mode() === "segment" ? segment() : undefined,
        mute: mute(),
        output: output(),
        segments: mode() === "time" ? segments() : undefined,
        gif_fps: output() === "gif" ? gifFps() : undefined,
        gif_width: output() === "gif" ? gifWidth() : undefined,
      });
      upsertTask({
        task_id,
        name: `拆分 ${mode() === "segment" ? segment() + "s/段" : segments().length + "段"}`,
        status: "running",
        progress: 0,
        created_at: Math.floor(Date.now() / 1000),
      });
      pushToast("已提交拆分任务", "success");
    } catch (e) {
      pushToast("提交失败：" + (e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="tab-panel two-col">
      <h2>拆分</h2>
      <p class="muted">
        按固定时长切片，或自定义多段时间区间；输出可选择视频片段或 GIF。
      </p>

      <div class="form-card">
        <div class="field col-span">
          <label>拆分方式</label>
            <div class="seg">
              <button
                class={mode() === "segment" ? "active" : ""}
                onClick={() => setMode("segment")}
              >
                按固定时长
              </button>
              <button
                class={mode() === "time" ? "active" : ""}
                onClick={() => setMode("time")}
              >
                按时间区间
              </button>
            </div>
          </div>

          <Show when={mode() === "segment"}>
            <div class="field">
              <label>每段时长（秒）</label>
              <input
                type="number"
                min="1"
                value={segment()}
                onInput={(e) => setSegment(+e.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label>输出格式</label>
              <div class="seg">
                <button
                  class={output() === "video" ? "active" : ""}
                  onClick={() => setOutput("video")}
                >
                  视频
                </button>
                <button
                  class={output() === "gif" ? "active" : ""}
                  onClick={() => setOutput("gif")}
                >
                  GIF
                </button>
              </div>
            </div>
          </Show>

          <Show when={output() === "gif"}>
            <div class="field">
              <label>GIF 帧率</label>
              <input
                type="number"
                min="1"
                max="30"
                value={gifFps()}
                onInput={(e) => setGifFps(+e.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label>GIF 宽度 (px)</label>
              <input
                type="number"
                min="100"
                value={gifWidth()}
                onInput={(e) => setGifWidth(+e.currentTarget.value)}
              />
            </div>
          </Show>

        <Show when={mode() === "time"}>
          <div class="field">
            <label>时间区间（HH:MM:SS）</label>
            <div class="seg-list">
              <For each={segments()}>
                {(s, i) => (
                  <div class="seg-row">
                    <input
                      type="text"
                      value={s.start}
                      onInput={(e) => updateSeg(i(), "start", e.currentTarget.value)}
                      style={{ width: "100px" }}
                    />
                    <span>→</span>
                    <input
                      type="text"
                      value={s.end}
                      onInput={(e) => updateSeg(i(), "end", e.currentTarget.value)}
                      style={{ width: "100px" }}
                    />
                    <button
                      class="btn danger small"
                      onClick={() => removeSeg(i())}
                      disabled={segments().length <= 1}
                    >
                      删除
                    </button>
                  </div>
                )}
              </For>
              <button class="btn secondary small" onClick={addSeg}>
                + 添加区间
              </button>
            </div>
          </div>
        </Show>

        <label class="check-row" style={{ "margin-top": "4px" }}>
          <input
            type="checkbox"
            checked={mute()}
            onChange={(e) => setMute(e.currentTarget.checked)}
          />
          静音（去除音轨）
        </label>
      </div>

      <aside class="panel-aside">
        <h4>拆分贴士</h4>
        <ul>
          <li><b>按固定时长</b>：适合长视频均匀切片，如每 60s 一段。</li>
          <li><b>按时间区间</b>：适合精确截取高光片段。</li>
          <li>输出选 <b>GIF</b> 时，帧率 12~15、宽度 480 体积与流畅度较平衡。</li>
          <li>勾选「静音」可顺便剥离音轨、缩小体积。</li>
        </ul>
        <div class="aside-note">
          提示：短视频卡点建议用「时间区间」精确裁剪。
        </div>
      </aside>

      <div class="actions">
        <button class="btn" onClick={submit} disabled={busy()}>
          {busy() ? "提交中…" : "开始拆分"}
        </button>
      </div>
    </div>
  );
}
