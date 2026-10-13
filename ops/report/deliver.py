"""reports 브랜치의 암호화된 점검 PDF를 풀어 Google Drive에 올리고 Gmail로 보낸다 (GitHub Actions에서 실행).

필요한 GitHub Secrets
  REPORT_PRIVATE_KEY   seal.sh가 쓰는 공개키(report_pub.pem)의 짝 RSA 개인키(PEM 전체)
  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN
                       Oliver 계정 OAuth (get_refresh_token.py로 발급, 범위: drive + gmail.send)

입력: 환경변수 DATE(YYYY-MM-DD), 작업 디렉터리에 reports/<DATE>/ 가 있어야 한다.
같은 이름의 파일이 Drive 폴더에 이미 있으면 업로드를 건너뛴다(재실행 안전). 메일은 SKIP_MAIL=1이면 보내지 않는다.
"""
import base64, hashlib, json, os, subprocess, sys, tempfile, urllib.parse, urllib.request
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.header import Header

FOLDER_ID = "10TzILPEU7J9mrQZz2rYmMvPYLkfzTDOF"          # Ingredi/마케팅/Daily Report
ALLOWED_TO = {"cokun2001@gmail.com", "smile.yongjae@gmail.com"}  # 이 밖의 수신자는 거부


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, **kw)


def decrypt(d, key_pem):
    with tempfile.TemporaryDirectory() as t:
        kp = os.path.join(t, "priv.pem")
        with open(kp, "w") as f:
            f.write(key_pem)
        os.chmod(kp, 0o600)
        run(["openssl", "pkeyutl", "-decrypt", "-inkey", kp, "-pkeyopt", "rsa_padding_mode:oaep",
             "-in", f"{d}/key.enc", "-out", f"{t}/k"])
        out = {}
        for name in ("pdf", "mail"):
            run(["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-pass", f"file:{t}/k",
                 "-in", f"{d}/{name}.enc", "-out", f"{t}/{name}"])
            out[name] = open(f"{t}/{name}", "rb").read()
    return out["pdf"], json.loads(out["mail"])


def http(method, url, token=None, data=None, headers=None):
    h = dict(headers or {})
    if token:
        h["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {url.split('?')[0]} -> HTTP {e.code}: {e.read()[:500]!r}")


def access_token():
    body = urllib.parse.urlencode({
        "client_id": os.environ["GOOGLE_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
        "refresh_token": os.environ["GOOGLE_REFRESH_TOKEN"],
        "grant_type": "refresh_token"}).encode()
    return http("POST", "https://oauth2.googleapis.com/token", data=body,
                headers={"Content-Type": "application/x-www-form-urlencoded"})["access_token"]


def drive_upload(tok, name, pdf):
    q = urllib.parse.quote(f"name = '{name}' and '{FOLDER_ID}' in parents and trashed = false")
    found = http("GET", f"https://www.googleapis.com/drive/v3/files?q={q}&fields=files(id,md5Checksum,webViewLink)", tok)
    md5 = hashlib.md5(pdf).hexdigest()
    for f in found.get("files", []):
        if f.get("md5Checksum") == md5:
            return f, "already"
    boundary = "ingrediboundary7f3a"
    meta = json.dumps({"name": name, "parents": [FOLDER_ID], "mimeType": "application/pdf"}).encode()
    body = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".encode() + meta +
            f"\r\n--{boundary}\r\nContent-Type: application/pdf\r\n\r\n".encode() + pdf +
            f"\r\n--{boundary}--".encode())
    f = http("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,md5Checksum,webViewLink",
             tok, data=body, headers={"Content-Type": f"multipart/related; boundary={boundary}"})
    if f.get("md5Checksum") != md5:
        raise SystemExit(f"Drive md5 불일치: {f.get('md5Checksum')} != {md5}")
    return f, "uploaded"


def gmail_send(tok, mail, name, pdf):
    to = [a.strip().lower() for a in mail["to"]]
    bad = [a for a in to if a not in ALLOWED_TO]
    if bad:
        raise SystemExit(f"허용되지 않은 수신자: {bad}")
    m = MIMEMultipart("mixed")
    m["To"] = ", ".join(to)
    m["Subject"] = str(Header(mail["subject"], "utf-8"))
    alt = MIMEMultipart("alternative")
    alt.attach(MIMEText(mail.get("text", ""), "plain", "utf-8"))
    alt.attach(MIMEText(mail.get("html", ""), "html", "utf-8"))
    m.attach(alt)
    att = MIMEApplication(pdf, "pdf")
    att.add_header("Content-Disposition", "attachment", filename=("utf-8", "", name))
    m.attach(att)
    raw = base64.urlsafe_b64encode(m.as_bytes()).decode()
    return http("POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", tok,
                data=json.dumps({"raw": raw}).encode(), headers={"Content-Type": "application/json"})


def main():
    date = os.environ["DATE"]
    d = f"reports/{date}"
    if not os.path.isdir(d):
        raise SystemExit(f"{d} 없음 (reports 브랜치에 seal.sh로 올렸는지 확인)")
    missing = [k for k in ("REPORT_PRIVATE_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN")
               if not os.environ.get(k)]
    if missing:
        raise SystemExit(f"GitHub Secrets 미등록: {', '.join(missing)}")
    name = open(f"{d}/name.txt").read().strip()
    pdf, mail = decrypt(d, os.environ["REPORT_PRIVATE_KEY"])
    want = open(f"{d}/sha256.txt").read().strip()
    if hashlib.sha256(pdf).hexdigest() != want:
        raise SystemExit("복호화한 PDF의 sha256이 원본과 다름")
    tok = access_token()
    f, how = drive_upload(tok, name, pdf)
    result = {"ok": True, "date": date, "file": name, "bytes": len(pdf), "drive": how,
              "drive_id": f.get("id"), "drive_link": f.get("webViewLink")}
    if os.environ.get("SKIP_MAIL") == "1":
        result["mail"] = "skipped"
    elif how == "already" and os.environ.get("FORCE_MAIL") != "1":
        result["mail"] = "skipped (같은 PDF가 이미 Drive에 있음 = 이전 실행에서 발송됨)"
    else:
        sent = gmail_send(tok, mail, name, pdf)
        result["mail"] = "sent"; result["mail_id"] = sent.get("id"); result["to"] = mail["to"]
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
