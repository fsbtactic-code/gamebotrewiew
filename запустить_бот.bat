@echo off
chcp 65001 >nul
title HezzlBot v7
cd /d "%~dp0"
:start
echo.
echo  === HezzlBot v7 starting... ===
echo.
node bot_v7.js
echo.
echo  [!] Bot stopped. Restarting in 5s... (close window to stop)
echo.
ping 127.0.0.1 -n 6 >nul
goto start
