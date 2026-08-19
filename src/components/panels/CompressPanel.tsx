import { createSignal, createMemo, Show, For } from "solid-js";
import {
  files,
  selectedId,
  pushToast,
  upsertTask,
  faststartEnabled,
} from "../../store";
import { compressVideo } from "../../api";

// 后端对 HEVC 源的等效 CRF 偏移（与 app.py api_compress 保持一致）：
// 码率 ≥ 2Mbps 时 +6，< 2Mbps 时 +16；H.264 源无偏移。
const HEVC_CODECS = new Set(["hevc", "h265", "h.265"]);

const PRESETS = [
  { v: "veryslow", label: "极慢(最小)" },
  { v: "slow", label: "慢" },
  { v: "medium", label: "中" },
  { v: "fast", label: "快" },
  { v: "veryfast", label: "极快(最大)" },
] as const;

const SCALES = [
  { v: "original", label: "原始分辨率" },
  { v: "1080", label: "1080p" },
  { v: "720", label: "720p" },
  { v: "480", label: "480p" },
] as const;

export default function CompressPanel() {
  const [preset, setPreset] = createSignal<string>("medium");
  const [crf, setCrf] = createSignal(23);
  const [scale, setScale] = createSignal<"original" | "1080" | "720" | "480">(
    "original"
  );
  // 输出编码：h264(默认，浏览器/设备通用) | hevc(体积更小，仅部分设备可播)
  const [vcodec, setVcodec] = createSignal<"h264" | "hevc">("h264");
  const [busy, setBusy] = createSignal(false);

  // 智能建议：根据选中视频的编码 / 码率 / 分辨率 + 输出编码动态给出推荐参数
  const suggestion = createMemo(() => {
    const file = files.find((f) => f.name === selectedId());
    if (!file || !file.is_video) return null;
    const codec = (file.video_codec ?? "").toLowerCase();
    const maxEdge = Math.max(file.width ?? 0, file.height ?? 0);
    if (!codec || !maxEdge) return null;

    const isHevc = HEVC_CODECS.has(codec);
    const outIsHevc = vcodec() === "hevc";
    const bitrate = file.video_bitrate ?? 0; // bps，可能为 0（探测不到）
    const lowRate = bitrate > 0 && bitrate < 2_000_000;
    const highRate = bitrate >= 8_000_000;
    const is4k = maxEdge >= 3200;
    const is1080 = maxEdge >= 1800 && maxEdge < 3200;

    // 推荐的滑块 CRF（UI 值）与后端实际编码 CRF
    let recCrf: number;
    let actualCrf: number;
    let offsetHint: string | null = null;
    if (outIsHevc) {
      recCrf = lowRate ? 20 : highRate ? 24 : 22;
      if (isHevc) {
        actualCrf = recCrf + (lowRate ? 16 : 6);
        offsetHint = `+${lowRate ? 16 : 6}`;
      } else {
        actualCrf = recCrf;
      }
    } else {
      // H.264 输出：后端无偏移，直接按 UI 值编码
      recCrf = lowRate ? 18 : highRate ? 26 : 22;
      actualCrf = recCrf;
    }

    // 推荐分辨率
    let recScale: "original" | "1080" | "720" | "480" = "original";
    if (is4k) recScale = "1080";
    else if (is1080 && highRate) recScale = "720";

    const codecLabel = outIsHevc ? "HEVC (H.265)" : "H.264";
    const mbps = bitrate > 0 ? (bitrate / 1_000_000).toFixed(2) : "?";
    const tips: string[] = [];
    if (lowRate) {
      tips.push(`源码率仅 ${mbps} Mbps，已很紧凑，建议轻微压缩或保持原画质`);
    } else if (highRate) {
      tips.push(`源码率 ${mbps} Mbps，压缩空间大，可放心压到 CRF ${recCrf}`);
    } else {
      tips.push(`质量滑块设为 ${recCrf} 可兼顾清晰度与体积`);
    }
    if (isHevc && !outIsHevc) {
      tips.push(
        "HEVC 源将转码为 H.264 以保证浏览器/设备通用播放，体积可能略有增大"
      );
    } else if (!isHevc && outIsHevc) {
      tips.push("H.264 源转 HEVC，体积可再减约 30%，但仅 Safari/部分设备可播");
    } else if (isHevc && outIsHevc && offsetHint) {
      tips.push(
        `后端自动等效偏移 ${offsetHint}，实际编码 CRF ≈ ${actualCrf}`
      );
    }
    if (is4k) {
      tips.push("4K 源建议降到 1080p，体积可减 60% 以上，观感几乎不变");
    } else if (recScale === "720") {
      tips.push("建议降到 720p，画质损失小，体积再减约 40%");
    }
    if ((file.duration ?? 0) > 600) {
      tips.push("长视频建议用「慢」或更高预设，编码更充分且文件更小");
    }

    // 条内一句话摘要（优先级：分辨率建议 > 码率提示 > 转码说明）
    let summary: string;
    if (is4k) summary = "4K 源建议降到 1080p，体积可减 60% 以上";
    else if (recScale === "720") summary = "建议降到 720p，体积再减约 40%";
    else if (lowRate) summary = `源码率仅 ${mbps} Mbps，建议轻微压缩或保持原画质`;
    else if (highRate) summary = `源码率 ${mbps} Mbps，可放心压到 CRF ${recCrf}`;
    else if (isHevc && !outIsHevc)
      summary = `转 H.264 保证浏览器通用，CRF ${recCrf} 兼顾体积`;
    else summary = `设为 CRF ${recCrf} 可兼顾清晰度与体积`;

    return {
      res: `${file.width}x${file.height}`,
      codecLabel,
      outIsHevc,
      mbps,
      recCrf,
      recScale,
      recScaleLabel:
        SCALES.find((x) => x.v === recScale)?.label ?? "原始分辨率",
      actualCrf,
      summary,
      tips,
    };
  });

  const applySuggestion = () => {
    const s = suggestion();
    if (!s) return;
    setCrf(s.recCrf);
    if (s.recScale !== "original") setScale(s.recScale);
    const parts = [`CRF ${s.recCrf}`];
    if (s.recScale !== "original") parts.push(s.recScaleLabel);
    pushToast(`已应用：${parts.join(" · ")}，可再微调`, "info");
  };

  const submit = async () => {
    if (!selectedId()) {
      pushToast("请先在左侧选择一个视频", "error");
      return;
    }
    setBusy(true);
    try {
      const { task_id } = await compressVideo({
        file_id: selectedId()!,
        preset: preset(),
        crf: crf(),
        scale: scale(),
        vcodec: vcodec(),
        faststart: faststartEnabled(),
      });
      upsertTask({
        task_id,
        name: `压缩 ${vcodec() === "hevc" ? "HEVC" : "H.264"} (${preset()}, CRF ${crf()})`,
        status: "running",
        progress: 0,
        created_at: Math.floor(Date.now() / 1000),
      });
      pushToast("已提交压缩任务", "success");
    } catch (e) {
      pushToast("提交失败：" + (e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="tab-panel">
      <h2>压缩</h2>
      <p class="muted">降低码率/分辨率以减小文件体积，保持画质可控。</p>

      <Show when={suggestion()} keyed>
        {(s) => (
          <div class="suggestion-bar" title={s.tips.join("\n")}>
            <span class="suggestion-title">智能建议</span>
            <span class="s-tag">输出 {s.outIsHevc ? "HEVC" : "H.264"}</span>
            <span class="s-tag">
              质量 CRF <b>{s.recCrf}</b>
            </span>
            <Show when={s.recScale !== "original"}>
              <span class="s-tag">{s.recScaleLabel}</span>
            </Show>
            <Show when={s.actualCrf !== s.recCrf}>
              <span class="s-tag">
                {s.codecLabel} 实际 ≈<b>{s.actualCrf}</b>
              </span>
            </Show>
            <span class="s-note">{s.summary}</span>
            <button class="btn small" onClick={applySuggestion}>
              一键应用
            </button>
          </div>
        )}
      </Show>

      <div class="form-card">
        <div class="field">
          <label>输出编码</label>
          <div class="seg">
            <button
              class={vcodec() === "h264" ? "active" : ""}
              onClick={() => setVcodec("h264")}
            >
              H.264 (通用兼容)
            </button>
            <button
              class={vcodec() === "hevc" ? "active" : ""}
              onClick={() => setVcodec("hevc")}
            >
              HEVC (体积更小)
            </button>
          </div>
          <p class="hint">
            H.264 所有浏览器/设备可播；HEVC 仅 Safari/iOS 等部分设备可播，文件更小
          </p>
        </div>

        <div class="field">
          <label>压缩预设</label>
        <div class="seg">
          <For each={PRESETS}>
            {(p) => (
              <button
                class={preset() === p.v ? "active" : ""}
                onClick={() => setPreset(p.v)}
              >
                {p.label}
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="field">
        <label>质量 (CRF，越大文件越小)</label>
        <div class="range-row">
          <input
            type="range"
            min="18"
            max="34"
            value={crf()}
            onInput={(e) => setCrf(+e.currentTarget.value)}
          />
          <span class="range-val">{crf()}</span>
        </div>
      </div>

      <div class="field">
        <label>分辨率</label>
        <div class="seg">
          <For each={SCALES}>
            {(s) => (
              <button
                class={scale() === s.v ? "active" : ""}
                onClick={() => setScale(s.v as any)}
              >
                {s.label}
              </button>
            )}
          </For>
        </div>
      </div>

      </div>

      <div class="actions">
        <button class="btn" onClick={submit} disabled={busy()}>
          {busy() ? "提交中…" : "开始压缩"}
        </button>
      </div>
    </div>
  );
}
