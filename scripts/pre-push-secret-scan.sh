#!/bin/sh
# pre-push — chặn push nếu phát hiện secret.
#
# CÀI (machine-local — `.git/hooks` không track nên không vào repo/zip).
# Dùng `git show`, KHÔNG dùng `cp`: core.autocrlf=true nên file này thành CRLF
# khi checkout, mà sh trên Windows đọc CRLF là hỏng (`\r: command not found`).
#   git show HEAD:scripts/pre-push-secret-scan.sh > .git/hooks/pre-push
#   chmod +x .git/hooks/pre-push
# Gỡ: rm .git/hooks/pre-push
#
# Git bắn push với stdin: <local_ref> <local_sha> <remote_ref> <remote_sha>

PATTERN='sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,}'

hits=""

# 1) Working tree — mọi file đang được git track
wt="$(git grep -I -n -E "$PATTERN" -- 2>/dev/null || true)"
[ -n "$wt" ] && hits="$hits
[working tree]
$wt"

# 2) Tên file credential không bao giờ được track (trừ bản mẫu)
credfiles="$(git ls-files \
  | grep -iE '(^|/)(\.env$|id_rsa$|id_ed25519$|[^/]*\.(pem|p12|pfx|keystore)$)' \
  | grep -viE '\.env\.example$' || true)"
[ -n "$credfiles" ] && hits="$hits
[credential file tracked]
$credfiles"

# 3) Từng commit sắp push (stdin: local remote)
while read -r local localsha remote remotesha; do
  [ -z "${localsha:-}" ] && continue
  case "$localsha" in
    0000000000000000000000000000000000000000) continue ;;  # tạo branch mới, không có lịch sử riêng
  esac
  if [ -z "${remotesha:-}" ] || [ "$remotesha" = "0000000000000000000000000000000000000000" ]; then
    revs="$localsha"   # branch mới → quét cả lịch sử của nó
  else
    revs="$(git rev-list "$remotesha..$localsha" 2>/dev/null || echo "$localsha")"
  fi
  for c in $revs; do
    h="$(git grep -I -n -E "$PATTERN" "$c" -- 2>/dev/null || true)"
    [ -n "$h" ] && hits="$hits
[commit $c]
$h"
  done
done

if [ -n "$hits" ]; then
  printf '\n❌ pre-push chặn push — phát hiện secret:\n%s\n\n' "$hits" >&2
  printf 'Xóa khỏi working tree hoặc lịch sử trước khi push.\n' >&2
  printf '(bỏ qua cực chẳng đã: git push --no-verify)\n' >&2
  exit 1
fi
exit 0
