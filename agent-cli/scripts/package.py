#!/usr/bin/env python3
"""Build self-contained x64 archives on Linux using pinned official releases."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
CACHE = Path(os.environ.get('DICODE_DOWNLOAD_CACHE', Path(tempfile.gettempdir()) / 'dicode-downloads'))
ASSETS = {
 'node-linux': ('https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz', 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6'),
 'node-win': ('https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip', '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'),
 'codex-linux': ('https://github.com/openai/codex/releases/download/rust-v0.165.0/codex-package-x86_64-unknown-linux-musl.tar.gz', 'e97c4463d7f146692a955d7b0e1c8cf48f97cd4d616cd45c5dcab2e8d9743316'),
 'codex-win': ('https://github.com/openai/codex/releases/download/rust-v0.165.0/codex-package-x86_64-pc-windows-msvc.tar.gz', '2a64beb5856c3170738793e0aa65b44aa3f2d7b8f53221a3f72bdafe6485d119'),
}

def digest(path):
 h = hashlib.sha256()
 with path.open('rb') as stream:
  for chunk in iter(lambda: stream.read(1024 * 1024), b''): h.update(chunk)
 return h.hexdigest()

def asset(name):
 url, expected = ASSETS[name]
 CACHE.mkdir(parents=True, exist_ok=True)
 path = CACHE / url.rsplit('/', 1)[1]
 if not path.exists() or digest(path) != expected:
  temporary = path.with_suffix(path.suffix + '.partial')
  print(f'Downloading {name}...', flush=True)
  with urllib.request.urlopen(url, timeout=120) as response, temporary.open('wb') as output:
   shutil.copyfileobj(response, output)
  if digest(temporary) != expected: raise ValueError(f'{name}: SHA-256 mismatch')
  temporary.replace(path)
 if digest(path) != expected: raise ValueError(f'{name}: SHA-256 mismatch')
 return path

def extract_codex(path, dest):
 with tarfile.open(path, 'r:gz') as archive:
  archive.extractall(dest, filter='data')

def main():
 if not (ROOT / 'node_modules' / '@earendil-works' / 'pi-tui').is_dir():
  raise SystemExit('Run npm ci --workspaces=false before packaging')
 DIST.mkdir(exist_ok=True)
 with tempfile.TemporaryDirectory(prefix='dicode-package-') as tmp:
  temp = Path(tmp)
  for platform in ('linux', 'win'):
   label = 'linux-x64' if platform == 'linux' else 'windows-x64'
   base = temp / f'dicode-{label}'
   app = base / 'app'
   app.mkdir(parents=True)
   for directory in ('src', 'config', 'node_modules'):
    shutil.copytree(ROOT / directory, app / directory, symlinks=False)
   for file in ('package.json', 'package-lock.json', 'README.md'):
    shutil.copy2(ROOT / file, app / file)
   for file in ('LICENSE', 'NOTICE'):
    shutil.copy2(ROOT.parent / file, base / ('CODEX-' + file))
   runtime = base / 'runtime'; runtime.mkdir()
   if platform == 'linux':
    with tarfile.open(asset('node-linux'), 'r:xz') as archive:
     license_file = archive.extractfile('node-v24.21.0-linux-x64/LICENSE')
     (base / 'NODE-LICENSE').write_bytes(license_file.read())
     member = archive.getmember('node-v24.21.0-linux-x64/bin/node')
     with archive.extractfile(member) as src, (runtime / 'node').open('wb') as dst: shutil.copyfileobj(src, dst)
    (runtime / 'node').chmod(0o755)
   else:
    with zipfile.ZipFile(asset('node-win')) as archive:
     (base / 'NODE-LICENSE').write_bytes(archive.read('node-v24.21.0-win-x64/LICENSE'))
     with archive.open('node-v24.21.0-win-x64/node.exe') as src, (runtime / 'node.exe').open('wb') as dst: shutil.copyfileobj(src, dst)
   guide = ('Dicode Linux x64\n\nRun from a terminal:\n  /path/to/dicode-linux-x64/dicode --check\n  /path/to/dicode-linux-x64/dicode --cwd /path/to/project\n  /path/to/dicode-linux-x64/dicode login deepseek\n\nNode.js and Codex are included. State: ${XDG_STATE_HOME:-~/.local/state}/dicode.\n' if platform == 'linux' else 'Dicode Windows x64\n\nRun from PowerShell or Windows Terminal:\n  & \"C:\\path\\to\\dicode-windows-x64\\dicode.cmd\" --check\n  & \"C:\\path\\to\\dicode-windows-x64\\dicode.cmd\" --cwd \"C:\\path\\to\\project\"\n  & \"C:\\path\\to\\dicode-windows-x64\\dicode.cmd\" login deepseek\n\nNode.js and Codex are included. State: %LOCALAPPDATA%\\Dicode.\n')
   guide = ('Dicode Linux x64\n\nInstall: ./install.sh\nOpen a new terminal, then run: dicode --check\nUninstall: ./uninstall.sh\n' if platform == 'linux' else 'Dicode Windows x64\n\nInstall: powershell -ExecutionPolicy Bypass -File .\\install.ps1\nOpen a new terminal, then run: dicode --check\nUninstall: powershell -ExecutionPolicy Bypass -File .\\uninstall.ps1\n')
   (base / 'README.txt').write_text(guide, encoding='utf-8')
   suffix = 'linux.sh' if platform == 'linux' else 'windows.ps1'
   extension = 'sh' if platform == 'linux' else 'ps1'
   for action in ('install', 'uninstall'):
    shutil.copy2(ROOT / 'scripts' / f'{action}-{suffix}', base / f'{action}.{extension}')
   vendor = app / 'vendor'; vendor.mkdir()
   extract_codex(asset('codex-' + platform), vendor)
   # The executable remains inside the official package layout, with its companions.
   if platform == 'linux':
    launcher = base / 'dicode'
    launcher.write_text('#!/bin/sh\nset -eu\nDICODE_ROOT=$(dirname -- "$(readlink -f -- "$0")")\nexport DICODE_STATE_DIR="${DICODE_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/dicode}"\nexport CODEX_BIN="${CODEX_BIN:-$DICODE_ROOT/app/vendor/bin/codex}"\nexport DICODE_PACKAGED=1\nexec "$DICODE_ROOT/runtime/node" "$DICODE_ROOT/app/src/cli.ts" "$@"\n')
    launcher.chmod(0o755)
    output = DIST / f'dicode-{label}.tar.gz'
    with tarfile.open(output, 'w:gz', compresslevel=1) as archive: archive.add(base, arcname=base.name)
   else:
    (base / 'dicode.cmd').write_text('@echo off\r\nsetlocal\r\nset "DICODE_PACKAGED=1"\r\nif not defined LOCALAPPDATA set "LOCALAPPDATA=%USERPROFILE%\\AppData\\Local"\r\nif not defined DICODE_STATE_DIR set "DICODE_STATE_DIR=%LOCALAPPDATA%\\Dicode"\r\nif not defined CODEX_BIN set "CODEX_BIN=%~dp0app\\vendor\\bin\\codex.exe"\r\n"%~dp0runtime\\node.exe" "%~dp0app\\src\\cli.ts" %*\r\nexit /b %errorlevel%\r\n', newline='')
    output = DIST / f'dicode-{label}.zip'
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as archive:
     for path in base.rglob('*'):
      if path.is_file(): archive.write(path, Path(base.name) / path.relative_to(base))
   print(f'{output.name}: {digest(output)}', flush=True)

if __name__ == '__main__': main()
