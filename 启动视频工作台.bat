@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动视频工作台.ps1"
if errorlevel 1 pause
