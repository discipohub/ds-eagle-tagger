@echo off
setlocal EnableExtensions
chcp 65001 >nul
title ds Eagle Tagger - Select Eagle Folder
set "PROJECT_ROOT=%~dp0..\.."
cd /d "%PROJECT_ROOT%"
if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Windows environment is missing. Run install.bat first.
    pause
    exit /b 1
)
.venv\Scripts\python.exe scripts\dev\folder_runner.py
pause
