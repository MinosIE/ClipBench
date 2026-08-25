import { createSignal, createEffect, Show, For } from "solid-js";
import {
  files,
  selectedId,
  pushToast,
  upsertTask,
  faststartEnabled,
} from "../../store";
import { compressVideo, compressSuggest, CompressSuggestion } from "../../api";

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

  // 智能建议由后端统一计算（/api/compress_suggest），前端不写死任何阈值
  const [suggestion, setSuggestion] = createSignal<CompressSuggestion | null>(
    null
  );
  const [sugLoading, setSugLoading] = createSignal(false);

  // 选中文件或切换输出编码时，实时拉取后端建议
  createEffect(() => {
    const fid = selectedId();
    const vc = vcodec();
    if (!fid) {
      setSuggestion(null);
      return;
    }
    setSugLoading(true);
    compressSuggest(fid, vc)
      .then((s) => setSuggestion(s))
      .catch(() => setSuggestion(null))
      .finally(() => setSugLoading(false));
  });

  const applySuggestion = () => {
    const s = suggestion();
    if (!s) return;
    setCrf(s.rec_crf);
    if (s.rec_scale !== "original") setScale(s.rec_scale as typeof scale);
    const parts = [`CRF ${s.rec_crf}`];
    if (s.rec_scale !== "original") parts.push(s.rec_scale_label);
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
      const f = files.find((x) => x.name === selectedId());
      upsertTask({
        task_id,
        name: `压缩 ${vcodec() === "hevc" ? "HEVC" : "H.264"} (${preset()}, CRF ${crf()})`,
        status: "running",
        progress: 0,
        created_at: Math.floor(Date.now() / 1000),
        kind: "compress",
        src_name: selectedId(),
        src_size: f?.size,
        src_size_human: f?.display_size,
        src_codec: f?.video_codec,
        src_resolution:
          f?.width && f?.height ? `${f.width}x${f.height}` : undefined,
      });
      pushToast("已提交压缩任务", "success");
    } catch (e) {
      pushToast("提交失败：" + (e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="tab-panel two-col">
      <h2>压缩</h2>
      <p class="muted">降低码率/分辨率以减小文件体积，保持画质可控。</p>

      {/* 加载中提示 */}
      <Show when={sugLoading() && !suggestion()}>
        <div class="suggestion-bar suggestion-loading">
          <span class="suggestion-title">智能建议</span>
          <span class="s-note">分析中…</span>
        </div>
      </Show>

      <Show when={suggestion()} keyed>
        {(s) => (
          <div
            class="suggestion-bar"
            title={[
              ...s.tips,
              `预估输出：${s.src_size_human || "?"} → 约 ${s.est_out_human}（${s.est_up ? "增" : "省"}${Math.abs(s.est_saving)}%，仅供参考）`,
            ].join("\n")}
          >
            <span class="suggestion-title">智能建议</span>
            <span class="s-tag">输出 {s.out_is_hevc ? "HEVC" : "H.264"}</span>
            <span class="s-tag">
              质量 CRF <b>{s.rec_crf}</b>
            </span>
            <Show when={s.rec_scale !== "original"}>
              <span class="s-tag">{s.rec_scale_label}</span>
            </Show>
            <Show when={s.actual_crf !== s.rec_crf}>
              <span class="s-tag">
                {s.codec_label} 实际 ≈<b>{s.actual_crf}</b>
              </span>
            </Show>
            <span
              class="s-tag s-est"
              classList={{ up: s.est_up }}
              title="基于分辨率/CRF/编码的经验估算，仅供参考"
            >
              预估 {s.est_up ? "↑" : "↓"}
              {Math.abs(s.est_saving)}%
            </span>
            <span class="s-note">
              {s.summary} · {s.src_size_human || "?"} → 约 {s.est_out_human}
            </span>
            <button class="btn small" onClick={applySuggestion}>
              一键应用
            </button>
          </div>
        )}
      </Show>

      <div class="form-card grid2 compact">
        <div class="field col-span">
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

        <div class="field col-span">
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

      <aside class="panel-aside">
        <h4>压缩贴士</h4>
        <ul>
          <li><b>智能建议</b> 由后端按源视频参数计算，可直接「一键应用」。</li>
          <li><b>CRF</b> 越大文件越小，18~23 画质损失很小。</li>
          <li><b>HEVC</b> 比 H.264 体积更小，但兼容性较差。</li>
          <li>降分辨率（720p/480p）对减小体积最有效。</li>
        </ul>
        <div class="aside-note">
          提示：预估压缩率为经验估算，实际以任务结果为准。
        </div>
      </aside>

      <div class="actions">
        <button class="btn" onClick={submit} disabled={busy()}>
          {busy() ? "提交中…" : "开始压缩"}
        </button>
      </div>
    </div>
  );
}
