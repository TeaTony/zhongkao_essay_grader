@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "HERE=%~dp0"

echo.
echo   ================================================
echo    苏州中考英语作文批改平台
echo   ================================================
echo   位置：%HERE%
echo.

rem ── 1. 解除「来自网络」的封锁（外来的 .bat 会被 Windows 标记）──
powershell -NoProfile -Command "if (Get-Item -LiteralPath '%HERE%启动.bat' -Stream Zone.Identifier -ErrorAction SilentlyContinue) { Get-ChildItem -LiteralPath '%HERE%' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue; Write-Host '  已解除文件的网络封锁标记。' }" >nul 2>nul

rem ── 2. 数据目录可写性自检 ──
if not exist "%HERE%data" mkdir "%HERE%data" 2>nul
echo test> "%HERE%data\.write_test" 2>nul
if not exist "%HERE%data\.write_test" (
  echo   x 无法写入 data 目录，这是权限问题，不是程序出错。
  echo.
  echo     解决办法：
  echo       把整个「作文批改平台（Teacher_Tony）」文件夹移到「文档」或「桌面」下你自己的目录里
  echo       ^(不要放在 C:\Program Files、C:\Windows 这类系统目录^)，再重新双击本文件。
  echo.
  pause
  exit /b 1
)
del "%HERE%data\.write_test" >nul 2>nul
echo   数据目录可读写 OK
echo.

rem ── 3. 找 Node.js ──
where node >nul 2>nul
if errorlevel 1 (
  echo   x 没有找到 Node.js，无法启动。
  echo.
  echo     解决办法：
  echo       1. 到 https://nodejs.org 下载 LTS 版安装，装完重新双击本文件
  echo       2. 装完如果还是提示找不到，重启一次电脑再试
  echo.
  echo     本平台不依赖任何第三方库，只要有 Node.js 就能跑。
  echo.
  pause
  exit /b 1
)

echo   正在启动……浏览器会自动打开
echo   用完在本窗口按 Ctrl + C 关闭服务
echo.
node server.js
echo.
pause
