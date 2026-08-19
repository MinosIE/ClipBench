import { setTasks, upsertTask } from "./store";
import type { Task } from "./api";

let es: EventSource | null = null;
let pollTimer: number | null = null;

function startPolling() {
  if (pollTimer != null) return;
  // 兜底轮询：仅当 SSE 断线时才启用，500ms 拉一次保证进度可见
  pollTimer = window.setInterval(() => {
    fetch("/api/tasks")
      .then((r) => r.json())
      .then((data: Task[]) => {
        if (!Array.isArray(data)) return;
        // 用 upsertTask 逐项合并，保持对象身份不重挂载、进度条平滑
        for (const t of data) upsertTask(t);
      })
      .catch(() => {});
  }, 500);
}

function stopPolling() {
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function startSSE() {
  if (es) return;
  es = new EventSource("/api/tasks/stream");

  es.onmessage = (ev) => {
    // 收到任意推送即说明 SSE 正常，关闭兜底轮询
    stopPolling();
    let payload: Task[];
    try {
      payload = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!Array.isArray(payload)) return;
    // upsert：已在列表中的任务原地更新（保持 DOM 不重挂载、进度条平滑），
    // 不在列表中的（如刷新后从 tasks.json 恢复）则新增进来，避免记录丢失
    for (const t of payload) {
      upsertTask(t);
    }
  };

  es.onerror = () => {
    // SSE 断线：降级为兜底轮询，并 2s 后尝试重连
    startPolling();
    es?.close();
    es = null;
    setTimeout(startSSE, 2000);
  };
}

export function stopSSE() {
  stopPolling();
  es?.close();
  es = null;
}
