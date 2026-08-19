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

// icon 为 stroke 风格 SVG path（viewBox 0 0 24 24），在 Tab 栏内渲染
export const TABS: { key: TabKey; label: string; icon: string[] }[] = [
  {
    key: "split",
    label: "拆分",
    icon: ["M4 6h16", "M4 12h7", "M15 12h5", "M4 18h10", "M18 18h2"],
  },
  {
    key: "screenshot",
    label: "截图",
    icon: [
      "M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z",
      "M12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    ],
  },
  {
    key: "convert",
    label: "格式转换",
    icon: ["M17 1l4 4-4 4", "M3 11V9a4 4 0 0 1 4-4h14", "M7 23l-4-4 4-4", "M21 13v2a4 4 0 0 1-4 4H3"],
  },
  {
    key: "compress",
    label: "压缩",
    icon: ["M4 14h6v6", "M20 10h-6V4", "M14 10l7-7", "M3 21l7-7"],
  },
  {
    key: "crop",
    label: "裁剪",
    icon: ["M6 2v14a2 2 0 0 0 2 2h14", "M18 22V8a2 2 0 0 0-2-2H2"],
  },
  {
    key: "merge",
    label: "合并",
    icon: ["M12 2 2 7l10 5 10-5-10-5Z", "m2 17 10 5 10-5", "m2 12 10 5 10-5"],
  },
  {
    key: "rotate",
    label: "旋转",
    icon: ["M23 4v6h-6", "M20.49 15a9 9 0 1 1-2.12-9.36L23 10"],
  },
  {
    key: "watermark",
    label: "水印",
    icon: ["M4 7V5h16v2", "M12 5v14", "M9 19h6"],
  },
  {
    key: "speed",
    label: "调速",
    icon: ["M13 2 3 14h9l-1 8 10-12h-9l1-8Z"],
  },
  {
    key: "desubtitle",
    label: "去字幕",
    icon: ["M6 10h12", "M8 16h8", "M5 5l14 14"],
  },
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
// 全局偏好：输出 MP4/MOV 时追加 -movflags +faststart（便于网络流式播放）
export const [faststartEnabled, setFaststartEnabled] = createSignal<boolean>(
  localStorage.getItem("cb_faststart") === "1"
);
export function toggleFaststart() {
  const next = !faststartEnabled();
  setFaststartEnabled(next);
  localStorage.setItem("cb_faststart", next ? "1" : "0");
}

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
  // 注意：Solid 的 createStore 是基于 Proxy 的细粒度响应式。
  // setTasks(idx, fn) 只有在 fn 返回**新对象**时才会把新值挂上代理、触发反应式更新；
  // 若返回同一个对象（mutate-then-return-same-ref），Solid 认为值未变、不会通知订阅者，
  // 表现就是接口数据到了但 UI 永远停在 0%。所以这里必须返回一个新对象（用扩展运算符合并，
  // 保留旧对象上可能的 UI 局部状态）。
  setTasks(idx, (cur) => ({ ...cur, ...t }));
}

export function patchTask(taskId: string, patch: Partial<Task>) {
  const idx = tasks.findIndex((x) => x.task_id === taskId);
  if (idx === -1) return;
  // 同 upsertTask：必须返回新对象以触发 Solid store 的反应式更新
  setTasks(idx, (cur) => ({ ...cur, ...patch }));
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
