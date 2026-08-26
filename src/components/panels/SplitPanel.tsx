import { createSignal, Show, For } from "solid-js";
import { selectedId, pushToast, confirmModal, upsertTask } from "../../store";
import { splitVideo } from "../../api";

interface Seg {
  start: string;
  end: string;
}

export default function SplitPanel() {
  const [mode, setMode] = createSignal<"segment" | "time">("segment");
  const [segment, setSegment] = createSignal(60);
  const [mute, setMute] = createSignal(false);
  const [output, setOutput] = createSignal<"video" | "gif">("video");
  const [encode, setEncode] = createSignal<"copy" | "reencode">("reencode");
  const [segments, setSegments] = createSignal<Seg[]>([
    { start: "00:00:00", end: "00:00:10" },
  ]);
  const [gifFps, setGifFps] = createSignal(15);
  const [gifWidth, setGifWidth] = createSignal(480);
  const [busy, setBusy] = createSignal(false);

  const addSeg = () =>
    setSegments([...segments(), { start: "00:00:00", end: "00:00:10" }]);
  const removeSeg = (i: number) =>
    setSegments(segments().filter((_, idx) => idx !== i));

  // HH:MM:SS → 秒；不合法返回 null
  const parseHms = (s: string): number | null => {
    const m = /^(\d{1,2}):([0-5]?\d):([0-5]?\d)$/.exec(s.trim());
    if (!m) return null;
    return +m[1] * 3600 + +m[2] * 60 + +m[3];
  };
  const fmtHms = (sec: number): string => {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600),
      m = Math.floor((sec % 3600) / 60),
      s = sec % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };
  // 同步某个 input 的值到 store（blur / 提交时调用），避免每按一键都重建数组
  // 仅在值实际变化时 setSegments。store 仅作为"提交时读取的最终值"。
  const syncSeg = (i: number, key: "start" | "end", val: string) => {
    const cur = segments();
    if (cur[i]?.[key] === val) return;
    const next = cur.slice();
    next[i] = { ...next[i], [key]: val };
    setSegments(next);
  };

  const submit = async () => {
    if (!selectedId()) {
      pushToast("请先在左侧选择一个视频", "error");
      return;
    }
    // 校验时间区间：完全相同的重复区间 / start>=end / 非法格式
    if (mode() === "time") {
      const segs = segments();
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const a = parseHms(s.start),
          b = parseHms(s.end);
        if (a == null || b == null) {
          pushToast(`第 ${i + 1} 段时间格式错误（需 HH:MM:SS）`, "error");
          return;
        }
        if (b <= a) {
          pushToast(`第 ${i + 1} 段结束时间必须大于开始时间`, "error");
          return;
        }
        // 检测完全相同的重复区间
        const dupIdx = segs.findIndex(
          (x, j) =>
            j !== i &&
            parseHms(x.start) === a &&
            parseHms(x.end) === b,
        );
        if (dupIdx >= 0) {
          pushToast(
            `第 ${i + 1} 段与第 ${dupIdx + 1} 段区间完全相同，请修改后再提交`,
            "error",
          );
          return;
        }
      }
    }
    setBusy(true);
    try {
      const { task_id } = await splitVideo({
        file_id: selectedId()!,
        mode: mode(),
        segment: mode() === "segment" ? segment() : undefined,
        mute: mute(),
        output: output(),
        encode: encode(),
        segments: mode() === "time" ? segments() : undefined,
        gif_fps: output() === "gif" ? gifFps() : undefined,
        gif_width: output() === "gif" ? gifWidth() : undefined,
      });
      upsertTask({
        task_id,
        name: `拆分 ${mode() === "segment" ? segment() + "s/段" : segments().length + "段"}`,
        status: "running",
        progress: 0,
        created_at: Math.floor(Date.now() / 1000),
      });
      pushToast("已提交拆分任务", "success");
    } catch (e) {
      pushToast("提交失败：" + (e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="tab-panel two-col">
      <h2>拆分</h2>
      <p class="muted">
        按固定时长切片，或自定义多段时间区间；输出可选择视频片段或 GIF。
      </p>

      <div class="form-card">
        <div class="field row col-span">
          <label>拆分方式</label>
            <div class="seg">
              <button
                class={mode() === "segment" ? "active" : ""}
                onClick={() => setMode("segment")}
              >
                按固定时长
              </button>
              <button
                class={mode() === "time" ? "active" : ""}
                onClick={() => setMode("time")}
              >
                按时间区间
              </button>
            </div>
          </div>

          <Show when={mode() === "segment"}>
            <div class="field row">
              <label>每段时长（秒）</label>
              <input
                type="number"
                min="1"
                value={segment()}
                onInput={(e) => setSegment(+e.currentTarget.value)}
              />
            </div>
            <div class="field row">
              <label>输出格式</label>
              <div class="seg">
                <button
                  class={output() === "video" ? "active" : ""}
                  onClick={() => setOutput("video")}
                >
                  视频
                </button>
                <button
                  class={output() === "gif" ? "active" : ""}
                  onClick={() => setOutput("gif")}
                >
                  GIF
                </button>
              </div>
            </div>
          </Show>

          <Show when={output() === "gif"}>
            <div class="field row">
              <label>GIF 帧率</label>
              <input
                type="number"
                min="1"
                max="30"
                value={gifFps()}
                onInput={(e) => setGifFps(+e.currentTarget.value)}
              />
            </div>
            <div class="field row">
              <label>GIF 宽度 (px)</label>
              <input
                type="number"
                min="100"
                value={gifWidth()}
                onInput={(e) => setGifWidth(+e.currentTarget.value)}
              />
            </div>
          </Show>

        <Show when={mode() === "time"}>
          <div class="field row col-span">
            <label>时间区间（HH:MM:SS）</label>
            <div class="seg-list">
              <For each={segments()}>
                {(s, i) => {
                  // 解析 start/end 为秒，解析失败时不显示时长
                  const startSec = () => parseHms(s.start);
                  const endSec = () => parseHms(s.end);
                  const durSec = () => {
                    const a = startSec(),
                      b = endSec();
                    return a == null || b == null || b <= a ? null : b - a;
                  };
                  const isOverlapWithPrev = () => {
                    if (i() === 0) return null;
                    const prev = segments()[i() - 1];
                    const ps = parseHms(prev.start),
                      pe = parseHms(prev.end);
                    const cs = startSec();
                    if (ps == null || pe == null || cs == null) return null;
                    if (cs < pe) return "与上一段重叠";
                    if (cs > pe) return `与上一段间隔 ${(cs - pe).toFixed(1)}s`;
                    return null;
                  };
                  // 非受控 input：ref 初始化 + onBlur 才同步到 store，编辑过程不触发重渲染
                  let startEl!: HTMLInputElement;
                  let endEl!: HTMLInputElement;
                  // 行 mount 时从 store 读初值写入 ref；只跑一次（无 reactive dep）
                  queueMicrotask(() => {
                    if (startEl && startEl.value === "") startEl.value = s.start;
                    if (endEl && endEl.value === "") endEl.value = s.end;
                  });
                  return (
                    <div class="seg-row">
                      <input
                        ref={startEl}
                        type="text"
                        placeholder="00:00:00"
                        // 完全不设 value，DOM 自己持有输入态
                        onBlur={() => syncSeg(i(), "start", startEl.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") startEl.blur();
                        }}
                        style={{ width: "100px" }}
                      />
                      <span>→</span>
                      <input
                        ref={endEl}
                        type="text"
                        placeholder="00:00:10"
                        onBlur={() => syncSeg(i(), "end", endEl.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") endEl.blur();
                        }}
                        style={{ width: "100px" }}
                      />
                      <span
                        class="seg-dur"
                        title={durSec() != null ? `本段时长 ${durSec()}s` : ""}
                      >
                        {durSec() != null ? `${durSec().toFixed(1)}s` : ""}
                      </span>
                      <Show when={isOverlapWithPrev()}>
                        <span class="seg-warn">{isOverlapWithPrev()}</span>
                      </Show>
                      <button
                        class="btn danger small"
                        onClick={() => removeSeg(i())}
                        disabled={segments().length <= 1}
                      >
                        删除
                      </button>
                    </div>
                  );
                }}
              </For>
              <button class="btn secondary small" onClick={addSeg}>
                + 添加区间
              </button>
            </div>
          </div>
        </Show>

        <div class="field row col-span">
          <label>编码方式</label>
          <div class="seg">
            <button
              class={encode() === "reencode" ? "active" : ""}
              title="重编码为 H.264 并强制首帧为关键帧，彻底避免起始黑屏，浏览器/QuickTime 全兼容（体积略增、速度略慢）"
              onClick={() => setEncode("reencode")}
            >
              重编码（兼容优先，推荐）
            </button>
            <button
              class={encode() === "copy" ? "active" : ""}
              title="直接流拷贝原编码，速度最快、零画质损失；但起点若在 GOP 中间，部分浏览器可能前几秒黑屏"
              onClick={() => setEncode("copy")}
            >
              保留原编码（极速无损）
            </button>
          </div>
        </div>

        <div class="field row">
          <label>静音输出</label>
          <label class="inline-check">
            <input
              type="checkbox"
              checked={mute()}
              onChange={(e) => setMute(e.currentTarget.checked)}
            />
            去除音轨
          </label>
        </div>

        <div class="actions">
          <button class="btn" onClick={submit} disabled={busy()}>
            {busy() ? "提交中…" : "开始拆分"}
          </button>
        </div>
      </div>

      <aside class="panel-aside">
        <h4>拆分贴士</h4>
        <ul>
          <li><b>按固定时长</b>：适合长视频均匀切片，如每 60s 一段。</li>
          <li><b>按时间区间</b>：适合精确截取高光片段。</li>
          <li>输出选 <b>GIF</b> 时，帧率 12~15、宽度 480 体积与流畅度较平衡。</li>
          <li>勾选「静音」可顺便剥离音轨、缩小体积。</li>
        </ul>
        <div class="aside-note">
          提示：短视频卡点建议用「时间区间」精确裁剪。
        </div>
      </aside>

    </div>
  );
}
