$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'Dicode'
$current = Join-Path $root 'current'
$bin = Join-Path $root 'bin'
$command = Join-Path $bin 'dicode.cmd'
if ((Test-Path $current) -and !(Test-Path (Join-Path $current '.dicode-installed'))) { throw "Refusing to remove unmanaged directory: $current" }
if ((Test-Path $command) -and ((Get-Content -Raw $command) -match 'REM Dicode-managed')) { Remove-Item $command -Force }
if (Test-Path (Join-Path $current '.dicode-installed')) { Remove-Item $current -Recurse -Force }
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @($userPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $bin.TrimEnd('\') })
[Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
Write-Host 'Dicode removed. Login and session data were retained.'
