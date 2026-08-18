import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { StoredFile, Region, Task } from "./api";

// ---- 全局响应式状态 ----
// 用 Solid 的 store 保存任务列表：更新某个 task 的 progress 时只触发该字段
// 的细粒度更新（编译时自动拆分），不会重绘整个列表 —— 这正是消除 Elements
// 里 task-list 闪动的关键。

export type TabKey =
  | "desubtitle"
  | "split"
  | "screenshot"
  | "convert"
  | "compress"
  | "crop"
  | "merge"
  | "rotate"
  | "watermark"
  | "speed";

export const TABS: { key: TabKey; label: string }[] = [
  { key: "split", label: "拆分" },
  { key: "screenshot", label: "截图" },
  { key: "convert", label: "格式转换" },
  { key: "compress", label: "压缩" },
  { key: "crop", label: "裁剪" },
  { key: "merge", label: "合并" },
  { key: "rotate", label: "旋转" },
  { key: "watermark", label: "水印" },
  { key: "speed", label: "调速" },
  { key: "desubtitle", label: "去字幕" },
];

export const [files, setFiles] = createStore<StoredFile[]>([]);
export const [selectedId, setSelectedId] = createSignal<string | null>(null);
// 注意：不要用 createStore 包裹原生 Set，Solid 的 Proxy 会让 Set.prototype.size
// 的 getter 报 "incompatible receiver"。用普通 signal 保存 Set 即可。
export const [selectedFiles, setSelectedFiles] = createSignal<Set<string>>(
  new Set()
);
export const [regions, setRegions] = createStore<Region[]>([]);
export const [tasks, setTasks] = createStore<Task[]>([]);
export const [busy, setBusy] = createSignal(false); // 上传/提交中
export const [activeTab, setActiveTab] = createSignal<TabKey>("desubtitle");
export const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);

export interface ModalState {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export const [modal, setModal] = createSignal<ModalState | null>(null);

export interface ToastItem {
  id: number;
  message: string;
  type: "success" | "error" | "info";
}
export const [toasts, setToasts] = createStore<ToastItem[]>([]);

let toastSeq = 0;
export function pushToast(
  message: string,
  type: ToastItem["type"] = "info",
  ttl = 3000
) {
  const id = ++toastSeq;
  setToasts((prev) => [...prev, { id, message, type }]);
  setTimeout(() => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, ttl);
}

export function confirmModal(opts: ModalState) {
  setModal(opts);
}

export function upsertTask(t: Task) {
  const idx = tasks.findIndex((x) => x.task_id === t.task_id);
  if (idx === -1) {
    // 新增任务：保持对象标识，使 For 不会重挂载
    setTasks((prev) => [t, ...prev]);
    return;
  }
  // 原地合并到已有对象的属性上，保持数组元素引用不变 -> 进度条可平滑过渡
  setTasks(idx, (cur) => {
    Object.assign(cur, t);
    return cur;
  });
}

export function patchTask(taskId: string, patch: Partial<Task>) {
  const idx = tasks.findIndex((x) => x.task_id === taskId);
  if (idx === -1) return;
  // 原地合并，保持对象引用不变
  setTasks(idx, (cur) => {
    Object.assign(cur, patch);
    return cur;
  });
}

// 批量选择辅助
export function toggleSelect(name: string) {
  const prev = selectedFiles();
  const next = new Set(prev);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  setSelectedFiles(next);
}
export function clearSelect() {
  setSelectedFiles(new Set());
}
