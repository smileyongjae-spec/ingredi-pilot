// 배포 위치: functions/_lib/coupang.js
// 쿠팡 파트너스 Deeplink API 헬퍼 (Cloudflare Functions 런타임 / Web Crypto 기반)
//
// Cloudflare Workers/Functions 에는 Node 의 'crypto' 모듈이 없으므로
// HMAC-SHA256 서명은 crypto.subtle 로 직접 구현한다.

const COUPANG_HOST = "https://api-gateway.coupang.com";
const DEEPLINK_PATH =
  "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";

// UTC datetime → 'yyMMddTHHmmssZ' (쿠팡 HMAC 규격)
function signedDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    p(d.getUTCFullYear() % 100) +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    "T" +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds()) +
    "Z"
  );
}

// HMAC-SHA256 → hex 문자열
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// CEA Authorization 헤더 생성
// message = datetime + method + path + query
async function buildAuth(method, path, query, accessKey, secretKey) {
  const datetime = signedDate();
  const message = datetime + method + path + (query || "");
  const signature = await hmacHex(secretKey, message);
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
}

/**
 * 상품 URL 배열을 deeplink 로 변환한다.
 *
 * 반환:
 *   { ok: true,  map: Map<originalUrl, {shortenUrl, landingUrl}>, rCode: "0" }
 *   { ok: false, map: (empty), rCode, rMessage }   ← 배치 자체가 거절됨(예: 변환불가 상품 포함)
 * 예외(throw):
 *   HTTP 비2xx (401 인증오류 / 429 레이트리밋 / 5xx 등) 또는 응답 파싱 실패
 */
export async function convertDeeplinks(env, urls, subId) {
  const accessKey = env.COUPANG_ACCESS_KEY;
  const secretKey = env.COUPANG_SECRET_KEY;
  if (!accessKey || !secretKey) {
    throw new Error(
      "COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY 환경변수가 설정되지 않았습니다."
    );
  }

  const auth = await buildAuth("POST", DEEPLINK_PATH, "", accessKey, secretKey);

  const body = { coupangUrls: urls };
  if (subId) body.subId = subId;

  const res = await fetch(COUPANG_HOST + DEEPLINK_PATH, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json;charset=UTF-8",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    // 인증/레이트리밋/서버오류 → 호출 측에서 중단·재시도 판단
    throw new Error(`쿠팡 HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`쿠팡 응답 파싱 실패: ${text.slice(0, 300)}`);
  }

  const normalized = String(json.rCode);
  if (normalized === "0") {
    const map = new Map();
    for (const item of json.data || []) {
      if (item.shortenUrl) {
        map.set(item.originalUrl, {
          shortenUrl: item.shortenUrl,
          landingUrl: item.landingUrl || "",
        });
      }
    }
    return { ok: true, map, rCode: "0", rMessage: "" };
  }

  // rCode != 0 → 이 배치는 변환 불가(예: 400204). 호출 측에서 1개씩 재시도.
  return {
    ok: false,
    map: new Map(),
    rCode: normalized,
    rMessage: json.rMessage || "",
  };
}
