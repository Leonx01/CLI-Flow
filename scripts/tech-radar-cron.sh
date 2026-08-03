#!/bin/bash
# tech-stack-radar 定时运行包装脚本（供 crontab 调用）
#
# 为什么要包装脚本：cron 的环境极简 —— PATH 只有 /usr/bin:/bin，不会加载
# 你的 ~/.zshenv/~/.zshrc，也没有工作目录。所有依赖必须在这里显式兜住。
#
# 用法：
#   1. 把 DASHSCOPE_API_KEY 放进 ~/.config/tech-radar.env（见下），不要硬编进本脚本
#   2. chmod +x 本脚本
#   3. crontab -e 加入调度行（见文件末尾注释）

set -euo pipefail

# ── 环境 ──
export PATH="/opt/homebrew/bin:/usr/bin:/bin:$PATH"      # 让 cron 找得到 node
# PROJECT 由脚本自身位置推导（本脚本位于 <project>/scripts/），无硬编码路径
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"

# API key 从独立的 secrets 文件读取，不写进脚本本身（避免误提交/泄露）
# 创建方式：echo 'export DASHSCOPE_API_KEY=sk-你的key' > ~/.config/tech-radar.env && chmod 600 ~/.config/tech-radar.env
if [ -f "$HOME/.config/tech-radar.env" ]; then
  # shellcheck source=/dev/null
  . "$HOME/.config/tech-radar.env"
fi

cd "$PROJECT"

# ── 按日期分目录 + 分日志，避免每次覆盖 ──
STAMP="$(date +%Y-%m-%d)"
OUT_DIR="$PROJECT/output/tech-radar/$STAMP"
LOG_DIR="$PROJECT/output/tech-radar/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$STAMP.log"

echo "===== tech-stack-radar run @ $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$LOG"

# ── 运行 ──
# --auto-approve：无人值守自动应答（两个 multi-select 全选、confirm 门→true）
# -f json：机器可读输出，禁用 TUI
# 全部数据源走 public API，无浏览器步骤，无需 OPENCLI_BROWSER_COMMAND_TIMEOUT
node dist/cli/index.js run workflows/tech-stack-radar.yaml \
  --auto-approve -f json \
  --arg out_dir="$OUT_DIR" \
  >> "$LOG" 2>&1

CODE=$?
echo "exit=$CODE @ $(date '+%H:%M:%S')" >> "$LOG"
exit $CODE
