@echo off
rem Drag a video or a folder onto this file to analyse and prep it ahead of time (e.g. overnight).
title Brushwork - processing
cd /d "%~dp0helper"
if "%~1"=="" (
  echo Drag a video or a folder of videos onto this file.
  pause
  exit /b
)
py -3.8 brushwork.py process "%~1"
echo.
echo Done.
pause
