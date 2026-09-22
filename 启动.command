#!/bin/bash
# 双击本文件即可启动「苏州中考英语作文批改平台」
# 若双击没反应，请打开「终端」执行（把路径换成实际路径）：
#   bash "/Users/你的用户名/作文批改平台（Teacher_Tony）/启动.command"

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1
SELF="$DIR/启动.command"

say() { echo "  $1"; }
pause_exit() { echo ""; read -r -p "  按回车键关闭窗口…"; exit "${1:-0}"; }

echo ""
echo "  ════════════════════════════════════════════"
echo "   苏州中考英语作文批改平台"
echo "  ════════════════════════════════════════════"
say "位置：$DIR"
echo ""

# ── 1. 可执行权限（从微信 / U 盘 / Windows 解压过来常会丢）───────────
if [ ! -x "$SELF" ]; then
  chmod +x "$SELF" 2>/dev/null
  say "已修复文件的执行权限。"
fi

# ── 2. 隔离属性（经网络传输的文件会被 macOS 打上，导致无法双击）───────
if command -v xattr >/dev/null 2>&1; then
  if xattr -p com.apple.quarantine "$SELF" >/dev/null 2>&1 \
     || xattr -p com.apple.quarantine "$DIR/server.js" >/dev/null 2>&1; then
    say "检测到 macOS「隔离」标记，正在移除…"
    xattr -dr com.apple.quarantine "$DIR" 2>/dev/null
    say "已移除，以后双击可直接打开。"
  fi
fi

# ── 3. 所在位置是否会被系统隐私保护拦截 ─────────────────────────────
case "$DIR" in
  "$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Downloads"*)
    say "注意：文件夹在「桌面 / 文稿 / 下载」里，macOS 会要求授权才能读写。"
    say "      首次启动若弹出授权窗口，请点「允许」。"
    say "      若已误点「不允许」，去 系统设置 › 隐私与安全性 › 文件与文件夹，"
    say "      给「终端」勾上对应文件夹；或直接把本文件夹移到个人文件夹下。"
    echo ""
    ;;
esac

# ── 4. 数据目录可写性自检（权限问题的症状都出在这里）─────────────────
mkdir -p "$DIR/data" 2>/dev/null
if ! ( : > "$DIR/data/.write_test" ) 2>/dev/null; then
  echo "  ✗ 无法写入 data 目录 —— 这是权限问题，不是程序出错。"
  echo ""
  echo "    解决办法（任选一种）："
  echo "      1. 把整个「作文批改平台（Teacher_Tony）」文件夹拖到个人文件夹里"
  echo "         （访达 › 前往 › 个人），再重新双击本文件"
  echo "      2. 系统设置 › 隐私与安全性 › 文件与文件夹 › 终端，勾上「桌面」"
  echo ""
  pause_exit 1
fi
rm -f "$DIR/data/.write_test" 2>/dev/null
say "数据目录可读写 ✓"

# ── 5. 找 Node.js ────────────────────────────────────────────────
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/current/bin:$PATH"

find_node() {
  # 本机打包进来的 Node（如果有）
  for p in "./node/bin/node" "./runtime/node/bin/node"; do
    [ -x "$p" ] && { echo "$(cd "$(dirname "$p")" && pwd)/node"; return; }
  done
  # 系统里常见的位置（Apple 芯片 Homebrew / Intel Homebrew / 官方安装包）
  for p in \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node" \
    "/usr/bin/node" ; do
    [ -x "$p" ] && { echo "$p"; return; }
  done
  # nvm / volta / asdf 装的 Node
  for p in "$HOME"/.nvm/versions/node/*/bin/node \
           "$HOME"/.volta/bin/node \
           "$HOME"/.asdf/shims/node ; do
    [ -x "$p" ] && { echo "$p"; return; }
  done
  # 交给 PATH 找
  command -v node 2>/dev/null
}

NODE_BIN="$(find_node)"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "  ✗ 没有找到 Node.js，无法启动。"
  echo ""
  echo "    解决办法（任选一种）："
  echo "      1. 到 https://nodejs.org 下载 LTS 版安装，装完重新双击本文件"
  echo "      2. 装了 Homebrew 的话，在终端执行：brew install node"
  echo ""
  echo "    本平台不依赖任何第三方库，只要有 Node.js 就能跑。"
  pause_exit 1
fi
say "Node.js ✓"
echo ""
say "正在启动……浏览器会自动打开"
say "用完在本窗口按 Ctrl + C 关闭服务"
echo ""

"$NODE_BIN" server.js

echo ""
read -r -p "  服务已停止，按回车键关闭窗口…"
