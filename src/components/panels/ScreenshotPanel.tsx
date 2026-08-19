import { createSignal, Show } from "solid-js";
import { selectedId, pushToast, upsertTask } from "../../store";
import { screenshotVideo } from "../../api";

export default function ScreenshotPanel() {
  const [mode, setMode] = createSignal<"single" | "every">("single");
  const [time, setTime] = createSignal("00:00:01");
  const [format, setFormat] = createSignal<"jpg" | "png">("jpg");
  const [interval, setInterval] = createSignal(5);
  const [busy, setBusy] = createSignal(false);

  const submit = async () => {
    if (!selectedId()) {
      pushToast("请先在左侧选择一个视频", "error");
      return;
    }
    setBusy(true);
    try {
      const { task_id } = await screenshotVideo({
        file_id: selectedId()!,
        mode: mode(),
        time: mode() === "single" ? time() : undefined,
        format: format(),
        interval: mode() === "every" ? interval() : undefined,
      });
      upsertTask({
        task_id,
        name: `截图 ${mode() === "single" ? "单张" : "每" + interval() + "s"} (${format()})`,
        status: "running",
        progress: 0,
        created_at: Math.floor(Date.now() / 1000),
      });
      pushToast("已提交截图任务", "success");
    } catch (e) {
      pushToast("提交失败：" + (e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="tab-panel">
      <h2>截图</h2>
      <p class="muted">截取单张画面，或按固定间隔批量截取。</p>

      <div class="form-card">
        <div class="field">
          <label>模式</label>
        <div class="seg">
          <button
            class={mode() === "single" ? "active" : ""}
            onClick={() => setMode("single")}
          >
            单张截图
          </button>
          <button
            class={mode() === "every" ? "active" : ""}
            onClick={() => setMode("every")}
          >
            间隔批量
          </button>
        </div>
      </div>

      <Show when={mode() === "single"}>
        <div class="field">
          <label>时间点（HH:MM:SS）</label>
          <input
            type="text"
            value={time()}
            onInput={(e) => setTime(e.currentTarget.value)}
            style={{ width: "130px" }}
          />
        </div>
      </Show>

      <Show when={mode() === "every"}>
        <div class="field">
          <label>间隔（秒）</label>
          <input
            type="number"
            min="1"
            value={interval()}
            onInput={(e) => setInterval(+e.currentTarget.value)}
            style={{ width: "100px" }}
          />
        </div>
      </Show>

      <div class="field">
        <label>输出格式</label>
        <div class="seg">
          <button
            class={format() === "jpg" ? "active" : ""}
            onClick={() => setFormat("jpg")}
          >
            JPG
          </button>
          <button
            class={format() === "png" ? "active" : ""}
            onClick={() => setFormat("png")}
          >
            PNG
          </button>
        </div>
      </div>

      </div>

      <div class="actions">
        <button class="btn" onClick={submit} disabled={busy()}>
          {busy() ? "提交中…" : "开始截图"}
        </button>
      </div>
    </div>
  );
}
