#!/usr/bin/env bash
set -euo pipefail

# Installs the two Apple PKI trust anchors used by App Store signed transactions and ASSN v2.
# Downloads are pinned to fingerprints published by Apple; a changed file fails before install.
target_dir="${APPLE_ROOT_TARGET_DIR:-/opt/gw-alloc/apple-roots}"
temp_dir="$(mktemp -d /tmp/friday-apple-roots.XXXXXX)"
trap 'rm -rf "$temp_dir"' EXIT

curl -fsS --proto '=https' --tlsv1.2 \
  https://www.apple.com/certificateauthority/AppleRootCA-G2.cer \
  -o "$temp_dir/AppleRootCA-G2.cer"
curl -fsS --proto '=https' --tlsv1.2 \
  https://www.apple.com/certificateauthority/AppleRootCA-G3.cer \
  -o "$temp_dir/AppleRootCA-G3.cer"

printf '%s  %s\n' \
  'c2b9b042dd57830e7d117dac55ac8ae19407d38e41d88f3215bc3a890444a050' \
  "$temp_dir/AppleRootCA-G2.cer" \
  '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179' \
  "$temp_dir/AppleRootCA-G3.cer" | sha256sum --check --status

install -d -m 0755 "$target_dir"
install -m 0644 "$temp_dir/AppleRootCA-G2.cer" "$target_dir/AppleRootCA-G2.cer"
install -m 0644 "$temp_dir/AppleRootCA-G3.cer" "$target_dir/AppleRootCA-G3.cer"
printf 'Installed Apple roots in %s\n' "$target_dir"
printf 'Set APPLE_ROOT_CA_FILES=%s/AppleRootCA-G2.cer:%s/AppleRootCA-G3.cer\n' \
  "$target_dir" "$target_dir"
