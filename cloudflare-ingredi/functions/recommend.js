// Cloudflare Pages Function: Product recommendation with V-Score (v4)
// File path: functions/recommend.js
// URL: /recommend?profile=<profile_id>&query=<optional>
//
// v4 changes:
// - Loose column name matching (handles whitespace/special chars)
// - Coupang link extraction works regardless of exact column name

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
  const debug = url.searchParams.get("debug") === "true";

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

  // ─── LOOSE FIELD VALUE GETTER ─────────────────────
  // 컬럼명에 공백/특수문자/언더스코어 차이가 있어도 잘 찾음
  function normalizeKey(s) {
    return String(s).replace(/[\s_\-\(\)\[\]]/g, "").toLowerCase();
  }

  function getField(fields, ...candidates) {
    if (!fields) return null;
    
    // 1. 정확 매칭 시도
    for (const cand of candidates) {
      if (fields[cand] !== undefined && fields[cand] !== null && fields[cand] !== "") {
        return fields[cand];
      }
    }
    
    // 2. 정규화 매칭 (공백/언더스코어 무시)
    const normalizedCands = candidates.map(normalizeKey);
    const allKeys = Object.keys(fields);
    for (const key of allKeys) {
      const normKey = normalizeKey(key);
      if (normalizedCands.indexOf(normKey) !== -1) {
        if (fields[key] !== undefined && fields[key] !== null && fields[key] !== "") {
          return fields[key];
        }
      }
    }
    
    // 3. 부분 매칭 (키 포함 관계)
    for (const key of allKeys) {
      const normKey = normalizeKey(key);
      for (const nc of normalizedCands) {
        if (normKey.indexOf(nc) !== -1 || nc.indexOf(normKey) !== -1) {
          if (fields[key] !== undefined && fields[key] !== null && fields[key] !== "") {
            return fields[key];
          }
        }
      }
    }
    
    return null;
  }

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
    if (f.indexOf("\uBBF8\uAE30\uC7AC") !== -1) return 30;
    return 50;
  }

  function scoreSource(supplier) {
    if (!supplier) return 40;
    const s = String(supplier).toLowerCase();
    if (s.indexOf("\uBBF8\uAE30\uC7AC") !== -1) return 40;
    
    const trustedSuppliers = ["dsm", "basf", "epax", "croda", "gc rieber", "solutex", "kd\uD30C\uB9C8"];
    for (let i = 0; i < trustedSuppliers.length; i++) {
      if (s.indexOf(trustedSuppliers[i]) !== -1) return 90;
    }
    
    const knownRegions = ["\uB178\uB974\uC6E8\uC774", "\uD398\uB8E8", "\uC2A4\uD398\uC778", "\uCEAC\uB098\uB2E4", "\uC54C\uB798\uC2A4\uCE74"];
    for (let i = 0; i < knownRegions.length; i++) {
      if (s.indexOf(knownRegions[i]) !== -1) return 70;
    }
    
    return 60;
  }

  function scoreCert(certs) {
    if (!certs || String(certs).trim() === "" || String(certs).indexOf("\uBBF8\uAE30\uC7AC") !== -1) return 0;
    
    let score = 0;
    const certText = String(certs).toUpperCase();
    
    if (certText.indexOf("IFOS") !== -1) {
      if (certText.indexOf("5-STAR") !== -1 || certText.indexOf("5\uC2A4\uD0C0") !== -1) {
        score += 40;
      } else {
        score += 25;
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

  // ─── DEBUG: dump first record's keys ──────────────
  if (debug && records.length > 0) {
    return new Response(JSON.stringify({
      debug: true,
      firstRecord: records[0].fields,
      allKeys: Object.keys(records[0].fields)
    }, null, 2), { status: 200, headers });
  }

  // ─── SCORE EACH PRODUCT ─────────────────────────
  const scored = records.map(function(record) {
    const f = record.fields || {};
    
    // 느슨한 매칭으로 모든 필드 추출
    const productId = getField(f, "product_id", "productId", "\uC81C\uD488ID");
    const productName = getField(f, "\uC81C\uD488\uBA85", "name", "productName") || "";
    let imageUrl = getField(f, "이미지URL", "imageUrl", "image", "이미지", "photo") || "";
    // Airtable Attachment 형식 처리
    if (Array.isArray(imageUrl) && imageUrl.length > 0) {
      const att = imageUrl[0];
      if (att.thumbnails && att.thumbnails.large) {
        imageUrl = att.thumbnails.large.url;
      } else if (att.url) {
        imageUrl = att.url;
      } else {
        imageUrl = "";
      }
    } else if (typeof imageUrl === 'object' && imageUrl !== null) {
      imageUrl = imageUrl.url || "";
    }
    const dailyMg = parseFloat(getField(f, "EPA_DHA_\uD569\uACC4_mg", "epaDha", "EPA_DHA")) || 0;
    const dailyCapsules = parseFloat(getField(f, "1\uC77C_\uCEA1\uC290\uC218", "dailyCapsules")) || 1;
    const purity = getField(f, "\uC21C\uB3C4", "purity");
    const form = getField(f, "\uC81C\uD615", "form");
    const supplier = getField(f, "\uC6D0\uB8CC\uC0AC", "supplier");
    const certs = getField(f, "\uC778\uC99D", "certs", "certifications");
    const dailyCost = parseFloat(getField(f, "1\uC77C\uBE44\uC6A9_\uC6D0", "dailyCost")) || 0;
    const tier = getField(f, "Tier\uB4F1\uAE09", "tier");
    const passFail = getField(f, "\uD568\uB7C9_Pass_Fail", "passFail", "pass_fail");
    
    // 쿠팡 링크 ─ 다양한 컬럼명 시도
    const coupangLink = getField(f, 
      "\uCFE0\uD314_\uD30C\uD2B8\uB108\uC2A4_\uB9C1\uD06C",     // 쿠팡_파트너스_링크
      "\uCFE0\uD314_\uC0C1\uC138\uD398\uC774\uC9C0_\uB9C1\uD06C", // 쿠팡_상세페이지_링크
      "\uCFE0\uD314 url",                                          // 쿠팡 url (원본)
      "\uCFE0\uD314_url",                                          // 쿠팡_url
      "coupangUrl",
      "coupangLink",
      "url"
    ) || "";

    const dose = scoreDose(dailyMg);
    const formScore = scoreForm(form);
    const sourceScore = scoreSource(supplier);
    const certScore = scoreCert(certs);
    const priceScore = scorePrice(dailyCost);

    const w = profile.weights;
    let total = (
      dose * w.dose / 100 +
      formScore * w.form / 100 +
      sourceScore * w.source / 100 +
      certScore * w.cert / 100 +
      priceScore * w.price / 100
    );

    let highDoseFlag = false;
    if (dailyMg > 2000) {
      total = Math.min(80, total);
      highDoseFlag = true;
    }
    total = Math.round(total);

    return {
      record: record,
      fields: f,
      productId: productId,
      productName: productName,
      imageUrl: imageUrl,
      coupangLink: coupangLink,
      tier: tier,
      passFail: passFail,
      form: form,
      supplier: supplier,
      certs: certs,
      purity: purity,
      dailyMg: dailyMg,
      dailyCost: Math.round(dailyCost),
      scores: {
        dose: dose,
        form: formScore,
        source: sourceScore,
        cert: certScore,
        price: priceScore,
        total: total
      },
      highDoseFlag: highDoseFlag
    };
  });

  // ─── APPLY FILTERS ──────────────────────────────
  let filtered = scored.filter(function(item) {
    if (!includeFailed && item.passFail === "Fail") {
      return false;
    }
    if (profile.filters.minDailyDose && item.dailyMg < profile.filters.minDailyDose) {
      return false;
    }
    if (profile.filters.veganOnly) {
      const nameLower = String(item.productName).toLowerCase();
      const isVegan = nameLower.indexOf("\uC2DD\uBB3C\uC131") !== -1 || 
                      nameLower.indexOf("vegan") !== -1 ||
                      nameLower.indexOf("algae") !== -1 ||
                      nameLower.indexOf("\uBBF8\uC138\uC870\uB958") !== -1;
      if (!isVegan) return false;
    }
    return true;
  });

  filtered.sort(function(a, b) { return b.scores.total - a.scores.total; });

  const top3 = filtered.slice(0, 3).map(function(item, idx) {
    return {
      rank: idx + 1,
      id: item.productId || item.record.id,
      name: item.productName,
      image: item.imageUrl,
      coupangLink: item.coupangLink,
      keySpec: {
        dailyMg: item.dailyMg,
        dailyCost: item.dailyCost,
        form: item.form || "",
        supplier: item.supplier || "",
        certs: item.certs || "",
        purity: item.purity,
        tier: item.tier || ""
      },
      vScore: item.scores.total,
      detailScores: item.scores,
      highDoseFlag: item.highDoseFlag,
      passFail: item.passFail || ""
    };
  });

  const rest = filtered.slice(3, 30).map(function(item, idx) {
    return {
      rank: idx + 4,
      id: item.productId || item.record.id,
      name: item.productName,
      image: item.imageUrl || "",
      vScore: item.scores.total,
      tier: item.tier || "",
      dailyMg: item.dailyMg || 0,
      dailyCost: item.dailyCost || 0,
      form: item.form || "",
      supplier: item.supplier || "",
      coupangLink: item.coupangLink
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
