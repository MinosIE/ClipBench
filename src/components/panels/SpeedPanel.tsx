import { createSignal, Show, For } from "solid-js";
import { selectedId, pushToast, upsertTask, faststartEnabled } from "../../store";
import { speedVideo } from "../../api";

export default function SpeedPanel() {
  const [speed, setSpeed] = createSignal(1);
  const [reverse, setReverse] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const presets = [0.5, 1, 1.5, 2, 4];

  const submit = async () => {
    if (!selectedId()) {
      pushToast("请先在左侧选择一个视频", "error");
      return;
    }
    if (speed() === 1 && !reverse()) {
      pushToast("请调整速度或勾选倒放", "error");
      return;
    }
    setBusy(true);
    try {
      const { task_id } = await speedVideo({
        file_id: selectedId()!,
        speed: speed(),
        reverse: reverse(),
        faststart: faststartEnabled(),
      });
      upsertTask({
        task_id,
        name: `调速 ${speed()}x${reverse() ? " 倒放" : ""}`,
        status: "running",
        progress: 0,
        created_at: Math.floor(Date.now() / 1000),
      });
      pushToast("已提交调速任务", "success");
    } catch (e) {
      pushToast("提交失败：" + (e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="tab-panel two-col">
      <h2>调速 / 倒放</h2>
      <p class="muted">调整播放速度（0.5x ~ 4x），或生成倒放视频。</p>

      <div class="form-card">
        <div class="field row col-span">
          <label>速度倍率</label>
        <div class="seg">
          <For each={presets}>
            {(p) => (
              <button
                class={speed() === p ? "active" : ""}
                onClick={() => setSpeed(p)}
              >
                {p}x
              </button>
            )}
          </For>
        </div>
        <div class="range-row">
          <input
            type="range"
            min="0.25"
            max="4"
            step="0.25"
            value={speed()}
            onInput={(e) => setSpeed(+e.currentTarget.value)}
          />
          <span class="range-val">{speed()}x</span>
        </div>
      </div>

      <div class="field row">
        <label>倒放</label>
        <label class="inline-check">
          <input
            type="checkbox"
            checked={reverse()}
            onChange={(e) => setReverse(e.currentTarget.checked)}
          />
          生成倒放视频
        </label>
      </div>

      <p class="hint col-span">
        加速（&gt;1x）丢弃部分帧、文件变小；减速（&lt;1x）复制帧、体积增大。慢动作选 0.5x，长视频摘要选 2x~4x。
      </p>

      <div class="actions">
        <button class="btn" onClick={submit} disabled={busy()}>
          {busy() ? "提交中…" : "开始处理"}
        </button>
      </div>

      </div>

      <aside class="panel-aside">
        <h4>说明</h4>
        <ul>
          <li>加速（&gt;1x）会丢弃部分帧，文件变小、更流畅。</li>
          <li>减速（&lt;1x）会复制帧，体积增大、动作变慢。</li>
          <li>倒放需重新编码，无法用「复制」模式。</li>
          <li>2x / 4x 常用于教程快进、卡点剪辑。</li>
        </ul>
        <div class="aside-note">
          建议：慢动作选 0.5x，长视频摘要选 2x~4x。
        </div>
      </aside>
    </div>
  );
}
