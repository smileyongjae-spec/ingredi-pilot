// Cloudflare Pages Function: Unified category recommendation (v7.2)
// [v6] 엑셀 5축 점수(제형/원료사/인증/최종)를 함께 내려준다. 없으면 null.
// [v7] 품질점수(quality)·절대등급(qualityGrade)·가성비 경계(isPareto)를 서버에서 계산한다.
//      - 품질점수 = 검증 가능한 축만 (가격·리뷰 제외)
//      - 근거함량 = min(원값/임상앵커, 1)×100, 초과 가점 없음 (앵커: knowledge 테이블 근거 용량)
//      - 등급 컷 = A≥85 B≥70 C≥55 D≥40 E — 절대평가, 모집단과 무관
//      - 축 데이터가 없는 제품은 quality=null (평가 준비중) — 0점으로 둔갑시키지 않는다
// [v7.1] 리뷰 인사이트에 마이크로바이옴 추가 — 마이크로바이옴_리뷰인사이트 테이블 실데이터
//        업데이트 완료에 따라 예시 폴백 해제. 4개 카테고리 전체가 실리뷰.
// [v7.2] 진단 계측 추가 (첫 화면 20초 간헐 지연 원인 규명용).
//        *** 추천 로직·응답 필드·캐시 키는 v7.1과 완전히 동일. 계측은 순수 부가. ***
//        - /recommend2?category=X&debug=timing  → 응답에 _timing 블록 추가
//        - /recommend2?category=X&debug=timing&nocache=<CACHE_REFRESH_SECRET>
//          → 캐시를 무시하고 강제 미스 재현 (KV 키를 지우지 않고도 반복 측정 가능)
//        - _timing.dataShape 로 Attachment 가설·컬럼 수 가설을 함께 검증한다
// File path: functions/recommend2.js
// URL: /recommend2?category=<오메가3|눈|마이크로바이옴|비타민C>
//
// 단일 소스: *_쿠팡업데이트 테이블이 V_Score·등급 + 제품링크/쿠팡 URL/coupang_deeplink 를
//            모두 보유한 완전한 테이블이므로, 조인 없이 이 테이블 하나만 읽는다.
//
// [딥링크] 링크 우선순위 = coupang_deeplink(파트너스 딥링크) → 쿠팡 URL(raw) → 제품링크(네이버).
//          isAffiliate 는 coupang_deeplink 가 있을 때만 true.

import { getRecords } from "./_lib/airtable.js";

const CATEGORIES = {
  "오메가3":        { table: "오메가3_쿠팡업데이트",        primary: { field: "EPA_DHA_mg",     label: "EPA+DHA",  unit: "mg" }, extra: ["EPA_mg", "DHA_mg", "캡슐당순도"] },
  "눈":            { table: "눈_쿠팡업데이트",            primary: { field: "루테인_mg",       label: "루테인",    unit: "mg" }, extra: ["지아잔틴_mg", "아스타잔틴_mg", "EPA_DHA_mg", "베타카로틴_mg", "비타민A"] },
  "마이크로바이옴":  { table: "마이크로바이옴_쿠팡업데이트",  primary: { field: "보장균수_억",     label: "보장균수",  unit: "억" }, extra: ["프리바이오틱스", "포스트바이오틱스", "다중코팅", "냉장유통"] },
  "비타민C":        { table: "비타민C_쿠팡업데이트",        primary: { field: "비타민C함량_mg",  label: "비타민C",   unit: "mg" }, extra: ["제형구분"] }
};

const CATEGORY_ALIASES = {
  "omega3": "오메가3", "omega": "오메가3", "오메가3": "오메가3", "오메가": "오메가3",
  "eye": "눈", "lutein": "눈", "눈": "눈",
  "probiotics": "마이크로바이옴", "유산균": "마이크로바이옴", "microbiome": "마이크로바이옴", "마이크로바이옴": "마이크로바이옴",
  "vitaminc": "비타민C", "vitamin_c": "비타민C", "vitc": "비타민C", "비타민c": "비타민C", "비타민C": "비타민C"
};

const RAW_COUPANG_FIELDS = ["쿠팡 URL", "쿠팡URL", "쿠팡_URL", "쿠팡링크"];

// [v7] 품질점수: 카테고리별 산식과 임상 앵커.
//  - 오메가3/유산균: 근거함량 50 + 제형 30 + 인증 20
//  - 눈:            근거함량 70 + 원료품질 30   (제형·인증 축이 원천 데이터에 없음)
//  - 비타민C:        근거함량 60 + 원료품질 40
const QUALITY_CFG = {
  "오메가3":       { anchor: 1000, calc: (core, sc) => (sc.form == null || sc.cert == null) ? null : 0.5*core + 0.3*sc.form + 0.2*sc.cert },
  "눈":           { anchor: 20,   calc: (core, sc) => (sc.supplier == null) ? null : 0.7*core + 0.3*sc.supplier },
  "마이크로바이옴": { anchor: 100,  calc: (core, sc) => (sc.form == null || sc.cert == null) ? null : 0.5*core + 0.3*sc.form + 0.2*sc.cert },
  "비타민C":       { anchor: 1000, calc: (core, sc) => (sc.supplier == null) ? null : 0.6*core + 0.4*sc.supplier }
};
function qualityGradeOf(q) {
  return q == null ? null : q >= 85 ? "A" : q >= 70 ? "B" : q >= 55 ? "C" : q >= 40 ? "D" : "E";
}

// [v7.2] 원천 레코드의 형태를 요약한다 — Attachment 가설·컬럼 수 가설 검증용.
// 20초의 크기를 설명하려면 "왜 페이지 하나가 느린가"를 봐야 하는데,
// 그 유력 후보가 (a) 이미지 Attachment 서명 URL 생성 (b) 불필요한 컬럼 과다 이다.
function describeShape(records, imageField) {
  if (!records || !records.length) return null;
  const colSet = new Set();
  let attachmentCount = 0, stringUrlCount = 0, emptyImgCount = 0;
  let thumbCount = 0;
  for (const r of records) {
    const f = r.fields || {};
    for (const k of Object.keys(f)) colSet.add(k);
    const v = f[imageField];
    if (v === undefined || v === null || v === "") { emptyImgCount++; continue; }
    if (Array.isArray(v)) {
      attachmentCount++;
      const a = v[0];
      if (a && a.thumbnails) thumbCount++;
    } else if (typeof v === "object") {
      attachmentCount++;
      if (v.thumbnails) thumbCount++;
    } else {
      stringUrlCount++;
    }
  }
  // 실제로 서비스가 쓰는 컬럼 대비 얼마나 더 받아오는지
  return {
    records: records.length,
    distinctColumns: colSet.size,
    columnNames: Array.from(colSet).sort(),
    image: {
      field: imageField,
      attachment: attachmentCount,   // ← 높으면 Attachment 가설 유력
      withThumbnails: thumbCount,    // ← 썸네일 생성 부하 지표
      plainString: stringUrlCount,
      empty: emptyImgCount
    }
  };
}

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

  // ── [v7.2] 진단 스위치 ──
  const wantTiming = url.searchParams.get("debug") === "timing";
  const timing = wantTiming ? [] : null;
  const T_START = Date.now();

  // 강제 미스 재현은 시크릿 필요 (공개 엔드포인트 남용 방지 — Airtable 초당 5요청 한도 보호)
  const nocacheKey = url.searchParams.get("nocache") || "";
  const forceMiss = !!(nocacheKey && env.CACHE_REFRESH_SECRET && nocacheKey === env.CACHE_REFRESH_SECRET);

  function num(v) { const n = parseFloat(String(v).replace(/,/g, "")); return isNaN(n) ? 0 : n; }
  function numOrNull(v) {
    if (v === "" || v === null || v === undefined) return null;
    const n = parseFloat(String(v).replace(/,/g, ""));
    return isNaN(n) ? null : n;
  }
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
  // product_id를 강건하게 읽음: 정확 일치 → 정규화(공백/하이픈/대소문자) → 값 패턴(mfds_/new_catalog_)
  function readProductId(f, fallback) {
    let v = f.product_id;
    if (Array.isArray(v)) v = v[0];
    if (v != null && String(v).trim()) return String(v).trim();
    for (const k of Object.keys(f)) {
      const nk = k.trim().toLowerCase().replace(/[-\s]+/g, "_");
      if (nk === "product_id" || nk === "productid") {
        let vv = f[k]; if (Array.isArray(vv)) vv = vv[0];
        vv = (vv == null) ? "" : String(vv).trim();
        if (vv) return vv;
      }
    }
    for (const k of Object.keys(f)) {
      let vv = f[k]; if (Array.isArray(vv)) vv = vv[0];
      vv = (vv == null) ? "" : String(vv).trim();
      if (/^(mfds_|new_catalog_)/i.test(vv)) return vv;
    }
    return fallback || "";
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

  // ── 데이터 로드 (단일 테이블) ──
  let records;
  const tProduct = Date.now();
  try {
    records = await getRecords(env, cfg.table, { timing, force: forceMiss });
  } catch (e) {
    const errBody = { error: "airtable_error", message: e.message };
    if (wantTiming) errBody._timing = { phase: "product_load", ms: Date.now() - tProduct, steps: timing };
    return new Response(JSON.stringify(errBody), { status: 500, headers });
  }
  const msProductLoad = Date.now() - tProduct;

  // 원천 레코드 형태 요약 (진단 모드에서만 계산)
  const dataShape = wantTiming ? describeShape(records, "이미지URL") : null;

  // ── 매핑 ──
  const tMap = Date.now();
  let affiliateCount = 0;
  const items = records.map(r => {
    const f = r.fields || {};
    const extra = {};
    for (const k of cfg.extra) extra[k] = f[k] !== undefined ? f[k] : null;

    // 링크 우선순위: 파트너스 딥링크 → raw 쿠팡 → 네이버
    const partnersLink = str(f.coupang_deeplink).trim();
    const rawCoupang = readField(f, RAW_COUPANG_FIELDS);
    const naverLink = str(f.제품링크).trim();
    const outLink = partnersLink || rawCoupang || naverLink;
    if (partnersLink) affiliateCount++;

    return {
      id: readProductId(f, r.id),
      name: str(f.제품명),
      image: cleanImage(f.이미지URL),
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
      profile: str(f.추천프로필),
      target: str(f.대상분류),
      primaryValue: num(f[cfg.primary.field]),
      scores: {
        core: num(f.핵심성분점수),
        cost: num(f.비용점수),
        review: num(f.리뷰점수),
        // [v6] 엑셀 5축의 나머지. 카테고리마다 축 이름이 다를 수 있어 후보를 순서대로 찾는다.
        form:     numOrNull(readField(f, ["제형점수", "제형편의점수", "리포좀중성점수"])),
        supplier: numOrNull(readField(f, ["원료사점수", "원료사균주점수", "원료품질점수"])),
        cert:     numOrNull(readField(f, ["인증점수", "인증근거점수", "부형제안전점수"])),
        final:    numOrNull(readField(f, ["최종점수"]))
      },
      extra
    };
  }).filter(it => it.name);
  const msMap = Date.now() - tMap;

  // [v7] 품질점수 · 절대등급 · 가성비(파레토) 경계
  const tScore = Date.now();
  const qcfg = QUALITY_CFG[catKey];
  for (const it of items) {
    // 근거 원값: 눈은 루테인+지아잔틴 합, 나머지는 primaryValue 그대로
    const raw = (catKey === "눈")
      ? it.primaryValue + num(it.extra && it.extra["지아잔틴_mg"])
      : it.primaryValue;
    const core = Math.min(raw / qcfg.anchor, 1) * 100;
    const q = qcfg.calc(core, it.scores);
    it.quality = (q == null) ? null : Math.round(q * 10) / 10;
    it.qualityGrade = qualityGradeOf(it.quality);
  }
  // 파레토 경계: "이보다 싸면서 더 좋은 제품이 없는" 제품 (동률은 둘 다 경계에 남는다)
  for (const it of items) {
    it.isPareto = false;
    if (it.quality == null || !(it.dailyCost > 0)) continue;
    it.isPareto = !items.some(o =>
      o !== it && o.quality != null && o.dailyCost > 0 &&
      o.dailyCost <= it.dailyCost && o.quality >= it.quality &&
      (o.dailyCost < it.dailyCost || o.quality > it.quality)
    );
  }

  items.sort((a, b) => b.vScore - a.vScore);
  items.forEach((it, i) => { it.rank = i + 1; });
  const msScore = Date.now() - tScore;

  // ── 리뷰 인사이트 조인 (4개 카테고리 전체) ──
  // [v7.1] 마이크로바이옴_리뷰인사이트 실데이터 업데이트로 예시 폴백 해제.
  const REVIEW_TABLE = { "오메가3": "오메가_리뷰인사이트", "눈": "눈_리뷰인사이트", "비타민C": "비타민C_리뷰인사이트", "마이크로바이옴": "마이크로바이옴_리뷰인사이트" };
  const reviewsReady = !!REVIEW_TABLE[catKey];
  const tReview = Date.now();
  let reviewError = null;
  let reviewMatched = 0;
  if (reviewsReady) {
    try {
      const rv = await getRecords(env, REVIEW_TABLE[catKey], { ttl: 1800, timing, force: forceMiss });
      const rmap = {};
      for (const r of rv) {
        const f = r.fields || {};
        const pid = readProductId(f, "");
        if (!pid) continue;
        const good = [], caution = [];
        if (str(f.good_label_1).trim()) good.push({ label: str(f.good_label_1).trim(), score: num(f.good_score_1) });
        if (str(f.good_label_2).trim()) good.push({ label: str(f.good_label_2).trim(), score: num(f.good_score_2) });
        if (str(f.caution_label_1).trim()) caution.push({ label: str(f.caution_label_1).trim(), score: num(f.caution_score_1) });
        if (str(f.caution_label_2).trim()) caution.push({ label: str(f.caution_label_2).trim(), score: num(f.caution_score_2) });
        rmap[pid] = { good, caution };
      }
      for (const it of items) {
        const rvd = rmap[String(it.id).trim()];
        if (rvd && (rvd.good.length || rvd.caution.length)) { it.reviews = rvd; reviewMatched++; }
      }
    } catch (e) {
      // 리뷰 테이블 조회 실패 시 해당 카테고리는 예시로 폴백
      // [v7.2] 조용한 실패를 진단에서는 드러낸다 (429가 여기 숨어 있을 수 있음)
      reviewError = e && e.message ? String(e.message).slice(0, 300) : "unknown";
    }
  }
  const msReview = Date.now() - tReview;

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

  const payload = {
    category: catKey,
    reviewsReady: reviewsReady,
    metrics: {
      primary: { field: cfg.primary.field, label: cfg.primary.label, unit: cfg.primary.unit, higherBetter: true,  dist: distributions.primary },
      cost:    { label: "1일 비용", unit: "원", higherBetter: false, dist: distributions.cost },
      capsule: { label: "캡슐 크기", unit: "mg", higherBetter: false, dist: distributions.capsule }
    },
    qualityMeta: {
      anchorLabel: { "오메가3":"EPA+DHA 1,000mg", "눈":"루테인+지아잔틴 20mg", "마이크로바이옴":"보장균수 100억", "비타민C":"비타민C 1,000mg" }[catKey],
      cuts: { A: 85, B: 70, C: 55, D: 40 }
    },
    total: items.length,
    affiliateCount,
    products: items,
    disclaimer: "\u00A0\uBCF8 V-Score\uB294 \uACF5\uAC1C\uB41C \uC81C\uD488 \uB370\uC774\uD130 \uAE30\uBC18\uC758 \uAC1D\uAD00\uC801 \uC9C0\uD45C\uC774\uBA70, \uAC1C\uC778\uC758 \uAC74\uAC15 \uC0C1\uD0DC\u00B7\uC57D\uBB3C\u00B7\uC54C\uB808\uB974\uAE30\uC5D0 \ub530\ub77c \uCD5C\uC801 \uC81C\ud488\uC740 \ub2E4\ub97c \uC218 \uC788\uC2B5\ub2C8\ub2E4."
  };

  // ── [v7.2] 진단 블록 ──
  if (wantTiming) {
    const totalMs = Date.now() - T_START;
    const steps = timing || [];
    const pages = steps.filter(s => s.step === "airtable.page");
    const kvGets = steps.filter(s => s.step === "kv.get");
    const kvPuts = steps.filter(s => s.step === "kv.put");
    const payloads = steps.filter(s => s.step === "payload");
    const sum = (arr, f) => arr.reduce((a, b) => a + (f(b) || 0), 0);

    payload._timing = {
      note: "Workers는 I/O 전까지 시계가 멈춰 있어 순수 CPU 구간(map/score)은 0ms로 찍힙니다. 정상입니다.",
      forceMiss,
      totalMs,
      phases: {
        productLoad: msProductLoad,   // 제품 테이블 (캐시 or Airtable)
        map: msMap,                   // 매핑 (CPU)
        score: msScore,               // 품질·파레토·정렬 (CPU, O(n^2))
        reviewLoad: msReview          // 리뷰 테이블 (캐시 or Airtable)
      },
      summary: {
        cacheHits: kvGets.filter(s => s.hit).length,
        cacheMisses: kvGets.filter(s => !s.hit).length,
        airtablePages: pages.length,
        airtableMsTotal: sum(pages, s => s.ms),
        slowestPageMs: pages.length ? Math.max(...pages.map(s => s.ms || 0)) : 0,
        kvGetMsTotal: sum(kvGets, s => s.ms),
        kvPutMsTotal: sum(kvPuts, s => s.ms),
        kvPutFailures: kvPuts.filter(s => !s.ok).length,
        payloadBytesTotal: sum(payloads, s => s.bytes)
      },
      review: { matched: reviewMatched, error: reviewError },
      dataShape,
      steps
    };
  }

  return new Response(JSON.stringify(payload), { status: 200, headers });
}
