"use strict";

const state = {
  selected: null,   // 当前选中的 file_id
  meta: null,
  pollTimer: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function toast(msg, type = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (type ? " " + type : "") + " show";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

// ---------- 文件列表 ----------
async function loadVersion() {
  try {
    const v = await api("/api/version");
    $("#ffmpeg-version").textContent = v.ffmpeg;
  } catch {
    $("#ffmpeg-version").textContent = "获取失败";
  }
}

async function loadFiles() {
  try {
    const { files } = await api("/api/files");
    const box = $("#file-list");
    if (!files.length) {
      box.innerHTML = '<p class="empty">还没有文件，点击右上角上传。</p>';
      return;
    }
    box.innerHTML = "";
    files.forEach((f, i) => {
      const el = document.createElement("div");
      el.className = "file-item" + (state.selected === f.file_id ? " active" : "");
      el.style.animationDelay = (i * 45) + "ms";
      const isVideo = f.meta && f.meta.has_video;
      const icon = isVideo ? "🎞️" : (f.meta && f.meta.has_audio ? "🎵" : "📄");
      const dur = f.meta && f.meta.duration ? fmtDur(f.meta.duration) : "";
      const res = f.meta && f.meta.width ? `${f.meta.width}×${f.meta.height}` : "";
      el.innerHTML = `
        <span class="fi-icon">${icon}</span>
        <div class="fi-info">
          <div class="fi-name" title="${esc(f.filename)}">${esc(f.filename)}</div>
          <div class="fi-meta">${res} ${dur} · ${f.size_human}</div>
        </div>
        <span class="fi-del" title="删除">✕</span>`;
      el.addEventListener("click", (e) => {
        if (e.target.classList.contains("fi-del")) {
          e.stopPropagation();
          deleteFile(f.file_id);
          return;
        }
        selectFile(f.file_id);
      });
      box.appendChild(el);
    });
  } catch (e) {
    toast(e.message, "err");
  }
}

async function deleteFile(fileId) {
  if (!confirm("确定删除该文件？")) return;
  await api("/api/delete_upload/" + fileId, { method: "POST" });
  if (state.selected === fileId) {
    state.selected = null;
    $("#workbench").classList.add("hidden");
    $("#no-select").classList.remove("hidden");
  }
  loadFiles();
}

async function uploadFile(file) {
  const fd = new FormData();
  fd.append("file", file);
  toast("上传中…");
  try {
    await api("/api/upload", { method: "POST", body: fd });
    toast("上传成功", "ok");
    await loadFiles();
  } catch (e) {
    toast(e.message, "err");
  }
}

// ---------- 选择文件 ----------
async function selectFile(fileId) {
  state.selected = fileId;
  $$(".file-item").forEach((el) => el.classList.remove("active"));
  // 高亮
  const items = $$(".file-item");
  for (const it of items) {
    if (it.querySelector(".fi-name").title === fileFromTitle(fileId)) {
      it.classList.add("active");
    }
  }
  $("#no-select").classList.add("hidden");
  $("#workbench").classList.remove("hidden");
  try {
    const info = await api("/api/file/" + fileId);
    state.meta = info.meta;
    renderMediaInfo(fileId, info.meta);
  } catch (e) {
    toast(e.message, "err");
  }
}

function fileFromTitle(fileId) {
  return fileId;
}

function renderMediaInfo(fileId, meta) {
  $("#media-name").textContent = fileId;
  const thumb = $("#media-thumb");
  if (meta && meta.has_video) {
    thumb.src = "/api/thumbnail/" + encodeURIComponent(fileId) + "?" + Date.now();
    thumb.style.display = "block";
  } else {
    thumb.style.display = "none";
  }
  const grid = $("#media-meta");
  const items = [];
  if (meta) {
    if (meta.duration) items.push(["时长", fmtDur(meta.duration)]);
    if (meta.width) items.push(["分辨率", `${meta.width}×${meta.height}`]);
    if (meta.fps) items.push(["帧率", meta.fps + " fps"]);
    if (meta.video_codec) items.push(["视频编码", meta.video_codec]);
    if (meta.audio_codec) items.push(["音频编码", meta.audio_codec]);
    items.push(["大小", meta.size_human]);
    items.push(["容器", meta.format_name]);
  }
  grid.innerHTML = items
    .map(([k, v]) => `<div class="m"><b>${k}</b>${esc(String(v))}</div>`)
    .join("");
}

// ---------- 标签切换 ----------
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const name = tab.dataset.tab;
    $$(".panel").forEach((p) => {
      p.classList.toggle("active", p.dataset.panel === name);
    });
    if (name === "merge") refreshMergeList();
  });
});

// 拆分模式切换
$$('input[name="split-mode"]').forEach((r) => {
  r.addEventListener("change", () => {
    const seg = r.value === "segment";
    $("#split-segment").classList.toggle("hidden", !seg);
    $("#split-time").classList.toggle("hidden", seg);
  });
});

// 多片段列表管理
function addSegRow(start = "", end = "") {
  const list = $("#seg-list");
  const row = document.createElement("div");
  row.className = "seg-row";
  const idx = list.children.length + 1;
  row.innerHTML = `
    <span class="seg-idx">${idx}</span>
    <input type="text" class="seg-start" placeholder="开始 00:00:00" value="${esc(start)}" />
    <span class="seg-tilde">~</span>
    <input type="text" class="seg-end" placeholder="结束(可空)" value="${esc(end)}" />
    <button type="button" class="seg-del" title="删除">✕</button>`;
  row.querySelector(".seg-del").addEventListener("click", () => {
    row.remove();
    reindexSegs();
  });
  list.appendChild(row);
}
function reindexSegs() {
  $$("#seg-list .seg-row").forEach((row, i) => {
    row.querySelector(".seg-idx").textContent = i + 1;
  });
}
$("#add-seg").addEventListener("click", () => addSegRow());
// 初始给一行
addSegRow("00:00:00", "");

// 时间解析与校验（前端）
function parseTime(v) {
  v = (v || "").trim();
  if (v === "") return null;
  if (/^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  const m = v.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2]) * 60) + parseFloat(m[3]);
  return NaN;
}
function validateSegs() {
  const rows = $$("#seg-list .seg-row");
  if (!rows.length) return { ok: false, msg: "请至少添加一个片段" };
  const segs = [];
  const dur = (state.meta && state.meta.duration) || 0;
  for (const row of rows) {
    const s = parseTime(row.querySelector(".seg-start").value);
    const eRaw = row.querySelector(".seg-end").value;
    const e = eRaw.trim() === "" ? null : parseTime(eRaw);
    if (isNaN(s)) return { ok: false, msg: "开始时间格式不正确" };
    if (s < 0) return { ok: false, msg: "开始时间不能为负" };
    if (e !== null) {
      if (isNaN(e)) return { ok: false, msg: "结束时间格式不正确" };
      if (e <= s) return { ok: false, msg: "结束时间需大于开始时间" };
      if (dur && e > dur + 1) return { ok: false, msg: `结束时间超过视频总时长 ${fmtDur(dur)}` };
    }
    if (dur && s > dur + 1) return { ok: false, msg: `开始时间超过视频总时长 ${fmtDur(dur)}` };
    segs.push({ start: row.querySelector(".seg-start").value, end: eRaw });
  }
  return { ok: true, segs };
}
// 截图模式切换
$$('input[name="shot-mode"]').forEach((r) => {
  r.addEventListener("change", () => {
    const single = r.value === "single";
    $("#shot-single").classList.toggle("hidden", !single);
    $("#shot-every").classList.toggle("hidden", single);
  });
});
// 拆分输出格式切换（视频 / GIF）
$$('input[name="split-out"]').forEach((r) => {
  r.addEventListener("change", () => {
    const gif = r.value === "gif";
    $("#split-gif").classList.toggle("hidden", !gif);
  });
});
// 水印类型切换
$$('input[name="wm-type"]').forEach((r) => {
  r.addEventListener("change", () => {
    const text = r.value === "text";
    $("#wm-text").classList.toggle("hidden", !text);
    $("#wm-image").classList.toggle("hidden", text);
  });
});
// 调速滑块显示
$("#speed-val").addEventListener("input", (e) => {
  $("#speed-label").textContent = parseFloat(e.target.value).toFixed(2) + "x";
});
// CRF 显示
$("#comp-crf").addEventListener("input", (e) => {
  $("#comp-crf-val").textContent = e.target.value;
});

// 水印图片上传
let wmUploadedId = null;
$("#wm-image-file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append("file", f);
  try {
    const r = await api("/api/upload_watermark", { method: "POST", body: fd });
    wmUploadedId = r.watermark_id;
    $("#wm-image-hint").textContent = "已上传: " + r.filename;
  } catch (err) {
    toast(err.message, "err");
  }
});

// 合并：填充文件列表（排除当前选中项也可包含）
async function refreshMergeList() {
  try {
    const { files } = await api("/api/files");
    const box = $("#merge-list");
    box.innerHTML = "";
    if (!files.length) {
      box.innerHTML = '<p class="empty">暂无可用文件，请先上传。</p>';
      return;
    }
    for (const f of files) {
      const el = document.createElement("label");
      el.className = "check-item";
      const isVideo = f.meta && f.meta.has_video;
      el.innerHTML = `
        <input type="checkbox" class="merge-chk" value="${esc(f.file_id)}" />
        <span>${isVideo ? "🎞️" : "🎵"} ${esc(f.filename)}</span>`;
      box.appendChild(el);
    }
  } catch (e) {
    // ignore
  }
}

// ---------- 执行操作 ----------
async function runAction(action, payload, opts = {}) {
  if (!opts.noFile && !state.selected) {
    toast("请先选择文件", "err");
    return;
  }
  if (!opts.noFile) payload.file_id = state.selected;
  const map = {
    split: "/api/split",
    screenshot: "/api/screenshot",
    convert: "/api/convert",
    compress: "/api/compress",
    crop: "/api/crop",
    merge: "/api/merge",
    rotate: "/api/rotate",
    watermark: "/api/watermark",
    speed: "/api/speed",
  };
  try {
    const r = await api(map[action], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast("任务已提交", "ok");
    startPolling();
  } catch (e) {
    toast(e.message, "err");
  }
}

$$("[data-action]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const a = btn.dataset.action;
    if (a === "split") {
      const mode = $('input[name="split-mode"]:checked').value;
      const mute = $("#split-mute").checked;
      const output = $('input[name="split-out"]:checked').value;
      if (mode === "segment") {
        runAction("split", { mode, segment: $("#seg-time").value, mute });
      } else {
        const v = validateSegs();
        if (!v.ok) { toast(v.msg, "err"); return; }
        const payload = { mode, segments: v.segs, mute, output };
        if (output === "gif") {
          payload.gif_fps = $("#gif-fps").value;
          payload.gif_width = $("#gif-width").value;
        }
        runAction("split", payload);
      }
    } else if (a === "screenshot") {
      const mode = $('input[name="shot-mode"]:checked').value;
      if (mode === "single") {
        runAction("screenshot", { mode, time: $("#shot-time").value, format: $("#shot-format").value });
      } else {
        runAction("screenshot", { mode, interval: $("#shot-interval").value, format: $("#shot-format").value });
      }
    } else if (a === "convert") {
      runAction("convert", {
        target: $("#conv-target").value,
        vcodec: $("#conv-vcodec").value,
        crf: $("#conv-crf").value || null,
      });
    } else if (a === "compress") {
      runAction("compress", {
        crf: $("#comp-crf").value,
        preset: $("#comp-preset").value,
        scale: $("#comp-scale").value,
      });
    } else if (a === "crop") {
      runAction("crop", {
        x: $("#crop-x").value,
        y: $("#crop-y").value,
        w: $("#crop-w").value || null,
        h: $("#crop-h").value || null,
      });
    } else if (a === "merge") {
      const ids = $$(".merge-chk:checked").map((c) => c.value);
      if (ids.length < 2) { toast("请至少选择 2 个文件", "err"); return; }
      runAction("merge", { file_ids: ids }, { noFile: true });
    } else if (a === "rotate") {
      const rot = $("#rot-angle").value;
      const flipH = $("#rot-flip-h").checked;
      const flipV = $("#rot-flip-v").checked;
      if (rot === "0" && !flipH && !flipV) { toast("请选择旋转或翻转操作", "err"); return; }
      runAction("rotate", { rotation: rot, flip_h: flipH, flip_v: flipV });
    } else if (a === "watermark") {
      const type = $('input[name="wm-type"]:checked').value;
      const payload = {
        type,
        position: $("#wm-position").value,
        margin: $("#wm-margin").value,
      };
      if (type === "text") {
        payload.text = $("#wm-text-val").value;
        payload.fontsize = $("#wm-fontsize").value;
        payload.color = $("#wm-color").value;
        payload.alpha = $("#wm-alpha").value;
      } else {
        if (!wmUploadedId) { toast("请先上传水印图片", "err"); return; }
        payload.watermark_id = wmUploadedId;
        payload.scale_w = $("#wm-scale-w").value || null;
      }
      runAction("watermark", payload);
    } else if (a === "speed") {
      runAction("speed", {
        speed: parseFloat($("#speed-val").value),
        reverse: $("#speed-reverse").checked,
      });
    }
  });
});

// ---------- 任务队列 ----------
async function loadTasks() {
  try {
    const { tasks } = await api("/api/tasks");
    const box = $("#task-list");
    if (!tasks.length) {
      box.innerHTML = '<p class="empty">暂无任务。</p>';
      return;
    }
    box.innerHTML = "";
    tasks.forEach((t, i) => {
      const el = document.createElement("div");
      el.className = "task-item";
      el.style.animationDelay = (i * 50) + "ms";
      const st = t.status;
      const stText = { running: "处理中", finished: "已完成", failed: "失败" }[st] || st;
      const pct = t.progress == null ? "" : ` · ${t.progress}%`;
      let actions = "";
      if (st === "finished") {
        if (t.output_dir) {
          actions = `<a href="/api/download_dir/${t.task_id}">⬇ 下载全部 (ZIP)</a>`;
        } else if (t.output_name) {
          actions = `<a href="/api/download/${encodeURIComponent(t.output_name)}">⬇ 下载</a>`;
        }
      }
      const prog = t.progress == null
        ? `<div class="progress-bar"><div class="progress-fill" style="width:100%"></div></div>`
        : `<div class="progress-bar"><div class="progress-fill" style="width:${t.progress}%"></div></div>`;
      el.innerHTML = `
        <div class="task-head">
          <span class="task-name">${esc(t.name)}</span>
          <span class="task-status status-${st}">${stText}${pct}</span>
        </div>
        ${st === "running" ? prog : ""}
        ${actions ? `<div class="task-actions">${actions}</div>` : ""}
        ${t.error ? `<div class="task-error">${esc(t.error)}</div>` : ""}`;
      box.appendChild(el);
    });
  } catch (e) {
    // ignore
  }
}

let polling = false;
function startPolling() {
  if (polling) return;
  polling = true;
  const tick = async () => {
    await loadTasks();
    const { tasks } = await api("/api/tasks").catch(() => ({ tasks: [] }));
    const anyRunning = tasks.some((t) => t.status === "running");
    if (anyRunning) {
      setTimeout(tick, 1500);
    } else {
      polling = false;
    }
  };
  tick();
}

// ---------- 工具 ----------
function fmtDur(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}
function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---------- 事件绑定 ----------
$("#file-input").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) uploadFile(f);
  e.target.value = "";
});
$("#refresh-files").addEventListener("click", loadFiles);
$("#refresh-tasks").addEventListener("click", loadTasks);

// ---------- 初始化 ----------
loadVersion();
loadFiles();
loadTasks();
