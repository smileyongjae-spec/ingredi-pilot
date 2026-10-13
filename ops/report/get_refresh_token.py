"""Oliver가 자기 PC에서 한 번 실행해 GOOGLE_REFRESH_TOKEN을 발급받는 도구 (표준 라이브러리만 사용).

준비 (Google Cloud Console, Oliver 계정으로 로그인):
  1) 프로젝트 만들기 → 'API 및 서비스'에서 Google Drive API, Gmail API 사용 설정
  2) 'OAuth 동의 화면': 외부(External), 테스트 사용자에 smile.yongjae@gmail.com 추가.
     ※ '테스트' 상태면 refresh token이 7일 뒤 만료된다 → 발급 후 '앱 게시(프로덕션)'로 바꿔 둔다
        (개인용·미인증 앱 경고는 그대로 진행하면 된다)
  3) '사용자 인증 정보' → OAuth 클라이언트 ID → 애플리케이션 유형 '데스크톱 앱'
  4) 이 스크립트 실행:  python3 get_refresh_token.py <CLIENT_ID> <CLIENT_SECRET>
     브라우저가 열리면 smile.yongjae@gmail.com으로 허용 → 터미널에 refresh token 출력
  5) GitHub 저장소 Settings → Secrets and variables → Actions 에 등록:
     GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
"""
import http.server, json, secrets, sys, urllib.parse, urllib.request, webbrowser

SCOPES = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/gmail.send"


def main():
    cid, csec = sys.argv[1], sys.argv[2]
    state = secrets.token_urlsafe(16)
    got = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
            if q.get("state") == state and "code" in q:
                got["code"] = q["code"]
            self.send_response(200); self.send_header("Content-Type", "text/plain; charset=utf-8"); self.end_headers()
            self.wfile.write("완료. 이 창을 닫고 터미널을 보세요.".encode())

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    redirect = f"http://127.0.0.1:{srv.server_port}"
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": cid, "redirect_uri": redirect, "response_type": "code", "scope": SCOPES,
        "access_type": "offline", "prompt": "consent", "state": state})
    print("브라우저에서 허용하세요:\n" + url)
    webbrowser.open(url)
    while "code" not in got:
        srv.handle_request()
    body = urllib.parse.urlencode({"code": got["code"], "client_id": cid, "client_secret": csec,
                                   "redirect_uri": redirect, "grant_type": "authorization_code"}).encode()
    tok = json.loads(urllib.request.urlopen(urllib.request.Request(
        "https://oauth2.googleapis.com/token", data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"})).read())
    if "refresh_token" not in tok:
        sys.exit(f"refresh_token 없음: {tok}")
    print("\nGOOGLE_REFRESH_TOKEN =", tok["refresh_token"])


if __name__ == "__main__":
    main()
