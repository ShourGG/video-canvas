$ErrorActionPreference = 'Stop'
$studioRoot = $PSScriptRoot
$studioUrl = 'http://127.0.0.1:7790'
try {
    $studioState = Invoke-RestMethod -Uri "$studioUrl/api/state" -TimeoutSec 2
    if ($studioState.version -ne 'video-studio-2') { throw '7790 端口被其他程序占用' }
} catch {
    if (Get-NetTCPConnection -LocalPort 7790 -State Listen -ErrorAction SilentlyContinue) {
        throw '7790 端口已占用，请查看占用程序。'
    }
    $env:STUDIO_PORT = '7790'
    $env:PYTHONIOENCODING = 'utf-8'
    $studioPython = (Get-Command python -ErrorAction Stop).Source
    Start-Process -FilePath $studioPython -ArgumentList @('server.py', '--no-browser') -WorkingDirectory $studioRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $studioRoot 'studio.stdout.log') -RedirectStandardError (Join-Path $studioRoot 'studio.stderr.log')
    $studioReady = $false
    for ($studioAttempt=0; $studioAttempt -lt 20; $studioAttempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $studioState = Invoke-RestMethod -Uri "$studioUrl/api/state" -TimeoutSec 1
            if ($studioState.version -eq 'video-studio-2') { $studioReady=$true; break }
        } catch { }
    }
    if (-not $studioReady) { throw "启动失败，请查看 $studioRoot\studio.stderr.log" }
}
Start-Process "$studioUrl/canvas"
