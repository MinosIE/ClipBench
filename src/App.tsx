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
  faststartEnabled,
  toggleFaststart,
  showOutputs,
  toggleShowOutputs,
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
  AudioExtractPanel,
} from "./components/panels";
import { startSSE } from "./sse";

function getSelectedFile() {
  const id = selectedId();
  if (!id) return null;
  return files.find((f) => f.name === id) ?? null;
}

// 后端 format_name 形如 "mov,mp4,m4a,3gp,3g2,mj2" / "mp4"，取第一个容器名大写显示
function formatName(f: StoredFile): string {
  const raw = f.format_name;
  if (!raw) return "";
  const first = String(raw).split(",")[0].trim().toUpperCase();
  return first ? `${first} 格式` : "";
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
      if (uploaded.length > 0) {
        setSelectedId(uploaded[uploaded.length - 1]);
        setActiveTab("split");
      }
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
        accept="video/*,audio/*"
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
          <label class="fs-switch">
            <input
              type="checkbox"
              checked={showOutputs()}
              onChange={() => {
                toggleShowOutputs();
                refreshFiles();
              }}
            />
            <span class="fs-text">显示产物</span>
            <span
              class="fs-help"
              tabindex="0"
              role="tooltip"
              data-tip="开启后，处理完成的视频产物会回流到左侧媒体列表，可直接继续二次处理；关闭后只显示手动上传的文件。"
            >?</span>
          </label>
          <label class="fs-switch">
            <input
              type="checkbox"
              checked={faststartEnabled()}
              onChange={() => toggleFaststart()}
            />
            <span class="fs-text">快速启动</span>
            <span
              class="fs-help"
              tabindex="0"
              role="tooltip"
              data-tip="开启后，输出的 MP4/MOV 视频会把索引信息移到文件开头，让网页和手机能一边下载一边播放，不用等整段下完。小白一般保持开启即可。"
            >?</span>
          </label>
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
              <div class="empty-state">
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
                {/* 左栏：媒体信息 + Tab 切换 + 功能面板 */}
                <div class="main-left">
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
                        <span>{formatName(file())}</span>
                      </div>
                      <Show when={file().is_video}>
                        <div class="mi-codec">
                          <span class="codec-tag">
                            {file().video_codec ?? "—"}
                          </span>
                          {file().duration != null ? (
                            <span>
                              时长 {Math.floor(file().duration / 60)}:
                              {String(Math.floor(file().duration % 60)).padStart(2, "0")}
                            </span>
                          ) : null}
                          {file().video_bitrate ? (
                            <span>视频 {Math.round(file().video_bitrate / 1000)} kbps</span>
                          ) : null}
                          {file().audio_codec ? (
                            <span class="codec-tag audio">
                              {file().audio_codec}
                              {file().audio_bitrate
                                ? ` ${Math.round(file().audio_bitrate / 1000)}k`
                                : ""}
                            </span>
                          ) : (
                            <span>无音轨</span>
                          )}
                        </div>
                      </Show>
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
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <For each={t.icon}>
                              {(d) => <path d={d} />}
                            </For>
                          </svg>
                          {t.label}
                        </button>
                      )}
                    </For>
                  </div>

                  {/* 功能面板 */}
                  <div class="panel-scroll">
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
                    <Show when={activeTab() === "audio"}>
                      <AudioExtractPanel />
                    </Show>
                  </div>
                </div>

                {/* 右栏：任务队列（常驻，始终可见） */}
                <Tasks />
              </>
            )}
          </Show>
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
