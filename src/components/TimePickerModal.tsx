import { createSignal, Show, For } from "solid-js";
import { uploadUrl } from "../api";

interface PickerAction {
  label: string;
  onPick: (sec: number) => void;
}

interface Props {
  videoName: string;
  title: string;
  actions: PickerAction[];
  onClose: () => void;
}

export const fmtHms = (sec: number): string => {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

/**
 * 预览取帧弹窗：用 <video> 播放/拖动定位目标画面，
 * 点动作按钮把当前时间（秒）交给调用方（通常格式化为 HH:MM:SS 填入输入框）。
 * 浏览器无法解码的编码会显示提示，用户仍可手动输入。
 */
export default function TimePickerModal(props: Props) {
  const [cur, setCur] = createSignal(0);
  const [err, setErr] = createSignal(false);
  let videoRef!: HTMLVideoElement;

  return (
    <div class="modal-mask" onClick={props.onClose}>
      <div class="modal time-picker" onClick={(e) => e.stopPropagation()}>
        <h3>{props.title}</h3>
        <video
          ref={videoRef}
          src={uploadUrl(props.videoName)}
          controls
          preload="metadata"
          onTimeUpdate={() => setCur(videoRef.currentTime)}
          onError={() => setErr(true)}
        />
        <Show
          when={err()}
          fallback={
            <p class="muted">
              拖动进度条或播放定位到目标画面，再点下方按钮填入时间。
            </p>
          }
        >
          <p class="hint" style={{ color: "#e5484d" }}>
            浏览器无法解码该视频编码，无法预览，请手动输入时间。
          </p>
        </Show>
        <div class="picker-time">当前：{fmtHms(cur())}</div>
        <div class="modal-actions">
          <Show when={!err()}>
            <For each={props.actions}>
              {(a) => (
                <button
                  class="btn primary small"
                  onClick={() => a.onPick(videoRef.currentTime)}
                >
                  {a.label}
                </button>
              )}
            </For>
          </Show>
          <button class="btn secondary small" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
