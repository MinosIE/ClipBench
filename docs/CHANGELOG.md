# 改动日志（CHANGELOG）

> **约定**：每次对代码做出改动后，先把改动内容总结到本文档（见「待提交改动」一节），
> 提交时直接对照本文档编写 commit message 即可，无需再逐文件回忆。
> 提交完成后，把对应内容从「待提交改动」移到「已提交记录」并按提交哈希归档。

---

## 待提交改动

### 2026-08-26 — 媒体列表收敛：音频不回流 + 产物显示开关
- 涉及文件：`app.py`、`src/api.ts`、`src/store.ts`、`src/App.tsx`、`src/components/Sidebar.tsx`、`vite.config.js`、`docs/CHANGELOG.md`

**音频不再进入媒体文件列表**
- 后端 `/api/files`：`get_media_meta` 后过滤 `has_video` 为假的文件 → 音频（含音频提取产物 mp3/m4a/wav/flac）不再显示在左侧；同时修复产物缩略图/取帧/元信息 404（`_find_media` 同时查 uploads 与 outputs）。

**产物回流开关（顶栏「显示产物」，置于快速启动左侧）**
- `store.ts` 新增 `showOutputs` 信号（localStorage 键 `cb_show_outputs`，默认开启）+ `toggleShowOutputs()`。
- 后端 `/api/files?outputs=0`：关闭时仅返回手动上传文件；前端 `listFiles({ includeOutputs })` 透传，切换开关立即刷新列表。
- 产物开关独立持久化，不影响「快速启动」开关。

**前端缩略图 404 根治（上一轮遗留）**
- `Sidebar` 视频缩略图 `onerror` 防死循环（二次失败隐藏）+ 按 `location` 兜底 `/outputs/` 或 `/uploads/`；音频文件渲染 ♪ 占位（防御性保留，列表已无音频）。
- `vite.config.js` dev 代理 5000→8080（macOS 隔空播放接收器占用 5000 会返回 403），并补 `/outputs` 代理。

### 2026-08-26 — P0 任务闭环：失败日志查看 + 取消接口修复
- 涉及文件：`app.py`、`src/api.ts`、`src/components/Tasks.tsx`、`src/styles.css`、`docs/todo.md`

**失败任务可查看 ffmpeg 日志**
- 后端 `_run_ffmpeg_locked`：限制 `out_lines` 只保留尾部 600 行（防长任务内存膨胀）；进程结束后把 ffmpeg 输出（stderr 并入 stdout）整体存入 `task["log"]`，随任务记录持久化并经 SSE 推送。
- 前端失败任务卡片新增「日志」按钮，弹窗展示完整日志（深色 `<pre>`、可滚动、`pre-wrap` 自动换行），复用 `.modal-mask` 遮罩。
- `Task` 类型新增 `log?: string`。

**处理中可取消（修复 404）**
- 前端 `cancelTask` 之前请求复数路径 `/api/tasks/<id>/cancel`，后端只有单数 `/api/task/<id>/cancel`，取消按钮一直 404 失效 → 修正为单数路径。
- `onCancel` 加 try/catch，失败时 toast 提示而非静默抛未捕获异常。

**其他**
- todo.md：P0 的「产物打开/下载」评估为不需要（已有查看/下载入口），标记完成项。

### 2026-08-26 — P1 时间点输入体验：预览取帧打点
- 涉及文件：`src/components/TimePickerModal.tsx`（新增）、`src/components/panels/SplitPanel.tsx`、`src/components/panels/ScreenshotPanel.tsx`、`src/styles.css`、`docs/todo.md`

**改动**
- 新增复用组件 `TimePickerModal`：弹窗内 `<video>`（preload=metadata + controls）播放/拖动定位目标画面，实时显示当前时间（HH:MM:SS，等宽数字），点动作按钮回调时间秒数；导出 `fmtHms` 工具函数；浏览器无法解码编码时提示手动输入。
- 拆分面板「时间区间」每行新增「预览」按钮，弹窗内「设为起点 / 设为终点」直接写入该行 start/end（非受控 input 同步 DOM + store）。
- 截图面板「单张」模式时间点旁新增「预览取帧」按钮，弹窗内「使用当前时间」回填输入框。
- 样式：`.time-picker` 弹窗（视频占满、max-height 52vh、当前时间加粗）。

### 2026-08-26 — P3 新一轮建议：高价值 + 中价值
- 涉及文件：`app.py`、`src/api.ts`、`src/store.ts`、`src/App.tsx`、`src/components/panels/index.ts`、`src/components/panels/AudioExtractPanel.tsx`（新增）、`src/components/panels/MergePanel.tsx`、`src/components/panels/ConvertPanel.tsx`、`src/components/panels/CompressPanel.tsx`、`src/components/panels/ScreenshotPanel.tsx`、`src/components/panels/SplitPanel.tsx`、`src/components/Sidebar.tsx`、`src/components/Tasks.tsx`、`src/styles.css`、`docs/todo.md`

**高价值-1 音频提取（第 11 个功能 Tab）**
- 后端新增 `/api/extract_audio`：ffmpeg `-vn -map 0:a:0` 提取主音轨，输出 mp3（libmp3lame + 码率）/ m4a（aac）/ wav（pcm_s16le）/ flac；源文件无音频流返回 400 提示；源文件可来自上传目录或输出目录（产物可二次处理）。
- 前端新增 `AudioExtractPanel`（格式 seg + 码率 seg + 无损提示），`TABS` 注册「音频提取」（音乐音符图标，置于调速与去字幕之间），`api.ts` 新增 `extractAudio`。
- 冒烟验证：对 `sample_v3.mp4` 提取 mp3 128k，任务 finished，产物 `audio_*.mp3` 落盘。

**高价值-2 合并文件顺序可拖拽调整**
- `MergePanel` 每行支持 HTML5 拖拽重排（`draggable` + dragstart/drop 重排 picked 数组），并保留 ↑ / ↓ 按钮；拖拽中半透明虚线、悬停目标行高亮（`.merge-row.dragging / .drag-over`）。

**高价值-3 输出文件回流左侧列表**
- 后端 `/api/files` 改为合并列出上传目录 + 输出目录产物（`location: uploads|outputs`，同名去重、按 mtime 排序）；排除 `thumb_*` 缩略图、`*.zip` 打包产物、`merge_list_*` 合并清单中间文件。
- 删除接口（单个/批量）均支持产物文件：优先上传目录，其次输出目录。
- 前端 `Tasks.tsx`：任务完成且带 `output_name` 时自动 `refreshFiles()`，产物即时出现在左侧；`Sidebar` 产物卡片显示「产物」徽标（`.file-badge`）。

**中价值-1 面板参数记忆**
- `store.ts` 新增 `persistSignal(key, fallback)`：带 localStorage 持久化的 signal（读时 JSON.parse、写时自动落盘，异常静默）。
- 接入面板：转换（目标格式/CRF/编码器）、压缩（预设/CRF/分辨率/编码）、截图（模式/间隔/格式）、拆分（方式/每段时长/静音/输出/编码）；音频提取面板初版未接入（后续可选）。

**中价值-2 左侧文件搜索框**
- `Sidebar` 文件列表顶部新增搜索输入框（`.file-search`），按文件名过滤展示（`createMemo`），无匹配时显示空态提示；搜索不影响全选/计数。

**中价值-3 日志弹窗一键复制**
- 失败日志弹窗新增「复制全部」按钮（`navigator.clipboard.writeText` + toast 反馈）。

---

## 已提交记录

### 2026-08-26 — 左右栏折叠功能（含细节打磨）
- 提交哈希：`841eadf`
- 涉及文件：`src/components/Sidebar.tsx`、`src/components/Tasks.tsx`、`src/styles.css`、`docs/CHANGELOG.md`

**折叠功能**
- 左侧「媒体文件」head 新增折叠按钮（chevron ◀）：点击后侧栏收缩为 40px 窄条，主区自动占据空出的空间；再点展开恢复。
- 右侧「任务列表」head 新增折叠按钮（chevron ▶）：点击后收为 40px 窄条，中间面板自动撑满；再点展开恢复。
- 折叠态用 `.sidebar.collapsed` / `.tasks-pane.collapsed`：宽度收缩 + 内部内容隐藏 + head 居中 + `width 0.18s` 过渡动画。
- 折叠时任务/文件数据不丢失，展开即恢复原状。

**细节打磨**
- 左侧 head 的刷新 ⟳ 与折叠按钮包进 `.head-actions`（flex + gap 6px），与标题 space-between 分布，两图标紧凑相邻不再割裂。
- 右侧「任务列表」head 按钮精简为「删除」「清空」两字（去掉「批量删除(N)」「清空全部」长文案），`flex-wrap: nowrap` 保证整行不换行。
- 折叠后窄条不再空白：head 改为纵向布局，中间竖排显示「媒体文件 / 任务列表」标题（`writing-mode: vertical-rl`，`flex: 1` 撑满）。
- 折叠态展开按钮 `order: 1` 置顶（标题 `order: 2` 在其下撑满），避免按钮被挤到底部、交互别扭；head 加 `gap: 10px` 让按钮与竖排标题保持间距。

### 2026-08-26 — 合并功能全面增强 + 各面板表单布局统一
- 提交哈希：`f79e899`
- 涉及文件：`app.py`、`src/api.ts`、`src/components/Tasks.tsx`、`src/components/panels/MergePanel.tsx`、`src/components/panels/ConvertPanel.tsx`、`src/components/panels/RotatePanel.tsx`、`src/components/panels/ScreenshotPanel.tsx`、`src/components/panels/SpeedPanel.tsx`、`src/components/panels/SplitPanel.tsx`、`src/components/panels/WatermarkPanel.tsx`、`src/styles.css`、`tests/test_app.py`、`docs/CHANGELOG.md`（新增）

**合并功能增强**
- 合并编码改为三选：`h264`（libx264 + keyint=2，兼容最好，默认）/ `hevc`（libx265 -crf 20 + `-tag:v hvc1`，体积更小）/ `copy`（保留原编码，极速零损）；后端按编码器生成参数，任务 extra 记录 `encode`。
- copy 模式前后端双重一致性校验：后端 `_check_merge_compatible`（ffprobe 比对编码/分辨率/帧率/音频编码，不一致返回 400 + 中文提示）；前端 `checkMergeCompatible` 纯函数预判，不一致时 toast 弹错且**不发请求**；新增集成测试 `test_merge_copy_requires_consistent_codec` / `test_merge_copy_same_files_ok`。
- `jsonFetch` 错误处理：解析后端 JSON 响应体的 `error` 字段，修复 toast 出现 `\u4fdd\u7559...` 转义乱码。
- 合并面板展示选中文件信息（分辨率 · 时长 · 编码）与处理后结果（大小/编码/分辨率/时长/编码方式）；「合并编码」选中实时显示说明文字（`.hint`）。
- 修复 `createStore` proxy 被当函数调用的两个 bug：`tasks()` → `tasks`（MergePanel 挂载崩溃）、`files()` → `files`（点开始合并报 `Ce is not a function`）。

**各面板布局/样式统一**
- 截图输出格式增加 WebP / AVIF（后端 `libwebp` / `libaom-av1 -still-picture 1`）。
- 截图/旋转/水印/调速面板表单项统一为 label 在左、控件在右的 `.field.row` 布局。
- 6 个面板底部按钮移入 form-card，`.actions` 统一虚线分隔 + 右对齐。
- 新增 `.inline-check` 修复字段行内开关文字被遮挡/换行问题（拆分静音、调速倒放、旋转翻转）。

### 2026-08-26 — 拆分编码方式可选 + 表单左右布局
- 提交哈希：`08ec20d`
- 涉及文件：`app.py`、`src/api.ts`、`src/components/Tasks.tsx`、`src/components/panels/SplitPanel.tsx`、`src/styles.css`

**后端**
- `/api/split` 新增 `encode` 参数（`copy` / `reencode`），默认 `reencode`。
- 新增 `_split_encode_args(encode, mute, suffix)` 辅助函数，封装两套方案：
  - `copy`：`-c copy` 流拷贝，保留原编码/分辨率/体积，速度最快、零画质损失；
    但片段起点落在 GOP 中间时，部分浏览器可能前几秒黑屏。
  - `reencode`（默认）：重编码为 H.264（CRF 18 + 段首强制关键帧 `keyint=2`），
    加 `-movflags +faststart`、mp4/mov 用 `avc1` tag，浏览器 / QuickTime 全兼容，彻底无黑屏。
- 单段时间截取、多段时间截取、按时长拆分三种模式均接入 `encode` 选项；任务 extra 记录 `encode`。

**前端**
- 拆分面板新增「编码方式」单选：默认「重编码（兼容优先，推荐）」/「保留原编码（极速无损）」。
- 拆分表单改为 label 在左、控件在右的左右布局（`.field.row`）。
- 「静音」从游离开关改为与编码方式同款左右布局字段，紧跟其后，不再突兀。
- `Tasks.tsx` 拆分结果信息新增「保留原编码 / 重编码 H.264」标签（读 `t.encode`）。

---

### 拆分功能历史修复（早期提交，概览）
- 起始黑屏、QT 不兼容、多段时长错误等问题经多轮修复，最终确立：
  - 用 `-t`（时长）而非 `-to`（停止时间）避免 seeking 语义歧义；
  - 输出文件加 `-movflags +faststart`，HEVC 用 `hvc1` tag 兼容 QuickTime；
  - 多段时间段采用「按段独立 `-ss` + `-t` + 串行执行」方案，并用 `_record_split_result` 记录输出基本信息（大小/编码/分辨率/时长/片段数）。
- 拆分结果在前端以 `.cc-params` 单行 chip 紧凑展示；多文件任务提供下载压缩包入口。
