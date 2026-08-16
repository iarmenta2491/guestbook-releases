@echo off
title My Guestbook Debug
cd /d "c:\Users\iarme\OneDrive\Documents\My Guestbook"
echo Working directory: %CD%
echo.
echo Running Electron...
node_modules\.bin\electron.cmd . > debug_output.txt 2>&1
echo.
echo Exit code: %ERRORLEVEL%
echo.
echo --- Output ---
type debug_output.txt
echo --- End ---
pause
