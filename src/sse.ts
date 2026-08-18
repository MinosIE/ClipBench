import { setTasks, upsertTask } from "./store";
import type { Task } from "./api";

let es: EventSource | null = null;

export function startSSE() {
  if (es) return;
  es = new EventSource("/api/tasks/stream");

  es.onmessage = (ev) => {
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
    // 断线降级：拉一次全量，2s 后重连
    es?.close();
    es = null;
    fetch("/api/tasks")
      .then((r) => r.json())
      .then((data: Task[]) => setTasks(data))
      .catch(() => {})
      .finally(() => setTimeout(startSSE, 2000));
  };
}

export function stopSSE() {
  es?.close();
  es = null;
}
