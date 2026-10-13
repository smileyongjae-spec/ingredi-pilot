#!/usr/bin/env bash
# 점검 PDF·메일 내용을 암호화해 `reports` 브랜치에 올린다 (07시 보고 세션에서 실행).
# 저장소가 public이라 원문은 올리지 않는다: 무작위 AES 키로 암호화하고, 그 키는 RSA 공개키(report_pub.pem)로 감싼다.
# 복호화용 개인키는 GitHub Secrets의 REPORT_PRIVATE_KEY에만 있다.
#
# 사용: ops/report/seal.sh 2026-10-14 /path/ingredi_점검_03_2026-10-14.pdf /path/mail.json
#   mail.json = {"to":["cokun2001@gmail.com"], "subject":"...", "html":"...", "text":"..."}
# 그다음 GitHub Actions 'report-deliver'를 date 입력으로 실행하면 Drive 업로드 + Gmail 발송.
set -euo pipefail
DATE="$1"; PDF="$2"; MAIL="$3"
[[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "날짜 형식 YYYY-MM-DD"; exit 1; }
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
PUB="$REPO/ops/report/report_pub.pem"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

openssl rand -hex 32 > "$WORK/k"
openssl enc -aes-256-cbc -pbkdf2 -salt -pass file:"$WORK/k" -in "$PDF"  -out "$WORK/pdf.enc"
openssl enc -aes-256-cbc -pbkdf2 -salt -pass file:"$WORK/k" -in "$MAIL" -out "$WORK/mail.enc"
openssl pkeyutl -encrypt -pubin -inkey "$PUB" -pkeyopt rsa_padding_mode:oaep -in "$WORK/k" -out "$WORK/key.enc"
basename "$PDF" > "$WORK/name.txt"           # 파일명은 평문(날짜·번호뿐)
sha256sum "$PDF" | cut -d' ' -f1 > "$WORK/sha256.txt"   # 원본 확인용
rm -f "$WORK/k"

# reports 브랜치(코드와 분리된 orphan 브랜치)에 reports/<date>/ 로 커밋
WT="$WORK/wt"
cd "$REPO"
git fetch -q origin reports 2>/dev/null || true
if git ls-remote --exit-code --heads origin reports >/dev/null 2>&1; then
  git worktree add -q -B reports-local "$WT" origin/reports
else
  git worktree add -q --detach "$WT"
  (cd "$WT" && git checkout -q --orphan reports-local && git rm -rq . >/dev/null 2>&1 || true)
fi
mkdir -p "$WT/reports/$DATE"
cp "$WORK"/{pdf.enc,mail.enc,key.enc,name.txt,sha256.txt} "$WT/reports/$DATE/"
(cd "$WT" && git add "reports/$DATE" && git commit -qm "report $DATE (encrypted)" && git push -q origin reports-local:reports)
git worktree remove --force "$WT"
git branch -D reports-local >/dev/null 2>&1 || true
echo "sealed reports/$DATE  sha256=$(cat "$WORK/sha256.txt")"
