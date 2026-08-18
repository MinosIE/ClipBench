# ClipBench

一个基于本地 **ffmpeg** 的 Web UI 操作台，把常用的视频处理命令包装成可视化界面操作。纯本地运行，文件不上云。

## ✨ 功能

| 功能 | 说明 |
| --- | --- |
| 🧹 去字幕 | 在画面上框选字幕区域，智能修复 / 边缘修复 / 模糊 / 马赛克多种方式擦除，支持标准/高质量与修复强度调节 |
| ✂️ 拆分 | 按固定时长切分为多段 / 截取多个指定片段（可静音）/ 导出 GIF |
| 📸 截图 | 单张截图（指定时间点）或定时批量截图（每 N 秒一张），支持 JPG/PNG |
| 🔄 格式转换 | 转 MP4/MOV/MKV/WEBM/GIF，或提取音频 MP3/M4A，可指定编码与 CRF |
| 🗜️ 压缩 | 基于 H.264 + CRF 压缩，可选编码速度与分辨率上限（1080p/720p/480p） |
| 🖼️ 裁剪 | 在画面上拖拽框选保留区域，按像素坐标裁剪 |
| 🔗 合并 | 勾选多个文件按顺序拼接，可调整先后顺序 |
| 🔄 旋转/翻转 | 旋转 90/180/270° + 水平/垂直翻转 |
| 💧 水印 | 文字水印（位置/字号/颜色/透明度）或图片水印（自动缩放） |
| ⏩ 调速 | 任意倍速（0.25x~4x）+ 倒放（音视频同步） |

所有任务在后台异步执行，前端通过 **SSE 实时推送进度**，完成后可单文件下载或整体打包（ZIP）下载。

## 🚀 快速开始

```bash
git clone <your-repo-url>
cd clipbench
chmod +x start.sh
./start.sh
```

启动后浏览器打开：http://127.0.0.1:5000

`start.sh` 会：
1. 自动创建 `.venv` 虚拟环境并安装 Python 依赖；
2. 用 **pnpm** 安装前端依赖（`solid-js` + Vite）并执行 `pnpm run build`，将前端构建到 `dist/`；
3. **自动处理 ffmpeg**：若系统已安装则直接使用；若未安装，则通过 `imageio-ffmpeg` 自动下载一个静态二进制。

> 未安装 pnpm 时，`start.sh` 会跳过前端构建并提示，此时 Flask 会回退托管旧的 `static/` 原生 JS 前端（功能一致，但无编译时细粒度更新）。

## 🔧 关于 ffmpeg

本项目依赖 `ffmpeg` / `ffprobe`，但**不要求你提前安装**：

- **已安装系统 ffmpeg**：直接使用，性能最佳、功能最全。
- **未安装**：`start.sh` 自动 `pip install imageio-ffmpeg`，它会在首次运行时下载对应平台（macOS / Linux / Windows）的 ffmpeg 静态二进制并自动启用。

如需手动安装系统版本：

```bash
# macOS
brew install ffmpeg
# Debian/Ubuntu
sudo apt install ffmpeg
# Fedora
sudo dnf install ffmpeg
# Windows (scoop)
scoop install ffmpeg
```

## 🎨 前端架构（Solid + Vite）

前端采用 **SolidJS**（编译时细粒度响应式框架）+ **Vite** 构建，使用 **pnpm** 管理依赖：

- `src/`：TypeScript + TSX 源码
  - `App.tsx`：根组件，顶部品牌栏 + 左侧文件栏 + 主区 Tab 切换 + 任务列表 + 自定义弹框/Toast
  - `store.ts`：全局响应式状态（`createStore` 集中管理任务/文件/选中态）
  - `api.ts`：类型化的后端 API 客户端
  - `sse.ts`：EventSource 订阅 `/api/tasks/stream`，增量 patch 任务进度
  - `components/Sidebar.tsx`：文件列表、上传、缩略图、批量勾选与删除
  - `components/Workbench.tsx`：去字幕工作台（视频预览 + 多区域框选 + 时间轴 + 参数）
  - `components/Tasks.tsx`：任务列表（细粒度进度条，不重绘整列表）
  - `components/panels/*.tsx`：拆分/截图/转换/压缩/裁剪/合并/旋转/水印/调速 9 个功能面板
- `dist/`：Vite 生产构建产物（文件名带内容哈希，天然无缓存问题），由 Flask 直接托管
- `static/`：旧版原生 JS 前端（无 Vite 时的回退）

**细粒度更新优势**：任务进度变化时，Solid 编译时只更新对应进度条节点的 `style.width`，不再 `innerHTML` 重写整个任务列表，彻底消除浏览器 Elements 面板里的整体闪动。

### 开发模式

```bash
pnpm install
pnpm dev          # 启动 Vite dev server（默认 http://localhost:5173，代理 /api 到 Flask）
# 另开终端运行后端
source .venv/bin/activate && python app.py
```

### 生产构建

```bash
pnpm run build    # 输出到 dist/
```

Flask 的 `serve_static` 优先托管 `dist/`；无 `dist/` 时回退到 `static/`。

## 📁 目录结构

```
clipbench/
├── app.py              # Flask 后端（ffmpeg 任务封装 + API + dist 托管）
├── start.sh            # 启动脚本（环境/依赖/ffmpeg/前端构建 自动准备）
├── requirements.txt    # Python 依赖
├── package.json        # 前端依赖与脚本（pnpm）
├── vite.config.js      # Vite 配置（输出 dist/，dev 代理 /api）
├── tsconfig.json       # TypeScript 配置
├── src/                # 前端源码（Solid + TSX）
├── dist/               # Vite 构建产物（git 忽略）
├── node_modules/       # 前端依赖（git 忽略）
├── static/             # 旧版原生 JS 前端（回退用）
├── uploads/            # 上传的源文件
└── outputs/            # 处理输出文件
```

## 🛠 技术说明

- 后端通过 `subprocess` 调用 ffmpeg，并用 `-progress pipe:1` 解析实时进度，经 SSE 推送给前端。
- 文件大小上限默认 4GB（可在 `app.py` 的 `MAX_CONTENT_LENGTH` 调整）。
- 任务状态持久化在 `tasks.json`，重启服务后历史仍在。
- 可用环境变量 `PORT` 修改端口（默认 5000）。

## ❓ 常见问题

- **启动提示「未检测到 ffmpeg」**：按上方指引安装系统 ffmpeg，或确认 `imageio-ffmpeg` 已安装（`pip install imageio-ffmpeg`）。
- **浏览器报 "Failed to load module script: Expected a JavaScript ... but got text/html"**：旧构建哈希被缓存。清掉 `dist/` 重新 `pnpm run build`，并在浏览器硬刷新（Cmd/Ctrl+Shift+R）。生产模式下 `index.html` 已设 `no-cache`，缺失资源直接返回 404，不会误返 HTML。
- **上传大文件慢**：文件先写入 `uploads/`，再交由 ffmpeg 处理，纯本地产物，不上云。
- **某些格式转换失败**：容器与编码不兼容时会失败，可尝试指定 `libx264` + 目标格式，或查看任务列表中的错误输出。
