import { For, Show, createSignal } from "solid-js";
import {
  tasks,
  patchTask,
  setTasks,
  confirmModal,
  pushToast,
} from "../store";
import {
  cancelTask,
  deleteTask,
  deleteAllTasks,
  outputUrl,
  downloadDirUrl,
  downloadFileUrl,
} from "../api";

const statusText: Record<string, string> = {
  queued: "排队中",
  running: "处理中",
  finished: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export default function Tasks() {
  const [selected, setSelected] = createSignal<Set<string>>(new Set());

  const toggleSelect = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const allSelected = () =>
    tasks.length > 0 && selected().size >= tasks.length;
  const toggleSelectAll = (checked: boolean) => {
    setSelected(checked ? new Set(tasks.map((t) => t.task_id)) : new Set());
  };

  const onCancel = async (id: string) => {
    await cancelTask(id);
    patchTask(id, { status: "cancelled" });
  };

  const onDelete = async (id: string) => {
    await deleteTask(id);
    setTasks((prev) => prev.filter((t) => t.task_id !== id));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const onBatchDelete = () => {
    const ids = [...selected()];
    if (ids.length === 0) return;
    confirmModal({
      title: "批量删除任务",
      message: `确定删除选中的 ${ids.length} 个任务记录？已生成的输出文件不会被删除。`,
      confirmText: "删除",
      danger: true,
      onConfirm: async () => {
        for (const id of ids) {
          await deleteTask(id);
        }
        const set = new Set(ids);
        setTasks((prev) => prev.filter((t) => !set.has(t.task_id)));
        setSelected(new Set());
        pushToast(`已删除 ${ids.length} 个任务`, "info");
      },
    });
  };

  const onDeleteAll = () => {
    confirmModal({
      title: "清空任务列表",
      message: "确定删除全部任务记录？已生成的输出文件不会被删除。",
      confirmText: "清空",
      danger: true,
      onConfirm: async () => {
        const ids = tasks.map((t) => t.task_id);
        await deleteAllTasks(ids);
        setTasks([]);
        setSelected(new Set());
        pushToast("已清空任务列表", "info");
      },
    });
  };

  return (
    <>
      <Show when={tasks.length > 0}>
        <div class="panel" style={{ position: "relative" }}>
          <div
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
            }}
          >
            <h2>
              任务列表 <span class="badge">共 {tasks.length}</span>
            </h2>
            <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
              <label
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "4px",
                  "font-size": "12px",
                  color: "var(--muted)",
                }}
              >
                <input
                  type="checkbox"
                  checked={allSelected()}
                  onChange={(e) => toggleSelectAll(e.currentTarget.checked)}
                />
                全选
              </label>
              <button
                class="btn danger small"
                disabled={selected().size === 0}
                onClick={onBatchDelete}
              >
                批量删除{selected().size > 0 ? `(${selected().size})` : ""}
              </button>
              <button class="btn danger small" onClick={onDeleteAll}>
                清空全部
              </button>
            </div>
          </div>
          <div class="tasks">
            <For each={tasks} fallback={<div class="empty">暂无任务</div>}>
              {(t) => (
                <div class="task-card">
                  <div class="task-head">
                    <label class="task-check">
                      <input
                        type="checkbox"
                        checked={selected().has(t.task_id)}
                        onChange={(e) => toggleSelect(t.task_id, e.currentTarget.checked)}
                      />
                    </label>
                    <div class="task-top">
                      <span class="task-name">{t.name}</span>
                      <span class={`task-status status-${t.status}`}>
                        {statusText[t.status] ?? t.status}
                      </span>
                    </div>
                  </div>

                  <div class="progress">
                    <div
                      class={`progress-bar ${t.status === "running" || t.status === "queued" ? "" : "progress-done"}`}
                      style={{ width: `${Math.round(t.progress ?? 0)}%` }}
                    />
                  </div>

                  <div class="task-line">
                    <div class="task-meta">
                      <span>{Math.round(t.progress ?? 0)}%</span>
                      <Show when={t.quality}>
                        <span>{t.quality === "high" ? "高质量" : "标准"}</span>
                      </Show>
                      <Show when={t.elapsed}>
                        <span>耗时 {Math.round(t.elapsed!)}s</span>
                      </Show>
                    </div>

                    <Show when={t.output_name && t.status === "finished"}>
                      <div class="task-result">
                        <a href={outputUrl(t.output_name!)} target="_blank">
                          查看单个结果
                        </a>
                        <Show
                          when={t.output_dir}
                          fallback={
                            <a href={downloadFileUrl(t.output_name!)}>
                              下载结果
                            </a>
                          }
                        >
                          <a href={downloadDirUrl(t.task_id)}>下载完整输出</a>
                        </Show>
                      </div>
                    </Show>

                    <div class="task-actions">
                      <Show
                        when={t.status === "running" || t.status === "queued"}
                      >
                        <button
                          class="btn secondary small"
                          onClick={() => onCancel(t.task_id)}
                        >
                          取消
                        </button>
                      </Show>
                      <button
                        class="btn danger small"
                        onClick={() => onDelete(t.task_id)}
                      >
                        删除
                      </button>
                    </div>
                  </div>

                  <Show when={t.error}>
                    <div class="task-error">{t.error}</div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </>
  );
}
