// 与 Flask 后端交互的薄封装。所有请求走同源（生产由 Flask 托管 dist，
// 开发期由 vite proxy 转发 /api）。

async function jsonFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`请求失败 ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export interface StoredFile {
  name: string;
  size: number;
  uploaded_at: number;
  display_size?: string;
  is_video?: boolean;
  width?: number;
  height?: number;
  fps?: number;
  fourcc?: string;
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

// 后端任务结构（与 app.py 中 TASKS 字典一致）
export interface Task {
  task_id: string;
  name: string;
  status: "queued" | "running" | "finished" | "failed" | "cancelled";
  progress: number | null;
  error?: string | null;
  duration?: number;
  elapsed?: number;
  output_name?: string;
  output_dir?: string;
  quality?: string;
  created_at: number;
}

// ---------- 文件 ----------
// 后端 /api/files 返回的每个对象字段为 file_id/filename/size/size_human/meta，
// 这里统一映射成前端使用的 StoredFile（name/display_size/width/...）。
function mapFile(raw: any): StoredFile {
  const meta = raw.meta ?? {};
  return {
    name: raw.filename ?? raw.file_id,
    size: raw.size ?? meta.size ?? 0,
    uploaded_at: raw.uploaded_at ?? 0,
    display_size: raw.size_human ?? meta.size_human,
    is_video: meta.has_video ?? meta.width != null,
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    fourcc: meta.video_codec,
  };
}

export async function listFiles(): Promise<StoredFile[]> {
  const data = await jsonFetch("/api/files");
  return (data.files ?? []).map(mapFile);
}

export async function uploadFile(file: File): Promise<{ filename: string }> {
  const form = new FormData();
  form.append("file", file);
  return jsonFetch("/api/upload", { method: "POST", body: form });
}

export async function deleteFile(filename: string): Promise<void> {
  await jsonFetch(`/api/delete_upload/${encodeURIComponent(filename)}`, {
    method: "POST",
  });
}

export async function deleteFiles(filenames: string[]): Promise<void> {
  await jsonFetch(`/api/delete_uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_ids: filenames }),
  });
}

export async function getVideoInfo(
  fileId: string
): Promise<{ width: number; height: number; fps: number; fourcc: string }> {
  // 后端媒体信息接口为 /api/file/<file_id>（无 /api/video_info 路由）
  const data = await jsonFetch(`/api/file/${encodeURIComponent(fileId)}`);
  return data.meta ?? data;
}

export function thumbUrl(name: string) {
  return `/api/thumbnail/${encodeURIComponent(name)}`;
}
export function frameUrl(name: string, t: number) {
  return `/api/frame/${encodeURIComponent(name)}?t=${t}`;
}
export function uploadUrl(name: string) {
  return `/uploads/${encodeURIComponent(name)}`;
}
export function outputUrl(name: string) {
  return `/outputs/${encodeURIComponent(name)}`;
}
export function downloadDirUrl(taskId: string) {
  return `/api/download_dir/${encodeURIComponent(taskId)}`;
}

// ---------- 任务 ----------
export async function listTasks(): Promise<Task[]> {
  const data = await jsonFetch("/api/tasks");
  return data.tasks ?? [];
}

export async function cancelTask(taskId: string): Promise<void> {
  await jsonFetch(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
  });
}

export async function deleteTask(taskId: string): Promise<void> {
  await jsonFetch(`/api/task/${encodeURIComponent(taskId)}/delete`, {
    method: "POST",
  });
}

export async function deleteAllTasks(): Promise<void> {
  await jsonFetch(`/api/tasks/delete`, { method: "POST" });
}

// ---------- 去字幕 ----------
export async function startDesubtitle(
  fileId: string,
  region: Region,
  quality: "standard" | "high" = "standard",
  mode: "delogo" | "inpaint" | "blur" | "mosaic" = "inpaint",
  strength: number = 18
): Promise<{ task_id: string }> {
  // 对齐旧版：inpaint 模式用 strength 作为修复半径；其余模式用 strength 作为强度
  const payload: Record<string, unknown> = {
    file_id: fileId,
    mode,
    quality,
    x: region.x,
    y: region.y,
    w: region.w,
    h: region.h,
  };
  if (mode === "inpaint") {
    payload.radius = strength;
  } else {
    payload.strength = strength;
  }
  return jsonFetch("/api/desubtitle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ---------- 拆分 ----------
export async function splitVideo(params: {
  file_id: string;
  mode: "segment" | "time";
  segment?: number;
  mute?: boolean;
  output?: "video" | "gif";
  start?: string;
  end?: string;
  segments?: { start: string; end: string }[];
  gif_fps?: number;
  gif_width?: number;
}): Promise<{ task_id: string }> {
  return jsonFetch("/api/split", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

// ---------- 截图 ----------
export async function screenshotVideo(params: {
  file_id: string;
  mode: "single" | "every";
  time?: string;
  format?: "jpg" | "png";
  interval?: number;
}): Promise<{ task_id: string }> {
  return jsonFetch("/api/screenshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

// ---------- 格式转换 ----------
export async function convertVideo(params: {
  file_id: string;
  target: string;
  crf?: number;
  vcodec?: string;
}): Promise<{ task_id: string }> {
  return jsonFetch("/api/convert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

// ---------- 压缩 ----------
export async function compressVideo(params: {
  file_id: string;
  preset: string;
  crf: number;
  scale: "original" | "1080" | "720" | "480";
}): Promise<{ task_id: string }> {
  return jsonFetch("/api/compress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

// ---------- 裁剪 ----------
export async function cropVideo(params: {
  file_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}): Promise<{ task_id: string }> {
  return jsonFetch("/api/crop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

// ---------- 合并 ----------
export async function mergeVideos(file_ids: string[]): Promise<{
  task_id: string;
}> {
  return jsonFetch("/api/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_ids }),
  });
}

// ---------- 旋转 / 翻转 ----------
export async function rotateVideo(params: {
  file_id: string;
  rotation: number;
  flip_h?: boolean;
  flip_v?: boolean;
}): Promise<{ task_id: string }> {
  return jsonFetch("/api/rotate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

// ---------- 水印 ----------
export async function uploadWatermark(file: File): Promise<{
  watermark_id: string;
  filename: string;
}> {
  const form = new FormData();
  form.append("file", file);
  return jsonFetch("/api/upload_watermark", { method: "POST", body: form });
}

export async function watermarkVideo(params: {
  file_id: string;
  type: "text" | "image";
  position: "tl" | "tr" | "bl" | "br" | "c";
  margin?: number;
  text?: string;
  fontsize?: number;
  color?: string;
  alpha?: number;
  watermark_id?: string;
  scale_w?: number;
}): Promise<{ task_id: string }> {
  return jsonFetch("/api/watermark", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

// ---------- 调速 / 倒放 ----------
export async function speedVideo(params: {
  file_id: string;
  speed: number;
  reverse?: boolean;
}): Promise<{ task_id: string }> {
  return jsonFetch("/api/speed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

// 结果文件下载前缀
export const OUTPUT_PREFIX = "/outputs/";
