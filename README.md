# ClipBench

[English](README_EN.md) | 简体中文

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg) ![Python](https://img.shields.io/badge/python-3.10%2B-blue) ![ffmpeg](https://img.shields.io/badge/ffmpeg-required-orange) ![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)

本地视频处理工具箱 —— 基于 Flask + ffmpeg 的后端与 SolidJS + Vite 的前端，提供**去字幕、拆分、截图、格式转换、压缩、裁剪、合并、旋转、水印、调速、音频提取** 11 个常用功能。所有处理都在本机完成，不上传任何数据。

> English: A self-hosted **video toolbox** powered by ffmpeg — **video compressor**, **hardsub / subtitle remover**, **ffmpeg GUI**, video transcoding, cutting, merging, watermarking and more. Everything runs locally, nothing is uploaded.

`视频压缩` `去硬字幕` `ffmpeg GUI` `视频转码` `批量视频处理` `自托管` · `video-compression` `subtitle-removal` `ffmpeg-gui` `video-transcoding` `video-cutter` `self-hosted` `flask` `solidjs`

- 端口：**8080**（可用 `PORT` 环境变量修改；默认避开 macOS AirPlay 占用的 5000 端口）
- 语言：Python 3.10+ / TypeScript
- 运行方式：直接 `start.sh` 一键启动，自动创建虚拟环境、安装依赖、构建前端并启动服务

---

## 功能一览

| 模块 | 说明 | 关键参数 |
| --- | --- | --- |
| 去字幕 | 移除视频中的硬字幕区域，支持 4 种模式 | 模式：边缘修复 delogo / 模糊 / 马赛克 / 内容感知修复 inpaint；区域选择：整行 / 指定顶部、底部高度；CPU 密集任务**串行排队**执行（inpaint 互斥闸门，避免并发饿死） |
| 拆分 | 按固定时长或自定义片段拆分，可输出 GIF | 拆分模式：按时长 / 按片段；片段时间轴输入；目标格式：mp4 / gif；编码方式：重编码 H.264（默认，段首强制关键帧避免黑屏）/ 保留原编码（极速无损） |
| 截图 | 单帧截图或按固定间隔批量截帧 | 时间点 / 间隔秒数；输出 jpg / png / webp / avif |
| 格式转换 | 任意格式互转，支持 mp4 / mkv / webm / mov / avi / gif 等 | 目标格式；可选：重编码开关 + CRF 画质档位、音频开关、`-movflags +faststart` 快速启动（便于网页播放） |
| 压缩 | 压缩体积，**自动识别源编码** | 源为 H.264 → `libx264` + CRF 自适应；源为 HEVC/H.265 → `libx265` + 自适应 CRF（保留 HDR10+ 与 master-display 元数据，兼容字幕烧录等场景）；可选分辨率缩放（不缩放 / 720p / 480p / 360p）、视频/音频码率、`+faststart` |
| 裁剪 | 在预览图上拖拽选区裁剪，支持自定义区域 | 选区 / 固定尺寸 16:9、9:16、1:1、4:3 |
| 合并 | 2 个及以上视频按顺序拼接 | 编码：H.264（默认，兼容最好）/ HEVC（体积更小）/ 保留原编码（copy，极速零损，要求各源参数一致，前端预检不通过不发请求） |
| 旋转 | 旋转 + 水平/垂直翻转，可预览 | 90° / 180° / 270° / 水平翻转 / 垂直翻转 |
| 水印 | 文字或图片水印，5 个角位 + 缩放 + 透明度 | 类型：文字 / 图片（支持 PNG 等透明图）；位置：左上/右上/左下/右下/居中；文字字号、颜色、描边；图片缩放比、透明度 |
| 调速 | 0.5x–4x 变速，支持倒放 | 速度（0.5–4.0，步进 0.1）；倒放开关 |
| 音频提取 | 提取视频音轨或转码纯音频，导出 mp3 / m4a / wav / flac | 格式；码率（mp3/m4a：128k / 192k / 320k；wav/flac 无损无码率） |

### 输出文件名模板

侧栏底部可设置全局输出文件名模板，所有任务产物命名都会套用。支持占位符：

| 占位符 | 含义 | 示例 |
| --- | --- | --- |
| `{name}` | 源文件名（不含扩展名） | `demo` |
| `{ext}` | 扩展名（含点） | `.mp4` |
| `{ts}` | Unix 时间戳 | `1787801543` |
| `{date}` | 日期 | `20260827` |
| `{time}` | 时分秒 | `113200` |

留空则回退默认模板 `{name}_{ts}{ext}`（如 `demo_1787801543.mp4`）。模板支持中文描述（如 `{name}_去字幕{ext}`），仅禁止路径穿越字符。

### 产物回流到媒体列表

任务完成后产物**不会**自动进入左侧媒体文件列表。在任务列表中，已完成且产物为**单文件视频**的任务会显示「添加」按钮，点击后产物出现在左侧（带「产物」徽标），可直接继续二次处理；点媒体文件卡片上的 ✕ 可删除该产物文件。任务卡片会展示产物大小、编码与分辨率。

### 右侧媒体信息卡片

文件详情卡片会实时展示由 ffprobe 探测到的媒体信息，其中：

- **编码信息**：视频编码显示为 `H.264 (h264)` / `HEVC (hevc)` 等编码标签，供压缩、转码前判断源编码；
- 分辨率、时长、帧率、码率、文件大小、音频信息（编码/声道/采样率）等。

---

## 技术栈

- **前端**：SolidJS + Vite + TypeScript；细粒度响应式（`createStore`），内联 SVG 图标，无路由单页应用
- **后端**：Flask，本地文件系统存储，`tasks.json` 持久化任务列表
- **媒体处理**：`ffmpeg` / `ffprobe`（优先使用系统安装；未安装时自动回退到 `imageio-ffmpeg` 附带的静态二进制，开箱即用）
- **内容感知修复**：OpenCV（`cv2.inpaint`）用于去字幕 inpaint 模式
- **实时进度**：后端 SSE（Server-Sent Events）流式推送任务进度，前端通过 `EventSource` 监听

---

## 快速开始

```bash
# 一键启动（自动完成：venv + pip 依赖 + pnpm 前端构建 + 启动服务）
./start.sh

# 打开浏览器访问
open http://localhost:8080
```

### 手动启动（开发模式）

```bash
# 1. 后端依赖
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# 2. 前端：开发模式（热更新，端口 5173，需 CORS 已配置）
pnpm install
pnpm dev          # 或 pnpm build 生产构建到 dist/

# 3. 启动后端（生产模式下托管 dist/ 构建产物）
python app.py
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 服务监听端口 |
| `FFMPEG_PATH` | 自动探测 | 指定 ffmpeg 可执行文件路径 |
| `FFPROBE_PATH` | 自动探测 | 指定 ffprobe 可执行文件路径 |
| `CLIPBENCH_FFMPEG_SLOTS` | 逻辑核心数的一半（至少 1） | ffmpeg 任务并发数；设为 `1` 即完全串行 |

---

## API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/files` | 列出已上传文件及其媒体信息（含编码、分辨率、时长等） |
| POST | `/api/upload` | 上传媒体文件（表单字段 `file`；单文件上限 4GB） |
| POST | `/api/delete_uploads` | 按文件名批量删除上传文件（防目录穿越） |
| POST | `/api/desubtitle` | 去字幕：`{file_id, mode, x, y, w, h, quality?, radius?, strength?}`（`mode`：`delogo` 边缘修复 / `blur` 模糊 / `mosaic` 马赛克 / `inpaint` 内容感知修复） |
| POST | `/api/split` | 拆分：`{file_id, mode, segment?, segments?, start?, end?, output?, encode?, mute?, gif_fps?, gif_width?}`（`mode`：`segment` 按时长 / `time` 按片段；`output`：`video` / `gif`；`encode`：`reencode` 重编码 H.264 默认 / `copy` 保留原编码） |
| POST | `/api/screenshot` | 截图：`{file_id, mode, time?, interval?, format?}`（`mode`：`single` 单张 / `every` 按间隔；`format`：jpg / png / webp / avif） |
| POST | `/api/convert` | 转码：`{file_id, target, crf?, vcodec?, faststart?}`（`target`：mp4 / mkv / webm / mov / avi / gif 等；gif / webm 或传 `crf` 时强制重编码） |
| POST | `/api/compress` | 压缩：`{file_id, preset?, crf?, scale?, vcodec?, faststart?}`（自动选择 x264/x265；`preset`：veryslow → veryfast；`scale`：original / 1080 / 720 / 480；`vcodec`：h264 / hevc） |
| POST | `/api/compress_suggest` | 压缩智能建议：`{file_id, vcodec}` → 推荐 CRF、分辨率与预估体积（前端智能建议的唯一权威来源） |
| POST | `/api/crop` | 裁剪：`{file_id, x, y, w, h, faststart?}` |
| POST | `/api/merge` | 合并：`{file_ids, encode?, faststart?}`（≥2 个；`encode`：`h264` 默认 / `hevc` / `copy` 保留原编码，copy 要求各源参数一致） |
| POST | `/api/rotate` | 旋转/翻转：`{file_id, rotation, flip_h?, flip_v?, faststart?}`（`rotation`：0 / 90 / 180 / 270） |
| POST | `/api/watermark` | 水印：`{file_id, type, position, text?, fontsize?, color?, alpha?, watermark_id?, scale_w?, margin?, faststart?}`（`type`：text / image；`position`：tl / tr / bl / br / c） |
| POST | `/api/upload_watermark` | 上传水印图片，返回 `watermark_id` |
| POST | `/api/speed` | 调速：`{file_id, speed, reverse?, faststart?}`（`speed`：0.5–4.0） |
| POST | `/api/extract_audio` | 音频提取：`{file_id, format, bitrate?}`（`format`：mp3 / m4a / wav / flac；源可来自上传或输出目录） |
| GET | `/api/tasks` | 所有任务及状态 |
| GET | `/api/tasks/stream` | SSE：任务状态实时推送 |
| GET | `/api/task/<task_id>` | 单个任务详情（未找到返回 404） |
| POST | `/api/task/<task_id>/cancel` | 取消运行中的任务 |
| POST | `/api/task/<task_id>/delete` | 删除任务并清理输出 |
| POST | `/api/tasks/delete` | 批量删除任务（运行中先取消，需 `task_ids` 列表） |
| GET | `/api/version` | 服务与 ffmpeg/ffprobe 版本信息 |
| GET | `/api/download/<file_id>` | 下载输出文件 |
| GET | `/api/download_dir/<task_id>` | 多文件产物打包下载（zip） |
| GET | `/media/<path>` | 预览媒体文件 |
| GET | `/api/file/<file_id>` / `/api/thumbnail/<file_id>` / `/api/frame/<file_id>` | 文件详情 / 首帧缩略图 / 抽帧 |

> 所有任务创建接口均支持可选参数 `filename_template`，用于自定义产物文件名（见下方「输出文件名模板」一节）。

任务字段：`task_id`、`name`（功能名）、`kind`（compress / split / merge 等）、`status`（queued / running / finished / failed / cancelled）、`progress`（0–100）、`duration`、`elapsed`、`output_name` / `output_dir`、`out_size` / `out_size_human`（产物大小）、`out_codec` / `out_resolution`、`out_count`、`error`、`log`、`created_at` 等。

---

## 目录结构

```
clipbench/
├── app.py                 # Flask 后端：全部 API + ffmpeg 任务队列
├── detect_subtitle.py     # 字幕区域自动检测
├── desub_inpaint.py       # 内容感知修复（cv2.inpaint）实现
├── requirements.txt       # Python 依赖（Flask、imageio-ffmpeg）
├── requirements-dev.txt   # 测试依赖（pytest）
├── start.sh               # 一键启动脚本
├── package.json           # 前端依赖与构建脚本
├── vite.config.js         # Vite 配置
├── LICENSE                # MIT 许可证
├── llms.txt               # 供 AI 引擎抓取的项目摘要（llmstxt.org 标准）
├── src/                   # SolidJS + TypeScript 前端
│   ├── App.tsx            # 应用入口 / Tab 布局
│   ├── store.ts           # 全局状态（文件列表、任务、Tab 定义）
│   ├── api.ts             # 后端 API 封装
│   ├── sse.ts             # SSE 进度订阅
│   ├── addedOutputs.ts    # 已添加产物集合（localStorage 持久化）
│   ├── filenameTemplate.ts # 全局输出文件名模板（localStorage 持久化）
│   ├── components/        # Sidebar、Workbench、panels/（11 个功能面板）
│   └── styles.css         # 全部样式（暗色主题）
├── static/                # 静态资源（favicon 等）
├── uploads/               # 上传文件目录（运行时自动创建）
├── outputs/               # 处理产物目录（运行时自动创建）
├── tasks.json             # 任务持久化（运行时自动生成）
└── tests/                 # 自动化测试（pytest）+ 手工测试清单
```

---

## 关键设计

- **编码信息展示**：`/api/files` 返回 ffprobe 探测的 `video_codec`（小写 `h264` / `hevc` 等），前端媒体卡片用编码标签高亮展示，方便转码/压缩前判断源编码。
- **HEVC 智能压缩**：压缩时自动读取源编码 —— H.264 源走 `libx264`，HEVC 源走 `libx265` 并保留 `hdr10_plus`、`master_display` 等元数据；CRF 根据源编码自动选取合理初始值。
- **快速启动（faststart）**：转码/压缩可选 `-movflags +faststart`，将 moov 元数据前置，便于浏览器边下边播。
- **SSE 实时进度**：后端每个任务以固定间隔向 `/api/tasks/stream` 广播状态与进度；任务并行执行，由守护线程轮询收集结果。
- **inpaint 互斥闸门**：内容感知修复为 CPU + 磁盘 IO 密集操作，同一时间只允许 1 个任务执行，其余排队，避免并发互相饿死。
- **任务生命周期**：`tasks.json` 持久化；支持取消运行中任务（terminate 子进程）、删除任务并清理输出；启动时自动扫描孤任务。
- **安全**：文件名校验扩展名白名单、路径防目录穿越（`secure_filename` + 路径归一化校验）、上传大小限制 4GB。

---

## 测试

### 自动化测试（pytest）

```bash
. .venv/bin/activate
pip install -r requirements-dev.txt

# 运行全部测试
python -m pytest tests/ -v

# 只跑 API 集成测试（需要可用的 ffmpeg，失败时自动 skip）
python -m pytest tests/test_app.py -v
```

覆盖范围：`tests/test_app.py` 包含——

- **单元测试**：文件大小格式化、时间解析、片段校验、扩展名白名单、faststart 逻辑等纯函数；
- **API 测试**（Flask test client，隔离的临时目录）：文件列表、上传/删除、版本探测、11 个功能的参数校验、任务查询/取消/删除、SSE 流、下载 404；
- **端到端流程**：上传样例视频 → 拆分 → 等待任务成功 → 校验输出文件（缺少 ffmpeg 时自动跳过）。

### 手工测试清单

见 [`tests/manual-test.md`](tests/manual-test.md)，覆盖 11 个功能面板的 UI 与完整操作流程、SSE 进度、编码信息展示等。

---

## 常见问题

- **为什么端口是 8080 而不是 5000？** macOS 上 5000 常被 AirPlay Receiver 占用，故默认使用 8080，可用 `PORT=9000 python app.py` 自定义。
- **没有安装 ffmpeg 能用吗？** 可以。依赖中包含 `imageio-ffmpeg`，后端自动使用其附带的静态 ffmpeg/ffprobe 二进制；如系统已安装则优先使用系统版本。
- **前端不生效 / 页面是旧版？** 开发模式请运行 `pnpm dev` 并确保后端已启动；生产模式需执行 `pnpm build` 生成 `dist/`，后端会托管该构建产物。

---

## 许可证

本项目基于 [MIT](LICENSE) 许可证开源 —— © 2026 yuxing.wang

可自由使用、复制、修改、合并、发布、分发、再许可及出售副本（含商业用途），只需保留版权与许可声明。软件按「原样」提供，不含任何明示或默示的担保。
