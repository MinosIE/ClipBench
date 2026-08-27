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
    // 尝试解析后端 JSON 错误体（如 {error: "..."}），解析失败则降级显示原文。
    // 否则会把整个 JSON 字符串拼进 Error，导致 toast 里出现 \u 转义乱码。
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      if (j && typeof j.error === "string") msg = j.error;
    } catch {
      /* 文本不是 JSON，保持原文 */
    }
    throw new Error(msg);
  }
  return res.json();
}

// 全局输出文件名模板（独立模块，避免与 store 循环依赖）
import { filenameTemplate } from "./filenameTemplate";

/** 给任务创建请求体注入 filename_template（模板为空时后端用默认） */
function withTemplate(payload: Record<string, any>): Record<string, any> {
  const tpl = filenameTemplate();
  if (tpl) return { ...payload, filename_template: tpl };
  return payload;
}

/** 复制模式（保留原编码）下，选中文件参数是否一致。返回 null 表示 OK，否则返回中文错误。 */
export function checkMergeCompatible(files: StoredFile[]): string | null {
  if (files.length < 2) return null;
  const ref = files[0];
  for (const f of files.slice(1)) {
    if ((ref.video_codec ?? "") !== (f.video_codec ?? "")) {
      return `「保留原编码」要求所有视频参数一致，但 ${f.name} 与 ${ref.name} 的视频编码不同（${ref.video_codec ?? "未知"} ≠ ${f.video_codec ?? "未知"}）。请改用「H.264」或「HEVC」后重试。`;
    }
    if (ref.width && f.width && ref.height && f.height &&
        (ref.width !== f.width || ref.height !== f.height)) {
      return `「保留原编码」要求所有视频参数一致，但 ${f.name} 与 ${ref.name} 的分辨率不同（${ref.width}x${ref.height} ≠ ${f.width}x${f.height}）。请改用「H.264」或「HEVC」后重试。`;
    }
    if (ref.fps && f.fps && Math.abs(ref.fps - f.fps) > 0.5) {
      return `「保留原编码」要求所有视频参数一致，但 ${f.name} 与 ${ref.name} 的帧率不同（${ref.fps} ≠ ${f.fps}）。请改用「H.264」或「HEVC」后重试。`;
    }
    if ((ref.audio_codec ?? "") !== (f.audio_codec ?? "")) {
      return `「保留原编码」要求所有视频参数一致，但 ${f.name} 与 ${ref.name} 的音频编码不同（${ref.audio_codec ?? "未知"} ≠ ${f.audio_codec ?? "未知"}）。请改用「H.264」或「HEVC」后重试。`;
    }
  }
  return null;
}

export interface StoredFile {
  name: string;
  size: number;
  uploaded_at: number;
  display_size?: string;
  location?: "uploads" | "outputs"; // 后端返回：上传文件 / 输出产物
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
  // 压缩参数（提交任务时写入）
  preset?: string;
  crf?: number; // 实际生效 CRF（含 HEVC 偏移）
  user_crf?: number; // 用户输入的 CRF
  crf_offset?: number; // 偏移量（HEVC 源二次压缩时 > 0）
  vcodec_out?: string;
  scale?: string;
  src_duration?: number; // 源总时长（秒）
  processed_duration?: number; // 实际处理时长（秒）
  log?: string; // ffmpeg 输出日志（尾部若干行，含 stderr），用于失败排查
  // 拆分任务结果信息（后端完成后写入）
  split_mode?: string; // segment | time
  encode?: "copy" | "reencode"; // 拆分采用的编码方式
  out_duration?: number; // 单片段时长（秒，多片段取首个文件）
  out_count?: number; // 输出文件数量
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
    location: raw.location,
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

/** 获取后端 ffmpeg 版本（形如 "ffmpeg version 6.1.1 Copyright ..."，缺失时返回"未检测到 ffmpeg"） */
export async function fetchFFmpegVersion(): Promise<string> {
  const data = await jsonFetch("/api/version");
  return typeof data?.ffmpeg === "string" ? data.ffmpeg : "";
}

export async function listFiles(opts: {
  includeOutputs?: boolean;
} = {}): Promise<StoredFile[]> {
  const q = opts.includeOutputs === false ? "?outputs=0" : "";
  const data = await jsonFetch(`/api/files${q}`);
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
  // 注意：后端路由为单数 /api/task/<id>/cancel（与 /api/task/<id>、/api/task/<id>/delete 一致）
  await jsonFetch(`/api/task/${encodeURIComponent(taskId)}/cancel`, {
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
    body: JSON.stringify(withTemplate(payload)),
  });
}

// ---------- 拆分 ----------
export async function splitVideo(params: {
  file_id: string;
  mode: "segment" | "time";
  segment?: number;
  mute?: boolean;
  output?: "video" | "gif";
  encode?: "copy" | "reencode";
  start?: string;
  end?: string;
  segments?: { start: string; end: string }[];
  gif_fps?: number;
  gif_width?: number;
}): Promise<{ task_id: string }> {
  return jsonFetch("/api/split", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(withTemplate(params)),
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
    body: JSON.stringify(withTemplate(params)),
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
    body: JSON.stringify(withTemplate(params)),
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
    body: JSON.stringify(withTemplate(params)),
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
    body: JSON.stringify(withTemplate(params)),
  });
}

// ---------- 合并 ----------
export async function mergeVideos(file_ids: string[], faststart?: boolean, encode?: "h264" | "hevc" | "copy"): Promise<{
  task_id: string;
}> {
  return jsonFetch("/api/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(withTemplate({ file_ids, faststart: !!faststart, encode: encode ?? "reencode" })),
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
    body: JSON.stringify(withTemplate(params)),
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
    body: JSON.stringify(withTemplate(params)),
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
    body: JSON.stringify(withTemplate(params)),
  });
}

// ---------- 音频提取 ----------
export async function extractAudio(params: {
  file_id: string;
  format: "mp3" | "wav" | "flac" | "m4a";
  bitrate?: string;
}): Promise<{ task_id: string }> {
  return jsonFetch("/api/extract_audio", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(withTemplate(params)),
  });
}

// 结果文件下载前缀
export const OUTPUT_PREFIX = "/outputs/";
