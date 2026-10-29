$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'Dicode'
$current = Join-Path $root 'current'
$bin = Join-Path $root 'bin'
$command = Join-Path $bin 'dicode.cmd'
if (!(Test-Path (Join-Path $PSScriptRoot 'app\src\cli.ts')) -or !(Test-Path (Join-Path $PSScriptRoot 'runtime\node.exe'))) { throw 'Run install.ps1 from the extracted Windows package.' }
if ((Test-Path $current) -and !(Test-Path (Join-Path $current '.dicode-installed'))) { throw "Refusing to replace unmanaged directory: $current" }
if ((Test-Path $command) -and !((Get-Content -Raw $command) -match 'REM Dicode-managed')) { throw "Refusing to replace existing command: $command" }
New-Item -ItemType Directory -Force $root, $bin | Out-Null
$stage = Join-Path $root ('.install-' + [guid]::NewGuid())
$backup = Join-Path $root ('.backup-' + [guid]::NewGuid())
try {
 New-Item -ItemType Directory $stage | Out-Null
 Copy-Item -Path (Join-Path $PSScriptRoot '*') -Destination $stage -Recurse -Force
 New-Item -ItemType File (Join-Path $stage '.dicode-installed') | Out-Null
 if (Test-Path $current) { Move-Item $current $backup }
 Move-Item $stage $current
 $wrapper = "@echo off`r`nREM Dicode-managed`r`ncall `"%LOCALAPPDATA%\Dicode\current\dicode.cmd`" %*`r`nexit /b %errorlevel%`r`n"
 [IO.File]::WriteAllText($command, $wrapper, [Text.Encoding]::ASCII)
 $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
 $entries = @($userPath -split ';' | Where-Object { $_ })
 if (!($entries | Where-Object { $_.TrimEnd('\') -ieq $bin.TrimEnd('\') })) {
  [Environment]::SetEnvironmentVariable('Path', (($entries + $bin) -join ';'), 'User')
 }
 if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }
} finally {
 if ((Test-Path $backup) -and !(Test-Path $current)) { Move-Item $backup $current }
 if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
}
Write-Host "Installed Dicode: $command"
Write-Host 'Open a new terminal, then run: dicode --check'
