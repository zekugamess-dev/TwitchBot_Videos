@echo off
cls
echo ================================
echo  Iniciando Twitch Video Collector
setlocal
call npm install
start http://localhost:3000
call npm start
pause