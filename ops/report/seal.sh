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

# reports 브랜치(코드와 분리, reports/ 만 담는 브랜치)에 reports/<date>/ 로 커밋.
# 작업 트리를 건드리지 않도록 임시 인덱스로 트리를 만들어 커밋한다.
cd "$REPO"
export GIT_INDEX_FILE="$WORK/index"
PARENT=""
git read-tree --empty
if git fetch -q origin reports 2>/dev/null; then
  PARENT="$(git rev-parse FETCH_HEAD)"
  # 이전 커밋에서 reports/ 폴더만 이어받는다 (그 밖의 파일은 브랜치에 두지 않음)
  if git cat-file -e "$PARENT:reports" 2>/dev/null; then
    git read-tree --prefix=reports/ "$PARENT:reports"
  fi
fi
for f in pdf.enc mail.enc key.enc name.txt sha256.txt; do
  h="$(git hash-object -w "$WORK/$f")"
  git update-index --add --cacheinfo 100644 "$h" "reports/$DATE/$f"
done
TREE="$(git write-tree)"
unset GIT_INDEX_FILE
COMMIT="$(git commit-tree "$TREE" ${PARENT:+-p "$PARENT"} -m "report $DATE (encrypted)")"
git push -q origin "$COMMIT:refs/heads/reports"
echo "sealed reports/$DATE  commit=${COMMIT:0:7}  sha256=$(cat "$WORK/sha256.txt")"
