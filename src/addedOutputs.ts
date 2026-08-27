import { createSignal } from "solid-js";

/**
 * 已手动“添加”到左侧媒体列表的产物文件名集合（localStorage 持久化）。
 * 产物默认不回流，只有用户在任务列表点「添加」后才出现在媒体文件列表。
 */
const KEY = "cb_added_outputs";

function load(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const [addedOutputs, setAddedOutputs] = createSignal<string[]>(load());

export function persistAddedOutputs(list: string[]) {
  setAddedOutputs(list);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

/** 添加产物到媒体列表（去重） */
export function addOutput(name: string) {
  if (!name || isOutputAdded(name)) return;
  persistAddedOutputs([...addedOutputs(), name]);
}

/** 从媒体列表移除产物（不删物理文件，由调用方决定） */
export function removeOutput(name: string) {
  persistAddedOutputs(addedOutputs().filter((n) => n !== name));
}

export function isOutputAdded(name: string): boolean {
  return addedOutputs().includes(name);
}
