#!/bin/sh
set -eu
prefix=${DICODE_INSTALL_PREFIX:-"$HOME/.local"}
case "$prefix" in /*) ;; *) echo 'DICODE_INSTALL_PREFIX must be an absolute path.' >&2; exit 1;; esac
app_dir="$prefix/share/dicode/current"
command_path="$prefix/bin/dicode"
if [ -e "$app_dir" ] && [ ! -f "$app_dir/.dicode-installed" ]; then echo "Refusing to remove unmanaged directory: $app_dir" >&2; exit 1; fi
if [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$app_dir/dicode" ]; then rm "$command_path"; fi
if [ -f "$app_dir/.dicode-installed" ]; then rm -rf "$app_dir"; fi
if [ -z "${DICODE_INSTALL_PREFIX:-}" ]; then
 for startup in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$startup" ] || continue
  if grep -Fqx 'export PATH="$HOME/.local/bin:$PATH" # dicode' "$startup"; then
   temp=$(mktemp "${startup}.dicode.XXXXXX")
   grep -Fvx 'export PATH="$HOME/.local/bin:$PATH" # dicode' "$startup" > "$temp" || true
   cat "$temp" > "$startup"; rm "$temp"
  fi
 done
fi
echo 'Dicode removed. Login and session data were retained.'
