// functions/diag-claude.js — Claude API 연결 진단 (1회용, 확인 후 삭제 권장)
// 사용: https://ingredi.kr/diag-claude?key=<CACHE_REFRESH_SECRET>
// 반환: 게이트웨이 사용 여부, HTTP 상태, Anthropic 에러 타입·메시지 원문

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  const url = new URL(request.url);

  const secret = env.CACHE_REFRESH_SECRET || "";
  if (!secret || url.searchParams.get("key") !== secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });
  }

  const KEY = env.ANTHROPIC_API_KEY || "";
  const usingGateway = !!(env.CF_ACCOUNT_ID && env.CF_AI_GATEWAY);
  const BASE = usingGateway
    ? `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AI_GATEWAY}/anthropic`
    : "https://api.anthropic.com";

  const report = {
    keyPresent: KEY.length > 0,
    keyLength: KEY.length,
    keyPrefix: KEY ? KEY.slice(0, 10) + "..." : null,
    usingGateway,
    base: BASE
  };

  try {
    const resp = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 8, messages: [{ role: "user", content: "ping" }] })
    });
    report.status = resp.status;
    report.ok = resp.ok;
    const text = await resp.text();
    if (resp.ok) {
      report.result = "정상 — Claude API 연결에 문제 없음. 원인은 다른 곳입니다.";
      report.sample = text.slice(0, 200);
    } else {
      let err = null;
      try { err = JSON.parse(text); } catch (_) { /* raw */ }
      report.errorType = err && err.error ? err.error.type : null;
      report.errorMessage = err && err.error ? err.error.message : text.slice(0, 400);
      if (resp.status === 400 && /credit/i.test(report.errorMessage || "")) {
        report.result = "크레딧 소진 — console.anthropic.com > Billing 에서 충전 필요";
      } else if (resp.status === 401) {
        report.result = "API 키 무효 — 키가 폐기되었거나 잘못 설정됨. Cloudflare Pages 환경변수 ANTHROPIC_API_KEY 재확인";
      } else if (resp.status === 404 && usingGateway) {
        report.result = "AI Gateway 경로 오류 — CF_ACCOUNT_ID / CF_AI_GATEWAY 값 확인";
      } else if (resp.status === 429) {
        report.result = "레이트 리밋 — 일시적. 잠시 후 재시도";
      } else if (resp.status === 529) {
        report.result = "Anthropic 서버 과부하 — 일시적";
      } else {
        report.result = "기타 오류 — errorMessage 원문 확인";
      }
    }
  } catch (e) {
    report.result = "fetch 자체 실패 — 네트워크/게이트웨이 문제";
    report.exception = String(e && e.message || e);
  }

  return new Response(JSON.stringify(report, null, 2), { status: 200, headers });
}
