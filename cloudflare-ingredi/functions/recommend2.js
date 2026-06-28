// Cloudflare Pages Function: Unified category recommendation (v4)
// File path: functions/recommend2.js
// URL: /recommend2?category=<오메가3|눈|마이크로바이옴|비타민C>
//
// 구조: 두 테이블을 product_id로 조인한다.
//   - table     = product DB(오메가3/눈/마이크로바이옴/비타민C): V_Score·등급·추천사유·핵심성분·캡슐·비용 등 스코어/스펙
//   - linkTable = *_쿠팡업데이트: 제품링크(네이버) / 쿠팡 URL(raw) / coupang_deeplink(파트너스 딥링크)
//
// [딥링크] 링크 우선순위 = coupang_deeplink → 쿠팡 URL(raw) → 제품링크(네이버).
//          isAffiliate 는 coupang_deeplink 가 있을 때만 true.
//          linkTable 로드 실패 시 product DB 자체의 제품링크(있으면)로 안전 폴백.

import { getRecords } from "./_lib/airtable.js";

const CATEGORIES = {
  "오메가3":        { table: "오메가3",        linkTable: "오메가3_쿠팡업데이트",        primary: { field: "EPA_DHA_mg",     label: "EPA+DHA",  unit: "mg" }, extra: ["EPA_mg", "DHA_mg", "캡슐당순도"] },
  "눈":            { table: "눈",            linkTable: "눈_쿠팡업데이트",            primary: { field: "루테인_mg",       label: "루테인",    unit: "mg" }, extra: ["지아잔틴_mg", "아스타잔틴_mg", "EPA_DHA_mg", "베타카로틴_mg", "비타민A"] },
  "마이크로바이옴":  { table: "마이크로바이옴",  linkTable: "마이크로바이옴_쿠팡업데이트",  primary: { field: "보장균수_억",     label: "보장균수",  unit: "억" }, extra: ["프리바이오틱스", "포스트바이오틱스", "다중코팅", "냉장유통"] },
  "비타민C":        { table: "비타민C",        linkTable: "비타민C_쿠팡업데이트",        primary: { field: "비타민C함량_mg",  label: "비타민C",   unit: "mg" }, extra: ["제형구분"] }
};

const CATEGORY_ALIASES = {
  "omega3": "오메가3", "omega": "오메가3", "오메가3": "오메가3", "오메가": "오메가3",
  "eye": "눈", "lutein": "눈", "눈": "눈",
  "probiotics": "마이크로바이옴", "유산균": "마이크로바이옴", "microbiome": "마이크로바이옴", "마이크로바이옴": "마이크로바이옴",
  "vitaminc": "비타민C", "vitamin_c": "비타민C", "vitc": "비타민C", "비타민c": "비타민C", "비타민C": "비타민C"
};

const RAW_COUPANG_FIELDS = ["쿠팡 URL", "쿠팡URL", "쿠팡_URL", "쿠팡링크"];

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

  function num(v) { const n = parseFloat(String(v).replace(/,/g, "")); return isNaN(n) ? 0 : n; }
  function str(v) { return (v === undefined || v === null) ? "" : String(v); }
  function readField(f, names) {
    for (const k of names) {
      let v = f[k];
      if (Array.isArray(v)) v = v[0];
      v = (v === undefined || v === null) ? "" : String(v).trim();
      if (v) return v;
    }
    return "";
  }
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

  // ── 데이터 로드: product DB + 링크 테이블 ──
  let records, linkRecords = [];
  try {
    records = await getRecords(env, cfg.table);
  } catch (e) {
    return new Response(JSON.stringify({ error: "airtable_error", message: e.message }), { status: 500, headers });
  }
  let linkError = null;
  try {
    linkRecords = await getRecords(env, cfg.linkTable);
  } catch (e) {
    linkError = e.message; // 링크 테이블 없거나 캐시 미스 → 폴백(제품 DB의 제품링크) 사용
  }

  // product_id → 링크 정보 맵
  const linkMap = {};
  for (const r of linkRecords) {
    const f = r.fields || {};
    const pid = str(f.product_id);
    if (!pid) continue;
    linkMap[pid] = {
      deeplink: str(f.coupang_deeplink),
      rawCoupang: readField(f, RAW_COUPANG_FIELDS),
      naver: str(f.제품링크),
      name: str(f.제품명),
      image: cleanImage(f.이미지URL),
      coupangPrice: num(f.쿠팡가격)
    };
  }

  // ── 매핑 (조인) ──
  let affiliateCount = 0;
  const items = records.map(r => {
    const f = r.fields || {};
    const extra = {};
    for (const k of cfg.extra) extra[k] = f[k] !== undefined ? f[k] : null;

    const pid = str(f.product_id) || r.id;
    const lk = linkMap[pid] || {};

    // 링크 우선순위: 파트너스 딥링크 → raw 쿠팡 → 네이버(링크테이블 → 없으면 제품DB)
    const partnersLink = lk.deeplink || "";
    const rawCoupang = lk.rawCoupang || "";
    const naverLink = lk.naver || str(f.제품링크);
    const outLink = partnersLink || rawCoupang || naverLink;
    if (partnersLink) affiliateCount++;

    return {
      id: pid,
      name: str(f.제품명) || lk.name || "",
      image: cleanImage(f.이미지URL) || lk.image || "",
      link: outLink,
      isAffiliate: !!partnersLink,
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
  }).filter(it => it.name);

  items.sort((a, b) => b.vScore - a.vScore);
  items.forEach((it, i) => { it.rank = i + 1; });

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
    affiliateCount,
    linkError,
    products: items,
    disclaimer: "\u00A0\uBCF8 V-Score\uB294 \uACF5\uAC1C\uB41C \uC81C\uD488 \uB370\uC774\uD130 \uAE30\uBC18\uC758 \uAC1D\uAD00\uC801 \uC9C0\uD45C\uC774\uBA70, \uAC1C\uC778\uC758 \uAC74\uAC15 \uC0C1\uD0DC\u00B7\uC57D\uBB3C\u00B7\uC54C\uB808\uB974\uAE30\uC5D0 \ub530\ub77c \uCD5C\uC801 \uC81C\ud488\uC740 \ub2E4\ub97c \uC218 \uC788\uC2B5\ub2C8\ub2E4."
  }), { status: 200, headers });
}
