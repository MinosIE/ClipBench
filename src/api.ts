// 与 Flask 后端交互的薄封装。所有请求走同源（生产由 Flask 托管 dist，
// 开发期由 vite proxy 转发 /api）。

async function jsonFetch(url: string, init?: RequestInit) {
  const method = (init?.method ?? "GET").toUpperCase();
  const needsBody = method === "POST" || method === "PUT" || method === "PATCH";
  // FormData（multipart 上传）必须让浏览器自动生成 Content-Type 与 boundary，
  // 绝不能覆写为 application/json，否则后端 request.files 解析为空。
  const isFormData = init?.body instanceof FormData;
  const headers = isFormData
    ? { ...(init?.headers ?? {}) }
    : {
        // 写操作无 body 时，补上空 JSON 与 Content-Type，避免后端 415
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      };
  const body = needsBody && init?.body == null ? "{}" : init?.body;
  const res = await fetch(url, { ...init, headers, body });
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
  // 编码详情（来自后端 meta，用于选中文件时展示）
  video_codec?: string;
  audio_codec?: string;
  duration?: number;
  video_bitrate?: number;
  audio_bitrate?: number;
  format_name?: string;
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
  // 压缩任务对比信息（后端完成后写入）
  kind?: string;
  src_name?: string;
  src_size?: number;
  src_size_human?: string;
  src_codec?: string;
  src_resolution?: string;
  out_size?: number;
  out_size_human?: string;
  out_codec?: string;
  out_resolution?: string;
  out_bitrate?: number;
  saving?: number;
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
    video_codec: meta.video_codec,
    audio_codec: meta.audio_codec,
    duration: meta.duration,
    video_bitrate: meta.video_bitrate,
    audio_bitrate: meta.audio_bitrate,
    format_name: meta.format_name,
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
export function downloadFileUrl(name: string) {
  // 单文件结果走 /api/download 才会带 Content-Disposition: attachment 触发下载
  return `/api/download/${encodeURIComponent(name)}`;
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

export async function deleteAllTasks(ids: string[]): Promise<void> {
  await jsonFetch(`/api/tasks/delete`, {
    method: "POST",
    body: JSON.stringify({ task_ids: ids }),
  });
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
  faststart?: boolean;
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
  vcodec?: "h264" | "hevc";
  faststart?: boolean;
}): Promise<{ task_id: string }> {
  return jsonFetch("/api/compress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

// 压缩智能建议（由后端 suggest_compress 统一计算，前后端共用同一套逻辑）
export interface CompressSuggestion {
  codec_label: string;
  src_is_hevc: boolean;
  out_is_hevc: boolean;
  rec_crf: number;
  actual_crf: number;
  rec_scale: string;
  rec_scale_label: string;
  est_saving: number;
  est_up: boolean;
  est_out_size: number;
  est_out_human: string;
  src_size: number;
  src_size_human: string;
  low_rate: boolean;
  high_rate: boolean;
  is_4k: boolean;
  tips: string[];
  summary: string;
}

export async function compressSuggest(
  file_id: string,
  vcodec: "h264" | "hevc"
): Promise<CompressSuggestion> {
  return jsonFetch("/api/compress_suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id, vcodec }),
  });
}

// ---------- 裁剪 ----------
export async function cropVideo(params: {
  file_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  faststart?: boolean;
}): Promise<{ task_id: string }> {
  return jsonFetch("/api/crop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

// ---------- 合并 ----------
export async function mergeVideos(file_ids: string[], faststart?: boolean): Promise<{
  task_id: string;
}> {
  return jsonFetch("/api/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_ids, faststart: !!faststart }),
  });
}

// ---------- 旋转 / 翻转 ----------
export async function rotateVideo(params: {
  file_id: string;
  rotation: number;
  flip_h?: boolean;
  flip_v?: boolean;
  faststart?: boolean;
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
  faststart?: boolean;
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
  faststart?: boolean;
}): Promise<{ task_id: string }> {
  return jsonFetch("/api/speed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

// 结果文件下载前缀
export const OUTPUT_PREFIX = "/outputs/";
