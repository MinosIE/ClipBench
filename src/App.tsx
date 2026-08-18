/**
 * ClipBench 顶层布局。
 * 还原原版结构：玻璃浅色顶栏（品牌 + 上传按钮）→ flex 布局（左 290px 侧栏 + 自适应主区）→
 * 主区内 媒体信息卡片 + Tab 切换 + 功能面板 + 任务队列。整页不滚动，内部区域滚动。
 */
import { onMount, Show, For } from "solid-js";
import {
  files,
  selectedId,
  setSelectedId,
  activeTab,
  setActiveTab,
  TABS,
  busy,
  setBusy,
  pushToast,
  modal,
  setModal,
  toasts,
} from "./store";
import { uploadFile, thumbUrl } from "./api";
import Sidebar, { refreshFiles } from "./components/Sidebar";
import Workbench from "./components/Workbench";
import Tasks from "./components/Tasks";
import {
  SplitPanel,
  ScreenshotPanel,
  ConvertPanel,
  CompressPanel,
  CropPanel,
  MergePanel,
  RotatePanel,
  WatermarkPanel,
  SpeedPanel,
} from "./components/panels";
import { startSSE } from "./sse";

function getSelectedFile() {
  const id = selectedId();
  if (!id) return null;
  return files.find((f) => f.name === id) ?? null;
}

export default function App() {
  let fileInput!: HTMLInputElement;

  onMount(() => {
    startSSE();
    refreshFiles();
  });

  async function handleUpload(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const list = input.files;
    if (!list || list.length === 0) return;
    setBusy(true);
    try {
      const uploaded: string[] = [];
      for (const f of Array.from(list)) {
        const r = await uploadFile(f);
        if (r?.filename) uploaded.push(r.filename);
      }
      pushToast(`已上传 ${list.length} 个文件`, "success");
      await refreshFiles();
      // 上传后自动选中最后一个（用后端返回的 filename，避免原始名被清洗导致不匹配）
      if (uploaded.length > 0) setSelectedId(uploaded[uploaded.length - 1]);
    } catch (err: any) {
      pushToast(err?.message || "上传失败", "error");
    } finally {
      setBusy(false);
      input.value = "";
    }
  }

  return (
    <>
      {/* 隐藏上传 input：由顶栏「+ 上传文件」触发 */}
      <input
        ref={fileInput}
        type="file"
        multiple
        accept="video/*,image/*,.gif"
        style={{ display: "none" }}
        onChange={handleUpload}
      />

      <header class="topbar">
        <div class="brand">
          <div class="brand-logo">🎬</div>
          <div>
            <div class="brand-title">ClipBench</div>
            <div class="brand-sub">本地视频处理工作台 · ffmpeg 检测中…</div>
          </div>
        </div>
        <div class="topbar-actions">
          <button
            class="task-toggle"
            onClick={() => fileInput.click()}
            disabled={busy()}
          >
            + 上传文件
          </button>
        </div>
      </header>

      <div class="layout">
        <Sidebar />

        <main class="main">
          <Show
            when={getSelectedFile()}
            fallback={
              <div class="panel" style={{ "text-align": "center" }}>
                <h2>请先在左侧选择媒体文件</h2>
                <p class="muted">
                  选中后即可使用拆分、截图、格式转换、压缩、裁剪、合并、旋转、
                  水印、调速、去字幕等全部功能。
                </p>
              </div>
            }
          >
            {(file) => (
              <>
                {/* 媒体信息卡片 */}
                <div class="media-info">
                  <img src={thumbUrl(file().name)} alt="thumb" />
                  <div class="mi-body">
                    <div class="mi-title">{file().name}</div>
                    <div class="mi-meta">
                      <span>
                        <b>{file().width ?? "?"}</b> ×{" "}
                        <b>{file().height ?? "?"}</b>
                      </span>
                      <span>大小 <b>{file().display_size ?? "—"}</b></span>
                      <span>
                        {file().is_video ? "视频" : "图片"}
                        {file().fps ? ` · ${file().fps}fps` : ""}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Tab 切换 */}
                <div class="tabs">
                  <For each={TABS}>
                    {(t) => (
                      <button
                        class="tab"
                        classList={{ active: activeTab() === t.key }}
                        onClick={() => setActiveTab(t.key)}
                      >
                        {t.label}
                      </button>
                    )}
                  </For>
                </div>

                {/* 功能面板 */}
                <Show when={activeTab() === "desubtitle"}>
                  <Workbench />
                </Show>
                <Show when={activeTab() === "split"}>
                  <SplitPanel />
                </Show>
                <Show when={activeTab() === "screenshot"}>
                  <ScreenshotPanel />
                </Show>
                <Show when={activeTab() === "convert"}>
                  <ConvertPanel />
                </Show>
                <Show when={activeTab() === "compress"}>
                  <CompressPanel />
                </Show>
                <Show when={activeTab() === "crop"}>
                  <CropPanel />
                </Show>
                <Show when={activeTab() === "merge"}>
                  <MergePanel />
                </Show>
                <Show when={activeTab() === "rotate"}>
                  <RotatePanel />
                </Show>
                <Show when={activeTab() === "watermark"}>
                  <WatermarkPanel />
                </Show>
                <Show when={activeTab() === "speed"}>
                  <SpeedPanel />
                </Show>
              </>
            )}
          </Show>

          {/* 任务队列（原版位于主区右侧，此处置于主区底部，结构一致） */}
          <Tasks />
        </main>
      </div>

      {/* 自定义弹框 */}
      <Show when={modal()}>
        {(m) => (
          <div class="modal-mask">
            <div class="modal">
              <h3>{m().title}</h3>
              <p>{m().message}</p>
              <div class="modal-actions">
                <button
                  class="btn secondary"
                  onClick={() => setModal(null)}
                >
                  {m().cancelText ?? "取消"}
                </button>
                <button
                  class="btn"
                  classList={{ danger: m().danger }}
                  style={m().danger ? "background:#fff;color:var(--danger);border:1px solid var(--danger)" : ""}
                  onClick={() => {
                    const cb = m().onConfirm;
                    setModal(null);
                    cb();
                  }}
                >
                  {m().confirmText ?? "确定"}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      {/* Toast */}
      <div class="toast-wrap">
        <For each={toasts}>
          {(t) => <div class={`toast ${t.type}`}>{t.message}</div>}
        </For>
      </div>
    </>
  );
}
