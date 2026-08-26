import { createSignal, Show } from "solid-js";
import { selectedId, pushToast, upsertTask, persistSignal } from "../../store";
import { screenshotVideo } from "../../api";
import TimePickerModal, { fmtHms } from "../../components/TimePickerModal";

export default function ScreenshotPanel() {
  const [mode, setMode] = persistSignal<"single" | "every">("cb.screenshot.mode", "single");
  const [time, setTime] = createSignal("00:00:01");
  const [format, setFormat] = persistSignal<"jpg" | "png" | "webp" | "avif">("cb.screenshot.format", "jpg");
  const [interval, setInterval] = persistSignal<number>("cb.screenshot.interval", 5);
  const [busy, setBusy] = createSignal(false);
  const [previewOpen, setPreviewOpen] = createSignal(false);

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
    <div class="tab-panel two-col">
      <h2>截图</h2>
      <p class="muted">截取单张画面，或按固定间隔批量截取。</p>

      <div class="form-card">
        <div class="field row col-span">
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
          <div class="field row">
            <label>时间点（HH:MM:SS）</label>
            <input
              type="text"
              value={time()}
              onInput={(e) => setTime(e.currentTarget.value)}
              style={{ width: "130px" }}
            />
            <button
              class="btn secondary small"
              onClick={() => setPreviewOpen(true)}
            >
              预览取帧
            </button>
          </div>
        </Show>

        <Show when={mode() === "every"}>
          <div class="field row">
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

        <div class="field row">
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
            <button
              class={format() === "webp" ? "active" : ""}
              onClick={() => setFormat("webp")}
            >
              WebP
            </button>
            <button
              class={format() === "avif" ? "active" : ""}
              onClick={() => setFormat("avif")}
            >
              AVIF
            </button>
          </div>
        </div>

        <div class="actions">
          <button class="btn" onClick={submit} disabled={busy()}>
            {busy() ? "提交中…" : "开始截图"}
          </button>
        </div>

      </div>

      <Show when={previewOpen() && selectedId()}>
        <TimePickerModal
          videoName={selectedId()!}
          title="预览取帧"
          onClose={() => setPreviewOpen(false)}
          actions={[
            {
              label: "使用当前时间",
              onPick: (sec) => {
                setTime(fmtHms(sec));
                setPreviewOpen(false);
              },
            },
          ]}
        />
      </Show>

      <aside class="panel-aside">
        <h4>截图贴士</h4>
        <ul>
          <li><b>单张</b>：填写精确时间点（HH:MM:SS）截关键帧。</li>
          <li><b>间隔批量</b>：间隔越小，输出图片越多。</li>
          <li><b>JPG</b> 体积小适合分享；<b>PNG</b> 无损更清晰。</li>
          <li>批量截图会打包为 zip，注意下载体积。</li>
        </ul>
        <div class="aside-note">
          提示：封面图建议用「单张」+ PNG 保清晰。
        </div>
      </aside>
    </div>
  );
}
