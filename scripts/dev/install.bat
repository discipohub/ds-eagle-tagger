@echo off
setlocal EnableExtensions
chcp 65001 >nul
title ds Eagle Tagger - Setup
set "PROJECT_ROOT=%~dp0..\.."
cd /d "%PROJECT_ROOT%"
if errorlevel 1 goto :fail

echo ==== ds Eagle Tagger Setup - Windows NVIDIA GPU ====

where uv >nul 2>nul
if errorlevel 1 (
    echo [1/3] Installing uv...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$installer = Invoke-RestMethod 'https://astral.sh/uv/install.ps1'; Invoke-Expression $installer"
    if errorlevel 1 goto :fail
    set "PATH=%USERPROFILE%\.local\bin;%PATH%"
) else (
    echo [1/3] uv is already installed.
)

where uv >nul 2>nul
if errorlevel 1 (
    echo [ERROR] uv is not available after installation.
    echo Close this window, then run install.bat again.
    goto :fail
)

echo [2/3] Creating a clean Python 3.12 environment...
if exist ".venv\pyvenv.cfg" (
    echo Existing .venv will be replaced to avoid cross-platform conflicts.
)
set "UV_PYTHON_INSTALL_MIRROR=https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone/"
uv venv --python 3.12
if errorlevel 1 (
    echo USTC Python mirror failed, retrying with the official source...
    set "UV_PYTHON_INSTALL_MIRROR="
    uv venv --python 3.12
)
if errorlevel 1 goto :fail

echo [3/3] Installing GPU dependencies. Download size is about 1-2 GB...
uv pip install --link-mode copy --index-url https://mirrors.ustc.edu.cn/pypi/simple -r eagle-plugin\engine\requirements-gpu.txt
if errorlevel 1 (
    echo USTC PyPI mirror failed, retrying with the official source...
    uv pip install --link-mode copy --index-url https://pypi.org/simple -r eagle-plugin\engine\requirements-gpu.txt
)
if errorlevel 1 goto :fail

if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Windows Python launcher was not created.
    goto :fail
)

.venv\Scripts\python.exe -c "import numpy, PIL, requests, onnxruntime; print('[check] Python dependencies OK; providers:', onnxruntime.get_available_providers())"
if errorlevel 1 goto :fail

echo.
echo ==== Setup completed. Run run-dryrun.bat first. ====
pause
exit /b 0

:fail
echo.
echo Setup failed. Keep the full error output for troubleshooting.
pause
exit /b 1
