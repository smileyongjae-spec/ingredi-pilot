// Cloudflare Pages Function: Add LLM explanation to recommendation results (v2)
// File path: functions/explain-recommendation.js
// URL: /explain-recommendation?profile=<profile>&id=<product_id>
//
// v2 changes:
// - Removed self-fetch (calls Airtable directly)
// - Self-contained scoring logic (mirrors recommend.js v4)

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
  const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY;
  const TOKEN = env.AIRTABLE_TOKEN;
  const BASE_ID = env.AIRTABLE_BASE_ID;

  if (!ANTHROPIC_KEY || !TOKEN || !BASE_ID) {
    return new Response(JSON.stringify({
      error: "config_missing",
      message: "Environment variables not set"
    }), { status: 500, headers });
  }

  const url = new URL(request.url);
  const profileId = (url.searchParams.get("profile") || "balanced").trim();
  const productId = (url.searchParams.get("id") || "").trim();

  if (!productId) {
    return new Response(JSON.stringify({
      error: "bad_request",
      message: "Missing id parameter"
    }), { status: 400, headers });
  }

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

  const profile = PROFILES[profileId];
  if (!profile) {
    return new Response(JSON.stringify({
      error: "invalid_profile",
      message: "Unknown profile: " + profileId
    }), { status: 400, headers });
  }

  // ─── FIELD GETTER (loose match) ─────────────────
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

  // ─── SCORING (recommend.js v4와 동일) ──────────
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

  // ─── FETCH PRODUCT FROM AIRTABLE ────────────────
  const productsUrl = "https://api.airtable.com/v0/" + BASE_ID + "/product?maxRecords=100";
  const res = await fetch(productsUrl, {
    headers: { Authorization: "Bearer " + TOKEN }
  });
  if (!res.ok) {
    const text = await res.text();
    return new Response(JSON.stringify({
      error: "airtable_error",
      message: text
    }), { status: 500, headers });
  }
  const data = await res.json();
  const records = data.records || [];

  // 해당 제품 찾기
  let target = null;
  for (const r of records) {
    const f = r.fields || {};
    const pid = getField(f, "product_id", "productId");
    if (pid === productId) {
      target = r;
      break;
    }
  }

  if (!target) {
    return new Response(JSON.stringify({
      error: "product_not_found",
      message: "Product not found: " + productId
    }), { status: 404, headers });
  }

  const f = target.fields || {};
  const productName = getField(f, "\uC81C\uD488\uBA85", "name") || "";
  const dailyMg = parseFloat(getField(f, "EPA_DHA_\uD569\uACC4_mg")) || 0;
  const form = getField(f, "\uC81C\uD615", "form") || "";
  const supplier = getField(f, "\uC6D0\uB8CC\uC0AC", "supplier") || "";
  const certs = getField(f, "\uC778\uC99D", "certs") || "";
  const dailyCost = parseFloat(getField(f, "1\uC77C\uBE44\uC6A9_\uC6D0", "dailyCost")) || 0;
  const tier = getField(f, "Tier\uB4F1\uAE09", "tier") || "";
  
  // certs 안전 처리 (배열·문자열)
  let certsStr = "";
  if (Array.isArray(certs)) certsStr = certs.join(", ");
  else certsStr = String(certs);

  const dose = scoreDose(dailyMg);
  const formScore = scoreForm(form);
  const sourceScore = scoreSource(supplier);
  const certScore = scoreCert(certsStr);
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

  // ─── BUILD CLAUDE PROMPT ─────────────────────────
  const systemPrompt = "\uB2F9\uC2E0\uC740 ingredi\uC758 V-Score \uC124\uBA85 \uC5B4\uC2DC\uC2A4\uD134\uD2B8\uC785\ub2C8\ub2E4. \uC81C\ud488 \uC810\uC218\uC758 \uADFC\uAC70\ub97C 3\u00B74\ubb38\uC7A5\uC73C\ub85c \ub354\uc6B4\u00B7\uC57D\uC810 \uC911\uC2EC\uC73C\ub85c \uAC04\uACB0\ud558\uACE0 \uACE0\uAC1D\uAC10 \uC788\uAC8C \uC124\uBA85\ud569\ub2c8\ub2e4.\n\n[\uC6D0\uCE59]\n- \uACFC\uC7A5 \uAE08\uC9C0, \ud2b9\uc815 \ube0c\ub79c\ub4DC \uCC2C\uC591 \uAE08\uC9C0\n- \uC810\uC218\uC758 \uADFC\uAC70\ub9CC \uC0AC\uC2E4\ub300\ub85c \uC124\uBA85\n- \uC0AC\uC6A9\uC790 \ud504\ub85c\ud544\uC5d0 \ub9DE\ub294 \uC774\uC720 \ud3EC\ud568\n- \"\uC774 \uC81C\ud488\uC774 \uB2F9\uC2E0\uC5D0\uAC8C \uC798 \ub9DE\ub294 \uC774\uC720\"\uC640 \"\ud55c\uACC4\u00B7\uC8FC\uC758\uC0AC\ud56D\" \ub458 \ub2E4 \ud3EC\ud568";

  let userPrompt = "[\ud504\ub85c\ud544] " + profile.label + "\n";
  userPrompt += "[\uAC00\uC911\uCE58] \ud568\ub7c9 " + w.dose + ", \uC81C\ud615 " + w.form + ", \uC6D0\ub8cc " + w.source + ", \uC778\uC99D " + w.cert + ", \uAC00\uACA9 " + w.price + "\n\n";
  userPrompt += "[\uC81C\ud488] " + productName + "\n";
  userPrompt += "[\ud575\uC2EC \uC2A4\ud399]\n";
  userPrompt += "- 1\uC77C \uC120\uCDE8 EPA+DHA: " + dailyMg + "mg\n";
  userPrompt += "- 1\uC77C \uBE44\uC6A9: " + Math.round(dailyCost) + "\uC6D0\n";
  userPrompt += "- \uC81C\ud615: " + form + "\n";
  userPrompt += "- \uC6D0\ub8cc\uc0ac: " + supplier + "\n";
  userPrompt += "- \uC778\uC99D: " + certsStr + "\n";
  userPrompt += "- Tier: " + tier + "\n\n";
  userPrompt += "[\uC138\ubd80 \uC810\uC218 (100\uC810 \ub9CC\uC810)]\n";
  userPrompt += "- \ud568\ub7c9: " + dose + "\n";
  userPrompt += "- \uC81C\ud615: " + formScore + "\n";
  userPrompt += "- \uC6D0\ub8cc: " + sourceScore + "\n";
  userPrompt += "- \uC778\uC99D: " + certScore + "\n";
  userPrompt += "- \uAC00\uACA9: " + priceScore + "\n";
  userPrompt += "[\uC885\ud569 \uC810\uC218]: " + total + "\uC810\n\n";
  if (highDoseFlag) {
    userPrompt += "[\uC8FC\uC758] 1\uC77C 2000mg \uCD08\uACFC\uB85C \uACE0\ud568\ub7c9 \uD3ED\uADF8\uAC00 \uC801\uC6A9\ub418\uC5C8\uC2B5\ub2c8\ub2e4.\n";
  }
  userPrompt += "\uC774 \uC81C\ud488\uC774 \"" + profile.label + "\" \ud504\ub85c\ud544\uC5D0 \uC65C \uC774 \uC810\uC218\ub97C \ubc1B\uc558\ub294\uc9c0 3\u00B74\ubb38\uC7A5\uC73C\ub85c \uC124\uBA85\ud574\uC8FC\uC138\uc694.";

  // ─── CALL CLAUDE SONNET 4.6 ────────────────────
  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    })
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return new Response(JSON.stringify({
      error: "claude_api_error",
      status: claudeRes.status,
      message: errText
    }), { status: 500, headers });
  }

  const claudeData = await claudeRes.json();
  const explanation = (claudeData.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");

  return new Response(JSON.stringify({
    profile: { id: profileId, label: profile.label, weights: w },
    product: {
      id: productId,
      name: productName,
      vScore: total,
      tier: tier
    },
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
      dailyCost: Math.round(dailyCost),
      form: form,
      supplier: supplier,
      certs: certsStr
    },
    highDoseFlag: highDoseFlag,
    explanation: explanation
  }), { status: 200, headers });
}
