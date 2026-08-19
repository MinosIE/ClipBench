#!/bin/bash
# ClipBench 一键启动脚本
#
# 用法:
#   ./start.sh             快速启动（用已有 dist/，跳过前端构建）
#   ./start.sh --build     完整启动（安装依赖 + 重新构建前端）
#   ./start.sh -d          后台启动（日志写入 /tmp/clipbench.log）
#   ./start.sh -d --build  后台启动 + 完整构建
#
# 也可以: npm start / npm run start

set -e
cd "$(dirname "$0")"

BUILD=0
DAEMON=0
for arg in "$@"; do
  case "$arg" in
    --build|-b) BUILD=1 ;;
    --daemon|-d) DAEMON=1 ;;
    *)
      echo "未知参数: $arg"
      echo "支持: --build(-b) 重新构建前端 | --daemon(-d) 后台运行"
      exit 1
      ;;
  esac
done

# ---- 后端环境 ----
if [ ! -d ".venv" ]; then
  echo "📦 首次运行：创建虚拟环境 .venv ..."
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
. .venv/bin/activate

if ! python -c "import flask" 2>/dev/null; then
  echo "📦 安装后端依赖..."
  pip install -r requirements.txt
fi

# 系统没有 ffmpeg 时，用 imageio-ffmpeg 提供的静态二进制兜底
if ! command -v ffmpeg >/dev/null 2>&1; then
  if ! python -c "import imageio_ffmpeg" 2>/dev/null; then
    echo "📦 安装 imageio-ffmpeg（自动附带 ffmpeg 静态二进制）..."
    pip install imageio-ffmpeg
  fi
fi

# ---- 前端构建（dist/ 不存在 或 显式 --build 时执行）----
if [ "$BUILD" = "1" ] || [ ! -d "dist" ]; then
  if command -v pnpm >/dev/null 2>&1; then
    echo "🔨 构建前端 (vite build)..."
    pnpm install --prefer-offline
    pnpm run build
  else
    echo "⚠️  未检测到 pnpm，跳过前端构建"
    echo "    安装 pnpm: npm i -g pnpm"
  fi
else
  echo "⚡ 使用已有 dist/（跳过前端构建；--build 可强制重新构建）"
fi

# ---- 启动 ----
PORT="${PORT:-8080}"
if [ "$DAEMON" = "1" ]; then
  nohup python app.py > /tmp/clipbench.log 2>&1 &
  echo "🚀 服务已后台启动: http://127.0.0.1:$PORT （日志: /tmp/clipbench.log）"
else
  echo "🚀 启动服务: http://127.0.0.1:$PORT （Ctrl+C 停止）"
  exec python app.py
fi
