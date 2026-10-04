// functions/_lib/price.js  v1.0  (2026-10-04)
// 가격·하루 비용의 채널 선택 규칙 (단일 출처). 사용처: recommend2.js · counsel2.js · sports-api.js
//
// 규칙(2026-10-04 확정): 쿠팡 링크(coupang_deeplink 또는 쿠팡 URL)가 있으면 쿠팡 가격 기준,
//   없으면 네이버 가격 기준. 판단 기준은 "가격이 있느냐"가 아니라 "구매 버튼이 어디로 가느냐".
//   → 화면의 가격과 버튼이 가리키는 판매처가 항상 같다.
// 가격과 하루 비용은 같은 채널에서 함께 가져온다(필드별 따로 폴백하지 않음).
//   선택 채널 값이 둘 다 비었을 때만 옛 구조(가격_원·1일비용_원) → 반대 채널 순으로 폴백하고,
//   그 경우 priceSource에 실제 출처를 적어 데이터 누락을 드러낸다.

const F = {
  coupangLink:  ["coupang_deeplink"],
  coupangRaw:   ["쿠팡 URL", "쿠팡URL", "쿠팡_URL", "쿠팡링크"],
  naverLink:    ["제품링크"],
  coupangPrice: ["쿠팡가격_원", "쿠팡가격"],
  naverPrice:   ["네이버가격_원", "네이버가격"],
  legacyPrice:  ["가격_원"],
  // 테이블마다 이름이 조금씩 다르다: 건기식 "1일비용_쿠팡기준_원" / 헬스제품 "1일비용_쿠팡비용_원" / 옛 비타민C "1일비용_쿠팡_원"
  coupangDaily: ["1일비용_쿠팡기준_원", "1일비용_쿠팡비용_원", "1일비용_쿠팡_원"],
  naverDaily:   ["1일비용_네이버기준_원", "1일비용_네이버비용_원", "1일비용_네이버_원"],
  legacyDaily:  ["1일비용_원"]
};

function text(v) {
  if (Array.isArray(v)) v = v[0];
  return (v === undefined || v === null) ? "" : String(v).trim();
}
function pickText(f, names) {
  for (const k of names) { const v = text(f[k]); if (v) return v; }
  return "";
}
function num(v) {
  if (Array.isArray(v)) v = v[0];
  if (v === undefined || v === null || v === "") return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function pickNum(f, names) {
  for (const k of names) { const n = num(f[k]); if (n > 0) return n; }
  return 0;
}

// 링크: 파트너스 딥링크 → raw 쿠팡 → 네이버
export function linkOf(f) {
  const partners = pickText(f, F.coupangLink);
  const raw = pickText(f, F.coupangRaw);
  const naver = pickText(f, F.naverLink);
  return {
    link: partners || raw || naver || "",
    isAffiliate: !!partners,
    channel: (partners || raw) ? "coupang" : (naver ? "naver" : null)
  };
}

// 반환: { price, dailyCost(null 가능), priceSource, channel, naverPrice, naverDailyCost }
//   priceSource: "coupang" | "naver" | "legacy" | "naver-fallback"(쿠팡 링크인데 쿠팡값 없음) | "coupang-fallback"(네이버 링크인데 네이버값 없음) | null
export function priceOf(f) {
  f = f || {};
  const { channel } = linkOf(f);
  const c = { price: pickNum(f, F.coupangPrice), daily: pickNum(f, F.coupangDaily) };
  const n = { price: pickNum(f, F.naverPrice),   daily: pickNum(f, F.naverDaily) };
  const l = { price: pickNum(f, F.legacyPrice),  daily: pickNum(f, F.legacyDaily) };
  const has = x => x.price > 0 || x.daily > 0;

  const primary = channel === "coupang" ? c : n;
  const other   = channel === "coupang" ? n : c;
  let use, src;
  if (has(primary))    { use = primary; src = channel === "coupang" ? "coupang" : "naver"; }
  else if (has(l))     { use = l;       src = "legacy"; }
  else if (has(other)) { use = other;   src = channel === "coupang" ? "naver-fallback" : "coupang-fallback"; }
  else                 { use = { price: 0, daily: 0 }; src = null; }

  return {
    price: use.price ? Math.round(use.price) : 0,
    dailyCost: use.daily ? Math.round(use.daily) : null,
    priceSource: src,
    channel,
    naverPrice: n.price ? Math.round(n.price) : 0,
    naverDailyCost: n.daily ? Math.round(n.daily) : 0
  };
}
