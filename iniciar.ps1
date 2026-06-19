# Garante que o PowerShell utilize codificação UTF-8 para exibir caracteres especiais corretamente
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Clear-Host
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "              INICIANDO PROMPT BOOTCAMP                  " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# Define o diretório de trabalho como a pasta onde o script está localizado
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($ScriptDir) {
    Set-Location $ScriptDir
}

# Verifica se a pasta node_modules existe. Se não existir, instala as dependências.
if (-not (Test-Path "node_modules")) {
    Write-Host "[INFO] Pasta 'node_modules' não encontrada." -ForegroundColor Yellow
    Write-Host "[INFO] Instalando dependências do projeto (npm install)..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERRO] Falha ao instalar dependências. Verifique se o Node.js está instalado globalmente." -ForegroundColor Red
        Read-Host "Pressione Enter para fechar..."
        exit
    }
    Write-Host "[OK] Dependências instaladas com sucesso!`n" -ForegroundColor Green
}

# Inicia o app em uma janela separada do PowerShell
Write-Host "[INFO] Iniciando o servidor local (API + Frontend) em uma nova janela..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoProfile -NoExit -Command `"`$host.UI.RawUI.WindowTitle = 'Servidor - Prompt Bootcamp'; npm run dev`"" -WorkingDirectory $PWD

# Aguarda 3 segundos para dar tempo do servidor subir antes de abrir o navegador
Write-Host "[INFO] Aguardando a inicialização do servidor..." -ForegroundColor Yellow
Start-Sleep -Seconds 3

# Abre a URL no navegador padrão do usuário
Write-Host "[INFO] Abrindo o navegador em http://127.0.0.1:5173..." -ForegroundColor Green
Start-Process "http://127.0.0.1:5173"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Tudo pronto! O servidor continua rodando na outra janela. " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
Start-Sleep -Seconds 2
