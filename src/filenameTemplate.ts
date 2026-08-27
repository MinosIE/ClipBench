import { createSignal } from "solid-js";

/**
 * 全局输出文件名模板（持久化到 localStorage）。
 * 占位符：{name} 源文件名(去扩展名) / {ext} 扩展名(含点) /
 *          {ts} 时间戳 / {date} 日期(YYYYMMDD) / {time} 时分秒(HHMMSS)
 * 留空则后端回退到默认模板「原名_时间戳.扩展名」。
 */
const KEY = "cb_filename_template";

function load(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export const [filenameTemplate, setFilenameTemplate] = createSignal<string>(load());

export function persistFilenameTemplate(v: string) {
  setFilenameTemplate(v);
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** 占位符说明，供设置面板展示 */
export const TEMPLATE_HINT =
  "{name} 源名 · {ext} 扩展名 · {ts} 时间戳 · {date} 日期 · {time} 时分秒";
