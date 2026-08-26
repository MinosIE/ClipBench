# 改动日志（CHANGELOG）

> **约定**：每次对代码做出改动后，先把改动内容总结到本文档（见「待提交改动」一节），
> 提交时直接对照本文档编写 commit message 即可，无需再逐文件回忆。
> 提交完成后，把对应内容从「待提交改动」移到「已提交记录」并按提交哈希归档。

---

## 待提交改动

（无）

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
