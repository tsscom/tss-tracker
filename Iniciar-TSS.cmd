@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "TSS_NODE=C:\Users\sandu\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%TSS_NODE%" goto run
where node >nul 2>nul
if errorlevel 1 goto missing
set "TSS_NODE=node"
:run
echo A iniciar TSS Transportes...
echo Abra http://127.0.0.1:4317 no navegador.
echo Mantenha esta janela aberta enquanto utiliza a aplicação.
start "" "http://127.0.0.1:4317"
"%TSS_NODE%" server.mjs
pause
exit /b
:missing
echo Não foi encontrado o Node.js. Abra este projeto no Codex para configurar a execução.
pause
exit /b 1
