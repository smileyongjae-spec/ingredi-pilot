// Cloudflare Pages Function: Integrated counseling endpoint
// File path: functions/consult.js
// URL: /consult?q=<user_question>
//
// v3 fixes:
// - FAQ 컬럼명 수정: "질문(사용자 표현)" → "질문 (사용자 표현)" (공백 추가)
//                   "답변(3원칙 적용)" → "답변 (3원칙 적용)" (공백 추가)
// - 구어체 동의어 확장 추가 (ask.js v3와 동일)
// - 마크다운/이모지 금지 프롬프트 추가

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
    return new Response(JSON.stringify({ error: "config_missing" }), { status: 500, headers });
  }

  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  if (!query) {
    return new Response(JSON.stringify({ error: "bad_request", message: "Missing q parameter" }), { status: 400, headers });
  }

  // ─── HELPERS ─────────────────────────────────────
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

  // ─── PROFILE WEIGHTS ─────────────────────────────
  const PROFILES = {
    "premium_seeker": { label: "\uCD5C\uACE0 \uD488\uC9C8 \uC120\uD638", weights: { dose: 30, form: 20, source: 20, cert: 20, price: 10 }, medicalConsult: false },
    "budget_seeker":  { label: "\uAC00\uC131\uBE44 \uC120\uD638", weights: { dose: 20, form: 15, source: 15, cert: 10, price: 40 }, medicalConsult: false },
    "balanced":       { label: "\uAD50\uD615\uD615 (\uAE30\uBCF8\uAC12)", weights: { dose: 30, form: 20, source: 20, cert: 20, price: 10 }, medicalConsult: false },
    "pregnancy":      { label: "\uC784\uC0B0\uBD80\u00B7\uC218\uC720\uBD80", weights: { dose: 15, form: 15, source: 30, cert: 35, price: 5 }, medicalConsult: true },
    "senior":         { label: "\uC2DC\uB2C8\uC5B4 (50+)", weights: { dose: 35, form: 25, source: 15, cert: 15, price: 10 }, medicalConsult: false, filters: { minDailyDose: 1000 } },
    "vegan":          { label: "\uBE44\uAC74/\uC2DD\uBB3C\uC131", weights: { dose: 25, form: 15, source: 25, cert: 25, price: 10 }, medicalConsult: false, filters: { veganOnly: true } },
    "kid":            { label: "\uC5B4\uB9B0\uC774", weights: { dose: 20, form: 15, source: 25, cert: 30, price: 10 }, medicalConsult: true }
  };

  function matchProfileLocal(q) {
    const lower = q.toLowerCase();
    const keywordMap = [
      { profile: "pregnancy",      keywords: ["\uC784\uC0B0\uBD80", "\uC784\uC2E0", "\uC218\uC720", "pregnant"] },
      { profile: "kid",            keywords: ["\uC544\uC774", "\uC5B4\uB9B0\uC774", "\uC790\uB140", "\uC544\uB4E4", "\uB538", "child", "kid"] },
      { profile: "senior",         keywords: ["\uC2DC\uB2C8\uC5B4", "\uB178\uC778", "\uBD80\uBAA8\uB2D8", "50\uB300", "60\uB300", "70\uB300", "\uC5B4\uBC84\uC9C0", "\uC5B4\uBA38\uB2C8", "senior"] },
      { profile: "vegan",          keywords: ["\uBE44\uAC74", "\uCC44\uC2DD", "\uC2DD\uBB3C\uC131", "vegan", "algae", "\uC870\uB958"] },
      { profile: "budget_seeker",  keywords: ["\uAC00\uC131\uBE44", "\uC800\uB834", "\uC2F8\uB294", "\uACBD\uC81C\uC801", "\uC608\uC0B0", "cheap", "budget"] },
      { profile: "premium_seeker", keywords: ["\uCD5C\uACE0", "\uD504\uB9AC\uBBF8\uC5C4", "\uACE0\uAE09", "\uBE44\uC2F8\uB3C4", "premium", "best"] }
    ];
    for (const km of keywordMap) {
      for (const kw of km.keywords) {
        if (lower.indexOf(kw.toLowerCase()) !== -1) return km.profile;
      }
    }
    return "balanced";
  }

  function scoreDose(d) {
    if (!d || d <= 0) return 20;
    if (d >= 1500) return 100; if (d >= 1000) return 80;
    if (d >= 600) return 60;  if (d >= 500) return 40;
    return 20;
  }
  function scoreForm(form) {
    if (!form) return 50;
    const f = String(form).toLowerCase();
    if (f.indexOf("rtg") !== -1) return 100;
    if (f.indexOf("phospholipid") !== -1) return 95;
    if (f === "tg") return 90; if (f === "ee") return 60;
    return 50;
  }
  function scoreSource(supplier) {
    if (!supplier) return 40;
    const s = String(supplier).toLowerCase();
    for (const t of ["dsm", "basf", "epax", "croda", "solutex", "kd"]) if (s.indexOf(t) !== -1) return 90;
    return 60;
  }
  function scoreCert(certs) {
    if (!certs || String(certs).trim() === "") return 0;
    let score = 0;
    const c = String(certs).toUpperCase();
    if (c.indexOf("IFOS") !== -1) { score += (c.indexOf("5-STAR") !== -1 || c.indexOf("5\uC2A4\uD0C0") !== -1) ? 40 : 25; }
    if (c.indexOf("GMP") !== -1) score += 20;
    if (c.indexOf("GOED") !== -1) score += 20;
    if (c.indexOf("MSC") !== -1) score += 15;
    if (c.indexOf("NSF") !== -1) score += 15;
    if (c.indexOf("ISO") !== -1) score += 10;
    return Math.min(100, score);
  }
  function scorePrice(p) {
    if (!p || p <= 0) return 50;
    if (p <= 200) return 100; if (p <= 400) return 90; if (p <= 600) return 80;
    if (p <= 900) return 60;  if (p <= 1200) return 40;
    return 20;
  }

  try {
    // ─── [1] CATEGORY GATE ───────────────────────────
    const supportedCategories = {
      "omega3": [
        "\uC624\uBA54\uAC00", "omega", "epa", "dha", "ala", "dpa", "rtg",
        "\uC54C\uD2F0\uC9C0", "\uC5B4\uC720", "fish oil", "\uD06C\uB9B4", "ee", "tg",
        "\uD601\ud589", "\ud601\uc911", "\uc9c0\ubc29", "\uc2ec\ud608\uad00", "\uc5fc\uc99d", "\ub1cc", "\uc2dc\ub825",
        "\uc601\uc591\uc81c", "\uc5f5\uc36c", "\ucda9\uc528", "\uc544\ub974\uc53c", "\uc5b4\ub958"
      ],
      "probiotics": ["\uD504\uB85C\uBC14\uC774\uC624\uD2F1\uC2A4", "\uC720\uC0B0\uADE0", "\uC7A5\uAC74\uAC15"],
      "vitaminC":   ["\uBE44\uD0C0\uBBFCc", "\uBE44\uD0C0\uBBFC c", "vitamin c"]
    };

    const lowerQuery = query.toLowerCase();
    let matchedCategory = null;
    for (const cat in supportedCategories) {
      for (const kw of supportedCategories[cat]) {
        if (lowerQuery.indexOf(kw.toLowerCase()) !== -1) { matchedCategory = cat; break; }
      }
      if (matchedCategory) break;
    }

    const healthKeywords = ["\ud658\ud589", "\ud63c\uc911", "\uc9c0\ubc29", "\uc5fc\uc99d", "\uc2ec\ud608\uad00", "\ub1cc", "\uc2dc\ub825", "\uace0\ud63c\uc555", "\ub2f9\ub1a8", "\ucf5c\ub808\uc2a4\ud14c\ub864", "\uad00\uc808"];
    const isHealthQuery = healthKeywords.some(k => lowerQuery.indexOf(k) !== -1);

    if (!matchedCategory && !isHealthQuery) {
      return new Response(JSON.stringify({
        query, category: "out_of_scope",
        answer: "\uC8C4\uC1A1\uD569\uB2C8\uB2E4. ingredi\ub294 \ud604\uc7ac \uc624\uba54\uac003, \ud504\ub85c\ubc14\uc774\uc624\ud2f1\uc2a4, \ube44\ud0c0\ubbfcC\uc5d0 \ub300\ud55c \uc815\ubcf4\ub9cc \uc81c\uacf5\ud569\ub2c8\ub2e4.",
        sources: [], flags: { outOfScope: true }, recommendation: null
      }), { status: 200, headers });
    }
    if (!matchedCategory) matchedCategory = "omega3";

    // ─── [2] 구어체 → 검색 토큰 확장 ────────────────
    const synonymMap = [
      [/오래\s*(먹|복용|드시|섭취)/g, " \uC7A5\uAE30 \uBCF5\uC6A9 \uC624\uB798"],
      [/\uACC4\uC18D\s*(먹어|먹으면|복용하면|드시면)/g, " \uC7A5\uAE30 \uBCF5\uC6A9 \uACC4\uC18D"],
      [/\uAC04\uC774?\s*(안\s*좋|나쁘|약하|안\s*좋은데|좋지\s*않)/g, " \uAC04 \uAC04\uC9C8\uD658 \uAC04\uAE30\uB2A5"],
      [/\uAC04\uC5FC|\uAC04\uACBD\uD654|\uAC04\uC554/g, " \uAC04\uC9C8\uD658 \uAC04"],
      [/\uD63C\uC555(\uC57D|\uC758\uC57D)?/g, " \uD63C\uC555 \uD654\uACA9\uD63C\uC555\uC57D \uD63C\uC555"],
      [/\uD63C\uB2F9(\uC57D|\uC758\uC57D)?/g, " \uD63C\uB2F9 \uB2F9\uB1A8\uBCD1"],
      [/\uC0DD\uC120\s*\uC54C\uB808\uB974\uAE30/g, " \uC54C\uB808\uB974\uAE30 \uC5B4\uB958 \uC0DD\uC120"],
      [/\uC784\uC2E0\s*(중|했|했을|하면)?/g, " \uC784\uC0B0\uBD80 \uC784\uC2E0"],
      [/\uC544\uC774|\uC560\uAE30|\uC5B4\uB9B0\uC774|\uCD08\uB4F1\uC0DD|\uC5B4\uB9B0\uC560|\uC18C\uC544/g, " \uC5B4\uB9B0\uC774 \uC5B4\uB9B0\uC774\uC6A9 \uC18C\uC544"],
      [/\uC218\uC220\s*(전|앞두|예정|하기\s*전)/g, " \uC218\uC220 \uC218\uC220\uC804 \uC911\uB2E8"],
      [/\uC5B8\uC81C\s*(\uBA39|복용|드시)/g, " \uBCF5\uC6A9\uC2DC\uAC04 \uC2DD\uD6C4 \uC2DD\uC0AC"],
      [/\uBD80\uC791\uC6A9|\uBD80\uC791\uC758/g, " \uBD80\uC791\uC6A9 \uC8FC\uC758"],
      [/\uC21C\uB3C4/g, " \uC21C\uB3C4 80%"],
      [/\uC0B0\uD328|\uBE44\uB9B0\uB0B4/g, " \uC0B0\uD328 \uBE44\uB9B0\uB0B4 \uD488\uC9C8"],
    ];

    let expandedQuery = query;
    for (const [pattern, replacement] of synonymMap) {
      expandedQuery = expandedQuery.replace(pattern, replacement);
    }
    const originalTokens = query.split(/\s+/).filter(t => t.length > 0);
    const expandedTokens = expandedQuery.split(/\s+/).filter(t => t.length > 0);
    const allTokens = [...new Set([...originalTokens, ...expandedTokens])];
    const lowerTokens = allTokens.map(t => t.toLowerCase());

    // ─── [3] PARALLEL: knowledge + FAQ + products ────
    const knowledgeUrl = "https://api.airtable.com/v0/" + BASE_ID + "/knowledge?maxRecords=100";
    const faqTableName = encodeURIComponent("FAQ_\uC624\uBA54\uAC003");
    const faqUrl      = "https://api.airtable.com/v0/" + BASE_ID + "/" + faqTableName + "?maxRecords=200";
    const productUrl  = "https://api.airtable.com/v0/" + BASE_ID + "/product_v2?maxRecords=100";

    const [kRes, fRes, pRes] = await Promise.all([
      fetch(knowledgeUrl, { headers: { Authorization: "Bearer " + TOKEN } }).then(r => r.ok ? r.json() : { records: [] }).catch(() => ({ records: [] })),
      fetch(faqUrl,       { headers: { Authorization: "Bearer " + TOKEN } }).then(r => r.ok ? r.json() : { records: [] }).catch(() => ({ records: [] })),
      fetch(productUrl,   { headers: { Authorization: "Bearer " + TOKEN } }).then(r => r.ok ? r.json() : { records: [] }).catch(() => ({ records: [] }))
    ]);

    // knowledge 매칭
    const fK_keyword  = "\uD0A4\uC6CC\uB4DC";
    const fK_oneline  = "\uD55C\uC904\uC815\uC758";
    const fK_related  = "\uAD00\uB828\uC131\uBD84\uD0A4\uC6CC\uB4DC";
    const fK_category = "\uCE74\uD14C\uACE0\uB9AC";
    const fK_id       = "\uC9C0\uC2DDID";
    const fK_evidence = "\uC784\uC0C1\uADFC\uAC70";

    const knowledgeMatched = (kRes.records || [])
      .map(r => {
        const f = r.fields || {};
        const haystack = [f[fK_keyword]||"", f[fK_oneline]||"", f[fK_related]||"", f[fK_category]||""].join(" ").toLowerCase();
        let score = 0;
        for (const t of lowerTokens) if (t.length > 1 && haystack.indexOf(t) !== -1) score++;
        return { record: r, score, fields: f };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(item => ({
        id: item.fields[fK_id] || item.record.id,
        category: item.fields[fK_category] || "",
        oneline: item.fields[fK_oneline] || "",
        evidence: item.fields[fK_evidence] || "",
        score: item.score
      }));

    // ✅ v3: 컬럼명 수정 — 공백 추가
    // "질문(사용자 표현)" → "질문 (사용자 표현)"
    // "답변(3원칙 적용)" → "답변 (3원칙 적용)"
    const fF_id  = "FAQ_ID";
    const fF_q   = "\uC9C8\uBB38 (\uC0AC\uC6A9\uC790 \uD45C\uD604)";   // ✅ 수정
    const fF_a   = "\uB2F5\uBCC0 (3\uC6D0\uCE59 \uC801\uC6A9)";        // ✅ 수정
    const fF_med = "\uC758\uB8CC \uC8FC\uC758\uC0AC\uD56D";

    const faqMatched = (fRes.records || [])
      .map(r => {
        const f = r.fields || {};
        const haystack = [f[fF_q]||"", f[fF_a]||""].join(" ").toLowerCase();
        let score = 0;
        for (const t of lowerTokens) if (t.length > 1 && haystack.indexOf(t) !== -1) score++;
        return { record: r, score, fields: f };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(item => ({
        id: item.fields[fF_id] || item.record.id,
        question: item.fields[fF_q] || "",
        answer: item.fields[fF_a] || "",
        medicalNote: item.fields[fF_med] || ""
      }));

    // ─── [4] DETECT MEDICAL RISK ─────────────────────
    const riskKeywords = {
      pregnancy:     ["\uC784\uC0B0\uBD80", "\uC784\uC2E0", "\uC218\uC720"],
      surgery:       ["\uC218\uC220", "\uC2DC\uC220"],
      bleeding:      ["\uCD9C\uD608", "\uD56D\uC751\uACE0", "\uC640\uD30C\uB9B0"],
      highDose:      ["2000mg", "2500mg", "3000mg", "\uACE0\uD568\uB7C9", "\uACFC\uB2E4"],
      chronicDisease:["\uB2F9\uB1A8\uBCD1", "\uACE0\uD63C\uC555", "\uC2EC\uC7A5\uBCD1", "\uAC04\uC9C8\uD658", "\uAC04\uC5FC"]
    };
    const detectedRisks = [];
    for (const riskType in riskKeywords) {
      for (const kw of riskKeywords[riskType]) {
        if (lowerQuery.indexOf(kw.toLowerCase()) !== -1) { detectedRisks.push(riskType); break; }
      }
    }
    const requiresMedicalConsult = detectedRisks.length > 0;

    // ─── [5] PROFILE MATCH ───────────────────────────
    const matchedProfileId = matchProfileLocal(query);
    const profile = PROFILES[matchedProfileId];

    // ─── [6] CALL CLAUDE (RAG) ───────────────────────
    let answer = "";
    let claudeError = null;

    if (knowledgeMatched.length === 0 && faqMatched.length === 0) {
      answer = "\uC8C4\uC1A1\uD569\uB2C8\uB2E4. \ud574\ub2f9 \uc9c8\ubb38\uc5d0 \ub300\ud55c \uc815\ubcf4\uac00 ingredi \uc9c0\uc2DDDB\uc5d0 \uc544\uc9c1 \uc900\ube44\ub418\uc9c0 \uc54a\uc558\uc2b5\ub2c8\ub2e4. \ub2e4\ub9cc \uad00\ub828\ub420 \uc218 \uc788\ub294 \uc81c\ud488\uc744 \ucd94\ucc9c\ub4dc\ub9b4\uac8c\uc694.";
    } else {
      // v3: 마크다운/이모지 금지 프롬프트 추가
      const systemPrompt = "당신은 ingredi의 건강기능식품 정보 카운슬러입니다.\n\n[핵심 원칙]\n1. 광고 없음 — 특정 제품·브랜드를 추천하지 않습니다\n2. 임상 근거 기반 — 검색 결과의 사실만 답변합니다\n3. 엄격 모드 — 검색 결과에 없는 내용은 추측하지 않습니다\n\n[답변 스타일]\n- 한국어, 존댓말\n- 특정 제품명 언급 금지\n- 의학 자문 아님을 명시\n- 마크다운 헤더(#,##,###), 굵은체(**), 구분선(---), 인용(>), 이모지 사용 금지\n- 항목이 여러 개면 반드시 첫 문장 후 줄바꿈하고 각 항목을 '- ' 로 시작\n  예시: '세 가지 기준으로 확인하세요.\n- EPA+DHA 함량은 X mg 이상\n- 제형은 rTG가 흡수율이 높습니다\n- 원료는 IFOS 인증 여부를...'\n- 단순 질문은 한 단락으로 간결하게"

      let contextBlock = "[\uac80\uc0c9\ub41c \uc9c0\uc2dd]\n";
      knowledgeMatched.forEach((item, idx) => {
        contextBlock += `\n[K${idx+1}] ${item.id} (${item.category}): ${item.oneline}`;
        if (item.evidence) contextBlock += ` (\uadfc\uac70: ${item.evidence})`;
      });
      faqMatched.forEach((item, idx) => {
        contextBlock += `\n[F${idx+1}] Q: ${item.question} / A: ${item.answer}`;
        if (item.medicalNote) contextBlock += ` [\uC8FC\uC758: ${item.medicalNote}]`;
      });

      let userPrompt = contextBlock + "\n\n[\uc0ac\uc6a9\uc790 \uc9c8\ubb38]\n" + query;
      if (requiresMedicalConsult) {
        userPrompt += `\n\n[\ub0b4\ubd80 \ud50c\ub798\uadf8] \uc758\ub8cc \uc8fc\uc758\uac00 \ud544\uc694\ud55c \ud0a4\uc6cc\ub4dc \uac10\uc9c0\ub428 (${detectedRisks.join(", ")}). \ub2f5\ubcc0 \ub05d\uc5d0 "\ubc18\ub4dc\uc2dc \uc758\uc0ac\uc640 \uc0c1\ub2f4\ud558\uc138\uc694" \ud3ec\ud568.`;
      }

      const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 800,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }]
        })
      });

      if (claudeResponse.ok) {
        const claudeData = await claudeResponse.json();
        answer = (claudeData.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      } else {
        claudeError = await claudeResponse.text();
        answer = "\uAE30\uc220\uc801 \uc624\ub958\uac00 \ubc1c\uc0dd\ud588\uc2b5\ub2c8\ub2e4. \uc774\ub798 \uc81c\ud488 \ucd94\ucc9c\uc744 \ud655\uc778\ud574 \uc8fc\uc138\uc694.";
      }
    }

    // ─── [7] RECOMMEND PRODUCTS ──────────────────────
    const records = pRes.records || [];
    const scored = records.map(r => {
      const f = r.fields || {};
      const productId   = getField(f, "product_id", "productId");
      const productName = getField(f, "\uC81C\uD488\uBA85", "name") || "";
      const dailyMg     = parseFloat(getField(f, "EPA_DHA_\uD569\uACC4_mg")) || 0;
      const form        = getField(f, "\uC81C\uD615") || "";
      const supplier    = getField(f, "\uC6D0\uB8CC\uC0AC") || "";
      const certsRaw    = getField(f, "\uC778\uC99D");
      const certs       = Array.isArray(certsRaw) ? certsRaw.join(", ") : String(certsRaw || "");
      const dailyCost   = parseFloat(getField(f, "1\uC77C\uBE44\uC6A9_\uC6D0")) || 0;
      const tier        = getField(f, "Tier\uB4F1\uAE09") || "";
      const passFail    = getField(f, "\uD568\uB7C9_Pass_Fail") || "";
      const coupangLink = getField(f, "coupang_url", "coupangUrl", "coupangLink", "\uCFE0\uD314_\uD30C\uD2B8\uB108\uC2A4_\uB9C1\uD06C") || "";

      let imageUrl = getField(f, "\uC774\uBBF8\uC9C0URL", "imageUrl", "image", "\uC774\uBBF8\uC9C0", "photo") || "";
      if (Array.isArray(imageUrl) && imageUrl.length > 0) {
        const att = imageUrl[0];
        imageUrl = (att.thumbnails && att.thumbnails.large) ? att.thumbnails.large.url : (att.url || "");
      } else if (typeof imageUrl === 'object' && imageUrl !== null) {
        imageUrl = imageUrl.url || "";
      }

      const w = profile.weights;
      const dose       = scoreDose(dailyMg);
      const formScore  = scoreForm(form);
      const srcScore   = scoreSource(supplier);
      const certScore  = scoreCert(certs);
      const priceScore = scorePrice(dailyCost);
      let total = Math.round(dose*w.dose/100 + formScore*w.form/100 + srcScore*w.source/100 + certScore*w.cert/100 + priceScore*w.price/100);
      let highDoseFlag = false;
      if (dailyMg > 2000) { total = Math.min(80, total); highDoseFlag = true; }

      return { id: productId, name: productName, image: imageUrl, dailyMg, dailyCost: Math.round(dailyCost), form, supplier, certs, tier, passFail, coupangLink, scores: { dose, form: formScore, source: srcScore, cert: certScore, price: priceScore, total }, highDoseFlag };
    });

    let filtered = scored.filter(item => {
      if (item.passFail === "Fail") return false;
      if (profile.filters && profile.filters.minDailyDose && item.dailyMg < profile.filters.minDailyDose) return false;
      if (profile.filters && profile.filters.veganOnly) {
        const nl = String(item.name).toLowerCase();
        if (nl.indexOf("\uC2DD\uBB3C\uC131") === -1 && nl.indexOf("vegan") === -1 && nl.indexOf("algae") === -1) return false;
      }
      return true;
    });
    filtered.sort((a, b) => b.scores.total - a.scores.total);

    const top3 = filtered.slice(0, 3).map((item, idx) => ({
      rank: idx + 1, id: item.id, name: item.name, image: item.image || "",
      vScore: item.scores.total, detailScores: item.scores,
      keySpec: { dailyMg: item.dailyMg, dailyCost: item.dailyCost, form: item.form, supplier: item.supplier, certs: item.certs, tier: item.tier },
      coupangLink: item.coupangLink, highDoseFlag: item.highDoseFlag
    }));

    return new Response(JSON.stringify({
      query, category: matchedCategory, answer,
      sources: {
        knowledge: knowledgeMatched.map(k => ({ id: k.id, oneline: k.oneline, evidence: k.evidence || null })),
        faq: faqMatched.map(f => ({ id: f.id, question: f.question }))
      },
      flags: { requiresMedicalConsult, detectedRisks, knowledgeCount: knowledgeMatched.length, faqCount: faqMatched.length, claudeError },
      recommendation: {
        profile: { id: matchedProfileId, label: profile.label, weights: profile.weights },
        top3, filteredCount: filtered.length, totalCount: records.length
      },
      disclaimer: "\u00A0\uBCF8 \uC815\ubcf4\ub294 \uC758\uB8CC \uC790\ubb38\uc774 \uc544\ub2c8\uba70, \uAC1C\ubcc4 \uAC74\uAC15 \uC0c1\ud0dc\uC5d0 \ub530\ub77c \uB2E4\ub97c \uc218 \uc788\uC2B5\ub2c8\ub2e4. \ubcf5\uC6A9 \uc804 \uC758\uC0AC\u00b7\uC57D\uC0AC\uC640 \uC0C1\ub2D8\ud558\uc138\uc694."
    }), { status: 200, headers });

  } catch (error) {
    return new Response(JSON.stringify({ error: "internal_error", message: error.message }), { status: 500, headers });
  }
}
