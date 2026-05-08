// Cloudflare Pages Function: RAG-based answer generation
// File path: functions/ask.js
// URL: /ask?q=<query>
// 
// Pipeline:
// 1. Category gate (omega3/probiotics/vitamin-c only)
// 2. Search knowledge + FAQ
// 3. Detect medical risk keywords
// 4. Call Claude Sonnet 4.6 with RAG context
// 5. Post-process with safety flags

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
  const query = (url.searchParams.get("q") || "").trim();
  if (!query) {
    return new Response(JSON.stringify({
      error: "bad_request",
      message: "Missing q parameter"
    }), { status: 400, headers });
  }

  try {
    // ─── [1] CATEGORY GATE ──────────────────────────
    // 지원 카테고리: 오메가3만 우선 (Phase 1)
    // 향후 추가: 프로바이오틱스, 비타민C
    const supportedCategories = {
      "omega3": ["\uC624\uBA54\uAC00", "omega", "epa", "dha", "ala", "dpa", "rtg", "\uC54C\uD2F0\uC9C0", "\uC5B4\uC720", "fish oil", "\uD06C\uB9B4"],
      "probiotics": ["\uD504\uB85C\uBC14\uC774\uC624\uD2F1\uC2A4", "\uC720\uC0B0\uADE0", "\uC7A5\uAC74\uAC15", "probiotics"],
      "vitaminC": ["\uBE44\uD0C0\uBBFCc", "\uBE44\uD0C0\uBBFC c", "vitamin c", "\uC544\uC2A4\uCF54\uB974\uBE45", "ascorbic"]
    };
    
    const lowerQuery = query.toLowerCase();
    let matchedCategory = null;
    for (const cat in supportedCategories) {
      const keywords = supportedCategories[cat];
      for (let i = 0; i < keywords.length; i++) {
        if (lowerQuery.indexOf(keywords[i].toLowerCase()) !== -1) {
          matchedCategory = cat;
          break;
        }
      }
      if (matchedCategory) break;
    }

    if (!matchedCategory) {
      return new Response(JSON.stringify({
        query: query,
        category: "out_of_scope",
        answer: "\uC8C4\uC1A1\uD569\uB2C8\uB2E4. ingredi\uB294 \uD604\uC7AC \uC624\uBA54\uAC003, \uD504\uB85C\uBC14\uC774\uC624\uD2F1\uC2A4, \uBE44\uD0C0\uBBFCC\uC5D0 \uB300\uD55C \uC815\uBCF4\uB9CC \uC81C\uACF5\uD569\uB2C8\uB2E4. \uB2E4\uB978 \uCE74\uD14C\uACE0\uB9AC\uB294 \uC21C\uCC28 \uD655\uC7A5\uD560 \uC608\uC815\uC785\uB2C8\uB2E4.",
        sources: [],
        flags: { outOfScope: true }
      }), { status: 200, headers });
    }

    // ─── [2] SEARCH KNOWLEDGE + FAQ ──────────────────
    const origin = url.origin;
    const encodedQuery = encodeURIComponent(query);
    
    // 병렬 검색
    const [knowledgeRes, faqRes] = await Promise.all([
      fetch(origin + "/search-knowledge?q=" + encodedQuery).then(function(r) { return r.json(); }).catch(function() { return { results: [] }; }),
      fetch(origin + "/search-faq?q=" + encodedQuery).then(function(r) { return r.json(); }).catch(function() { return { results: [] }; })
    ]);

    const knowledgeResults = knowledgeRes.results || [];
    const faqResults = faqRes.results || [];

    // A안 엄격 모드: 검색 결과 0개면 "모른다" 답변
    if (knowledgeResults.length === 0 && faqResults.length === 0) {
      return new Response(JSON.stringify({
        query: query,
        category: matchedCategory,
        answer: "\uC8C4\uC1A1\uD569\uB2C8\uB2E4. \uD574\uB2F9 \uC9C8\uBB38\uC5D0 \uB300\uD55C \uC815\uBCF4\uAC00 ingredi \uC9C0\uC2DDDB\uC5D0 \uC544\uC9C1 \uC900\uBE44\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uBCF4\uB2E4 \uC815\uD655\uD55C \uB2F5\uBCC0\uC744 \uB4DC\uB9AC\uAE30 \uC704\uD574 \uC9C0\uC2DD\uC774 \uCD94\uAC00\uB418\uB294 \uB300\uB85C \uC11C\uBE44\uC2A4\uB97C \uAC1C\uC120\uD574 \uB098\uAC00\uACA0\uC2B5\uB2C8\uB2E4.",
        sources: [],
        flags: { noResults: true }
      }), { status: 200, headers });
    }

    // ─── [3] DETECT MEDICAL RISK KEYWORDS ──────────────
    const riskKeywords = {
      pregnancy: ["\uC784\uC0B0\uBD80", "\uC784\uC2E0", "\uC218\uC720"],
      surgery: ["\uC218\uC220", "\uC218\uC220\uC804", "\uC2DC\uC220"],
      bleeding: ["\uCD9C\uD608", "\uD56D\uC751\uACE0", "\uC640\uD30C\uB9B0"],
      highDose: ["2000mg", "2500mg", "3000mg", "\uACE0\uD568\uB7C9", "\uACFC\uB2E4"],
      chronicDisease: ["\uB2F9\uB1A8\uBCD1", "\uACE0\uD608\uC555", "\uC2EC\uC7A5\uBCD1"]
    };

    const detectedRisks = [];
    for (const riskType in riskKeywords) {
      const keywords = riskKeywords[riskType];
      for (let i = 0; i < keywords.length; i++) {
        if (lowerQuery.indexOf(keywords[i].toLowerCase()) !== -1) {
          detectedRisks.push(riskType);
          break;
        }
      }
    }

    const requiresMedicalConsult = detectedRisks.length > 0;

    // ─── [4] BUILD CLAUDE PROMPT ────────────────────
    const systemPrompt = "\uB2F9\uC2E0\uC740 ingredi\uC758 \uAC74\uAC15\uAE30\uB2A5\uC2DD\uD488 \uC815\uBCF4 \uC5B4\uC2DC\uC2A4\uD134\uD2B8\uC785\uB2C8\uB2E4.\n\n[\uD575\uC2EC \uC6D0\uCE59]\n1. \uAD11\uACE0 \uC5C6\uC74C \u2014 \uD2B9\uC815 \uC81C\uD488\u00B7\uBE0C\uB79C\uB4DC\uB97C \uCD94\uCC9C\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4\n2. \uC784\uC0C1 \uADFC\uAC70 \uAE30\uBC18 \u2014 \uC81C\uACF5\uB41C \uAC80\uC0C9 \uACB0\uACFC\uC758 \uC0AC\uC2E4\uB9CC \uB2F5\uBCC0\uD569\uB2C8\uB2E4\n3. \uC5C4\uACA9 \uBAA8\uB4DC \u2014 \uAC80\uC0C9 \uACB0\uACFC\uC5D0 \uC5C6\uB294 \uB0B4\uC6A9\uC740 \uCD94\uCE21\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4\n\n[\uB2F5\uBCC0 \uC2A4\uD0C0\uC77C]\n- \uD55C\uAD6D\uC5B4, \uC874\uB313\uB9D0\n- \uC9C8\uBB38 \uC131\uACA9\uC5D0 \uB9DE\uB294 \uAE38\uC774 (\ub2e8\uc21c \uC9C8\ubb38: 1~2\ubb38\uC7A5 / \ubcf5\ud569 \uC9C8\ubb38: 4~6\ubb38\uC7A5)\n- \uC758\uD559 \uC790\uBB38\uC774 \uC544\uB2D8\uC744 \uBA85\uC2DC\n- \uC2DC\uC791\uD560 \uB54C \uC778\uC0AC\uB9D0\u00B7\uC74C\u00B7\uC544 \uAC19\uC740 \uBD88\uD544\uC694\uD55C \uBC1B\uCE68\uC744 \uBE7C\uACE0 \uBC14\uB85C \uB2F5\uBCC0\n- \uADFC\uAC70 \uC788\uB294 \uACBD\uC6B0 \"\uC2DD\uC57D\uCC98 \uC778\uC815\", \"PubMed \uC5F0\uAD6C\" \uB4F1\uC73C\uB85C \uCD9C\uCC98 \uBC1D\uD788\uAE30\n- \uAC80\uC0C9 \uACB0\uACFC \uBC94\uC704\uB97C \uBC97\uC5B4\uB098\uB294 \uC9C8\uBB38\uC774\uBA74 \uC194\uC9C1\uD788 \"\uC774 \uBD80\uBD84\uC740 ingredi \uC9C0\uC2DDDB\uC5D0 \uC544\uC9C1 \uC9c0\uc2dD\uC774 \uC900\uBE44\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4\"\uB85C \uB2F5\uBCC0\n\n[\uC81C\uC57D]\n- \uD2B9\uC815 \uC81C\uD488\uBA85\u00B7\uBE0C\uB79C\uB4DC \uCD94\uCC9C \uAE08\uC9C0\n- \uC9C4\ub2DC \uC9c0\uC2DCNo - \"\uC758\uC0AC\uC640 \uC0C1\ub2D4\uD558\uC138\uC694\" \uB85C \uB300\uC2E0\n- \uACFC\ub2E8\uC801 \ud45c\ud604 \uAE08\uC9C0 (\"\uBC18\ub4DC\uC2DC\", \"\uBC18\ub4DC\uC2DC \uD3A8\uC694\" \uB4F1)\n- \uAC80\uC0C9 \uACB0\uACFC\uC5D0 \uC5C6\uB294 \uC22B\uC790\u00B7\uC9C0\uC218 \uCD94\uCE21 \uAE08\uC9C0";

    // 컨텍스트 구성
    let contextBlock = "[\uAC80\uC0C9\uB41C \uC9C0\uC2DD]\n\n";
    
    if (knowledgeResults.length > 0) {
      contextBlock += "## knowledge \uD56D\uBAA9 (" + knowledgeResults.length + "\uAC74)\n";
      knowledgeResults.forEach(function(item, idx) {
        contextBlock += "\n[K" + (idx + 1) + "] " + item.id + " (\uCE74\uD14C\uACE0\uB9AC: " + item.category + ")\n";
        contextBlock += "- " + item.oneline + "\n";
        if (item.evidence) {
          contextBlock += "- \uADFC\uAC70: " + item.evidence + "\n";
        }
      });
    }
    
    if (faqResults.length > 0) {
      contextBlock += "\n\n## FAQ \uD56D\uBAA9 (" + faqResults.length + "\uAC74)\n";
      faqResults.forEach(function(item, idx) {
        contextBlock += "\n[F" + (idx + 1) + "] " + item.id + " (" + item.mainCategory + " > " + item.subCategory + ")\n";
        contextBlock += "Q: " + item.question + "\n";
        contextBlock += "A: " + item.answer + "\n";
        if (item.medicalNote) {
          contextBlock += "\u2009\u26A0\u2009 \uC758\ub8CC \uC8FC\uC758: " + item.medicalNote + "\n";
        }
      });
    }

    let userPrompt = contextBlock + "\n\n[\uC0AC\uC6A9\uC790 \uC9C8\uBB38]\n" + query;
    
    if (requiresMedicalConsult) {
      userPrompt += "\n\n[\uB0B4\ubd80 \ud50c\ub798\uADF8] \uC774 \uC9C8\uBB38\uC5D0\uB294 \uC758\ub8CC \uC8FC\uC758\uAC00 \ud544\uC694\ud55c \ud0a4\uC6CC\ub4DC\uAC00 \ud3EC\ud568\ub418\uC5C8\ub2C8\uB2E4 (" + detectedRisks.join(", ") + "). \ub2F5\ubcc0 \ub05d\uc5D0 \"\uBC18\ub4dc\uC2DC \uC758\uC0AC\uC640 \uC0C1\ub2D4\ud558\uC138\uC694\" \ub77c\ub294 \uBB38\uAD6C\ub97C \ud3EC\ud568\ud558\uc138\uc694.";
    }

    // ─── [5] CALL CLAUDE SONNET 4.6 ─────────────────
    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
          { role: "user", content: userPrompt }
        ]
      })
    });

    if (!claudeResponse.ok) {
      const errorText = await claudeResponse.text();
      return new Response(JSON.stringify({
        error: "claude_api_error",
        status: claudeResponse.status,
        message: errorText
      }), { status: 500, headers });
    }

    const claudeData = await claudeResponse.json();
    const answer = (claudeData.content || [])
      .filter(function(b) { return b.type === "text"; })
      .map(function(b) { return b.text; })
      .join("\n");

    // ─── [6] POST-PROCESS ────────────────────────────
    const sources = [];
    knowledgeResults.forEach(function(k) {
      sources.push({ type: "knowledge", id: k.id, evidence: k.evidence || null });
    });
    faqResults.forEach(function(f) {
      sources.push({ type: "faq", id: f.id });
    });

    const disclaimer = "\u00A0\uBCF8 \uC815\ubcf4\ub294 \uC758\uB8CC \uC790\ubb38\uc774 \uc544\ub2c8\uba70, \uAC1C\ubcc4 \uAC74\uAC15 \uC0c1\ud0dc\uC5d0 \ub530\ub77c \uB2E4\ub97c \uc218 \uc788\uC2B5\ub2c8\ub2e4. \ubcf5\uC6A9 \uc804 \uC758\uC0AC\u00b7\uC57D\uC0AC\uC640 \uC0C1\ub2d8\ud558\uC138\uC694.";

    return new Response(JSON.stringify({
      query: query,
      category: matchedCategory,
      answer: answer,
      sources: sources,
      flags: {
        requiresMedicalConsult: requiresMedicalConsult,
        detectedRisks: detectedRisks,
        knowledgeCount: knowledgeResults.length,
        faqCount: faqResults.length
      },
      disclaimer: disclaimer
    }), { status: 200, headers });

  } catch (error) {
    return new Response(JSON.stringify({
      error: "internal_error",
      message: error.message
    }), { status: 500, headers });
  }
}
