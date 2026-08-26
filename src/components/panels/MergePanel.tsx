import { createSignal, Show, For, createMemo } from "solid-js";
import { files, pushToast, upsertTask, faststartEnabled, tasks } from "../../store";
import { mergeVideos, checkMergeCompatible, type StoredFile } from "../../api";
import { thumbUrl } from "../../api";

// 展示单个文件的编码/分辨率/时长信息
function fileInfo(name: string): string {
  const f = files.find((x) => x.name === name);
  if (!f) return "";
  const parts: string[] = [];
  if (f.width && f.height) parts.push(`${f.width}x${f.height}`);
  if (f.duration) {
    const s = Math.round(f.duration);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    parts.push(`${mm}:${ss}`);
  }
  if (f.video_codec) parts.push(String(f.video_codec).toUpperCase());
  return parts.join(" · ");
}

export default function MergePanel() {
  const [picked, setPicked] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [encode, setEncode] = createSignal<"h264" | "hevc" | "copy">("h264");
  const [dragIdx, setDragIdx] = createSignal<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = createSignal<number | null>(null);

  const toggle = (name: string) =>
    setPicked((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    );

  // 用上下按钮调整顺序
  const move = (name: string, dir: -1 | 1) => {
    setPicked((prev) => {
      const idx = prev.indexOf(name);
      const next = prev.slice();
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  // 拖拽调整顺序（HTML5 DnD）
  const dropAt = (idx: number) => {
    const from = dragIdx();
    setDragIdx(null);
    if (from == null || from === idx) return;
    setPicked((prev) => {
      const next = prev.slice();
      const [x] = next.splice(from, 1);
      next.splice(idx, 0, x);
      return next;
    });
  };

  // 最近的已完成合并任务，用于展示处理后信息
  const lastResult = createMemo(() => {
    const list = tasks;
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i];
      if (t.kind === "merge" && t.status === "finished") return t;
    }
    return null;
  });

  const submit = async () => {
    if (picked().length < 2) {
      pushToast("请至少选择 2 个文件进行合并", "error");
      return;
    }
    // 复制编码模式：前端先预判，源参数不一致就根本不发请求，UI 即时反馈
    if (encode() === "copy") {
      const metas: StoredFile[] = picked()
        .map((name) => files.find((f) => f.name === name))
        .filter((f): f is StoredFile => !!f);
      if (metas.length !== picked().length) {
        pushToast("部分文件信息尚未加载，请稍候再试", "error");
        return;
      }
      const conflict = checkMergeCompatible(metas);
      if (conflict) {
        pushToast(conflict, "error");
        return;
      }
    }
    setBusy(true);
    try {
      const { task_id } = await mergeVideos(picked(), faststartEnabled(), encode());
      upsertTask({
        task_id,
        name: `合并 ${picked().length} 个文件`,
        status: "running",
        progress: 0,
        created_at: Math.floor(Date.now() / 1000),
      });
      pushToast("已提交合并任务", "success");
    } catch (e) {
      pushToast("提交失败：" + (e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="tab-panel two-col">
      <h2>合并</h2>
      <p class="muted">
        勾选多个文件（按顺序从上到下拼接），可拖动顺序调整先后。
      </p>

      <Show
        when={files.length > 0}
        fallback={<div class="empty">暂无文件，请先上传</div>}
      >
        <div class="form-card">
          <div class="pick-grid">
          <For each={files}>
            {(f) => (
              <div
                class={`pick-item ${
                  picked().includes(f.name) ? "selected" : ""
                }`}
                onClick={() => toggle(f.name)}
              >
                <img src={thumbUrl(f.name)} />
                <span>{f.name}</span>
                <Show when={picked().includes(f.name)}>
                  <span class="badge">
                    第 {picked().indexOf(f.name) + 1} 位
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>

        <Show when={picked().length > 0}>
          <div class="field row col-span">
            <label>合并顺序</label>
            <div class="merge-list">
              <For each={picked()}>
                {(name, i) => (
                  <div
                    class="row merge-row"
                    classList={{
                      dragging: dragIdx() === i(),
                      "drag-over": dragOverIdx() === i() && dragIdx() !== i(),
                    }}
                    draggable
                    onDragStart={() => setDragIdx(i())}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverIdx(i());
                    }}
                    onDrop={() => dropAt(i())}
                    onDragEnd={() => {
                      setDragIdx(null);
                      setDragOverIdx(null);
                    }}
                  >
                    <span class="badge">{i() + 1}</span>
                    <span class="merge-name">{name}</span>
                    <span class="merge-meta">{fileInfo(name)}</span>
                    <button
                      class="btn secondary small"
                      onClick={() => move(name, -1)}
                      disabled={i() === 0}
                    >
                      ↑
                    </button>
                    <button
                      class="btn secondary small"
                      onClick={() => move(name, 1)}
                      disabled={i() === picked().length - 1}
                    >
                      ↓
                    </button>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <div class="field row col-span">
          <label>合并编码</label>
          <div class="seg">
            <button
              class={encode() === "h264" ? "active" : ""}
              title="重编码为 H.264 (libx264)，兼容性最好，各平台/播放器通吃（推荐）"
              onClick={() => setEncode("h264")}
            >
              H.264（兼容优先，推荐）
            </button>
            <button
              class={encode() === "hevc" ? "active" : ""}
              title="重编码为 HEVC (libx265)，体积更小、画质更高；输出 hvc1 tag 保证 QuickTime/Safari 兼容"
              onClick={() => setEncode("hevc")}
            >
              HEVC（高压缩）
            </button>
            <button
              class={encode() === "copy" ? "active" : ""}
              title="直接流拷贝，速度最快、零画质损失；但要求所有源编码/分辨率/参数完全一致，否则拼接异常"
              onClick={() => setEncode("copy")}
            >
              保留原编码（极速）
            </button>
          </div>
        </div>
        <Show when={encode() === "h264"}>
          <p class="hint col-span">
            重编码为 H.264 (libx264)，兼容性最好，各平台与播放器通吃；不同源也能正确拼接（耗时略长、体积略增）。
          </p>
        </Show>
        <Show when={encode() === "hevc"}>
          <p class="hint col-span">
            重编码为 HEVC (libx265)，同等画质下体积更小；输出 hvc1 tag 以保证 Safari/QuickTime 兼容（编码更慢）。
          </p>
        </Show>
        <Show when={encode() === "copy"}>
          <p class="hint col-span">
            直接流拷贝，速度最快、零画质损失；但要求所有源的编码 / 分辨率 / 帧率完全一致，否则会合并失败（已自动校验）。
          </p>
        </Show>

        <Show when={lastResult()}>
          <div class="field row col-span">
            <label>合并结果</label>
            <div class="cc-params">
              <span>输出 {lastResult()!.out_size_human || "—"}</span>
              <span class="cc-codec">{lastResult()!.out_codec || "—"}</span>
              <Show when={lastResult()!.out_resolution}>
                <span>{lastResult()!.out_resolution}</span>
              </Show>
              <Show when={lastResult()!.out_duration}>
                <span>
                  时长 {Math.floor(lastResult()!.out_duration! / 60)}:
                  {String(Math.round(lastResult()!.out_duration! % 60)).padStart(2, "0")}
                </span>
              </Show>
              <span class="cc-tag">
                {lastResult()!.encode === "copy"
                  ? "保留原编码"
                  : lastResult()!.encode === "hevc"
                    ? "重编码 HEVC"
                    : "重编码 H.264"}
              </span>
            </div>
          </div>
        </Show>

        <div class="actions">
          <button class="btn" onClick={submit} disabled={busy()}>
            {busy() ? "提交中…" : "开始合并"}
          </button>
        </div>

        </div>

      </Show>

      <aside class="panel-aside">
        <h4>合并贴士</h4>
        <ul>
          <li>勾选 ≥2 个文件即可合并，顺序即拼接顺序。</li>
          <li>用 ↑ / ↓ 或直接拖拽调整先后。</li>
          <li>分辨率/编码不同的片段会自动统一为一种参数。</li>
          <li>长视频建议先压缩再合并，更省时。</li>
        </ul>
        <div class="aside-note">
          提示：先选素材再调顺序，避免漏选。
        </div>
      </aside>
    </div>
  );
}
