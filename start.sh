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
#
# 输出颜色：仅在终端（TTY）下启用；重定向到文件或设置 NO_COLOR=1 时自动关闭。

set -e
cd "$(dirname "$0")"

# ---- 颜色（TTY 检测，避免日志文件混入 ANSI 转义序列）----
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_KEY=$'\033[36m'    # 青：步骤 / 关键动作
  C_OK=$'\033[32m'     # 绿：成功
  C_WARN=$'\033[33m'   # 黄：警告
  C_ERR=$'\033[31m'    # 红：错误
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_KEY=""; C_OK=""; C_WARN=""; C_ERR=""
fi

BUILD=0
DAEMON=0
for arg in "$@"; do
  case "$arg" in
    --build|-b) BUILD=1 ;;
    --daemon|-d) DAEMON=1 ;;
    *)
      echo "${C_ERR}✘ 未知参数: $arg${C_RESET}"
      echo "${C_DIM}  支持: --build(-b) 重新构建前端 | --daemon(-d) 后台运行${C_RESET}"
      exit 1
      ;;
  esac
done

# ---- 后端环境 ----
if [ ! -d ".venv" ]; then
  echo "${C_KEY}📦 首次运行：创建虚拟环境 .venv ...${C_RESET}"
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
. .venv/bin/activate

if ! python -c "import flask" 2>/dev/null; then
  echo "${C_KEY}📦 安装后端依赖...${C_RESET}"
  pip install -r requirements.txt
fi

# 系统没有 ffmpeg 时，用 imageio-ffmpeg 提供的静态二进制兜底
if ! command -v ffmpeg >/dev/null 2>&1; then
  if ! python -c "import imageio_ffmpeg" 2>/dev/null; then
    echo "${C_KEY}📦 安装 imageio-ffmpeg（自动附带 ffmpeg 静态二进制）...${C_RESET}"
    pip install imageio-ffmpeg
  fi
fi

# ---- 前端构建（dist/ 不存在 或 显式 --build 时执行）----
if [ "$BUILD" = "1" ] || [ ! -d "dist" ]; then
  if command -v pnpm >/dev/null 2>&1; then
    echo "${C_KEY}🔨 构建前端 (vite build)...${C_RESET}"
    pnpm install --prefer-offline
    pnpm run build
    echo "${C_OK}✔ 前端构建完成${C_RESET}"
  else
    echo "${C_WARN}⚠️  未检测到 pnpm，跳过前端构建${C_RESET}"
    echo "${C_DIM}    安装 pnpm: npm i -g pnpm${C_RESET}"
    echo "${C_DIM}    未构建时页面将无法正常显示，请安装后执行: ./start.sh --build${C_RESET}"
  fi
else
  echo "${C_DIM}⚡ 使用已有 dist/（跳过前端构建；--build 可强制重新构建）${C_RESET}"
fi

# ---- 端口预检 ----
# 不做这步的话，用户只会看到 Flask 的英文堆栈 + pnpm 的 "ELIFECYCLE Command failed
# with exit code 1"，看不出真正原因就是端口被占用。
PORT="${PORT:-8080}"
if command -v lsof >/dev/null 2>&1 && lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "${C_ERR}✘ 启动失败：端口 ${PORT} 已被占用${C_RESET}"
  echo "${C_DIM}   占用进程 PID: $(lsof -ti:"$PORT" | tr '\n' ' ')${C_RESET}"
  echo "${C_DIM}   解决方式（任选其一）:${C_RESET}"
  echo "${C_DIM}     · 停止占用进程: lsof -ti:${PORT} | xargs kill${C_RESET}"
  echo "${C_DIM}     · 或换个端口启动: PORT=9000 ./start.sh${C_RESET}"
  echo "${C_DIM}     · 若 ClipBench 已在运行，直接访问 http://127.0.0.1:${PORT}${C_RESET}"
  exit 1
fi

# ---- 启动 ----
if [ "$DAEMON" = "1" ]; then
  nohup python app.py > /tmp/clipbench.log 2>&1 &
  echo "${C_OK}${C_BOLD}🚀 ClipBench 已后台启动${C_RESET} ${C_BOLD}http://127.0.0.1:${PORT}${C_RESET}"
  echo "${C_DIM}   日志: /tmp/clipbench.log${C_RESET}"
  echo "${C_DIM}   停止: lsof -ti:${PORT} | xargs kill${C_RESET}"
else
  echo "${C_OK}${C_BOLD}🚀 启动 ClipBench: ${C_OK}http://127.0.0.1:${PORT}${C_RESET} ${C_DIM}（Ctrl+C 停止）${C_RESET}"
  exec python app.py
fi
