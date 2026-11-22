@echo off
chcp 65001 >nul
title ComfyUI 无限画布 - 一键启动
cd /d "%~dp0"

echo ============================================
echo   ComfyUI 无限画布 一键启动
echo ============================================
echo.

REM 检查 Node
if not exist "%~dp0node\node.exe" (
    echo [错误] 未找到 node\node.exe，请确认 Node 已放在项目根目录
    pause
    exit /b 1
)

REM 1. 启动 ComfyUI（如果 8188 没在跑）
echo [1/3] 检查 ComfyUI (8188)...
curl -s -o nul -w "%%{http_code}" http://127.0.0.1:8188/system_stats > %TEMP%\comfy_check.txt 2>nul
set /p COMFY_CODE=< %TEMP%\comfy_check.txt
if "%COMFY_CODE%"=="200" (
    echo       ComfyUI 已在运行，跳过
) else (
    echo       启动 ComfyUI（8GB 显存用 lowvram 模式，图片和视频通用）...
    start "ComfyUI" /D "D:\ComfyUI-Easy\ComfyUI_windows_portable" cmd /c "python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --port 8188 --listen 127.0.0.1 --lowvram"
    echo       等待 ComfyUI 就绪（约 40 秒，加载 1600+ 节点）...
    timeout /t 30 /nobreak >nul
)

REM 2. 启动网关
echo [2/3] 启动网关 (8190)...
start "画布网关" /D "%~dp0" cmd /c ""%~dp0node\node.exe" gateway\server.js"
timeout /t 2 /nobreak >nul

REM 3. 启动画布
echo [3/3] 启动画布 (3000)...
start "无限画布" /D "%~dp0" cmd /c ""%~dp0node\node.exe" gateway\serve-canvas.js"
timeout /t 2 /nobreak >nul

echo.
echo ============================================
echo   全部就绪！
echo   画布地址: http://127.0.0.1:3000
echo   网关地址: http://127.0.0.1:8190
echo.
echo   首次使用请在画布右上角「配置 - 渠道」里填：
echo   Base URL: http://127.0.0.1:8190/v1
echo   API Key : 随便填（本地不校验）
echo   模型名  : image-qwen21（图片）/ video-minimax-h3（视频）
echo ============================================
echo.
start "" http://127.0.0.1:3000
pause
