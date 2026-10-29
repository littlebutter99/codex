#!/bin/sh
set -eu
package_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
prefix=${DICODE_INSTALL_PREFIX:-"$HOME/.local"}
case "$prefix" in /*) ;; *) echo 'DICODE_INSTALL_PREFIX must be an absolute path.' >&2; exit 1;; esac
app_dir="$prefix/share/dicode/current"
command_path="$prefix/bin/dicode"
if [ ! -f "$package_dir/app/src/cli.ts" ] || [ ! -x "$package_dir/runtime/node" ]; then echo 'Run install.sh from the extracted Linux package.' >&2; exit 1; fi
if [ -e "$app_dir" ] && [ ! -f "$app_dir/.dicode-installed" ]; then echo "Refusing to replace unmanaged directory: $app_dir" >&2; exit 1; fi
if [ -e "$command_path" ] || [ -L "$command_path" ]; then
  if [ ! -L "$command_path" ] || [ "$(readlink "$command_path")" != "$app_dir/dicode" ]; then echo "Refusing to replace existing command: $command_path" >&2; exit 1; fi
fi
mkdir -p "$prefix/share/dicode" "$prefix/bin"
stage=$(mktemp -d "$prefix/share/dicode/.install.XXXXXX")
backup="$stage.old"
cleanup() { if [ -d "$backup" ] && [ ! -e "$app_dir" ]; then mv "$backup" "$app_dir"; fi; [ ! -d "$stage" ] || rm -rf "$stage"; }
trap cleanup EXIT HUP INT TERM
cp -a "$package_dir/." "$stage/"
: > "$stage/.dicode-installed"
if [ -d "$app_dir" ]; then mv "$app_dir" "$backup"; fi
mv "$stage" "$app_dir"
ln -sfn "$app_dir/dicode" "$command_path"
[ ! -d "$backup" ] || rm -rf "$backup"
# For the default per-user installation, make the command discoverable in new shells.
if [ -z "${DICODE_INSTALL_PREFIX:-}" ] && ! printf ":%s:" "$PATH" | grep -Fq ":$prefix/bin:"; then
  for startup in "$HOME/.profile" "$HOME/.bashrc"; do
    if [ "$startup" = "$HOME/.bashrc" ] && [ ! -f "$startup" ]; then continue; fi
    if ! grep -Fqx 'export PATH="$HOME/.local/bin:$PATH" # dicode' "$startup" 2>/dev/null; then
      printf '\n%s\n' 'export PATH="$HOME/.local/bin:$PATH" # dicode' >> "$startup"
    fi
  done
  case "${SHELL:-}" in */zsh) if ! grep -Fqx 'export PATH="$HOME/.local/bin:$PATH" # dicode' "$HOME/.zshrc" 2>/dev/null; then printf '\n%s\n' 'export PATH="$HOME/.local/bin:$PATH" # dicode' >> "$HOME/.zshrc"; fi;; esac
fi
printf 'Installed Dicode: %s\n' "$command_path"
case ":$PATH:" in *":$prefix/bin:"*) echo 'Run: dicode --check';; *) echo "Open a new terminal, or add $prefix/bin to PATH.";; esac
