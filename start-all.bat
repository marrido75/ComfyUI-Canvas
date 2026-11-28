@echo off
chcp 65001 >nul
title ComfyUI 无限画布 - 统一控制台
cd /d "%~dp0"

echo ============================================
echo   ComfyUI 无限画布 - 统一控制台
echo ============================================
echo.

REM 检查 Node
if not exist "%~dp0node\node.exe" (
    echo [错误] 未找到 node\node.exe，请确认 Node 已放在项目根目录
    pause
    exit /b 1
)

if not exist "%~dp0gateway\console.js" (
    echo [错误] 未找到 gateway\console.js
    pause
    exit /b 1
)

REM 单窗口启动：ComfyUI / 网关 / 画布 全部作为后台子进程
REM 快捷键：0/A 全部日志  1/2/3 筛选  R 重启  S 停止  B 浏览器  H 帮助  Q 退出
"%~dp0node\node.exe" "%~dp0gateway\console.js" %*

if errorlevel 1 (
    echo.
    echo [错误] 控制台异常退出，请查看上方日志
    pause
)
