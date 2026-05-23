// Cloudflare Pages Function: Compare 1-3 products side by side
// File path: functions/compare-products.js
// URL: /compare-products?ids=om_005,om_001,om_002&profile=balanced

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
      error: "config_missing"
    }), { status: 500, headers });
  }

  const url = new URL(request.url);
  const idsParam = (url.searchParams.get("ids") || "").trim();
  const profileId = (url.searchParams.get("profile") || "balanced").trim();

  if (!idsParam) {
    return new Response(JSON.stringify({
      error: "bad_request",
      message: "Missing ids parameter (comma-separated product IDs)"
    }), { status: 400, headers });
  }

  const requestedIds = idsParam.split(",").map(s => s.trim()).filter(Boolean).slice(0, 3);

  // ─── PROFILE WEIGHTS ────────────────────────────
  const PROFILES = {
    "premium_seeker": { label: "\uCD5C\uACE0 \uD488\uC9C8 \uC120\uD638", weights: { dose: 30, form: 20, source: 20, cert: 20, price: 10 } },
    "budget_seeker": { label: "\uAC00\uC131\uBE44 \uC120\uD638", weights: { dose: 20, form: 15, source: 15, cert: 10, price: 40 } },
    "balanced": { label: "\uAD50\uD615\uD615 (\uAE30\uBCF8\uAC12)", weights: { dose: 30, form: 20, source: 20, cert: 20, price: 10 } },
    "pregnancy": { label: "\uC784\uC0B0\uBD80\u00B7\uC218\uC720\uBD80", weights: { dose: 15, form: 15, source: 30, cert: 35, price: 5 } },
    "senior": { label: "\uC2DC\uB2C8\uC5B4 (50+)", weights: { dose: 35, form: 25, source: 15, cert: 15, price: 10 } },
    "vegan": { label: "\uBE44\uAC74/\uC2DD\uBB3C\uC131", weights: { dose: 25, form: 15, source: 25, cert: 25, price: 10 } },
    "kid": { label: "\uC5B4\uB9B0\uC774", weights: { dose: 20, form: 15, source: 25, cert: 30, price: 10 } }
  };
  const profile = PROFILES[profileId] || PROFILES["balanced"];

  // ─── HELPERS ────────────────────────────────────
  function normalizeKey(s) {
    return String(s).replace(/[\s_\-\(\)\[\]]/g, "").toLowerCase();
  }
  function getField(fields, ...candidates) {
    if (!fields) return null;
    for (const cand of candidates) {
      if (fields[cand] !== undefined && fields[cand] !== null && fields[cand] !== "") return fields[cand];
    }
    const normalizedCands = candidates.map(normalizeKey);
    const allKeys = Object.keys(fields);
    for (const key of allKeys) {
      const normKey = normalizeKey(key);
      if (normalizedCands.indexOf(normKey) !== -1) {
        if (fields[key] !== undefined && fields[key] !== null && fields[key] !== "") return fields[key];
      }
    }
    for (const key of allKeys) {
      const normKey = normalizeKey(key);
      for (const nc of normalizedCands) {
        if (normKey.indexOf(nc) !== -1 || nc.indexOf(normKey) !== -1) {
          if (fields[key] !== undefined && fields[key] !== null && fields[key] !== "") return fields[key];
        }
      }
    }
    return null;
  }

  // ─── SCORING ────────────────────────────────────
  function scoreDose(d) {
    if (!d || d <= 0) return 20;
    if (d >= 1500) return 100;
    if (d >= 1000) return 80;
    if (d >= 600) return 60;
    if (d >= 500) return 40;
    return 20;
  }
  function scoreForm(form) {
    if (!form) return 50;
    const f = String(form).toLowerCase();
    if (f.indexOf("rtg") !== -1) return 100;
    if (f.indexOf("phospholipid") !== -1) return 95;
    if (f === "tg") return 90;
    if (f === "ee") return 60;
    return 50;
  }
  function scoreSource(supplier) {
    if (!supplier) return 40;
    const s = String(supplier).toLowerCase();
    const trusted = ["dsm", "basf", "epax", "croda", "solutex", "kd"];
    for (const t of trusted) if (s.indexOf(t) !== -1) return 90;
    return 60;
  }
  function scoreCert(certs) {
    if (!certs || String(certs).trim() === "") return 0;
    let score = 0;
    const c = String(certs).toUpperCase();
    if (c.indexOf("IFOS") !== -1) {
      if (c.indexOf("5-STAR") !== -1 || c.indexOf("5\uC2A4\uD0C0") !== -1) score += 40;
      else score += 25;
    }
    if (c.indexOf("GMP") !== -1) score += 20;
    if (c.indexOf("GOED") !== -1) score += 20;
    if (c.indexOf("MSC") !== -1) score += 15;
    if (c.indexOf("NSF") !== -1) score += 15;
    if (c.indexOf("ISO") !== -1) score += 10;
    return Math.min(100, score);
  }
  function scorePrice(p) {
    if (!p || p <= 0) return 50;
    if (p <= 200) return 100;
    if (p <= 400) return 90;
    if (p <= 600) return 80;
    if (p <= 900) return 60;
    if (p <= 1200) return 40;
    return 20;
  }

  // ─── FETCH ALL PRODUCTS ─────────────────────────
  const productsUrl = "https://api.airtable.com/v0/" + BASE_ID + "/product_v2?maxRecords=100";
  const res = await fetch(productsUrl, {
    headers: { Authorization: "Bearer " + TOKEN }
  });
  if (!res.ok) {
    return new Response(JSON.stringify({
      error: "airtable_error",
      message: await res.text()
    }), { status: 500, headers });
  }
  const data = await res.json();
  const records = data.records || [];

  // ─── EXTRACT REQUESTED PRODUCTS ─────────────────
  const products = [];
  for (const reqId of requestedIds) {
    const found = records.find(r => {
      const f = r.fields || {};
      const pid = getField(f, "product_id", "productId");
      return pid === reqId;
    });
    
    if (!found) {
      products.push({ id: reqId, error: "not_found" });
      continue;
    }

    const f = found.fields || {};
    const productName = getField(f, "\uC81C\uD488\uBA85", "name") || "";
    let imageUrl = getField(f, "이미지URL", "imageUrl", "image", "이미지", "photo") || "";
    if (Array.isArray(imageUrl) && imageUrl.length > 0) {
      const att = imageUrl[0];
      if (att.thumbnails && att.thumbnails.large) imageUrl = att.thumbnails.large.url;
      else if (att.url) imageUrl = att.url;
      else imageUrl = "";
    } else if (typeof imageUrl === 'object' && imageUrl !== null) {
      imageUrl = imageUrl.url || "";
    }
    const dailyMg = parseFloat(getField(f, "EPA_DHA_\uD569\uACC4_mg")) || 0;
    const epaMg = parseFloat(getField(f, "EPA_mg")) || 0;
    const dhaMg = parseFloat(getField(f, "DHA_mg")) || 0;
    const dailyCapsules = parseFloat(getField(f, "1\uC77C_\uCEA1\uC290\uC218")) || 1;
    const purity = getField(f, "\uC21C\uB3C4", "purity") || "";
    const form = getField(f, "\uC81C\uD615", "form") || "";
    const supplier = getField(f, "\uC6D0\uB8CC\uC0AC", "supplier") || "";
    const certsRaw = getField(f, "\uC778\uC99D", "certs");
    const certs = Array.isArray(certsRaw) ? certsRaw.join(", ") : String(certsRaw || "");
    const certCount = parseFloat(getField(f, "\uC778\uC99D\uAC2F\uC218")) || 0;
    const dailyCost = parseFloat(getField(f, "1\uC77C\uBE44\uC6A9_\uC6D0", "dailyCost")) || 0;
    const listPrice = parseFloat(getField(f, "\uC815\uAC00_\uC6D0")) || 0;
    const salePrice = parseFloat(getField(f, "\uD560\uC778\uAC00_\uC6D0")) || 0;
    const capsulesPerBottle = parseFloat(getField(f, "1\uD1B5_\uCEA1\uC290\uC218")) || 0;
    const reviews = parseFloat(getField(f, "\uB9AC\uBDF0\uC218")) || 0;
    const tier = getField(f, "Tier\uB4F1\uAE09", "tier") || "";
    const passFail = getField(f, "\uD568\uB7C9_Pass_Fail") || "";
    const coupangLink = getField(f, "coupang_url", "coupangUrl", "coupangLink", "\uCFE0\uD314_\uD30C\uD2B8\uB108\uC2A4_\uB9C1\uD06C") || "";

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

    products.push({
      id: reqId,
      name: productName,
      image: imageUrl,
      coupangLink: coupangLink,
      tier: tier,
      passFail: passFail,
      vScore: total,
      detailScores: {
        dose: dose,
        form: formScore,
        source: sourceScore,
        cert: certScore,
        price: priceScore,
        total: total
      },
      keySpec: {
        dailyMg: dailyMg,
        epaMg: epaMg,
        dhaMg: dhaMg,
        dailyCapsules: dailyCapsules,
        dailyCost: Math.round(dailyCost),
        listPrice: listPrice,
        salePrice: salePrice,
        capsulesPerBottle: capsulesPerBottle,
        purity: purity,
        form: form,
        supplier: supplier,
        certs: certs,
        certCount: certCount,
        reviews: reviews
      },
      highDoseFlag: highDoseFlag
    });
  }

  // ─── COMPUTE WINNERS ───────────────────────────
  // 각 항목별 1위 찾기
  const validProducts = products.filter(p => !p.error);
  const winners = {};
  
  if (validProducts.length > 0) {
    // 함량 (높을수록 좋음)
    const maxDose = Math.max(...validProducts.map(p => p.keySpec.dailyMg));
    winners.dose = validProducts
      .filter(p => p.keySpec.dailyMg === maxDose)
      .map(p => p.id);
    
    // 가격 (낮을수록 좋음)
    const minCost = Math.min(...validProducts.filter(p => p.keySpec.dailyCost > 0).map(p => p.keySpec.dailyCost));
    winners.price = validProducts
      .filter(p => p.keySpec.dailyCost === minCost && p.keySpec.dailyCost > 0)
      .map(p => p.id);
    
    // V-Score 종합
    const maxScore = Math.max(...validProducts.map(p => p.vScore));
    winners.total = validProducts
      .filter(p => p.vScore === maxScore)
      .map(p => p.id);
    
    // 인증
    const maxCert = Math.max(...validProducts.map(p => p.detailScores.cert));
    if (maxCert > 0) {
      winners.cert = validProducts
        .filter(p => p.detailScores.cert === maxCert)
        .map(p => p.id);
    }
    
    // 리뷰수
    const maxReviews = Math.max(...validProducts.map(p => p.keySpec.reviews));
    if (maxReviews > 0) {
      winners.reviews = validProducts
        .filter(p => p.keySpec.reviews === maxReviews)
        .map(p => p.id);
    }
  }

  return new Response(JSON.stringify({
    profile: { id: profileId, label: profile.label, weights: profile.weights },
    requestedIds: requestedIds,
    products: products,
    winners: winners,
    notFound: products.filter(p => p.error).map(p => p.id),
    disclaimer: "\u00A0\uBCF8 V-Score\uB294 \uACF5\uAC1C\uB41C \uC81C\uD488 \uB370\uC774\ud130 \uAE30\uBC18\uC758 \uAC1D\uAD00\uC801 \uC9C0\uD45C\uC774\uBA70, \uAC1C\uC778\uC758 \uAC74\uAC15 \uC0C1\uD0DC\u00B7\uC57D\uBB3C\u00B7\uC54C\uB808\uB974\uAE30\uC5D0 \ub530\ub77c \uCD5C\uC801 \uC81C\ud488\uC740 \ub2E4\ub97c \uC218 \uC788\uC2B5\ub2C8\ub2E4."
  }), { status: 200, headers });
}
