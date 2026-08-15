@echo off
chcp 65001 >nul
REM ========================================
REM  DSH 客户端一键编译+发布（通用版）
REM  默认源码目录 %USERPROFILE%\dsh-nim（可用环境变量 NIM_SRC 覆盖）
REM ========================================
setlocal
if "%NIM_SRC%"=="" set NIM_SRC=%USERPROFILE%\dsh-nim
set DEST=%USERPROFILE%\Desktop\DSH-Pet-Client

echo [1/4] 关闭旧客户端进程...
taskkill /IM dsh_client_full.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/4] 编译（%NIM_SRC%\build_full.bat）...
call "%NIM_SRC%\build_full.bat"
if errorlevel 1 (
    echo [错误] 编译失败！请确认 NIM_SRC 路径和 Nim 工具链。
    pause
    exit /b 1
)

echo [3/4] 复制到桌面 DSH-Pet-Client...
if not exist "%DEST%" mkdir "%DEST%"
copy /Y "%NIM_SRC%\dsh_client_full.exe" "%DEST%\dsh_client_full.exe" >nul

echo [4/4] 启动新版客户端...
start "" "%DEST%\dsh_client_full.exe"
echo 完成！
endlocal
