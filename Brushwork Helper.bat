@echo off
rem Starts the Brushwork helper and opens the viewer. Close this window to stop it.
title Brushwork helper
cd /d "%~dp0helper"
if not exist config.json copy config.example.json config.json >nul
py -3.8 brushwork.py serve --open
if errorlevel 1 (
  echo.
  echo The helper stopped with an error. It needs Python with numpy, and ffmpeg on the PATH.
  pause
)
