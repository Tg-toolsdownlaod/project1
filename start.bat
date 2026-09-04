@echo off
REM Starts the userbot service on Windows.
cd /d "%~dp0"

if not exist "node_modules" (
  echo Dependencies are not installed. Run this once:
  echo   npm install
  exit /b 1
)

node src/server.js
