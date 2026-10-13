// Cloudflare Pages Function: Product recommendation with V-Score (v4.1)
// File path: functions/recommend.js
// v4.1: vegan, kid 프로필 제거
// v4.2: Airtable 호출에 KV 캐시 적용 (functions/_lib/airtable.js 의 getRecords 사용)

import { getRecords } from "./_lib/airtable.js";

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
    return new Response(JSON.stringify({ error: "config_missing", message: "Environment variables not set" }), { status: 500, headers });
  }

  const url = new URL(request.url);
  const profileId = (url.searchParams.get("profile") || "balanced").trim();
  const query = (url.searchParams.get("query") || "").trim();
  const includeFailed = url.searchParams.get("includeFailed") === "true";
  const debug = url.searchParams.get("debug") === "true";

  // ── 5개 프로필 (vegan, kid 제거) ──
  const PROFILES = {
    "premium_seeker": {
      label: "\uCD5C\uACE0 \uD488\uC9C8 \uC120\uD638",
      weights: { dose: 30, form: 25, source: 25, cert: 15, price: 5 },
      filters: {}, medicalConsult: false
    },
    "budget_seeker": {
      label: "\uAC00\uC131\uBE44 \uC120\uD638",
      weights: { dose: 20, form: 10, source: 10, cert: 10, price: 50 },
      filters: {}, medicalConsult: false
    },
    "balanced": {
      label: "\uAD50\uD615\uD615 (\uAE30\uBCF8\uAC12)",
      weights: { dose: 25, form: 20, source: 20, cert: 20, price: 15 },
      filters: {}, medicalConsult: false
    },
    "pregnancy": {
      label: "\uC784\uC0B0\uBD80\u00B7\uC218\uC720\uBD80",
      weights: { dose: 15, form: 15, source: 30, cert: 35, price: 5 },
      filters: {}, medicalConsult: true
    },
    "senior": {
      label: "\uC2DC\uB2C8\uC5B4 (50+)",
      weights: { dose: 35, form: 25, source: 15, cert: 15, price: 10 },
      filters: { minDailyDose: 1000 }, medicalConsult: false
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

  // ── Airtable 제품 데이터 (KV 캐시 경유) ──
  let records;
  try {
    records = await getRecords(env, "product_v2");
  } catch (e) {
    return new Response(JSON.stringify({ error: "airtable_error", message: e.message }), { status: 500, headers });
  }

  if (records.length === 0) {
    return new Response(JSON.stringify({ profile: profileId, message: "\uC81C\uD488 DB\uAC00 \uBE44\uC5B4\uC788\uC2B5\uB2C8\uB2E4.", products: [] }), { status: 200, headers });
  }

  function normalizeKey(s) { return String(s).replace(/[\s_\-\(\)\[\]]/g, "").toLowerCase(); }
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

  function scoreDose(d) {
    if (!d || d <= 0) return 10;
    if (d >= 1200) return 100;
    if (d >= 1000) return 85;
    if (d >= 850)  return 70;
    if (d >= 700)  return 55;
    if (d >= 600)  return 40;
    if (d >= 500)  return 25;
    return 10;
  }
  function scoreForm(form) {
    if (!form) return 65;
    const f = String(form).toLowerCase();
    if (f.indexOf("\uBBF8\uAE30\uC7AC") !== -1) return 65;
    if (f.indexOf("rtg") !== -1) return 100;
    if (f.indexOf("phospholipid") !== -1 || f.indexOf("\uC778\uC9C0\uC9C8") !== -1) return 90;
    if (f === "tg" || f.indexOf("triglyceride") !== -1) return 80;
    if (f === "ee" || f.indexOf("ethyl") !== -1) return 70;
    return 50;
  }
  function scoreSource(supplier) {
    if (!supplier || String(supplier).trim() === "") return 30;
    const s = String(supplier).toLowerCase();
    if (s.indexOf("\uBBF8\uAE30\uC7AC") !== -1) return 30;
    // 글로벌 프리미엄 원료사 → 85점
    const premium = [
      "dsm", "dsm-firmenich", "meg-3",
      "basf", "pronova",
      "kd-pharma", "kdpharma", "kd\uD30C\uB9C8", "kd\uD30C\uBA38",
      "croda", "lysi",
      "epax",
      "gc rieber", "rieber", "m\u00F6ller", "moller", "\uBB60\uB7EC",
      "aker biomarine", "aker", "\uC544\uCEE4",
      "solutex", "omegavie", "\uC194\uD14C\uC2A4", "\uC194\uB958\uD14D\uC2A4",
      "polaris", "\uD3F4\uB77C\uB9AC\uC2A4",
      "alaskomega", "alask omega", "\uC54C\ub798\uC2A4\uCE74\uC624\uBA54\uAC00",
      "organic technologies"
    ];
    for (const t of premium) if (s.indexOf(t) !== -1) return 85;
    // 청정 지역 원산지 → 70점
    const regions = [
      "\uB178\uB974\uC6E8\uC774", "norway",
      "\uD398\uB8E8", "peru", "anchovy",
      "\uC54C\ub798\uC2A4\uCE74", "alaska",
      "\uC544\uC774\uC2AC\ub780\ub4DC", "iceland",
      "\uCEA0\uB098\uB2E4", "canada",
      "\uCE60\ub808", "chile",
      "\uD504\ub791\uC2A4", "france",
      "\uC2A4\uD398\uC778", "spain"
    ];
    for (const r of regions) if (s.indexOf(r) !== -1) return 70;
    return 50;
  }
  function scoreCert(certs) {
    if (!certs || String(certs).trim() === "" || String(certs).indexOf("\uBBF8\uAE30\uC7AC") !== -1) return 0;
    let score = 0;
    const c = String(certs).toUpperCase();
    const cLower = String(certs).toLowerCase();
    if (c.indexOf("IFOS") !== -1) {
      score += (c.indexOf("5-STAR") !== -1 || c.indexOf("5STAR") !== -1 || c.indexOf("\u3147\u3147") !== -1 || c.indexOf("FIVE STAR") !== -1) ? 40 : 25;
    }
    if (c.indexOf("GOED") !== -1) score += 25;
    if (cLower.indexOf("3rd party") !== -1 || cLower.indexOf("third party") !== -1 || c.indexOf("USP") !== -1 || c.indexOf("CONSUMERLAB") !== -1) score += 20;
    if (c.indexOf("GMP") !== -1 || c.indexOf("CGMP") !== -1) score += 20;
    if (c.indexOf("NSF") !== -1) score += 15;
    if (c.indexOf("MSC") !== -1) score += 15;
    if (c.indexOf("FRIEND OF THE SEA") !== -1 || c.indexOf("FOS") !== -1) score += 15;
    if (c.indexOf("IFFO") !== -1 || c.indexOf("MARINTRUST") !== -1) score += 10;
    if (c.indexOf("ISO 22000") !== -1 || c.indexOf("ISO22000") !== -1) score += 10;
    if (c.indexOf("HACCP") !== -1) score += 5;
    if (c.indexOf("ISO 9001") !== -1 || c.indexOf("ISO9001") !== -1) score += 5;
    return Math.min(100, score);
  }
  function scorePrice(p) {
    if (!p || p <= 0) return 50; // 데이터 없음 → 중간
    if (p <= 200)  return 100;
    if (p <= 300)  return 85;
    if (p <= 400)  return 70;
    if (p <= 600)  return 55;
    if (p <= 800)  return 40;
    if (p <= 1000) return 25;
    return 10;
  }

  if (debug && records.length > 0) {
    return new Response(JSON.stringify({ debug: true, firstRecord: records[0].fields, allKeys: Object.keys(records[0].fields) }, null, 2), { status: 200, headers });
  }

  const scored = records.map(function(record) {
    const f = record.fields || {};
    const productId = getField(f, "product_id", "productId", "\uC81C\uD488ID");
    const productName = getField(f, "\uC81C\uD488\uBA85", "name", "productName") || "";
    // 빈 행/메모 행 필터: product_id가 없거나 제품명이 메모인 경우 스킵
    if (!productId || !productName) return null;
    if (productName.indexOf("아래부터") !== -1 || productName.indexOf("내용 작성") !== -1) return null;
    let imageUrl = getField(f, "\uc774\ubbf8\uc9c0URL", "imageUrl", "image", "\uc774\ubbf8\uc9c0", "photo") || "";
    if (Array.isArray(imageUrl) && imageUrl.length > 0) {
      const att = imageUrl[0];
      imageUrl = (att.thumbnails && att.thumbnails.large) ? att.thumbnails.large.url : (att.url || "");
    } else if (typeof imageUrl === "object" && imageUrl !== null) {
      imageUrl = imageUrl.url || "";
    }
    // 텍스트 필드에 "image.png (https://...)" 형태로 저장된 경우 URL만 추출
    if (typeof imageUrl === "string" && imageUrl.indexOf("(http") !== -1) {
      const um = imageUrl.match(/\((https?:\/\/[^\s)]+)\)/);
      if (um) imageUrl = um[1];
    }
    const dailyMg = parseFloat(getField(f, "EPA_DHA_\uD569\uACC4_mg", "epaDha", "EPA_DHA")) || 0;
    const capsuleMg = parseFloat(getField(f, "\uCEA1\uC290\uC6A9\uB7C9_mg", "capsuleMg", "\uCEA1\uC290 \uC6A9\uB7C9 (mg)")) || 0;
    const purity = getField(f, "\uC21C\uB3C4", "purity");
    const form = getField(f, "\uC81C\uD615", "form");
    const supplier = getField(f, "\uC6D0\uB8CC\uC0AC", "supplier");
    const certs = getField(f, "\uC778\uC99D", "certs", "certifications");
    const dailyCost = parseFloat(getField(f, "1\uC77C\uBE44\uC6A9_\uC6D0", "dailyCost")) || 0;
    const tier = getField(f, "Tier\uB4F1\uAE09", "tier");
    const passFail = getField(f, "\uD568\uB7C9_Pass_Fail", "passFail", "pass_fail");
    const coupangLink = getField(f,
      "\uCFE0\uD314_\uD30C\uD2B8\uB108\uC2A4_\uB9C1\uD06C",
      "\uCFE0\uD314_\uC0C1\uC138\uD398\uC774\uC9C0_\uB9C1\uD06C",
      "\uCFE0\uD314 url", "\uCFE0\uD314_url", "coupangUrl", "coupangLink", "url"
    ) || "";

    const w = profile.weights;
    const dose = scoreDose(dailyMg);
    const formScore = scoreForm(form);
    const sourceScore = scoreSource(supplier);
    const certScore = scoreCert(certs);
    const priceScore = scorePrice(dailyCost);
    let total = Math.round(dose*w.dose/100 + formScore*w.form/100 + sourceScore*w.source/100 + certScore*w.cert/100 + priceScore*w.price/100);
    let highDoseFlag = false;
    if (dailyMg > 2000) { total = Math.min(80, total); highDoseFlag = true; }

    return { record, productId, productName, imageUrl, coupangLink, tier, passFail, form, supplier, certs, purity, dailyMg, capsuleMg, dailyCost: Math.round(dailyCost), scores: { dose, form: formScore, source: sourceScore, cert: certScore, price: priceScore, total }, highDoseFlag };
  }).filter(Boolean);

  const capsuleMgList = scored.map(it => it.capsuleMg).filter(m => m > 0).sort((a,b) => a-b);
  const capMin = capsuleMgList[0] || 0;
  const capMax = capsuleMgList[capsuleMgList.length-1] || 0;
  const capCount = capsuleMgList.length;
  const capAvg = capCount > 0 ? Math.round(capsuleMgList.reduce((s,v) => s+v, 0) / capCount) : 0;

  // EPA+DHA 함량 분포 (전체 제품 기준)
  const doseMgList = scored.map(it => it.dailyMg).filter(m => m > 0).sort((a,b) => a-b);
  const doseMin = doseMgList[0] || 0;
  const doseMax = doseMgList[doseMgList.length-1] || 0;
  const doseAvg = doseMgList.length > 0 ? Math.round(doseMgList.reduce((s,v) => s+v, 0) / doseMgList.length) : 0;

  // 1일 복용 비용 분포 (전체 제품 기준)
  const costList = scored.map(it => it.dailyCost).filter(c => c > 0).sort((a,b) => a-b);
  const costMin = costList[0] || 0;
  const costMax = costList[costList.length-1] || 0;
  const costAvg = costList.length > 0 ? Math.round(costList.reduce((s,v) => s+v, 0) / costList.length) : 0;

  function capsuleGrade(mg) {
    if (!mg || mg <= 0) return null;
    if (mg < 900) return "\uC791\uC74C"; if (mg < 1250) return "\uBCF4\uD1B5"; return "\uD070";
  }
  function capsulePosition(mg) {
    if (!mg || mg <= 0 || capMax === capMin) return null;
    return Math.max(0, Math.min(100, Math.round((mg-capMin)/(capMax-capMin)*100)));
  }
  function capsulePercentile(mg) {
    if (!mg || mg <= 0 || capCount === 0) return null;
    return Math.round(capsuleMgList.filter(x => x < mg).length / capCount * 100);
  }
  scored.forEach(it => {
    it.capsuleGrade = capsuleGrade(it.capsuleMg);
    it.capsulePosition = capsulePosition(it.capsuleMg);
    it.capsulePercentile = capsulePercentile(it.capsuleMg);
  });

  let filtered = scored.filter(item => {
    if (!includeFailed && item.passFail === "Fail") return false;
    if (profile.filters.minDailyDose && item.dailyMg < profile.filters.minDailyDose) return false;
    return true;
  });
  filtered.sort((a, b) => b.scores.total - a.scores.total);

  const top3 = filtered.slice(0, 3).map((item, idx) => ({
    rank: idx+1, id: item.productId || item.record.id,
    name: item.productName, image: item.imageUrl, coupangLink: item.coupangLink,
    keySpec: { dailyMg: item.dailyMg, dailyCost: item.dailyCost, form: item.form||"", supplier: item.supplier||"", certs: item.certs||"", purity: item.purity, tier: item.tier||"", capsuleMg: item.capsuleMg||0, capsuleGrade: item.capsuleGrade, capsulePosition: item.capsulePosition, capsulePercentile: item.capsulePercentile },
    vScore: item.scores.total, detailScores: item.scores, highDoseFlag: item.highDoseFlag, passFail: item.passFail||""
  }));

  const rest = filtered.slice(3).map((item, idx) => ({
    rank: idx+4, id: item.productId || item.record.id,
    name: item.productName, image: item.imageUrl||"", vScore: item.scores.total,
    tier: item.tier||"", dailyMg: item.dailyMg||0, dailyCost: item.dailyCost||0,
    form: item.form||"", supplier: item.supplier||"", certs: item.certs||"", capsuleMg: item.capsuleMg||0,
    capsuleGrade: item.capsuleGrade, capsulePosition: item.capsulePosition, capsulePercentile: item.capsulePercentile,
    coupangLink: item.coupangLink
  }));

  return new Response(JSON.stringify({
    profile: { id: profileId, label: profile.label, weights: profile.weights },
    query, distributions: {
      dose:    { min: doseMin, max: doseMax, avg: doseAvg, count: doseMgList.length },
      cost:    { min: costMin, max: costMax, avg: costAvg, count: costList.length },
      capsule: { min: capMin,  max: capMax,  avg: capAvg,  count: capCount }
    },
    capsuleDistribution: { min: capMin, max: capMax, count: capCount },
    totalProducts: records.length, filteredCount: filtered.length, excludedCount: records.length - filtered.length,
    top3, rest, medicalConsult: profile.medicalConsult,
    disclaimer: "\u00A0\uBCF8 V-Score\uB294 \uACF5\uAC1C\uB41C \uC81C\uD488 \uB370\uC774\uD130 \uAE30\uBC18\uC758 \uAC1D\uAD00\uC801 \uC9C0\uD45C\uC774\uBA70, \uAC1C\uC778\uC758 \uAC74\uAC15 \uC0C1\uD0DC\u00B7\uC57D\uBB3C\u00B7\uC54C\uB808\uB974\uAE30\uC5D0 \ub530\ub77c \uCD5C\uC801 \uC81C\ud488\uC740 \ub2E4\ub97c \uC218 \uC788\uC2B5\ub2C8\ub2E4."
  }), { status: 200, headers });
}
