@echo off
setlocal
cd /d "%~dp0"
where npm.cmd >nul 2>nul
if not errorlevel 1 goto npm
set "TSS_PNPM=C:\Users\sandu\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
if exist "%TSS_PNPM%" goto pnpm
echo Instale Node.js com npm para instalar as dependencias.
exit /b 1
:npm
call npm.cmd install
exit /b %errorlevel%
:pnpm
call "%TSS_PNPM%" install --frozen-lockfile
exit /b %errorlevel%
