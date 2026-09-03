// Cloudflare Pages Function: 스포츠 뉴트리션 추천 (v1.0)
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

const TABLE = "헬스제품_단백질_부스터_2026.08.12";
const DEFAULT_WEIGHT = 70;

// ── 카테고리 → 서브필터(성분유형) 매핑 ──
// 서브필터 순서 = 화면 탭 순서. 채점 유형을 앞에 둔다.
const CATEGORIES = {
  "단백질":   { label: "단백질",   subs: ["웨이프로틴", "웨이트게이너"] },
  "크레아틴": { label: "크레아틴", subs: ["크레아틴"] },
  "아미노산": { label: "아미노산", subs: ["EAA", "HMB", "BCAA", "글루타민"] },
  "부스터":   { label: "부스터",   subs: ["부스터_카페인", "부스터_비카페인"] },
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
  "웨이프로틴": {
    tier: "issn", label: "웨이프로틴",
    anchorLabel: "단백질 밀도 80%",
    note: "1회 섭취량 중 단백질이 차지하는 비율. WPC 순도 상한 80%를 기준으로 봅니다.",
    core: (f, N) => {
      const p = N(f["단백질_g"]), s = N(f["1일_총_섭취량(g)"]);
      return (p > 0 && s > 0) ? (p / s) * 100 : null;
    },
    anchor: () => 80,
    calc: (core, x) => (x.purity == null) ? null : 0.5 * core + 0.3 * x.purity + 0.2 * x.cert
  },
  "웨이트게이너": {
    tier: "issn", label: "게이너",
    anchorLabel: "1회 단백질 40g",
    note: "ISSN 단백질 지침의 1회 권장 20~40g 중 상한을 기준으로 봅니다. 열량·탄수화물은 점수에 넣지 않습니다.",
    core: (f, N) => N(f["단백질_g"]),
    anchor: () => 40,
    calc: (core, x) => (x.purity == null) ? null : 0.5 * core + 0.3 * x.purity + 0.2 * x.cert
  },
  "크레아틴": {
    tier: "issn", label: "크레아틴",
    anchorLabel: "1일 3,000mg",
    note: "ISSN 크레아틴 지침의 유지 용량 3~5g 중 하한을 기준으로 봅니다. 모노하이드레이트는 원료가 표준화되어 제품 간 품질 차이가 크지 않습니다.",
    core: (f, N) => N(f["크레아틴_모노하이드레이트_mg"]) || N(f["크레아틴_mg"]),
    anchor: () => 3000,
    calc: (core, x) => 0.8 * core + 0.2 * x.cert
  },
  "EAA": {
    tier: "issn", label: "EAA",
    anchorLabel: "총 EAA 10,000mg",
    note: "ISSN 단백질 지침은 1회 단백질 20~40g이 EAA 10~12g에 해당한다고 봅니다. 그 하한을 기준으로 합니다.",
    core: (f, N) => N(f["EAA총량_mg"]),
    anchor: () => 10000,
    calc: (core, x) => 0.8 * core + 0.2 * x.cert
  },
  "HMB": {
    tier: "issn_cond", label: "HMB",
    anchorLabel: "체중 1kg당 38mg",
    note: "ISSN 지침이 있으나 대상이 제한적입니다. 근력·파워 개선은 비훈련자에서 뚜렷하고, 훈련된 사람에서는 결과가 엇갈립니다.",
    core: (f, N) => N(f["CaHMB_mg"]),
    anchor: (w) => Math.round(w * 38),
    perKg: true,
    calc: (core, x) => 0.8 * core + 0.2 * x.cert
  },
  "부스터_카페인": {
    tier: "issn", label: "카페인",
    anchorLabel: "체중 1kg당 3mg",
    note: "ISSN 카페인 지침의 권장 3~6mg/kg 중 하한을 기준으로 봅니다. 9mg/kg 이상은 부작용만 늘고 추가 이득이 없습니다.",
    core: (f, N) => N(f["카페인_mg"]),
    anchor: (w) => Math.round(w * 3),
    perKg: true,
    calc: (core, x) => 0.8 * core + 0.2 * x.cert
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
    // 형태별 순수 카르니틴 환산: 유리형 100%, 타르트레이트 68%
    // 아세틸형·믹스는 연구 맥락이 달라 합산하지 않는다(표기만)
    show: (f, N) => {
      const a = N(f["L카르니틴_mg"]) || 0, b = N(f["L카르니틴_타르트레이트_mg"]) || 0;
      const t = a * 1.0 + b * 0.68;
      return { v: t > 0 ? Math.round(t) : null, unit: "mg", label: "카르니틴" };
    }
  },
  "부스터_비카페인": {
    tier: "none", label: "비카페인",
    note: "카페인이 들어 있지 않은 제품입니다. 아르기닌·타우린 등은 ISSN 별도 지침이 없어 등급을 매기지 않고 가격순으로 보여드립니다.",
    show: (f, N) => ({ v: N(f["L아르기닌_mg"]), unit: "mg", label: "L-아르기닌" })
  }
};

// ── 정제도 점수 ──
// 문자열에 여러 형태가 콤마로 들어온다. 가짓수가 아니라 "최고 등급"으로 판정한다.
// 여러 원료를 섞은 것이 더 좋다는 근거가 없고, 오히려 저가 원료 혼입 신호일 수 있다.
function purityScore(v) {
  const s = String(v || "").toUpperCase();
  if (!s || s === "-" || s === "NAN") return null;
  if (s.indexOf("WPH") !== -1 || s.indexOf("WPIH") !== -1) return 100; // 가수분해
  if (s.indexOf("WPI") !== -1 || s.indexOf("MPI") !== -1) return 85;   // 분리(유청·우유)
  if (s.indexOf("ISP") !== -1) return 75;                              // 분리(대두) — 급원 차이로 한 단계 하향
  if (s.indexOf("WPC") !== -1 || s.indexOf("MPC") !== -1) return 60;   // 농축
  return null;  // '혼합'·'유청' 등 미분류 → 평가 준비중
}

// 인증 개수 기반. 인증은 제조·안전 인증이지 효능 보증이 아니므로 가중치를 낮게 둔다.
function certScore(v) {
  const s = String(v || "").trim();
  if (!s || s === "-" || s === "nan") return 0;
  const k = s.replace(/[\/·]/g, ",").split(",").map(x => x.trim()).filter(Boolean).length;
  return k === 0 ? 0 : k === 1 ? 40 : k === 2 ? 70 : 100;
}

function gradeOf(q) {
  return q == null ? null : q >= 85 ? "A" : q >= 70 ? "B" : q >= 55 ? "C" : q >= 40 ? "D" : "E";
}

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
  try {
    records = await getRecords(env, TABLE, { ctx: context });
  } catch (e) {
    return new Response(JSON.stringify({ error: "airtable_error", message: e.message }), { status: 500, headers });
  }

  // ── 성분유형 판정 ──
  // 부스터는 카페인 표기 유무로 갈린다. 원본에 분류 컬럼이 없으므로 값으로 분기한다.
  // (제로카페인이 선택인 제품이 섞여 있어 "미표기 = 결측"으로 볼 수 없다)
  function typeOf(f) {
    const raw = S(f["성분유형"]);
    if (raw === "부스터") return N(f["카페인_mg"]) != null ? "부스터_카페인" : "부스터_비카페인";
    return raw;
  }

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

  const anchor = t.anchor ? t.anchor(weight) : null;
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
      price: N(f["가격_원"]),
      dailyCost: dailyCost(f),
      reviewCount: N(f["리뷰수"]) || 0,
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
      const raw = t.core(f, N);
      const purity = purityScore(f["정제도(농축(WPC/MPC),분리(WPI 분리유청/MPI/ISP분리대두),가수분해(WPH),표기없음)"]);
      const cert = certScore(f["인증"]);
      if (raw == null || !(raw > 0)) {
        it.quality = null; it.qualityGrade = null;
        it.primary = { v: null, unit: subKey === "웨이프로틴" ? "%" : "mg", label: t.label };
      } else {
        const core = Math.min(raw / anchor, 1) * 100;
        const q = t.calc(core, { purity, cert });
        it.quality = (q == null) ? null : Math.round(q * 10) / 10;
        it.qualityGrade = gradeOf(it.quality);
        it.core = Math.round(core);
        it.primary = {
          v: subKey === "웨이프로틴" ? Math.round(raw) : Math.round(raw),
          unit: subKey === "웨이프로틴" ? "%" : (subKey === "웨이트게이너" ? "g" : "mg"),
          label: t.label
        };
      }
      it.purityScore = purity;
      it.certScore = cert;
      it.purity = S(f["정제도(농축(WPC/MPC),분리(WPI 분리유청/MPI/ISP분리대두),가수분해(WPH),표기없음)"]);
    }
    items.push(it);
  }

  // ── 정렬 ──
  // 채점 유형: 품질점수 내림차순. 미채점은 항상 뒤(0점으로 둔갑시키지 않는다).
  // 무채점 유형: 함량 표기 여부 → 1일비용 오름차순.
  //   순수 가격순으로 하면 "적게 넣고 싸게 판 제품"이 최상단에 오므로 표기 여부를 앞에 둔다.
  const scored = items.filter(x => x.quality != null);
  const rest = items.filter(x => x.quality == null);

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
    subs: subs.map(k => ({ key: k, label: TYPES[k].label, tier: TYPES[k].tier })),
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
    disclaimer: "본 평가는 국제스포츠영양학회(ISSN) 포지션 스탠드와 공개된 제품 데이터를 기준으로 한 지표입니다. 대부분 일반식품이며, 일부 제품은 식약처 기능성 인정을 별도로 받아 카드에 표시됩니다. 개인의 건강 상태·약물·알레르기에 따라 최적 제품은 다를 수 있습니다."
  }), { status: 200, headers });
}
