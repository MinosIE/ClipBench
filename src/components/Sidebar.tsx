import { createSignal, Show, For } from "solid-js";
import {
  files,
  setFiles,
  selectedId,
  setSelectedId,
  selectedFiles,
  setSelectedFiles,
  toggleSelect,
  clearSelect,
  busy,
  setBusy,
  confirmModal,
  pushToast,
} from "../store";
import {
  uploadFile,
  deleteFile,
  deleteFiles,
  listFiles,
  uploadUrl,
  thumbUrl,
} from "../api";

export async function refreshFiles() {
  try {
    const data = await listFiles();
    setFiles(data);
    if (selectedId() && !data.find((f) => f.name === selectedId())) {
      setSelectedId(null);
    }
  } catch (e) {
    console.error(e);
  }
}

export default function Sidebar() {
  const [drag, setDrag] = createSignal(false);

  // 侧栏底部 dropzone 拖拽上传（顶栏也有「+ 上传文件」入口）
  const onUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setBusy(true);
    try {
      for (const file of Array.from(fileList)) {
        await uploadFile(file);
      }
      await refreshFiles();
      pushToast("上传成功", "success");
    } catch (e) {
      pushToast("上传失败：" + (e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const onSelect = (name: string) => {
    setSelectedId(name);
  };

  const removeOne = async (name: string) => {
    await deleteFile(name);
    if (selectedId() === name) setSelectedId(null);
    await refreshFiles();
    pushToast("已删除 " + name, "info");
  };

  const batchDelete = () => {
    const names = Array.from(selectedFiles());
    if (names.length === 0) return;
    confirmModal({
      title: "批量删除",
      message: `确定删除选中的 ${names.length} 个文件？此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
      onConfirm: async () => {
        await deleteFiles(names);
        clearSelect();
        await refreshFiles();
        pushToast(`已删除 ${names.length} 个文件`, "info");
      },
    });
  };

  const allChecked = () => files.length > 0 && selectedFiles().size === files.length;

  const toggleAll = () => {
    if (allChecked()) clearSelect();
    else setSelectedFiles(new Set(files.map((f) => f.name)));
  };

  return (
    <aside class="sidebar">
      <div class="sidebar-head">
        <h3>媒体文件</h3>
        <button
          class="icon-btn"
          title="刷新"
          onClick={() => refreshFiles()}
        >
          ⟳
        </button>
      </div>

      <div class="bulkbar">
        <label>
          <input
            type="checkbox"
            class="file-check"
            checked={allChecked()}
            onChange={toggleAll}
          />
          全选
        </label>
        <span>
          {selectedFiles().size > 0
            ? `已选 ${selectedFiles().size} / ${files.length}`
            : `共 ${files.length} 个`}
        </span>
        <span class="spacer" />
        <button
          class="btn danger small"
          disabled={selectedFiles().size === 0}
          onClick={batchDelete}
        >
          批量删除
        </button>
      </div>

      <div class="file-list">
        <Show
          when={files.length > 0}
          fallback={<div class="empty">暂无文件，请上传</div>}
        >
          <For each={files}>
            {(f) => (
              <div
                class={`file-card ${selectedId() === f.name ? "selected" : ""}`}
                onClick={() => onSelect(f.name)}
              >
                <input
                  type="checkbox"
                  class="file-check"
                  checked={selectedFiles().has(f.name)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleSelect(f.name)}
                />
                <img
                  class="file-thumb"
                  src={thumbUrl(f.name)}
                  onerror={(e) => {
                    (e.currentTarget as HTMLImageElement).src = uploadUrl(
                      f.name
                    );
                  }}
                />
                <div class="file-info">
                  <div class="file-name" title={f.name}>
                    {f.name}
                  </div>
                  <div class="file-meta">
                    {f.display_size ?? (f.size ? (f.size / 1e6).toFixed(1) + " MB" : "")}
                    {f.width ? ` · ${f.width}×${f.height}` : ""}
                  </div>
                </div>
                <button
                  class="file-del"
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    confirmModal({
                      title: "删除文件",
                      message: `确定删除 ${f.name}？`,
                      confirmText: "删除",
                      danger: true,
                      onConfirm: () => removeOne(f.name),
                    });
                  }}
                >
                  ✕
                </button>
              </div>
            )}
          </For>
        </Show>
      </div>

      <div
        class={`dropzone ${drag() ? "drag" : ""}`}
        style={{ "border-radius": "0", "border-width": "0", "border-top-width": "1.5px", margin: "0" }}
        onClick={() => document.getElementById("sidebar-file-input")?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          onUpload(e.dataTransfer.files);
        }}
      >
        拖拽文件到此处上传
        <input
          id="sidebar-file-input"
          type="file"
          accept="video/*,image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => onUpload(e.currentTarget.files)}
        />
      </div>
    </aside>
  );
}
