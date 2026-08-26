# 改动日志（CHANGELOG）

> **约定**：每次对代码做出改动后，先把改动内容总结到本文档（见「待提交改动」一节），
> 提交时直接对照本文档编写 commit message 即可，无需再逐文件回忆。
> 提交完成后，把对应内容从「待提交改动」移到「已提交记录」并按提交哈希归档。

---

## 待提交改动

### 2026-08-26 — 修复「开始合并」报错 Ce is not a function
- 涉及文件：`src/components/panels/MergePanel.tsx`

**背景**
- 上一轮前端预判里误写了 `files()` —— `files` 是 `createStore` 返回的 proxy 数组，**不能当函数调用**，minify 后报 `Ce is not a function`（与之前 `tasks()` 同款坑）。
- 报错只在点击「开始合并」且走预判分支时触发，`Array.map` 栈帧定位到 `.map((name) => files().find(...))`。

**改动**
- `submit` 中 `files()` → `files`（proxy 数组直接 `.find`，在 map 内自动建立响应式依赖，行为不变）。
- 全库复查无其他 `files()`/`tasks()` 误用。
- 已重建（hash `index-6ANEgKEs.js`）并重启服务。

### 2026-08-26 — 合并 copy 模式前端预判 + 错误信息 JSON 解析
- 涉及文件：`src/api.ts`（`jsonFetch`、`checkMergeCompatible`）、`src/components/panels/MergePanel.tsx`（`submit`）

**背景**
- 之前后端 400 错误时，`jsonFetch` 把整个 `{"error": "..."}` 字符串拼到 `Error.message`，toast 显示成 `\u4fdd\u7559...` 转义乱码。
- 用户体验：copy 模式 + 源不一致时希望「不通过就不请求接口」，前端立即反馈，避免走网络往返。

**改动**
- `jsonFetch` 错误处理：先尝试 `JSON.parse(text)` 取 `error` 字段，解析失败再降级用原文，杜绝 `\u` 乱码。
- 新增 `checkMergeCompatible(files: StoredFile[])` 纯函数：比对其余文件与首文件的 `video_codec / 分辨宽高 / fps / audio_codec`，首项不一致即返回中文错误文案。
- `MergePanel.submit` 在 `encode === "copy"` 时，先从 store 把 picked 文件对应的元数据查出（files 信息未就绪时也兜底提示），调用 `checkMergeCompatible`：
  - 通过 → 正常发请求；
  - 不通过 → 直接 `pushToast(error, "error")` 弹错，**不发 `/api/merge` 请求**。
- 后端 `_check_merge_compatible` 保留作最后防线（防御性）。

### 2026-08-26 — 合并编码改为三选：H.264 / HEVC / 保留原编码
- 涉及文件：`app.py`（`api_merge`）、`src/api.ts`、`src/components/panels/MergePanel.tsx`、`src/components/Tasks.tsx`

**背景**
- 原「重编码」固定输出 H.264，源为 HEVC 时强制降编码损失效率/画质潜力；且旧代码有个错误认知：源 HEVC 也会被标为"h264 转码"。

**改动**
- 合并编码 `encode` 取值从 `reencode/copy` 改为 `h264 / hevc / copy`（默认 `h264`）：
  - `h264`：`libx264` + `-x264-params keyint=2:min-keyint=2`（与拆分一致，快进快退兼容），兼容性最好。
  - `hevc`：`libx265 -crf 20` + `-tag:v hvc1`（QuickTime/Safari 兼容），同等画质体积更小、编码更慢。
  - `copy`：保留原编码（极速零损，需源参数一致，已有 `_check_merge_compatible` 校验）。
- 前端 MergePanel seg 三项 + 各自选中说明；Tasks.tsx 合并标签区分 h264/hevc/copy。
- 已重建并重启服务，三种模式实测均 `finished` 且输出编码正确。

### 2026-08-26 — 合并编码选项增加选中说明
- 涉及文件：`src/components/panels/MergePanel.tsx`

**改动**
- 合并面板「合并编码」下方，根据当前选中项（`encode()`）实时展示一行说明（复用 `.hint` 样式）：
  - 选「重编码」：说明统一 H.264+AAC、兼容不同源、最稳但耗时略长。
  - 选「保留原编码」：说明极速零损、要求源参数一致、已自动校验、不一致会失败。
- 原先仅 `title` 悬浮提示，现选中即见，降低误选风险。

### 2026-08-26 — 合并「保留原编码」模式下增加一致性校验（拦截不一致源）
- 涉及文件：`app.py`（`api_merge` + 新增 `_check_merge_compatible`）、`tests/test_app.py`

**背景**
- 合并「保留原编码」(copy) 直接 `-c copy` 走 ffmpeg concat，要求所有源编码/分辨率/帧率完全一致；不一致时 ffmpeg 直接报错或拼接处黑屏/音画错位，用户往往要等任务跑起来才发现失败。

**改动**
- 新增 `_check_merge_compatible(paths)`：合并前用 `get_media_meta`(ffprobe) 逐文件比对 **视频编码 / 分辨率 / 帧率 / 音频编码**，首个不一致项即返回明确中文提示，如「「保留原编码」要求所有视频参数一致，但 xxx 与 yyy 的分辨率不同（160x90 ≠ 320x180）。请改用「重编码」后重试。」；文件无法读取时提示具体文件名。
- `api_merge` 在 `encode == "copy"` 时先调用校验，失败返回 `400 + error`，不入队；`reencode` 模式跳过校验（本身统一重编码，兼容不同源）。
- 测试新增 `test_merge_copy_requires_consistent_codec`（不同分辨率→400）、`test_merge_copy_same_files_ok`（同源→200），均通过。

### 2026-08-26 — 截图/旋转/水印/调速面板表单统一改为左右布局
- 涉及文件：`src/components/panels/ScreenshotPanel.tsx`、`src/components/panels/RotatePanel.tsx`、`src/components/panels/WatermarkPanel.tsx`、`src/components/panels/SpeedPanel.tsx`（样式复用 `src/styles.css` 既有 `.field.row`，无需改 CSS）

**改动**
- 复用拆分面板已验证的 `.field.row` 左右布局（label 在左 92px 右对齐、控件在右），把上述四个面板的表单项统一改造：
  - 截图：模式（col-span）、时间点/间隔、输出格式 全部改为左右布局。
  - 旋转：旋转角度（col-span）左右布局；「翻转」由原本游离的 `.row` 两个开关改为「label 在左 + 右侧两个开关」的 `.field.row`。
  - 水印：水印类型（col-span）、水印文字/图片、相对宽度、位置 改为左右布局；字号+颜色、边距+透明度两组的内部 `.field` 也改为 `.field.row`。
  - 调速：速度倍率（col-span，含 seg + range）左右布局；「倒放」由游离 `.check-row` 改为「label 在左 + 右侧开关」的 `.field.row`。
- 视觉与拆分面板保持一致，整体更紧凑、字段对齐更整齐。

### 2026-08-26 — 截图输出格式增加 WebP / AVIF
- 涉及文件：`app.py`（`api_screenshot`）、`src/components/panels/ScreenshotPanel.tsx`

**后端**
- `/api/screenshot` 的 `format` 参数新增 `webp`、`avif`（原为 `jpg`/`png`），非法格式返回 400。
- 按格式指定编码器：webp → `-c:v libwebp`；avif → `-c:v libaom-av1 -still-picture 1`。
- 输出文件名扩展名统一为格式小写的 `ext`（jpeg 归一为 jpg）。单张/批量两种模式均已接入。
- 已用本机 ffmpeg 实测：`libwebp`、`libaom-av1` + avif muxer 均可用，生成文件格式正确（webp 50KB / avif 24KB）。

**前端**
- 截图面板「输出格式」seg 增加 WebP、AVIF 两个选项（共 JPG / PNG / WebP / AVIF）。

### 2026-08-26 — 统一所有面板底部按钮样式（虚线分隔 + 右对齐）
- 涉及文件：`src/components/panels/SplitPanel.tsx`、`src/components/panels/ScreenshotPanel.tsx`、`src/components/panels/ConvertPanel.tsx`、`src/components/panels/MergePanel.tsx`、`src/components/panels/RotatePanel.tsx`、`src/components/panels/WatermarkPanel.tsx`、`src/components/panels/SpeedPanel.tsx`、`src/styles.css`

**背景**
- 排查发现：截图 / 格式转换 / 合并 / 旋转 / 水印 / 调速 这 6 个面板的「开始处理」按钮原本在 `</aside>` 之外的独立 `.actions`，位于 form-card 外面，与字段卡片视觉脱节；只有 Compress 的按钮在 form-card 内。
- 拆分面板此前按钮在卡片外，已先行移入并验证。

**改动**
- 把 6 个面板的 `<div class="actions">` 从 form-card 之外移到 form-card 闭合 `</div>` 之前（即表单卡片末尾），使其与表单字段在同一卡片内。
- CSS `.actions` 统一增加 `padding-top:14px` + `border-top:1px dashed var(--line)`，所有面板底部按钮上方都有虚线分隔、右对齐。
- 拆分面板按钮 class 由 `.form-actions` 改回 `.actions`，删除冗余的 `.form-card .form-actions` 定义，样式一处管控、全面板一致。
- Compress 按钮本来就在 form-card 内，仅样式统一即与其它面板一致。

### 2026-08-26 — 字段行内开关文字不再被遮挡（新增 .inline-check）
- 涉及文件：`src/styles.css`、`src/components/panels/SplitPanel.tsx`、`src/components/panels/SpeedPanel.tsx`、`src/components/panels/RotatePanel.tsx`

**问题**
- `.check-row` 自带开关轨道 `::before`（26×15 圆角）和圆形拨钮 `::after`（11×11）通过 `position:absolute; left:0/2px` 定位，依赖 `padding-left:30px` 给开关留位、文字在开关右侧。
- 当 `.check-row` 嵌入 `.field.row`（label + 控件）时，开关的 `::before/::after` 仍按原 left:0/2px 渲染，会覆盖/遮挡紧随其后的文字 —— 在调速「倒放 / 生成倒放视频」、旋转「翻转 / 水平翻转 / 垂直翻转」、拆分「静音输出 / 去除音轨」上都出现遮挡甚至换行。

**修复**
- 新增 `.inline-check` 样式：`display:inline-flex; gap:6px`，checkbox 与文字紧凑内联排布，无开关轨道占位，专用于字段行内的"label + 文字说明型开关"。
- SplitPanel 静音、SpeedPanel 倒放、RotatePanel 水平/垂直翻转 三个面板把字段行内的 `<label class="check-row">` 改为 `<label class="inline-check">`，文字不再被开关遮挡且自然一行展示。

### 2026-08-26 — 合并功能增强（展示选中信息/结果信息 + 编码可选）
- 涉及文件：`app.py`（`api_merge`）、`src/components/panels/MergePanel.tsx`、`src/api.ts`、`src/styles.css`

**后端**
- `/api/merge` 新增 `encode` 参数（`copy` / `reencode`，默认 `reencode`）：
  - `reencode`：重编码为 H.264+AAC，统一所有片段参数，不同源也能正确拼接（最稳，耗时略长）。
  - `copy`：`-c copy` 流拷贝，速度最快、零画质损失；要求所有源编码/分辨率/参数完全一致，否则拼接异常。
- 合并任务 extra 记录 `kind:"merge"`、`encode`、`count`、`files`。
- `_run_ffmpeg_locked` 在 `kind=="merge"` 完成时调用 `_record_split_result`，把输出文件的大小/编码/分辨率/时长写入任务，供前端展示处理后信息。

**前端**
- 合并顺序列表每行新增「文件信息」小标签：分辨率 · 时长 · 编码（来自上传时的 meta），直观看到各源是否一致。
- 新增「合并编码」单选：默认「重编码（兼容优先，推荐）」/「保留原编码（极速）」，提交时传给后端。
- 面板底部新增「合并结果」区：读取最新已完成合并任务，展示输出大小/编码/分辨率/时长/编码方式（复用 `.cc-params`）。
- `mergeVideos` 增加 `encode` 参数；新增 `.merge-list / .merge-name / .merge-meta` 样式。

---

## 已提交记录

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
