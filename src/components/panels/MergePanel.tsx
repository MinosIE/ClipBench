import { createSignal, Show, For } from "solid-js";
import { files, pushToast, upsertTask, faststartEnabled } from "../../store";
import { mergeVideos } from "../../api";
import { thumbUrl } from "../../api";

export default function MergePanel() {
  const [picked, setPicked] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);

  const toggle = (name: string) =>
    setPicked((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    );

  // 用上下按钮调整顺序
  const move = (name: string, dir: -1 | 1) => {
    setPicked((prev) => {
      const idx = prev.indexOf(name);
      const next = prev.slice();
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const submit = async () => {
    if (picked().length < 2) {
      pushToast("请至少选择 2 个文件进行合并", "error");
      return;
    }
    setBusy(true);
    try {
      const { task_id } = await mergeVideos(picked(), faststartEnabled());
      upsertTask({
        task_id,
        name: `合并 ${picked().length} 个文件`,
        status: "running",
        progress: 0,
        created_at: Math.floor(Date.now() / 1000),
      });
      pushToast("已提交合并任务", "success");
    } catch (e) {
      pushToast("提交失败：" + (e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="tab-panel">
      <h2>合并</h2>
      <p class="muted">
        勾选多个文件（按顺序从上到下拼接），可拖动顺序调整先后。
      </p>

      <Show
        when={files.length > 0}
        fallback={<div class="empty">暂无文件，请先上传</div>}
      >
        <div class="form-card">
          <div class="pick-grid">
          <For each={files}>
            {(f) => (
              <div
                class={`pick-item ${
                  picked().includes(f.name) ? "selected" : ""
                }`}
                onClick={() => toggle(f.name)}
              >
                <img src={thumbUrl(f.name)} />
                <span>{f.name}</span>
                <Show when={picked().includes(f.name)}>
                  <span class="badge">
                    第 {picked().indexOf(f.name) + 1} 位
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>

        <Show when={picked().length > 0}>
          <div class="field">
            <label>合并顺序</label>
            <For each={picked()}>
              {(name, i) => (
                <div class="row">
                  <span class="badge">{i() + 1}</span>
                  <span style={{ flex: "1", "min-width": "0" }}>{name}</span>
                  <button
                    class="btn secondary small"
                    onClick={() => move(name, -1)}
                    disabled={i() === 0}
                  >
                    ↑
                  </button>
                  <button
                    class="btn secondary small"
                    onClick={() => move(name, 1)}
                    disabled={i() === picked().length - 1}
                  >
                    ↓
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>

        </div>

        <div class="actions">
          <button class="btn" onClick={submit} disabled={busy()}>
            {busy() ? "提交中…" : "开始合并"}
          </button>
        </div>
      </Show>
    </div>
  );
}
