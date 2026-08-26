import { For, Show, createSignal, createEffect } from "solid-js";
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
import { refreshFiles } from "./Sidebar";

const statusText: Record<string, string> = {
  queued: "排队中",
  running: "处理中",
  finished: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const presetLabels: Record<string, string> = {
  veryslow: "极慢",
  slow: "慢",
  medium: "中",
  fast: "快",
  veryfast: "极快",
};

const fmtDur = (s?: number) =>
  s == null ? "" : s >= 60 ? `${(s / 60).toFixed(1)}分` : `${s.toFixed(1)}s`;

export default function Tasks() {
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [collapsed, setCollapsed] = createSignal(false);
  const [logModal, setLogModal] = createSignal<{ name: string; content: string } | null>(null);

  // 任务完成且产生输出文件时，自动刷新左侧文件列表（产物回流）
  let lastDone = "";
  createEffect(() => {
    const done = tasks
      .filter((t) => t.status === "finished" && t.output_name)
      .map((t) => `${t.task_id}:${t.output_name}`)
      .join("|");
    if (done && done !== lastDone) {
      lastDone = done;
      refreshFiles();
    }
  });

  const copyLog = async () => {
    const m = logModal();
    if (!m) return;
    try {
      await navigator.clipboard.writeText(m.content);
      pushToast("日志已复制", "success");
    } catch {
      pushToast("复制失败", "error");
    }
  };

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
    try {
      await cancelTask(id);
      patchTask(id, { status: "cancelled" });
    } catch (e) {
      pushToast(`取消失败：${(e as Error).message}`, "error");
    }
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
    <aside class="tasks-pane" classList={{ collapsed: collapsed() }}>
      <div class="tasks-pane-head">
        <Show when={!collapsed()}>
          <h2>
            任务列表 <span class="badge">共 {tasks.length}</span>
          </h2>
        </Show>
        <Show when={collapsed()}>
          <span class="collapsed-title">任务列表</span>
        </Show>
        <Show when={!collapsed()}>
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
                disabled={tasks.length === 0}
                onChange={(e) => toggleSelectAll(e.currentTarget.checked)}
              />
              全选
            </label>
            <button
              class="btn danger small"
              disabled={selected().size === 0}
              onClick={onBatchDelete}
            >
              删除
            </button>
            <button class="btn danger small" disabled={tasks.length === 0} onClick={onDeleteAll}>
              清空
            </button>
          </div>
        </Show>
        <button
          class="icon-btn"
          title={collapsed() ? "展开任务列表" : "折叠任务列表"}
          onClick={() => setCollapsed((c) => !c)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d={collapsed() ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"} />
          </svg>
        </button>
      </div>
      <Show when={!collapsed()}>
        <div class="tasks-scroll">
        <Show when={tasks.length > 0} fallback={<div class="empty">暂无任务，处理视频后会显示在这里</div>}>
          <div class="tasks">
            <For each={tasks}>
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
                    <Show when={t.src_name}>
                      <div class="task-src">源：{t.src_name}</div>
                    </Show>
                  </div>

                  <div class="progress">
                    <div
                      class={`progress-bar ${t.status === "running" || t.status === "queued" ? "" : "progress-done"}`}
                      style={{ width: `${Math.round(t.progress ?? 0)}%` }}
                    />
                  </div>

                  {/* 压缩任务完成后的源/输出对比（独占一行，撑满卡片宽度） */}
                  <Show
                    when={
                      t.kind === "compress" &&
                      t.status === "finished" &&
                      t.out_size
                    }
                  >
                    <div class="compress-compare">
                      <div class="cc-col">
                        <div class="cc-label">源</div>
                        <div class="cc-size">{t.src_size_human || "—"}</div>
                        <div class="cc-sub">
                          <Show when={t.src_codec}>
                            <span class="cc-codec">{t.src_codec}</span>
                          </Show>
                          <Show when={t.src_resolution}>
                            <span>{t.src_resolution}</span>
                          </Show>
                        </div>
                      </div>
                      <div class="cc-mid">
                        <div class="cc-arrow">→</div>
                        <div
                          class="cc-saving"
                          classList={{ good: (t.saving ?? 0) > 0 }}
                        >
                          {t.saving != null
                            ? `${t.saving > 0 ? "↓" : "↑"}${Math.abs(t.saving).toFixed(1)}%`
                            : ""}
                        </div>
                      </div>
                      <div class="cc-col cc-out">
                        <div class="cc-label">输出</div>
                        <div class="cc-size">{t.out_size_human || "—"}</div>
                        <div class="cc-sub">
                          <Show when={t.out_codec}>
                            <span class="cc-codec">{t.out_codec}</span>
                          </Show>
                          <Show when={t.out_resolution}>
                            <span>{t.out_resolution}</span>
                          </Show>
                        </div>
                      </div>
                    </div>
                  </Show>

                  {/* 拆分任务完成后的输出基本信息（横排紧凑 chips） */}
                  <Show
                    when={
                      t.kind === "split" &&
                      t.status === "finished" &&
                      t.out_size
                    }
                  >
                    <div class="cc-params">
                      <span>输出 {t.out_size_human || "—"}</span>
                      <Show when={t.out_count && t.out_count > 1}>
                        <span>{t.out_count} 个片段</span>
                      </Show>
                      <Show when={t.encode}>
                        <span class="cc-tag">
                          {t.encode === "copy"
                            ? "保留原编码"
                            : t.encode === "hevc"
                              ? "重编码 HEVC"
                              : "重编码 H.264"}
                        </span>
                      </Show>
                      <Show when={t.out_codec}>
                        <span class="cc-codec">{t.out_codec}</span>
                      </Show>
                      <Show when={t.out_resolution}>
                        <span>{t.out_resolution}</span>
                      </Show>
                      <Show when={t.out_duration != null}>
                        <span>
                          时长 {fmtDur(t.out_duration)}
                          {t.out_count && t.out_count > 1 ? " (首段)" : ""}
                        </span>
                      </Show>
                    </div>
                  </Show>

                  {/* 压缩参数（预设/CRF/编码/缩放），供回看任务时对照 */}
                  <Show
                    when={
                      t.kind === "compress" &&
                      (t.preset != null || t.crf != null)
                    }
                  >
                    <div class="cc-params">
                      <Show when={t.preset}>
                        <span>预设 {presetLabels[t.preset!] ?? t.preset}</span>
                      </Show>
                      <Show when={t.crf != null}>
                        <span
                          title={
                            t.crf_offset
                              ? `用户输入 CRF ${t.user_crf}，HEVC 源二次压缩含 +${t.crf_offset} 偏移`
                              : undefined
                          }
                        >
                          CRF {t.crf}
                          {t.crf_offset ? ` (+${t.crf_offset})` : ""}
                        </span>
                      </Show>
                      <Show when={t.vcodec_out}>
                        <span
                          class={
                            t.vcodec_out === "hevc" ? "cc-warn-tag" : ""
                          }
                          title={
                            t.vcodec_out === "hevc"
                              ? "HEVC 在 Chrome/Edge/Firefox 的 <video> 标签中无法播放，仅 Safari/QuickTime 等系统播放器支持"
                              : undefined
                          }
                        >
                          {t.vcodec_out === "hevc" ? "HEVC ⚠" : "H.264"}
                        </span>
                      </Show>
                      <Show when={t.scale}>
                        <span>
                          {t.scale === "original" ? "原分辨率" : `${t.scale}p`}
                        </span>
                      </Show>
                      <Show when={t.processed_duration != null}>
                        <span
                          title={
                            t.src_duration != null &&
                            Math.abs(t.src_duration - t.processed_duration!) > 0.01
                              ? `源总时长 ${fmtDur(t.src_duration)}，实际处理 ${fmtDur(t.processed_duration)}`
                              : `源总时长 ${fmtDur(t.src_duration)}`
                          }
                        >
                          时长 {fmtDur(t.processed_duration)}
                        </span>
                      </Show>
                    </div>
                  </Show>

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

                    <Show
                      when={
                        t.status === "finished" &&
                        (t.output_name || t.output_dir)
                      }
                    >
                      <div class="task-result">
                        {/* 单文件结果：查看 + 下载 */}
                        <Show
                          when={t.output_name && !t.output_dir}
                        >
                          <a href={outputUrl(t.output_name!)} target="_blank">
                            查看单个结果
                          </a>
                          <a href={downloadFileUrl(t.output_name!)}>
                            下载结果
                          </a>
                        </Show>
                        {/* 多文件结果（目录）：打包下载压缩包 */}
                        <Show when={t.output_dir}>
                          <a href={downloadDirUrl(t.task_id)}>
                            下载压缩包（{t.out_count ? `${t.out_count} 个文件` : "全部"}）
                          </a>
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
                      <Show when={t.status === "failed" && t.log}>
                        <button
                          class="btn secondary small"
                          onClick={() =>
                            setLogModal({ name: t.name, content: t.log! })
                          }
                        >
                          日志
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
        </Show>
        </div>
      </Show>

      {/* ffmpeg 日志弹窗 */}
      <Show when={logModal()}>
        <div class="modal-mask" onClick={() => setLogModal(null)}>
          <div class="modal log-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{logModal()!.name} · ffmpeg 日志</h3>
            <pre class="log-body">{logModal()!.content}</pre>
            <div class="modal-actions">
              <button class="btn secondary small" onClick={copyLog}>
                复制全部
              </button>
              <button class="btn primary small" onClick={() => setLogModal(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      </Show>
    </aside>
  );
}
