// Cloudflare Pages Function: Unified category recommendation (v2)
// File path: functions/recommend2.js
// URL: /recommend2?category=<오메가3|눈|마이크로바이옴|비타민C>
//
// 새 통합 스키마용. 미리 계산된 V_Score·등급·추천사유를 읽어 V_Score 순으로 정렬한다.
// 기존 recommend.js(omega3 product_v2)는 유지 — 프론트 전환 완료 후 교체 예정.
//
// [딥링크] link 는 coupang_deeplink(제휴 추적 링크) 우선, 없으면 원본 제품링크로 폴백.
//          제휴 링크를 통과한 클릭만 쿠팡 수수료가 인정되므로 이 매핑이 정산의 핵심.

import { getRecords } from "./_lib/airtable.js";

// 카테고리 → 테이블명 + 핵심성분 설정
const CATEGORIES = {
  "오메가3":        { table: "오메가3",        primary: { field: "EPA_DHA_mg",     label: "EPA+DHA",  unit: "mg" }, extra: ["EPA_mg", "DHA_mg", "캡슐당순도"] },
  "눈":            { table: "눈",            primary: { field: "루테인_mg",       label: "루테인",    unit: "mg" }, extra: ["지아잔틴_mg", "아스타잔틴_mg", "EPA_DHA_mg", "베타카로틴_mg", "비타민A"] },
  "마이크로바이옴":  { table: "마이크로바이옴",  primary: { field: "보장균수_억",     label: "보장균수",  unit: "억" }, extra: ["프리바이오틱스", "포스트바이오틱스", "다중코팅", "냉장유통"] },
  "비타민C":        { table: "비타민C",        primary: { field: "비타민C함량_mg",  label: "비타민C",   unit: "mg" }, extra: ["제형구분"] }
};

// 영문/약식 별칭 → 표준 카테고리명
const CATEGORY_ALIASES = {
  "omega3": "오메가3", "omega": "오메가3", "오메가3": "오메가3", "오메가": "오메가3",
  "eye": "눈", "lutein": "눈", "눈": "눈",
  "probiotics": "마이크로바이옴", "유산균": "마이크로바이옴", "microbiome": "마이크로바이옴", "마이크로바이옴": "마이크로바이옴",
  "vitaminc": "비타민C", "vitamin_c": "비타민C", "vitc": "비타민C", "비타민c": "비타민C", "비타민C": "비타민C"
};

export async function onRequest(context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json"
  };
  const request = context.request;
  if (request.method === "OPTIONS") return new Response("", { status: 200, headers });

  const env = context.env;
  if (!env.AIRTABLE_TOKEN || !env.AIRTABLE_BASE_ID) {
    return new Response(JSON.stringify({ error: "config_missing" }), { status: 500, headers });
  }

  const url = new URL(request.url);
  const rawCat = (url.searchParams.get("category") || "오메가3").trim();
  const catKey = CATEGORY_ALIASES[rawCat.toLowerCase()] || CATEGORY_ALIASES[rawCat] || rawCat;
  const cfg = CATEGORIES[catKey];
  if (!cfg) {
    return new Response(JSON.stringify({
      error: "invalid_category", message: "Unknown category: " + rawCat,
      available: Object.keys(CATEGORIES)
    }), { status: 400, headers });
  }

  // ── 데이터 로드 (KV 캐시) ──
  let records;
  try {
    records = await getRecords(env, cfg.table);
  } catch (e) {
    return new Response(JSON.stringify({ error: "airtable_error", message: e.message }), { status: 500, headers });
  }

  function num(v) { const n = parseFloat(String(v).replace(/,/g, "")); return isNaN(n) ? 0 : n; }
  function str(v) { return (v === undefined || v === null) ? "" : String(v); }
  function cleanImage(v) {
    let img = v || "";
    if (Array.isArray(img) && img.length > 0) {
      const att = img[0];
      img = (att.thumbnails && att.thumbnails.large) ? att.thumbnails.large.url : (att.url || "");
    } else if (typeof img === "object" && img !== null) {
      img = img.url || "";
    }
    if (typeof img === "string" && img.indexOf("(http") !== -1) {
      const m = img.match(/\((https?:\/\/[^\s)]+)\)/);
      if (m) img = m[1];
    }
    return img || "";
  }

  // ── 매핑 ──
  const items = records.map(r => {
    const f = r.fields || {};
    const extra = {};
    for (const k of cfg.extra) extra[k] = f[k] !== undefined ? f[k] : null;

    // 딥링크 우선, 없으면 원본 제품링크로 폴백
    const deeplink = str(f.coupang_deeplink);
    const rawLink = str(f.제품링크);
    const outLink = deeplink || rawLink;

    return {
      id: str(f.product_id) || r.id,
      name: str(f.제품명),
      image: cleanImage(f.이미지URL),
      link: outLink,
      isAffiliate: !!deeplink,   // 딥링크(수수료 인정 링크) 적용 여부
      form: str(f.제형),
      supplier: str(f.원료사),
      certs: str(f.인증),
      price: num(f.가격_원),
      dailyCost: Math.round(num(f["1일비용_원"])),
      dailyCapsules: num(f["1일캡슐수"]),
      capsuleMg: num(f.캡슐용량_mg),
      reviewCount: num(f.리뷰수),
      function: str(f.주된기능성),
      vScore: num(f.V_Score),
      grade: str(f.등급),
      reason: str(f.추천사유),
      profile: str(f.추천프로필),
      primaryValue: num(f[cfg.primary.field]),
      scores: { core: num(f.핵심성분점수), cost: num(f.비용점수), review: num(f.리뷰점수) },
      extra
    };
  }).filter(it => it.name); // 이름 없는 빈 행 제외

  // ── V_Score 정렬 ──
  items.sort((a, b) => b.vScore - a.vScore);
  items.forEach((it, i) => { it.rank = i + 1; });

  // ── 분포 (카드 막대용): 핵심성분 / 1일비용 / 캡슐 ──
  function dist(vals) {
    const v = vals.filter(x => x > 0);
    if (v.length === 0) return null;
    const sum = v.reduce((a, b) => a + b, 0);
    return { min: Math.min(...v), max: Math.max(...v), avg: Math.round(sum / v.length), count: v.length };
  }
  const distributions = {
    primary: dist(items.map(it => it.primaryValue)),
    cost:    dist(items.map(it => it.dailyCost)),
    capsule: dist(items.map(it => it.capsuleMg))
  };

  return new Response(JSON.stringify({
    category: catKey,
    metrics: {
      primary: { field: cfg.primary.field, label: cfg.primary.label, unit: cfg.primary.unit, higherBetter: true,  dist: distributions.primary },
      cost:    { label: "1일 비용", unit: "원", higherBetter: false, dist: distributions.cost },
      capsule: { label: "캡슐 크기", unit: "mg", higherBetter: false, dist: distributions.capsule }
    },
    total: items.length,
    products: items,
    disclaimer: "\u00A0\uBCF8 V-Score\uB294 \uACF5\uAC1C\uB41C \uC81C\uD488 \uB370\uC774\uD130 \uAE30\uBC18\uC758 \uAC1D\uAD00\uC801 \uC9C0\uD45C\uC774\uBA70, \uAC1C\uC778\uC758 \uAC74\uAC15 \uC0C1\uD0DC\u00B7\uC57D\uBB3C\u00B7\uC54C\uB808\uB974\uAE30\uC5D0 \ub530\ub77c \uCD5C\uC801 \uC81C\ud488\uC740 \ub2E4\ub97c \uC218 \uC788\uC2B5\ub2C8\ub2E4."
  }), { status: 200, headers });
}
