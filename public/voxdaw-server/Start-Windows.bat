@echo off
cd /d "%~dp0"
title VoxDaw MIDI Bridge
echo =========================================
echo       Starting VoxDaw MIDI Bridge...
echo =========================================
echo.
echo Checking dependencies (this takes a second)...
call npm install --silent
echo.
echo Starting Server...
node server.js
pause