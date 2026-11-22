@echo off
chcp 65001 >nul
title FEFO Tarimas
cd /d "%~dp0"
echo.
echo   ==============================
echo     FEFO TARIMAS - prototipo
echo   ==============================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [X] No se encontro Node.js. Instala la version LTS desde https://nodejs.org
  goto fin
)
node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo   [X] Se necesita Node.js 20 o superior.
  goto fin
)
if not exist node_modules (
  echo   Instalando componentes por primera vez; necesita internet...
  call npm install --omit=dev
  if errorlevel 1 goto fin
)
if not exist .env copy .env.example .env >nul

start "" cmd /c "timeout /t 4 >nul & start http://localhost:3200"
node src\server.js
echo.
echo   [X] El sistema se detuvo. Revisa el mensaje de arriba (¿esta encendido MySQL en Laragon?).

:fin
echo.
pause
