#!/bin/bash
# ClipBench 启动脚本
set -e

cd "$(dirname "$0")"

echo "📦 准备运行环境..."
if [ ! -d ".venv" ]; then
  echo "创建虚拟环境 .venv ..."
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
. .venv/bin/activate

if ! python -c "import flask" 2>/dev/null; then
  echo "安装依赖..."
  pip install -r requirements.txt
fi

# 若系统没有 ffmpeg，确保 imageio-ffmpeg 已被安装（提供开箱即用的静态二进制）
if ! command -v ffmpeg >/dev/null 2>&1; then
  if ! python -c "import imageio_ffmpeg" 2>/dev/null; then
    echo "检测到系统未安装 ffmpeg，安装 imageio-ffmpeg（自动附带静态二进制）..."
    pip install imageio-ffmpeg
  fi
fi

# 前端构建：用 pnpm 安装 Solid+Vite 依赖并构建到 dist/
if command -v pnpm >/dev/null 2>&1; then
  echo "📦 安装前端依赖 (pnpm)..."
  pnpm install --prefer-offline
  echo "🔨 构建前端 (vite build)..."
  pnpm run build
else
  echo "⚠️  未检测到 pnpm，跳过前端构建（将使用 static/ 旧前端）"
  echo "    安装 pnpm: npm i -g pnpm"
fi

echo "🚀 启动服务..."
PORT="${PORT:-8080}"
PORT=$PORT python app.py
