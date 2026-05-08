// Cloudflare Pages Function: Product recommendation with V-Score (v3)
// File path: functions/recommend.js
// URL: /recommend?profile=<profile_id>&query=<optional>
//
// v3 changes:
// - Aligned with Oliver's actual Airtable column names (product table)
// - Case A: EPA_DHA_합계_mg is already daily total (no multiplication)
// - Tier-based filtering integrated (Fail/조사중 excluded)
// - Profiles: premium_seeker, budget_seeker, balanced, pregnancy, senior, vegan, kid

export async function onRequest(context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json"
  };
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response("", { status: 200, headers });
  }

  const env = context.env;
  const TOKEN = env.AIRTABLE_TOKEN;
  const BASE_ID = env.AIRTABLE_BASE_ID;

  if (!TOKEN || !BASE_ID) {
    return new Response(JSON.stringify({
      error: "config_missing",
      message: "Environment variables not set"
    }), { status: 500, headers });
  }

  const url = new URL(request.url);
  const profileId = (url.searchParams.get("profile") || "balanced").trim();
  const query = (url.searchParams.get("query") || "").trim();
  const includeFailed = url.searchParams.get("includeFailed") === "true";

  // ─── PROFILE → WEIGHTS MAPPING ───────────────────
  const PROFILES = {
    "premium_seeker": {
      label: "\uCD5C\uACE0 \uD488\uC9C8 \uC120\uD638",
      weights: { dose: 30, form: 20, source: 20, cert: 20, price: 10 },
      filters: {},
      medicalConsult: false
    },
    "budget_seeker": {
      label: "\uAC00\uC131\uBE44 \uC120\uD638",
      weights: { dose: 20, form: 15, source: 15, cert: 10, price: 40 },
      filters: {},
      medicalConsult: false
    },
    "balanced": {
      label: "\uAD50\uD615\uD615 (\uAE30\uBCF8\uAC12)",
      weights: { dose: 30, form: 20, source: 20, cert: 20, price: 10 },
      filters: {},
      medicalConsult: false
    },
    "pregnancy": {
      label: "\uC784\uC0B0\uBD80\u00B7\uC218\uC720\uBD80",
      weights: { dose: 15, form: 15, source: 30, cert: 35, price: 5 },
      filters: {},
      medicalConsult: true
    },
    "senior": {
      label: "\uC2DC\uB2C8\uC5B4 (50+)",
      weights: { dose: 35, form: 25, source: 15, cert: 15, price: 10 },
      filters: { minDailyDose: 1000 },
      medicalConsult: false
    },
    "vegan": {
      label: "\uBE44\uAC74/\uC2DD\uBB3C\uC131",
      weights: { dose: 25, form: 15, source: 25, cert: 25, price: 10 },
      filters: { veganOnly: true },
      medicalConsult: false
    },
    "kid": {
      label: "\uC5B4\uB9B0\uC774",
      weights: { dose: 20, form: 15, source: 25, cert: 30, price: 10 },
      filters: {},
      medicalConsult: true
    }
  };

  const profile = PROFILES[profileId];
  if (!profile) {
    return new Response(JSON.stringify({
      error: "invalid_profile",
      message: "Unknown profile: " + profileId,
      availableProfiles: Object.keys(PROFILES)
    }), { status: 400, headers });
  }

  // ─── FETCH PRODUCTS FROM AIRTABLE ────────────────
  const productsUrl = "https://api.airtable.com/v0/" + BASE_ID + "/product?maxRecords=100";
  const res = await fetch(productsUrl, {
    headers: { Authorization: "Bearer " + TOKEN }
  });

  if (!res.ok) {
    const text = await res.text();
    return new Response(JSON.stringify({
      error: "airtable_error",
      status: res.status,
      message: text
    }), { status: 500, headers });
  }
  const data = await res.json();
  const records = data.records || [];

  if (records.length === 0) {
    return new Response(JSON.stringify({
      query: query,
      profile: profileId,
      message: "\uC81C\uD488 DB\uAC00 \uBE44\uC5B4\uC788\uC2B5\uB2C8\uB2E4.",
      products: []
    }), { status: 200, headers });
  }

  // Field name constants — Oliver's actual column names
  const F = {
    id: "product_id",
    name: "\uC81C\uD488\uBA85",
    image: "\uC774\uBBF8\uC9C0URL",
    epaDha: "EPA_DHA_\uD569\uACC4_mg",     // 케이스 A: 이미 1일 합계
    epaMg: "EPA_mg",
    dhaMg: "DHA_mg",
    dailyCapsules: "1\uC77C_\uCEA1\uC290\uC218",
    purity: "\uC21C\uB3C4",
    form: "\uC81C\uD615",
    formGrade: "\uC81C\uD615\uB4F1\uAE09",
    supplier: "\uC6D0\uB8CC\uC0AC",
    certs: "\uC778\uC99D",
    certCount: "\uC778\uC99D\uAC2F\uC218",
    listPrice: "\uC815\uAC00_\uC6D0",
    salePrice: "\uD560\uC778\uAC00_\uC6D0",
    capsulesPerBottle: "1\uD1B5_\uCEA1\uC290\uC218",
    bottles: "\uD1B5_\uAC1C\uC218",
    dailyCost: "1\uC77C\uBE44\uC6A9_\uC6D0",
    pricePer100mg: "EPA_DHA_100mg\uB2F9_\uC6D0",
    reviews: "\uB9AC\uBDF0\uC218",
    tier: "Tier\uB4F1\uAE09",
    passFail: "\uD568\uB7C9_Pass_Fail",
    coupangLink: "\uCFE0\uD314_\uD30C\uD2B8\uB108\uC2A4_\uB9C1\uD06C",
    updatedAt: "\uC5C5\uB370\uC774\uD2B8\uC77C",
    notes: "\uBE44\uACE0"
  };

  // ─── SCORING FUNCTIONS ──────────────────────────
  function scoreDose(dailyMg) {
    if (!dailyMg || dailyMg <= 0) return 20;
    if (dailyMg >= 1500) return 100;
    if (dailyMg >= 1000) return 80;
    if (dailyMg >= 600) return 60;
    if (dailyMg >= 500) return 40;
    return 20;
  }

  function scoreForm(form) {
    if (!form) return 50;
    const f = String(form).toLowerCase();
    if (f.indexOf("rtg") !== -1) return 100;
    if (f.indexOf("phospholipid") !== -1 || f.indexOf("\uC778\uC9C0\uC9C8") !== -1) return 95;
    if (f === "tg" || f.indexOf("triglyceride") !== -1) return 90;
    if (f === "ee" || f.indexOf("ethyl") !== -1) return 60;
    if (f.indexOf("\uBBF8\uAE30\uC7AC") !== -1) return 30; // 미기재
    return 50;
  }

  function scoreSource(supplier) {
    if (!supplier) return 40;
    const s = String(supplier).toLowerCase();
    if (s.indexOf("\uBBF8\uAE30\uC7AC") !== -1) return 40; // 미기재
    
    // 글로벌 신뢰 원료사
    const trustedSuppliers = ["dsm", "basf", "epax", "croda", "gc rieber", "solutex", "kd\uD30C\uB9C8", "kd\u00A0\uD30C\uB9C8"];
    for (let i = 0; i < trustedSuppliers.length; i++) {
      if (s.indexOf(trustedSuppliers[i]) !== -1) return 90;
    }
    
    // 알려진 산지 (국가명만 표시된 경우)
    const knownRegions = ["\uB178\uB974\uC6E8\uC774", "\uD398\uB8E8", "\uC2A4\uD398\uC778", "\uCEAC\uB098\uB2E4", "\uC54C\uB798\uC2A4\uCE74"];
    for (let i = 0; i < knownRegions.length; i++) {
      if (s.indexOf(knownRegions[i]) !== -1) return 70;
    }
    
    return 60; // 기타 (회사명은 있지만 비표준)
  }

  function scoreCert(certs, certCount) {
    if (!certs || String(certs).trim() === "" || String(certs).indexOf("\uBBF8\uAE30\uC7AC") !== -1) return 0;
    
    let score = 0;
    const certText = String(certs).toUpperCase();
    
    // 인증 종류별 점수
    if (certText.indexOf("IFOS") !== -1) {
      if (certText.indexOf("5-STAR") !== -1 || certText.indexOf("5\uC2A4\uD0C0") !== -1) {
        score += 40; // IFOS 5스타
      } else {
        score += 25; // 일반 IFOS
      }
    }
    if (certText.indexOf("GMP") !== -1 || certText.indexOf("CGMP") !== -1) score += 20;
    if (certText.indexOf("GOED") !== -1) score += 20;
    if (certText.indexOf("MSC") !== -1) score += 15;
    if (certText.indexOf("NSF") !== -1) score += 15;
    if (certText.indexOf("ISO") !== -1) score += 10;
    
    return Math.min(100, score);
  }

  function scorePrice(dailyCost) {
    if (!dailyCost || dailyCost <= 0) return 50;
    if (dailyCost <= 200) return 100;
    if (dailyCost <= 400) return 90;
    if (dailyCost <= 600) return 80;
    if (dailyCost <= 900) return 60;
    if (dailyCost <= 1200) return 40;
    return 20;
  }

  // ─── SCORE EACH PRODUCT ─────────────────────────
  const scored = records.map(function(record) {
    const f = record.fields || {};
    const dailyMg = f[F.epaDha] || 0;
    const dailyCost = f[F.dailyCost] || 0;

    const dose = scoreDose(dailyMg);
    const form = scoreForm(f[F.form]);
    const source = scoreSource(f[F.supplier]);
    const cert = scoreCert(f[F.certs], f[F.certCount]);
    const price = scorePrice(dailyCost);

    const w = profile.weights;
    let total = (
      dose * w.dose / 100 +
      form * w.form / 100 +
      source * w.source / 100 +
      cert * w.cert / 100 +
      price * w.price / 100
    );

    // 고함량 페널티 (2000mg 초과)
    let highDoseFlag = false;
    if (dailyMg > 2000) {
      total = Math.min(80, total);
      highDoseFlag = true;
    }
    total = Math.round(total);

    return {
      record: record,
      fields: f,
      dailyMg: dailyMg,
      dailyCost: Math.round(dailyCost),
      scores: {
        dose: dose,
        form: form,
        source: source,
        cert: cert,
        price: price,
        total: total
      },
      highDoseFlag: highDoseFlag
    };
  });

  // ─── APPLY FILTERS ──────────────────────────────
  let filtered = scored.filter(function(item) {
    const f = item.fields;
    
    // 1. Pass/Fail 필터: Fail 자동 제외
    if (!includeFailed && f[F.passFail] === "Fail") {
      return false;
    }
    
    // 2. 프로필별 추가 필터
    if (profile.filters.minDailyDose && item.dailyMg < profile.filters.minDailyDose) {
      return false;
    }
    
    // 3. 비건 프로필: 식물성/algae만 (제품명 또는 원료사로 판단)
    if (profile.filters.veganOnly) {
      const nameLower = String(f[F.name] || "").toLowerCase();
      const supplierLower = String(f[F.supplier] || "").toLowerCase();
      const isVegan = nameLower.indexOf("\uC2DD\uBB3C\uC131") !== -1 || 
                      nameLower.indexOf("vegan") !== -1 ||
                      nameLower.indexOf("algae") !== -1 ||
                      nameLower.indexOf("\uBBF8\uC138\uC870\uB958") !== -1;
      if (!isVegan) return false;
    }
    
    return true;
  });

  // ─── RANK & PICK TOP 3 + REST ───────────────────
  filtered.sort(function(a, b) { return b.scores.total - a.scores.total; });

  const top3 = filtered.slice(0, 3).map(function(item, idx) {
    const f = item.fields;
    return {
      rank: idx + 1,
      id: f[F.id] || item.record.id,
      name: f[F.name] || "",
      image: f[F.image] || "",
      coupangLink: f[F.coupangLink] || "",
      keySpec: {
        dailyMg: item.dailyMg,
        dailyCost: item.dailyCost,
        form: f[F.form] || "",
        supplier: f[F.supplier] || "",
        certs: f[F.certs] || "",
        purity: f[F.purity] || null,
        tier: f[F.tier] || ""
      },
      vScore: item.scores.total,
      detailScores: item.scores,
      highDoseFlag: item.highDoseFlag,
      passFail: f[F.passFail] || ""
    };
  });

  const rest = filtered.slice(3, 30).map(function(item, idx) {
    const f = item.fields;
    return {
      rank: idx + 4,
      id: f[F.id] || item.record.id,
      name: f[F.name] || "",
      vScore: item.scores.total,
      tier: f[F.tier] || "",
      coupangLink: f[F.coupangLink] || ""
    };
  });

  return new Response(JSON.stringify({
    profile: {
      id: profileId,
      label: profile.label,
      weights: profile.weights
    },
    query: query,
    totalProducts: records.length,
    filteredCount: filtered.length,
    excludedCount: records.length - filtered.length,
    top3: top3,
    rest: rest,
    medicalConsult: profile.medicalConsult,
    disclaimer: "\u00A0\uBCF8 V-Score\uB294 \uACF5\uAC1C\uB41C \uC81C\uD488 \uB370\uC774\ud130 \uAE30\uBC18\uC758 \uAC1D\uAD00\uC801 \uC9C0\uD45C\uC774\uBA70, \uAC1C\uC778\uC758 \uAC74\uAC15 \uC0C1\uD0DC\u00B7\uC57D\uBB3C\u00B7\uC54C\uB808\uB974\uAE30\uC5D0 \ub530\ub77c \uCD5C\uC801 \uC81C\ud488\uC740 \ub2E4\ub97c \uC218 \uC788\uC2B5\ub2C8\ub2E4."
  }), { status: 200, headers });
}
