# ClipBench

一个基于本地 **ffmpeg** 的 Web UI 操作台，把常用的视频处理命令包装成可视化界面操作。纯本地运行，文件不上云。

## ✨ 功能

| 功能 | 说明 |
| --- | --- |
| ✂️ 拆分 | 按固定时长切分为多段 / 截取多个指定片段（可静音）/ 导出 GIF |
| 📸 截图 | 单张截图（指定时间点）或定时批量截图（每 N 秒一张） |
| 🔄 格式转换 | 转 MP4/MOV/MKV/AVI/WEBM/GIF，或提取音频 MP3/M4A/WAV，可指定编码与 CRF |
| 🗜️ 压缩 | 基于 H.264 + CRF 压缩，可选编码速度与分辨率上限 |
| 🖼️ 裁剪 | 按像素坐标裁剪画面区域 |
| 🔗 合并 | 按顺序拼接多个视频 |
| 🔄 旋转/翻转 | 旋转 90/180/270° + 水平/垂直翻转 |
| 💧 水印 | 文字水印（位置/字号/颜色/透明度）或图片水印（自动缩放） |
| ⏩ 调速 | 任意倍速 + 倒放（音视频同步） |

所有任务在后台异步执行，前端实时显示进度，完成后可单文件下载或整体打包（ZIP）下载。

## 🚀 快速开始

```bash
git clone <your-repo-url>
cd clipbench
chmod +x start.sh
./start.sh
```

启动后浏览器打开：http://127.0.0.1:5000

`start.sh` 会：
1. 自动创建 `.venv` 虚拟环境并安装依赖；
2. **自动处理 ffmpeg**：若系统已安装则直接使用；若未安装，则通过 `imageio-ffmpeg` 自动下载一个静态二进制，克隆后即可直接运行，无需手动安装。

## 🔧 关于 ffmpeg

本项目依赖 `ffmpeg` / `ffprobe`，但**不要求你提前安装**：

- **已安装系统 ffmpeg**：直接使用，性能最佳、功能最全。
- **未安装**：`start.sh` 自动 `pip install imageio-ffmpeg`，它会在首次运行时下载对应平台（macOS / Linux / Windows）的 ffmpeg 静态二进制并自动启用。后端也会优先检测系统 ffmpeg，找不到时回退到该二进制。

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

## 📁 目录结构

```
clipbench/
├── app.py              # Flask 后端（ffmpeg 任务封装 + API）
├── start.sh            # 启动脚本（含环境/依赖/ffmpeg 自动准备）
├── requirements.txt    # Python 依赖
├── static/             # 前端 UI（index.html / style.css / app.js）
├── uploads/            # 上传的源文件
└── outputs/            # 处理输出文件
```

## 🛠 技术说明

- 后端通过 `subprocess` 调用 ffmpeg，并用 `-progress pipe:1` 解析实时进度。
- 文件大小上限默认 4GB（可在 `app.py` 的 `MAX_CONTENT_LENGTH` 调整）。
- 任务状态持久化在 `tasks.json`，重启服务后历史仍在。
- 可用环境变量 `PORT` 修改端口（默认 5000）。

## ❓ 常见问题

- **启动提示「未检测到 ffmpeg」**：按上方指引安装系统 ffmpeg，或确认 `imageio-ffmpeg` 已安装（`pip install imageio-ffmpeg`）。
- **上传大文件慢**：文件先写入 `uploads/`，再交由 ffmpeg 处理，纯本地产物，不上云。
- **某些格式转换失败**：容器与编码不兼容时会失败，可尝试指定 `libx264` + 目标格式，或查看任务列表中的错误输出。
