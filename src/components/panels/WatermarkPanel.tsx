import { createSignal, Show, For } from "solid-js";
import { selectedId, pushToast, upsertTask, faststartEnabled } from "../../store";
import { uploadWatermark, watermarkVideo } from "../../api";

const POSITIONS = [
  { v: "tl", label: "左上" },
  { v: "tr", label: "右上" },
  { v: "bl", label: "左下" },
  { v: "br", label: "右下" },
  { v: "c", label: "居中" },
] as const;

export default function WatermarkPanel() {
  const [type, setType] = createSignal<"text" | "image">("text");
  const [text, setText] = createSignal("ClipBench");
  const [position, setPosition] = createSignal<string>("br");
  const [margin, setMargin] = createSignal(20);
  const [fontsize, setFontsize] = createSignal(36);
  const [color, setColor] = createSignal("#ffffff");
  const [alpha, setAlpha] = createSignal(0.7);
  const [wmId, setWmId] = createSignal<string>("");
  const [wmName, setWmName] = createSignal<string>("");
  const [scaleW, setScaleW] = createSignal(20);
  const [busy, setBusy] = createSignal(false);

  const onWmUpload = async (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const r = await uploadWatermark(file);
      setWmId(r.watermark_id);
      setWmName(r.filename);
      pushToast("水印图片已上传", "success");
    } catch (err) {
      pushToast("上传失败：" + (err as Error).message, "error");
    }
  };

  const submit = async () => {
    if (!selectedId()) {
      pushToast("请先在左侧选择一个视频", "error");
      return;
    }
    if (type() === "text" && !text()) {
      pushToast("请输入水印文字", "error");
      return;
    }
    if (type() === "image" && !wmId()) {
      pushToast("请先上传水印图片", "error");
      return;
    }
    setBusy(true);
    try {
      const { task_id } = await watermarkVideo({
        file_id: selectedId()!,
        type: type(),
        position: position() as any,
        margin: margin(),
        text: type() === "text" ? text() : undefined,
        fontsize: type() === "text" ? fontsize() : undefined,
        color: type() === "text" ? color() : undefined,
        alpha: alpha(),
        watermark_id: type() === "image" ? wmId() : undefined,
        scale_w: type() === "image" ? scaleW() : undefined,
        faststart: faststartEnabled(),
      });
      upsertTask({
        task_id,
        name: `水印(${type() === "text" ? "文字" : "图片"})`,
        status: "running",
        progress: 0,
        created_at: Math.floor(Date.now() / 1000),
      });
      pushToast("已提交水印任务", "success");
    } catch (e) {
      pushToast("提交失败：" + (e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="tab-panel two-col">
      <h2>水印</h2>
      <p class="muted">为视频添加文字或图片水印，支持 9 宫格位置与透明度。</p>

      <div class="form-card">
        <div class="field row col-span">
          <label>水印类型</label>
        <div class="seg">
          <button
            class={type() === "text" ? "active" : ""}
            onClick={() => setType("text")}
          >
            文字
          </button>
          <button
            class={type() === "image" ? "active" : ""}
            onClick={() => setType("image")}
          >
            图片
          </button>
        </div>
      </div>

      <Show when={type() === "text"}>
        <div class="field row">
          <label>水印文字</label>
          <input
            type="text"
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
          />
        </div>
        <div class="row">
          <div class="field row" style={{ "margin-bottom": "0" }}>
            <label>字号(px)</label>
            <input
              type="number"
              value={fontsize()}
              onInput={(e) => setFontsize(+e.currentTarget.value)}
              style={{ width: "90px" }}
            />
          </div>
          <div class="field row" style={{ "margin-bottom": "0" }}>
            <label>颜色</label>
            <input
              type="color"
              value={color()}
              onInput={(e) => setColor(e.currentTarget.value)}
              style={{ width: "60px", padding: "2px" }}
            />
          </div>
        </div>
      </Show>

      <Show when={type() === "image"}>
        <div class="field row">
          <label>水印图片</label>
          <input type="file" accept="image/*" onChange={onWmUpload} />
          <Show when={wmName()}>
            <span class="hint">已上传：{wmName()}</span>
          </Show>
        </div>
        <div class="field row">
          <label>相对宽度(%)</label>
          <div class="range-row">
            <input
              type="range"
              min="5"
              max="80"
              value={scaleW()}
              onInput={(e) => setScaleW(+e.currentTarget.value)}
            />
            <span class="range-val">{scaleW()}%</span>
          </div>
        </div>
      </Show>

      <div class="field row">
        <label>位置</label>
        <div class="seg">
          <For each={POSITIONS}>
            {(p) => (
              <button
                class={position() === p.v ? "active" : ""}
                onClick={() => setPosition(p.v)}
              >
                {p.label}
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="row">
        <div class="field row" style={{ "margin-bottom": "0" }}>
          <label>边距(px)</label>
          <input
            type="number"
            value={margin()}
            onInput={(e) => setMargin(+e.currentTarget.value)}
            style={{ width: "90px" }}
          />
        </div>
        <div class="field row" style={{ "margin-bottom": "0" }}>
          <label>透明度</label>
          <div class="range-row">
            <input
              type="range"
              min="0.1"
              max="1"
              step="0.05"
              value={alpha()}
              onInput={(e) => setAlpha(+e.currentTarget.value)}
            />
            <span class="range-val">{alpha().toFixed(2)}</span>
          </div>
        </div>
      </div>

      <div class="actions">
        <button class="btn" onClick={submit} disabled={busy()}>
          {busy() ? "提交中…" : "开始添加水印"}
        </button>
      </div>

      </div>

      <aside class="panel-aside">
        <h4>排版建议</h4>
        <ul>
          <li>位置选<b>右下角</b>最不遮挡主体，是平台惯例。</li>
          <li>透明度 0.6~0.8 既可见又不抢戏。</li>
          <li>文字水印字号建议画面的 1/30 左右。</li>
          <li>图片水印相对宽度 15%~25% 较克制。</li>
        </ul>
        <div class="aside-note">
          提示：边距越大，水印离画面边缘越远，更显精致。
        </div>
      </aside>
    </div>
  );
}
