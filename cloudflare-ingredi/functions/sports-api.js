// functions/sports-api.js  v2.4  (2026-09-18)
// Cloudflare Pages Function: 운동 보충제 추천 (v2.0 — 2026-09-14 기준표 v2.1 전면 반영)
//   단백질 core = 1회 단백질 g ÷ 25g(순도는 원료 등급 축) · 원료 등급 첫 표기 기준(WPI=WPH 100/MPI 85/ISP 75/WPC 60/미기재 30)
//   인증 종류별 가산(도핑 검사 40·3rd party 25·GMP 20·FSMS 15·HACCP 10, 배합 속성 0) · 원료 브랜드 축 0.1
//   부스터 통합(표방 성분 평균, 카페인 2분 폐지) · 베타알라닌·시트룰린 신설(종전 미노출 25개)
// (v1.4 정제도 미기재 30 / v1.3 중앙 설정 / v1.2 단백질 파우더 명명 / v1.1 가격 폴백)
// URL: /sports?category=<단백질|크레아틴|아미노산|부스터|카르니틴>&sub=<서브필터>&weight=<kg>
//
// [규제 분리] 기존 4개 카테고리(recommend2.js)는 식약처 인정 기능성 기준.
//   이 엔드포인트는 국제스포츠영양학회(ISSN) 포지션 스탠드 기준으로 채점한다.
//   두 도메인은 근거 체계가 다르므로 API·화면·화자를 분리한다.
//
// [근거등급] 성분유형별 3단계. 카테고리가 아니라 "성분"의 속성이다.
//   issn      — ISSN 포지션 스탠드 + 명시된 권장 용량 있음 → 채점
//   issn_cond — ISSN 스탠드 있으나 대상 제한 → 채점
//   none      — ISSN 스탠드 없음 → 채점하지 않음(quality=null), 가격순 정렬
//
//   "기준 없음"은 우리 평가가 아니라 사실 진술이다. 근거가 얇은 성분에
//   등급을 매기면 등급 체계 자체의 신뢰가 흔들리므로 아예 매기지 않는다.
//
// [체중 개인화] HMB(38mg/kg)·카페인(3mg/kg)은 ISSN 권장이 체중 비례다.
//   고정 앵커를 쓸 수 없으므로 ?weight= 로 받는다. 미지정 시 70kg.
//   저장하지 않는다(요청 단위).

import { getRecords } from "./_lib/airtable.js";
import { TABLES } from "./_lib/tables.js";   // [v1.3] 테이블명 중앙 설정
import { gradeOf } from "./_lib/axis-scores.js";   // [v2.1] 등급 컷 단일 출처

// [2026-09-06] 파트너 데이터 갱신: 08.12(185행) → 09.04(180행), 쿠팡 URL 전량 등록됨.
// 캐시 키가 테이블명 기반(at:테이블명)이라 전환 시 별도 purge 불필요 — 새 키로 새로 쌓인다.
const TABLE = TABLES["스포츠"];
const DEFAULT_WEIGHT = 70;

// ── 카테고리 → 서브필터(성분유형) 매핑 ──
// 서브필터 순서 = 화면 탭 순서. 채점 유형을 앞에 둔다.
const CATEGORIES = {
  "단백질":   { label: "단백질",   subs: ["웨이프로틴", "웨이트게이너"] },
  "크레아틴": { label: "크레아틴", subs: ["크레아틴"] },
  "아미노산": { label: "아미노산", subs: ["EAA", "베타알라닌", "HMB", "BCAA", "글루타민", "시트룰린"] },   // [v2.2] 단일 아미노산 계열 통합(근거 강한 순). 베타알라닌·아르기닌·시트룰린은 부스터에서 이동
  "부스터":   { label: "부스터",   subs: ["부스터"] },   // [v2.2] 프리워크아웃 혼합 제품 유형 하나 — 카페인 기준
  "카르니틴": { label: "카르니틴", subs: ["카르니틴"] }
};

const CAT_ALIASES = {
  "protein":"단백질","단백질":"단백질","웨이":"단백질","프로틴":"단백질",
  "creatine":"크레아틴","크레아틴":"크레아틴",
  "amino":"아미노산","아미노산":"아미노산","eaa":"아미노산","bcaa":"아미노산",
  "booster":"부스터","부스터":"부스터","preworkout":"부스터",
  "carnitine":"카르니틴","카르니틴":"카르니틴"
};

// ── 성분유형별 정의 ──
//  tier   : 근거등급
//  label  : 화면 표시명
//  anchor : 절대 앵커(mg 등). perKg면 체중 × 계수
//  core   : 원본 레코드 → 근거 원값
//  calc   : (core점수, 부가점수) → quality. null이면 채점 불가
const TYPES = {
  // ══ 단백질 — [v2.0] core를 "1회 단백질 g ÷ 25g"으로 재정의(순도는 원료 등급 축이 담당, 이중 계산 해소)
  "웨이프로틴": {
    name: "단백질 파우더",
    tier: "issn", label: "1회 단백질",
    anchorLabel: "1회 단백질 25g",
    note: "ISSN 단백질 지침의 1회 권장 20~40g 중 하한 근접값 25g을 기준으로 봅니다. 원료 순도(WPI·WPC 등)는 별도 축으로 봅니다.",
    core: (f, N) => N(f["단백질_g"]),
    anchor: () => 25, unit: "g",
    calc: (core, x) => 0.5 * core + 0.3 * x.purity + 0.2 * x.cert
  },
  "웨이트게이너": {
    tier: "issn", label: "게이너",
    anchorLabel: "1회 단백질 40g",
    note: "ISSN 단백질 지침의 1회 권장 20~40g 중 상한을 기준으로 봅니다. 열량·탄수화물은 점수에 넣지 않습니다. 대상은 식사로 열량을 채우기 어려운 분입니다.",
    core: (f, N) => N(f["단백질_g"]),
    anchor: () => 40, unit: "g",
    calc: (core, x) => 0.5 * core + 0.3 * x.purity + 0.2 * x.cert
  },
  // ══ 단일 성분 — [v2.0] 원료 브랜드 축(0.1) 추가: [core × 0.7] + [브랜드 × 0.1] + [인증 × 0.2]
  "크레아틴": {
    tier: "issn", label: "크레아틴",
    anchorLabel: "1일 3,000mg",
    note: "ISSN 크레아틴 지침의 유지 용량 3~5g 중 하한을 기준으로 봅니다. 모노하이드레이트 외 형태(HCl·완충)는 ISSN 근거가 없습니다.",
    core: (f, N) => N(f["크레아틴_모노하이드레이트_mg"]) || N(f["크레아틴_mg"]),
    anchor: () => 3000, unit: "mg",
    calc: (core, x) => 0.7 * core + 0.1 * x.brand + 0.2 * x.cert
  },
  "EAA": {
    tier: "issn", label: "EAA",
    anchorLabel: "총 EAA 10,000mg",
    note: "ISSN 단백질 지침은 1회 단백질 20~40g이 EAA 10~12g에 해당한다고 봅니다. 그 하한을 기준으로 합니다. 류신 2.5g 미만이면 카드에 표시합니다.",
    core: (f, N) => N(f["EAA총량_mg"]),
    anchor: () => 10000, unit: "mg",
    calc: (core, x) => 0.7 * core + 0.1 * x.brand + 0.2 * x.cert
  },
  "HMB": {
    tier: "issn_cond", label: "HMB",
    anchorLabel: "체중 1kg당 38mg",
    note: "ISSN 지침이 있으나 대상이 제한적입니다. 근력·파워 개선은 비훈련자에서 뚜렷하고, 훈련된 사람에서는 결과가 엇갈립니다.",
    core: (f, N) => N(f["CaHMB_mg"]),
    anchor: (w) => Math.round(w * 38), perKg: true, unit: "mg",
    calc: (core, x) => 0.7 * core + 0.1 * x.brand + 0.2 * x.cert
  },
  // [v2.0] 신설 — 종전에는 어느 탭에도 노출되지 않던 25개 제품
  "베타알라닌": {
    tier: "issn", label: "베타알라닌",
    anchorLabel: "1일 3,200mg",
    note: "ISSN 베타알라닌 포지션 스탠드(2015): 4주 이상 3.2~6.4g/일 누적 섭취 시 근지구력 개선. 유효 범위 하한 3,200mg을 기준으로 봅니다(시장 제품은 1일 1.6~3.4g).",
    core: (f, N) => N(f["베타알라닌_mg"]),
    anchor: () => 3200, unit: "mg",
    calc: (core, x) => 0.7 * core + 0.1 * x.brand + 0.2 * x.cert
  },
  "시트룰린": {
    // [v2.0] 데이터 실태: 이 유형은 L-아르기닌 6,000mg 제품들이며 시트룰린은 22~1,000mg 곁들임. 아르기닌은 ISSN 근거 불일치,
    //        시트룰린은 3g 이상에서만 조건부 → 무채점. 시트룰린이 실제 유효량으로 든 제품은 "부스터" 통합 규칙이 채점한다.
    name: "아르기닌·시트룰린",
    tier: "none", label: "아르기닌·시트룰린",
    note: "L-아르기닌은 ISSN에서 수행능력 근거가 일관되지 않고, 시트룰린은 1회 3g 이상에서만 조건부 근거가 있습니다. 이 유형은 아르기닌 위주 제품이라 등급을 매기지 않고 가격순으로 보여드립니다.",
    show: (f, N) => { const a = N(f["L아르기닌_mg"]), c = N(f["L시트룰린_mg (수박과피추출물)"]) || N(f["L시트룰린_mg"]);
      return { v: a || c || null, unit: "mg", label: a ? "L-아르기닌" : "L-시트룰린", extra: (a && c) ? `시트룰린 ${Math.round(c)}mg` : null }; }
  },
  // [v2.0] 부스터 통합 — 표방 성분(카페인·시트룰린·베타알라닌) core의 평균. 카페인 유무 2분 폐지.
  "부스터": {
    tier: "issn", label: "부스터",
    anchorLabel: "카페인 체중×3mg (시트룰린 3,000mg · 베타알라닌 1,600mg 병기 시 평균)",
    note: "카페인 함량이 기준입니다 — ISSN 권장 체중 1kg당 3~6mg. 시트룰린·베타알라닌이 유효량으로 들어 있으면 함께 평균합니다. 카페인이 없는 부스터(아르기닌·타우린 기반)는 근거가 없어 등급을 매기지 않아요.",
    multi: (w) => [
      { key: "카페인",   field: "카페인_mg",                       anchor: Math.round(w * 3), min: Math.round(w * 1.5) },
      { key: "시트룰린", field: "L시트룰린_mg (수박과피추출물)",     anchor: 3000,              min: 1500 },
      { key: "베타알라닌", field: "베타알라닌_mg",                   anchor: 1600,              min: 800 }
    ],
    perKg: true, unit: "mg",
    calc: (core, x) => 0.7 * core + 0.1 * x.brand + 0.2 * x.cert
  },
  // ── 무채점(기준 없음) ──
  "BCAA": {
    tier: "none", label: "BCAA",
    note: "ISSN 별도 지침이 없습니다. BCAA 3종만 든 제품보다 필수아미노산 전체가 든 조성에서 더 큰 이득이 확인됐습니다. 등급을 매기지 않고 가격순으로 보여드립니다.",
    show: (f, N) => ({ v: N(f["BCAA_mg"]), unit: "mg", label: "BCAA" })
  },
  "글루타민": {
    tier: "none", label: "글루타민",
    note: "근성장 목적의 ISSN 별도 지침이 없습니다. 등급을 매기지 않고 가격순으로 보여드립니다.",
    show: (f, N) => ({ v: N(f["L글루타민_g"]), unit: "g", label: "L-글루타민" })
  },
  "카르니틴": {
    tier: "none", label: "카르니틴",
    note: "지방 감소 목적의 ISSN 별도 지침이 없습니다. 등급을 매기지 않고 가격순으로 보여드립니다.",
    show: (f, N) => {
      const a = N(f["L카르니틴_mg"]) || 0, b = N(f["L카르니틴_타르트레이트_mg"]) || 0;
      const t = a * 1.0 + b * 0.68;
      return { v: t > 0 ? Math.round(t) : null, unit: "mg", label: "카르니틴" };
    }
  }
};


// ── 단백질 원료 등급 (구 정제도) ──
// [v2.0] 복수 표기("WPC,WPI,ISP")는 라벨 원재료 순서 = 함량 순이므로 첫 표기(주원료)로 판정한다.
//        (옛 방식은 토큰 검사 순서 때문에 WPH 하나 끼면 100점 — 혼합 제품 역전 결함)
//        WPH = WPI 동급: 가수분해는 소화 속도이지 순도가 아니다. 미기재·미분류 = 최하(60)의 50% = 30.
const PURITY = { isolate: 100, milkIsolate: 85, soyIsolate: 75, concentrate: 60, none: 30 };
function purityScore(v) {
  const s = String(v || "").toUpperCase().trim();
  if (!s || s === "-" || s === "NAN") return PURITY.none;
  const first = s.split(/[,/·]/)[0].trim();
  if (/WPH|WPIH|WPI/.test(first)) return PURITY.isolate;
  if (/MPI/.test(first)) return PURITY.milkIsolate;
  if (/ISP|SPI/.test(first)) return PURITY.soyIsolate;
  if (/WPC|MPC|MCC/.test(first)) return PURITY.concentrate;
  return PURITY.none;
}
// ── 인증 가산표 (전 유형 공통, 상한 100) ── [v2.0] 개수 기준 폐지. 배합 속성(Non-GMO·Vegan·Kosher·Halal 등)은 0.
const CERT_TABLE = [
  [/INFORMED\s*SPORT|INFORMED\s*CHOICE|NSF\s*CERTIFIED\s*(FOR\s*)?SPORT|TRUSTED\s*BY\s*SPORT/i, 40, "DOPING"],
  [/3RD[\s-]*PARTY|THIRD[\s-]*PARTY/i, 25, "3RD"],
  [/C?GMP/i, 20, "GMP"],
  [/FSSC\s*22000|ISO\s*22000|^NSF$/i, 15, "FSMS"],
  [/HACCP/i, 10, "HACCP"],
  [/\bTGA\b|FDA\s*REGISTERED/i, 10, "REG"]
];
function certScore(v) {
  const s = String(v || "").trim();
  if (!s || s === "-" || s.toLowerCase() === "nan") return 0;
  const hit = new Map();
  for (const tok of s.replace(/[\/·]/g, ",").split(",").map(x => x.trim()).filter(Boolean)) {
    for (const [re, pts, tag] of CERT_TABLE) { if (re.test(tok)) { if (!hit.has(tag)) hit.set(tag, pts); break; } }
  }
  let t = 0; for (const p of hit.values()) t += p;
  return Math.min(t, 100);
}
// ── 원료 브랜드 점수 ── [v2.0] 등록 상표 원료 100 / 원산지·제조사명 70 / 미기재 35 (최하 70의 50%)
const BRAND_RE = /CREAPURE|CARNOSYN|MYHMB|AJIPURE|KYOWA|CARNIPURE|CREATSOLV|CON-?CRET|CREASYN|BETAPOWER|VELOSITOL|PEAKO2|NITROSIGINE/i;
function brandScore(v) {
  const s = String(v || "").trim();
  if (!s || s === "-" || s.toLowerCase() === "nan") return 35;
  return BRAND_RE.test(s) ? 100 : 70;
}


// [v2.1] 등급 컷은 _lib/axis-scores.js 가 유일한 정의 (건기식과 동일 85/70/55/40)

export async function onRequest(context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };
  const request = context.request;
  if (request.method === "OPTIONS") return new Response("", { status: 200, headers });

  const env = context.env;
  if (!env.AIRTABLE_TOKEN || !env.AIRTABLE_BASE_ID) {
    return new Response(JSON.stringify({ error: "config_missing" }), { status: 500, headers });
  }

  const url = new URL(request.url);
  const rawCat = (url.searchParams.get("category") || "단백질").trim();
  const catKey = CAT_ALIASES[rawCat.toLowerCase()] || CAT_ALIASES[rawCat] || rawCat;
  const cfg = CATEGORIES[catKey];
  if (!cfg) {
    return new Response(JSON.stringify({
      error: "invalid_category", message: "Unknown category: " + rawCat,
      available: Object.keys(CATEGORIES)
    }), { status: 400, headers });
  }

  let weight = parseInt(url.searchParams.get("weight") || "", 10);
  if (!(weight >= 40 && weight <= 130)) weight = DEFAULT_WEIGHT;

  const subs = cfg.subs;
  const rawSub = (url.searchParams.get("sub") || "").trim();
  const subKey = subs.indexOf(rawSub) !== -1 ? rawSub : subs[0];
  const t = TYPES[subKey];

  function N(v) {
    if (v === "" || v === null || v === undefined) return null;
    const n = parseFloat(String(v).replace(/,/g, ""));
    return isNaN(n) ? null : n;
  }
  function S(v) {
    if (v === undefined || v === null) return "";
    if (Array.isArray(v)) v = v[0];
    return String(v).trim();
  }
  function img(v) {
    let s = v;
    if (Array.isArray(s) && s.length) {
      const a = s[0];
      s = (a.thumbnails && a.thumbnails.large) ? a.thumbnails.large.url : (a.url || "");
    } else if (s && typeof s === "object") s = s.url || "";
    s = S(s);
    const m = s.match(/\((https?:\/\/[^\s)]+)\)/);
    return m ? m[1] : s;
  }

  let records;
  // [v2.3] 리뷰 인사이트(헬스제품_리뷰인사이트) 병렬 로드 — 실패해도 목록은 나간다
  const reviewPromise = TABLES["리뷰"] && TABLES["리뷰"]["스포츠"]
    ? getRecords(env, TABLES["리뷰"]["스포츠"], { ctx: context }).then(rv => ({ ok: true, rv })).catch(e => ({ ok: false, err: String(e && e.message || e).slice(0, 200) }))
    : Promise.resolve({ ok: true, rv: [] });
  try {
    records = await getRecords(env, TABLE, { ctx: context });
  } catch (e) {
    try { context.waitUntil(reviewPromise.catch(function () {})); } catch (_) {}
    return new Response(JSON.stringify({ error: "airtable_error", message: e.message }), { status: 500, headers });
  }

  // ── 성분유형 판정 ──
  // 부스터는 카페인 표기 유무로 갈린다. 원본에 분류 컬럼이 없으므로 값으로 분기한다.
  // (제로카페인이 선택인 제품이 섞여 있어 "미표기 = 결측"으로 볼 수 없다)
  function typeOf(f) { return S(f["성분유형"]); }   // [v2.0] 부스터 카페인 2분 폐지

  // 1일비용: 원본이 비면 가격 ÷ 총용량 × 1일섭취량으로 재계산한다.
  // 실측 결과 기존값과 오차 10% 이상 불일치가 0건이라 신뢰 가능.
  function dailyCost(f) {
    const c = N(f["1일비용_원"]);
    if (c > 0) return Math.round(c);
    const price = N(f["가격_원"]), tong = N(f["통_개수"]);
    if (!(price > 0 && tong > 0)) return null;
    const vg = N(f["1통_용량 (g)"]), cg = N(f["1일_총_섭취량(g)"]);
    if (vg > 0 && cg > 0) return Math.round(price / (vg * tong) * cg);
    const vc = N(f["1통_용량 (캡슐수)"]), cc = N(f["1일_총_섭취량(캡슐수)"]);
    if (vc > 0 && cc > 0) return Math.round(price / (vc * tong) * cc);
    return null;
  }

  const anchor = t.anchor ? t.anchor(weight) : (t.multi ? t.multi(weight)[0].anchor : null);   // [v2.2] 부스터: 카페인 앵커(체중 반영)를 대표값으로 — "기준 함량 0mg" 표시 버그 수정
  const items = [];

  for (const r of records) {
    const f = r.fields || {};
    if (typeOf(f) !== subKey) continue;
    const name = S(f["제품명"]);
    if (!name) continue;

    const deeplink = S(f["coupang_deeplink"]);
    const coupang = S(f["쿠팡 URL"]);
    const naver = S(f["제품링크"]);

    const it = {
      id: S(f["product_id"]) || r.id,
      name,
      image: img(f["이미지URL"]),
      link: deeplink || coupang || naver,
      isAffiliate: !!deeplink,
      price: N(f["가격_원"]) || N(f["쿠팡가격"]),   // [v1.1] 09.04 테이블은 가격_원 없이 쿠팡가격만 있음 → 비교표 가격이 전부 "—"였던 원인
      dailyCost: dailyCost(f),
      reviewCount: N(f["네이버_리뷰수"]) || N(f["리뷰수"]) || N(f["쿠팡_리뷰수"]) || 0,   // [v2.4] 네이버 → 구분없음 → 쿠팡
      reviewSource: N(f["네이버_리뷰수"]) ? "naver" : (N(f["리뷰수"]) ? "unknown" : (N(f["쿠팡_리뷰수"]) ? "coupang" : null)),
      form: S(f["제형"]),
      supplier: S(f["원료사"]),
      certs: S(f["인증"]),
      flavor: S(f["맛"]),
      // 식약처 인정 기능성을 별도로 받은 제품이 일부 있다. 있으면 그대로 표시한다.
      mfdsFunction: S(f["주된기능성"])
    };

    if (t.tier === "none") {
      // 무채점: 등급을 계산하지 않는다. 대표 함량만 싣는다.
      const sh = t.show(f, N);
      it.quality = null;
      it.qualityGrade = null;
      it.primary = sh;
    } else {
      // [v2.0] core: 단일 성분은 함량 ÷ 앵커, 부스터는 표방 성분(하한 이상)의 core 평균
      const purity = purityScore(f["정제도(농축(WPC/MPC),분리(WPI 분리유청/MPI/ISP분리대두),가수분해(WPH),표기없음)"]);
      const cert = certScore(f["인증"]);
      const brand = brandScore(f["원료사"]);
      let core = null, primary = null, claimed = null, holdReason = null;
      if (t.multi) {
        const cl = [];
        for (const m of t.multi(weight)) { const v = N(f[m.field]); if (v != null && v >= m.min) cl.push({ key: m.key, v, core: Math.min(v / m.anchor, 1) * 100 }); }
        if (cl.length) {
          core = cl.reduce((a, c) => a + c.core, 0) / cl.length;
          const main = cl.slice().sort((a, b) => b.core - a.core)[0];
          primary = { v: Math.round(main.v), unit: "mg", label: main.key }; claimed = cl.map(c => c.key);
        } else { holdReason = "카페인 없음"; primary = { v: null, unit: "mg", label: "카페인" }; }   // [v2.2] 사용자에게 읽히는 사유로
      } else {
        const raw = t.core(f, N);
        if (raw == null || !(raw > 0)) { holdReason = "함량 미표기"; primary = { v: null, unit: t.unit || "mg", label: t.label }; }
        else { core = Math.min(raw / anchor, 1) * 100; primary = { v: Math.round(raw), unit: t.unit || "mg", label: t.label }; }
      }
      if (core == null) { it.quality = null; it.qualityGrade = null; it.holdReason = holdReason; }
      else {
        const q = t.calc(core, { purity, cert, brand });
        it.quality = Math.round(q * 10) / 10; it.qualityGrade = gradeOf(it.quality); it.core = Math.round(core);
      }
      it.primary = primary; it.claimed = claimed;
      it.purityScore = purity; it.brandScore = brand; it.certScore = cert;
      // [v2.0] EAA 류신 역치(ISSN 근합성 2.5g) 미달 표시 — 점수 미반영
      if (subKey === "EAA") { const leu = N(f["류신_mg"]); it.leucineLow = (leu != null && leu < 2500) ? leu : null; }
      // [v1.2] 단백질 원료 라벨 — 정제도 토큰이 1차 근거(ISP=대두, MPI/MPC=우유단백), 오리진의 산양유 표기가 2차.
      if (catKey === "단백질") {
        const ptxt = String(f["정제도(농축(WPC/MPC),분리(WPI 분리유청/MPI/ISP분리대두),가수분해(WPH),표기없음)"] || "").toUpperCase();
        const otxt = String(f["단백질오리진(우유 / 산양유 / 대두 / 완두 / 현미 / 혼합)"] || "");
        const hasWhey = /WP[CIH]/.test(ptxt), hasSoy = /ISP|SPI|PPI|RPI/.test(ptxt), hasMilk = /MP[CI]/.test(ptxt);
        const goat = /산양유/.test(otxt), plant = /식물|대두|완두|현미/.test(otxt);
        it.proteinSource = goat ? "산양유 단백"
          : (hasWhey && hasSoy) ? "유청·대두 혼합"
          : (hasWhey && hasMilk) ? "유청·우유단백 혼합"
          : (hasWhey && plant) ? "유청·식물성 혼합"
          : hasWhey ? "유청(웨이)"
          : hasSoy ? "대두 단백"
          : hasMilk ? "우유 단백"
          : (ptxt.trim() && ptxt.trim() !== "-") ? "표기 확인 필요"
          : "원료 미표기";
      }
      it.certScore = cert;
      it.purity = S(f["정제도(농축(WPC/MPC),분리(WPI 분리유청/MPI/ISP분리대두),가수분해(WPH),표기없음)"]);
    }
    items.push(it);
  }

  // ── 가성비 경계(파레토) ──
  // "이보다 싸면서 더 좋은 제품이 없는" 제품. 동률은 둘 다 경계에 남는다.
  // 순수 가격순은 "적게 넣고 싸게 판 제품"에 상을 주므로, 품질을 함께 본 경계를 쓴다.
  // (recommend2와 동일한 정의 — 두 도메인의 가성비 개념을 어긋나게 두지 않는다)
  for (const it of items) {
    it.isPareto = false;
    if (it.quality == null || !(it.dailyCost > 0)) continue;
    it.isPareto = !items.some(o =>
      o !== it && o.quality != null && o.dailyCost > 0 &&
      o.dailyCost <= it.dailyCost && o.quality >= it.quality &&
      (o.dailyCost < it.dailyCost || o.quality > it.quality)
    );
  }

  // ── 정렬 ──
  // 기본은 성분 우선(품질점수 내림차순). 미채점은 항상 뒤(0점으로 둔갑시키지 않는다).
  // 가성비 우선 정렬은 프런트에서 같은 데이터를 재정렬한다(추가 요청 없음).
  // 무채점 유형: 함량 표기 여부 → 1일비용 오름차순.
  const scored = items.filter(x => x.quality != null);
  const rest = items.filter(x => x.quality == null);

  // [v2.3] 리뷰 인사이트 조인 (recommend2 v8.2와 같은 형태: {good:[{label,score,text}], caution:[...], evidence})
  const rres = await reviewPromise;
  let reviewMatched = 0;
  if (rres.ok && rres.rv.length) {
    const rmap = {};
    for (const r of rres.rv) {
      const f = r.fields || {};
      const pid = S(f["product_id"]); if (!pid) continue;
      const rate = (k) => N(f[k.replace(/_(\d)$/, "_rate_$1_pct")]) || N(f[k.replace(/_(\d)$/, "_score_$1")]);
      const mk = (k) => S(f[k]) ? { label: S(f[k]), score: rate(k.replace("_label_", "_")), text: S(f[k.replace("_label_", "_text_")]) || null } : null;
      const good = [mk("good_label_1"), mk("good_label_2")].filter(Boolean);
      const caution = [mk("caution_label_1"), mk("caution_label_2")].filter(Boolean);
      const isLogi = x => /포장|배송/.test(x.label);
      good.sort((a, b) => (isLogi(a) - isLogi(b)));
      const totalM = S(f["review_count_display"]).match(/([\d,]+)\s*건/);
      rmap[pid] = { good, caution, evidence: S(f["review_evidence_level"]) || S(f["evidence_level"]) || null, insightScore: N(f["review_insight_score"]) || null, /* [v2.3] 09.18 컬럼명 */ total: totalM ? N(totalM[1].replace(/,/g, "")) : null, labeled: N(f["review_count_labeled"]) || null };
    }
    for (const it of items) { const rv = rmap[String(it.id || "").trim()]; if (rv && (rv.good.length || rv.caution.length)) { it.reviews = rv; reviewMatched++; if (rv.total > 0) { it.reviewCount = rv.total; it.reviewSource = "naver"; it.reviewLabeled = rv.labeled || null; } } }   // [v2.4] 요약 있으면 리뷰 수도 네이버 전체 건수
  }
  let list;
  if (t.tier === "none") {
    const has = items.filter(x => x.primary && x.primary.v != null);
    const no = items.filter(x => !x.primary || x.primary.v == null);
    const byCost = (a, b) => {
      const ac = a.dailyCost == null ? Infinity : a.dailyCost;
      const bc = b.dailyCost == null ? Infinity : b.dailyCost;
      return ac - bc;
    };
    list = has.sort(byCost).concat(no.sort(byCost));
  } else {
    scored.sort((a, b) => b.quality - a.quality || (a.dailyCost || 1e9) - (b.dailyCost || 1e9));
    list = scored.concat(rest);
  }
  list.forEach((x, i) => { x.rank = i + 1; });

  // 비교 문장용 분포 (해당 서브필터 안에서만)
  function dist(vals) {
    const v = vals.filter(x => x != null && x > 0).sort((a, b) => a - b);
    if (!v.length) return null;
    return { min: v[0], max: v[v.length - 1], median: v[Math.floor(v.length / 2)], count: v.length, arr: v };
  }

  return new Response(JSON.stringify({
    domain: "sports",
    category: catKey,
    categories: Object.keys(CATEGORIES),
    subs: subs.map(k => ({ key: k, label: TYPES[k].name || TYPES[k].label, tier: TYPES[k].tier })),   // [v1.2] 탭엔 유형 이름
    sub: subKey,
    tier: t.tier,
    tierNote: t.note,
    anchorLabel: t.anchorLabel || null,
    perKg: !!t.perKg,
    weight: t.perKg ? weight : null,
    anchor,
    cuts: { A: 85, B: 70, C: 55, D: 40 },
    total: list.length,
    scoredCount: t.tier === "none" ? 0 : scored.length,
    dist: {
      primary: dist(list.map(x => x.primary && x.primary.v)),
      cost: dist(list.map(x => x.dailyCost))
    },
    products: list,
    reviewsReady: !!(rres && rres.ok), reviewMatched,   // [v2.3]
    disclaimer: "본 평가는 국제스포츠영양학회(ISSN) 포지션 스탠드와 공개된 제품 데이터를 기준으로 한 지표입니다. 대부분 일반식품이며, 일부 제품은 식약처 기능성 인정을 별도로 받아 카드에 표시됩니다. 개인의 건강 상태·약물·알레르기에 따라 최적 제품은 다를 수 있습니다."
  }), { status: 200, headers });
}
