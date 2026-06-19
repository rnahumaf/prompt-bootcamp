@echo off
:: Garante que o terminal use UTF-8 para exibir os caracteres do script do PowerShell corretamente
chcp 65001 > nul

:: Navega para o diretório do script para evitar caminhos relativos incorretos
cd /d "%~dp0"

:: Executa o script do PowerShell contornando políticas de restrição locais
powershell -NoProfile -ExecutionPolicy Bypass -File "iniciar.ps1"
