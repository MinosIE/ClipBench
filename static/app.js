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
      box.appendChild(renderFileItem(f, i));
    });
    updateFileBulkbar();
  } catch (e) {
    toast(e.message, "err");
  }
}

function renderFileItem(f, i = 0) {
  const el = document.createElement("div");
  el.className = "file-item has-check" + (state.selected === f.file_id ? " active" : "");
  el.dataset.fileId = f.file_id;
  el.style.animationDelay = (i * 45) + "ms";
  const isVideo = f.meta && f.meta.has_video;
  const icon = isVideo ? "🎞️" : (f.meta && f.meta.has_audio ? "🎵" : "📄");
  const dur = f.meta && f.meta.duration ? fmtDur(f.meta.duration) : "";
  const res = f.meta && f.meta.width ? `${f.meta.width}×${f.meta.height}` : "";
  el.innerHTML = `
    <input type="checkbox" class="row-check file-chk" />
    <span class="fi-icon">${icon}</span>
    <div class="fi-main">
      <div class="fi-name" title="${esc(f.filename)}">${esc(f.filename)}</div>
      <div class="fi-meta">${res} ${dur} · ${f.size_human}</div>
    </div>
    <span class="fi-del" title="删除">✕</span>`;
  el.querySelector(".file-chk").addEventListener("change", (e) => {
    e.stopPropagation();
    updateFileBulkbar();
  });
  el.querySelector(".fi-del").addEventListener("click", (e) => {
    e.stopPropagation();
    deleteFile(f.file_id, f.filename);
  });
  el.addEventListener("click", (e) => {
    if (e.target.classList.contains("file-chk")) return;
    if (e.target.classList.contains("fi-del")) return;
    selectFile(f.file_id);
  });
  return el;
}

async function deleteFile(fileId, name) {
  const ok = await showConfirm({
    title: "删除文件",
    text: `确定删除「${name || fileId}」？\n删除后无法恢复。`,
  });
  if (!ok) return;
  try {
    await api("/api/delete_upload/" + fileId, { method: "POST" });
    if (state.selected === fileId) {
      state.selected = null;
      $("#workbench").classList.add("hidden");
      $("#no-select").classList.remove("hidden");
    }
    toast("已删除", "ok");
    await loadFiles();
  } catch (e) {
    toast(e.message, "err");
  }
}

// 文件批量选择
const MAX_BULK = 5;

function updateFileBulkbar() {
  const chks = $$("#file-list .file-chk");
  const checked = $$("#file-list .file-chk:checked");
  const bar = $("#file-bulkbar");
  const count = $("#file-sel-count");
  if (!chks.length) { bar.classList.remove("show"); return; }
  bar.classList.add("show");
  count.textContent = `已选 ${checked.length} / ${MAX_BULK} 项`;
  const all = $("#file-select-all");
  all.checked = checked.length === chks.length && chks.length > 0;
  all.indeterminate = checked.length > 0 && checked.length < chks.length;
  // 超出上限时禁用多余复选框
  if (checked.length >= MAX_BULK) {
    chks.forEach((c) => { if (!c.checked) c.disabled = true; });
  } else {
    chks.forEach((c) => (c.disabled = false));
  }
}

$("#file-list").addEventListener("change", (e) => {
  if (!e.target.classList.contains("file-chk")) return;
  const checked = $$("#file-list .file-chk:checked");
  if (checked.length > MAX_BULK) {
    e.target.checked = false;
    toast(`最多只能选择 ${MAX_BULK} 个`, "err");
  }
  updateFileBulkbar();
});

$("#file-select-all").addEventListener("change", (e) => {
  const chks = Array.from($$("#file-list .file-chk"));
  chks.forEach((c, i) => (c.checked = e.target.checked && i < MAX_BULK));
  updateFileBulkbar();
});

$("#file-bulk-del").addEventListener("click", async () => {
  const ids = Array.from($$("#file-list .file-chk:checked")).map((c) => c.closest(".file-item").dataset.fileId);
  if (!ids.length) return;
  if (ids.length > MAX_BULK) {
    toast(`最多只能删除 ${MAX_BULK} 个`, "err");
    return;
  }
  const ok = await showConfirm({
    title: "批量删除文件",
    text: `确定删除选中的 ${ids.length} 个文件？\n删除后无法恢复。`,
  });
  if (!ok) return;
  try {
    const r = await api("/api/delete_uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_ids: ids }),
    });
    if (ids.includes(state.selected)) {
      state.selected = null;
      $("#workbench").classList.add("hidden");
      $("#no-select").classList.remove("hidden");
    }
    toast(`已删除 ${r.count} 个文件`, "ok");
    await loadFiles();
  } catch (e) {
    toast(e.message, "err");
  }
});

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

// 去字幕：强度滑块显示 + 模式切换标签
$("#desub-strength").addEventListener("input", (e) => {
  $("#desub-strength-val").textContent = e.target.value;
});
$$('input[name="desub-mode"]').forEach((r) => {
  r.addEventListener("change", () => {
    const v = r.value;
    const cfg = {
      delogo: { label: "边缘羽化宽度 (px)", min: 1, max: 30, step: 1, val: 8 },
      inpaint: { label: "修复强度 (半径)", min: 1, max: 10, step: 1, val: 6 },
      blur: { label: "模糊强度 (σ)", min: 6, max: 50, step: 1, val: 25 },
      mosaic: { label: "马赛克块大小 (px)", min: 4, max: 64, step: 2, val: 16 },
    }[v] || { label: "强度", min: 1, max: 30, step: 1, val: 8 };
    $("#desub-strength-label").textContent = cfg.label;
    $("#desub-strength").min = cfg.min;
    $("#desub-strength").max = cfg.max;
    $("#desub-strength").step = cfg.step;
    $("#desub-strength").value = cfg.val;
    $("#desub-strength-val").textContent = cfg.val;
    $("#desub-quality-group").style.display = v === "inpaint" ? "block" : "none";
  });
});

// ---------- 去字幕：帧预览 + 选区框 ----------
const desub = {
  sel: { x: 0, y: 0, w: 0, h: 0 }, // 视频分辨率坐标
  dragging: false, resizing: false, sx: 0, sy: 0, ox: 0, oy: 0, ow: 0, oh: 0,
};
const $stage = $("#desub-stage");
const $frame = $("#desub-frame");
const $box = $("#desub-box");
const $noselect = $("#desub-noselect");

function desubDuration() {
  return (state.meta && state.meta.duration) || 0;
}
async function loadDesubFrame() {
  if (!state.selected) {
    $noselect.style.display = "grid";
    $frame.style.display = "none";
    $box.style.display = "none";
    return;
  }
  $noselect.style.display = "none";
  const dur = desubDuration();
  const maxT = Math.max(0, dur - 0.2);
  const t = (parseFloat($("#desub-time").value) / 100) * (maxT || 1);
  $("#desub-time-val").textContent = t.toFixed(1) + "s";
  const url = `/api/frame/${encodeURIComponent(state.selected)}?t=${t.toFixed(3)}&_=${Date.now()}`;
  $frame.style.display = "block";
  $frame.src = url;
}
// 帧加载完成后按比例绘制默认选区（底部 1/3）
$frame.addEventListener("load", () => {
  const vw = state.meta && state.meta.width;
  const vh = state.meta && state.meta.height;
  if (!vw || !vh) return;
  // 默认底部 1/3
  desub.sel = { x: 0, y: Math.round(vh * 2 / 3), w: vw, h: Math.round(vh / 3) };
  syncInputsFromSel();
  drawBoxFromSel();
});
function drawBoxFromSel() {
  const vw = state.meta && state.meta.width;
  const vh = state.meta && state.meta.height;
  if (!vw || !vh) return;
  const dispW = $frame.clientWidth;
  const dispH = $frame.clientHeight;
  if (!dispW || !dispH) return;
  const sx = dispW / vw, sy = dispH / vh;
  $box.style.display = "block";
  $box.style.left = (desub.sel.x * sx) + "px";
  $box.style.top = (desub.sel.y * sy) + "px";
  $box.style.width = (desub.sel.w * sx) + "px";
  $box.style.height = (desub.sel.h * sy) + "px";
}
function syncInputsFromSel() {
  $("#desub-x").value = desub.sel.x;
  $("#desub-y").value = desub.sel.y;
  $("#desub-w").value = desub.sel.w;
  $("#desub-h").value = desub.sel.h;
}
function syncSelFromInputs() {
  desub.sel.x = Math.max(0, parseInt($("#desub-x").value) || 0);
  desub.sel.y = Math.max(0, parseInt($("#desub-y").value) || 0);
  desub.sel.w = Math.max(2, parseInt($("#desub-w").value) || 2);
  desub.sel.h = Math.max(2, parseInt($("#desub-h").value) || 2);
  drawBoxFromSel();
}
["desub-x", "desub-y", "desub-w", "desub-h"].forEach((id) => {
  $("#" + id).addEventListener("input", syncSelFromInputs);
});

// 拖拽移动 + 缩放
function evtPos(e) {
  const rect = $stage.getBoundingClientRect();
  const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  const cy = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
  return { cx, cy };
}
$box.addEventListener("mousedown", (e) => {
  if (e.target.classList.contains("desub-handle")) return;
  desub.dragging = true;
  const { cx, cy } = evtPos(e);
  desub.sx = cx; desub.sy = cy;
  desub.ox = desub.sel.x; desub.oy = desub.sel.y;
  e.preventDefault();
});
$box.querySelector(".desub-handle").addEventListener("mousedown", (e) => {
  desub.resizing = true;
  const { cx, cy } = evtPos(e);
  desub.sx = cx; desub.sy = cy;
  desub.ow = desub.sel.w; desub.oh = desub.sel.h;
  e.stopPropagation(); e.preventDefault();
});
window.addEventListener("mousemove", (e) => {
  if (!desub.dragging && !desub.resizing) return;
  const vw = state.meta && state.meta.width;
  const vh = state.meta && state.meta.height;
  if (!vw || !vh) return;
  const dispW = $frame.clientWidth, dispH = $frame.clientHeight;
  if (!dispW || !dispH) return;
  const sx = vw / dispW, sy = vh / dispH;
  const { cx, cy } = evtPos(e);
  if (desub.dragging) {
    let nx = desub.ox + (cx - desub.sx) * sx;
    let ny = desub.oy + (cy - desub.sy) * sy;
    nx = Math.max(0, Math.min(nx, vw - desub.sel.w));
    ny = Math.max(0, Math.min(ny, vh - desub.sel.h));
    desub.sel.x = Math.round(nx); desub.sel.y = Math.round(ny);
  } else if (desub.resizing) {
    let nw = desub.ow + (cx - desub.sx) * sx;
    let nh = desub.oh + (cy - desub.sy) * sy;
    nw = Math.max(2, Math.min(nw, vw - desub.sel.x));
    nh = Math.max(2, Math.min(nh, vh - desub.sel.y));
    desub.sel.w = Math.round(nw); desub.sel.h = Math.round(nh);
  }
  drawBoxFromSel(); syncInputsFromSel();
});
window.addEventListener("mouseup", () => { desub.dragging = false; desub.resizing = false; });
// 触摸支持
$box.addEventListener("touchstart", (e) => {
  const { cx, cy } = evtPos(e);
  if (e.target.classList.contains("desub-handle")) {
    desub.resizing = true; desub.sx = cx; desub.sy = cy; desub.ow = desub.sel.w; desub.oh = desub.sel.h;
  } else {
    desub.dragging = true; desub.sx = cx; desub.sy = cy; desub.ox = desub.sel.x; desub.oy = desub.sel.y;
  }
  e.preventDefault();
}, { passive: false });
window.addEventListener("touchmove", (e) => {
  if (!desub.dragging && !desub.resizing) return;
  const vw = state.meta && state.meta.width, vh = state.meta && state.meta.height;
  if (!vw || !vh) return;
  const dispW = $frame.clientWidth, dispH = $frame.clientHeight;
  if (!dispW || !dispH) return;
  const sx = vw / dispW, sy = vh / dispH;
  const { cx, cy } = evtPos(e);
  if (desub.dragging) {
    let nx = Math.max(0, Math.min(desub.ox + (cx - desub.sx) * sx, vw - desub.sel.w));
    let ny = Math.max(0, Math.min(desub.oy + (cy - desub.sy) * sy, vh - desub.sel.h));
    desub.sel.x = Math.round(nx); desub.sel.y = Math.round(ny);
  } else if (desub.resizing) {
    let nw = Math.max(2, Math.min(desub.ow + (cx - desub.sx) * sx, vw - desub.sel.x));
    let nh = Math.max(2, Math.min(desub.oh + (cy - desub.sy) * sy, vh - desub.sel.y));
    desub.sel.w = Math.round(nw); desub.sel.h = Math.round(nh);
  }
  drawBoxFromSel(); syncInputsFromSel();
});
window.addEventListener("touchend", () => { desub.dragging = false; desub.resizing = false; });

// 时间滑块 + 加载帧
$("#desub-time").addEventListener("input", loadDesubFrame);
$("#desub-loadframe").addEventListener("click", loadDesubFrame);
// 切换去字幕 tab 时自动加载默认帧
$$('.tab').forEach((tab) => {
  tab.addEventListener("click", () => {
    if (tab.dataset.tab === "desubtitle") {
      const dur = desubDuration();
      $("#desub-time").max = dur ? Math.round(dur * 100) : 100;
      loadDesubFrame();
    }
  });
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
    desubtitle: "/api/desubtitle",
  };
  try {
    const r = await api(map[action], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast("任务已提交", "ok");
    loadTasks();
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
      const ids = Array.from($$(".merge-chk:checked")).map((c) => c.value);
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
    } else if (a === "desubtitle") {
      const mode = $('input[name="desub-mode"]:checked').value;
      const payload = {
        mode,
        strength: $("#desub-strength").value,
        x: parseInt($("#desub-x").value) || desub.sel.x || null,
        y: parseInt($("#desub-y").value) || desub.sel.y || null,
        w: parseInt($("#desub-w").value) || desub.sel.w || null,
        h: parseInt($("#desub-h").value) || desub.sel.h || null,
      };
      if (mode === "inpaint") {
        payload.radius = payload.strength;
        payload.quality = $('input[name="desub-quality"]:checked').value || "standard";
      }
      runAction("desubtitle", payload);
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
    // 后端 /api/tasks 已按最新在前排序，直接渲染（新任务置顶）
    const rows = tasks.map((t) => {
      const st = t.status;
      const stText = { running: "处理中", queued: "排队中", finished: "已完成", done: "已完成", failed: "失败" }[st] || st;
      const pct = t.progress == null ? "" : ` · ${t.progress}%`;
      const locked = st === "running" || st === "queued";
      let actions = "";
      if (st === "finished" || st === "done" || st === "failed") {
        const dl = t.output_dir
          ? `<a href="/api/download_dir/${t.task_id}">⬇ 下载全部 (ZIP)</a>`
          : (t.output_name
              ? `<a href="/api/download/${encodeURIComponent(t.output_name)}">⬇ 下载</a>`
              : "");
        actions = dl + `<a href="javascript:void(0)" class="task-del" data-id="${t.task_id}">🗑 删除</a>`;
      }
      const prog = t.progress == null
        ? `<div class="progress-bar"><div class="progress-fill" style="width:100%"></div></div>`
        : `<div class="progress-bar"><div class="progress-fill" style="width:${t.progress}%"></div></div>`;
      const elapsed = t.elapsed ? ` · 耗时 ${fmt_dur(t.elapsed)}` : "";
      const submitAt = t.created_at ? fmt_time(t.created_at) : "";
      return `
        <div class="task-item has-check${locked ? " locked" : ""}" data-id="${t.task_id}">
          ${locked ? "" : '<input type="checkbox" class="row-check task-chk" />'}
          <div class="task-main">
            <div class="task-head">
              <span class="task-name">${esc(t.name)}</span>
              <span class="task-status status-${st}">${stText}${pct}${elapsed}</span>
            </div>
            <div class="task-meta">提交时间：${submitAt}</div>
            ${(st === "running" || st === "queued") ? prog : ""}
            ${actions ? `<div class="task-actions">${actions}</div>` : ""}
            ${t.error ? `<div class="task-error">${esc(t.error)}</div>` : ""}
          </div>
        </div>`;
    });
    box.innerHTML = rows.join("");
    $$("#task-list .task-chk").forEach((c) => {
      c.addEventListener("change", updateTaskBulkbar);
    });
    updateTaskBulkbar();
  } catch (e) {
    // ignore
  }
}

// 任务批量选择
function updateTaskBulkbar() {
  const chks = $$("#task-list .task-chk");
  const checked = $$("#task-list .task-chk:checked");
  const bar = $("#task-bulkbar");
  const count = $("#task-sel-count");
  if (!chks.length) { bar.classList.remove("show"); return; }
  bar.classList.add("show");
  count.textContent = `已选 ${checked.length} / ${MAX_BULK} 项`;
  const all = $("#task-select-all");
  all.checked = checked.length === chks.length;
  all.indeterminate = checked.length > 0 && checked.length < chks.length;
  if (checked.length >= MAX_BULK) {
    chks.forEach((c) => { if (!c.checked) c.disabled = true; });
  } else {
    chks.forEach((c) => (c.disabled = false));
  }
}

$("#task-list").addEventListener("change", (e) => {
  if (!e.target.classList.contains("task-chk")) return;
  const checked = $$("#task-list .task-chk:checked");
  if (checked.length > MAX_BULK) {
    e.target.checked = false;
    toast(`最多只能选择 ${MAX_BULK} 个`, "err");
  }
  updateTaskBulkbar();
});

$("#task-select-all").addEventListener("change", (e) => {
  const chks = Array.from($$("#task-list .task-chk"));
  chks.forEach((c, i) => (c.checked = e.target.checked && i < MAX_BULK));
  updateTaskBulkbar();
});

$("#task-bulk-del").addEventListener("click", async () => {
  const ids = Array.from($$("#task-list .task-chk:checked")).map((c) => c.closest(".task-item").dataset.id);
  if (!ids.length) return;
  if (ids.length > MAX_BULK) {
    toast(`最多只能删除 ${MAX_BULK} 个`, "err");
    return;
  }
  const ok = await showConfirm({
    title: "批量删除任务",
    text: `确定删除选中的 ${ids.length} 个任务？\n其输出文件会被一并删除，正在处理的任务不会被删除。`,
  });
  if (!ok) return;
  try {
    const r = await api("/api/tasks/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_ids: ids }),
    });
    if (r.skipped && r.skipped.length) {
      toast(`已删除 ${r.count} 个，跳过 ${r.skipped.length} 个进行中任务`, "ok");
    } else {
      toast(`已删除 ${r.count} 个任务`, "ok");
    }
    await loadTasks();
  } catch (e) {
    toast(e.message, "err");
  }
});

let polling = false;
function startPolling() {
  if (polling) {
    // 已在轮询中，立即刷新一次即可
    loadTasks();
    return;
  }
  polling = true;
  const tick = async () => {
    await loadTasks();
    const { tasks } = await api("/api/tasks").catch(() => ({ tasks: [] }));
    const anyRunning = tasks.some((t) => t.status === "running" || t.status === "queued");
    if (anyRunning) {
      setTimeout(tick, 1500);
    } else {
      polling = false;
    }
  };
  tick();
}

// ---------- 工具 ----------
function fmt_dur(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}分${String(s).padStart(2, "0")}秒` : `${s}秒`;
}
function fmt_time(ts) {
  const d = new Date((ts || 0) * 1000);
  if (isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
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

// 任务删除按钮（事件委托，避免重复渲染丢失绑定）
const taskListEl = $("#task-list");
if (taskListEl) {
  taskListEl.addEventListener("click", async (e) => {
    const del = e.target.closest(".task-del");
    if (!del) return;
    e.preventDefault();
    const id = del.getAttribute("data-id");
    if (!id) return;
    const ok = await showConfirm({
      title: "删除任务",
      text: "确定删除该任务？其输出文件也会被一并删除。",
    });
    if (!ok) return;
    del.textContent = "删除中…";
    try {
      const r = await api(`/api/task/${id}/delete`, { method: "POST" });
      if (r && r.ok) loadTasks();
    } catch (err) {
      toast("删除失败：" + err.message, "err");
      loadTasks();
    }
  });
}

// ---------- 自定义确认弹框 ----------
let _modalResolve = null;
function showConfirm({ title = "确认操作", text = "", confirmText = "删除", type = "danger" } = {}) {
  return new Promise((resolve) => {
    const mask = $("#modal-mask");
    const icon = $("#modal-icon");
    $("#modal-title").textContent = title;
    $("#modal-text").textContent = text;
    const confirmBtn = $("#modal-confirm");
    confirmBtn.textContent = confirmText;
    confirmBtn.className = "btn " + (type === "danger" ? "btn-danger" : "btn-primary");
    icon.className = "modal-icon" + (type === "danger" ? "" : " info");
    icon.textContent = type === "danger" ? "⚠️" : "ℹ️";
    _modalResolve = resolve;
    mask.classList.add("show");
  });
}

function closeModal(result) {
  const mask = $("#modal-mask");
  mask.classList.remove("show");
  if (_modalResolve) { _modalResolve(result); _modalResolve = null; }
}

$("#modal-confirm").addEventListener("click", () => closeModal(true));
$("#modal-cancel").addEventListener("click", () => closeModal(false));
$("#modal-mask").addEventListener("click", (e) => { if (e.target.id === "modal-mask") closeModal(false); });
document.addEventListener("keydown", (e) => {
  if (!$("#modal-mask").classList.contains("show")) return;
  if (e.key === "Escape") closeModal(false);
  if (e.key === "Enter") closeModal(true);
});
