// Cloudflare Pages Function: RAG-based answer generation (v3)
// File path: functions/ask.js
//
// v3 fixes:
// - FAQ 컬럼명 수정 (공백/표기 불일치 → noResults 버그 해결)
//   "질문(사용자 표현)" → "질문 (사용자 표현)"
//   "답변(3원칙 적용)" → "답변 (3원칙 적용)"
//   "관련 지식 ID (RAG)" → "관련 지식 ID (RAG 매핑)"
// - 구어체 동의어 확장: "오래 먹으면"→장기복용, "간이 안좋은데"→간질환 등
// - 카테고리 게이트 키워드 보강 (구어체 포함)

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
    // v3: 구어체 표현 추가 ("영양제", "영양소", "캡슐", "알약" 등)
    const supportedCategories = {
      "omega3": [
        "\uC624\uBA54\uAC00", "omega", "epa", "dha", "ala", "dpa", "rtg",
        "\uC54C\uD2F0\uC9C0", "\uC5B4\uC720", "fish oil", "\uD06C\uB9B4", "ee", "tg",
        "\uC601\uC591\uC81C", "\uC5C1\uC36C", "\uCEA1\uC2EC", "\uC54C\uC57D",
        "\uBB3C\uACE0\uAE30\uAE30\uB984", "\uD5E4\uC5C4\uC624\uC77C", "\uC5B4\uB958"
      ],
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

    // ─── [2] 구어체 → 검색 토큰 확장 (v3 핵심) ─────
    // 사용자 구어체를 검색에 유리한 단어로 보강
    const synonymMap = [
      // 장기복용 관련
      [/오래\s*(먹|복용|드시|섭취)/g, " \uC7A5\uAE30 \uBCF5\uC6A9 \uC624\uB798"],
      [/\uACC4\uC18D\s*(먹어|먹으면|복용하면|드시면)/g, " \uC7A5\uAE30 \uBCF5\uC6A9 \uACC4\uC18D"],
      // 간 관련
      [/\uAC04\uC774?\s*(안\s*좋|나쁘|약하|안\s*좋은데|좋지\s*않)/g, " \uAC04 \uAC04\uC9C8\uD658 \uAC04\uAE30\uB2A5"],
      [/\uAC04\uC5FC|\uAC04\uACBD\uD654|\uAC04\uC554/g, " \uAC04\uC9C8\uD658 \uAC04"],
      // 혈압/혈당 관련
      [/\uD63C\uC555(\uC57D|\uC758\uC57D)?/g, " \uD63C\uC555 \uD639\uACE0\uD63C\uC555\uC57D \uD639\uC555"],
      [/\uD63C\uB2F9(\uC57D|\uC758\uC57D)?/g, " \uD63C\uB2F9 \uB2F9\uB1A8\uBCD1"],
      // 알레르기
      [/\uC0DD\uC120\s*\uC54C\uB808\uB974\uAE30/g, " \uC54C\uB808\uB974\uAE30 \uC5B4\uB958 \uC0DD\uC120"],
      // 임산부/임신
      [/\uC784\uC2E0\s*(중|했|했을|하면)?/g, " \uC784\uC0B0\uBD80 \uC784\uC2E0"],
      // 어린이/아이
      [/\uC544\uC774|\uC560\uAE30|\uC5B4\uB9B0\uC774|\uCD08\uB4F1\uC0DD|\uC5B4\uB9B0\uC560|\uC18C\uC544/g, " \uC5B4\uB9B0\uC774 \uC5B4\uB9B0\uC774\uC6A9 \uC18C\uC544"],
      // 수술
      [/\uC218\uC220\s*(전|앞두|예정|하기\s*전)/g, " \uC218\uC220 \uC218\uC220\uC804 \uC911\uB2E8"],
      // 복용시간
      [/\uC5B8\uC81C\s*(\uBA39|복용|드시)/g, " \uBCF5\uC6A9\uC2DC\uAC04 \uC2DD\uD6C4 \uC2DD\uC0AC"],
      [/\uC544\uCE68|\uC800\uB141|\uC800\uB140\uC5D0/g, " \uBCF5\uC6A9\uC2DC\uAC04 \uC2DC\uAC04\uB300"],
      // 부작용
      [/\uBD80\uC791\uC6A9|\uBD80\uC791\uC758|\uD6A8\uACFC\uAC00\s*\uC5C6|\uD6A8\uACFC\uC5C6/g, " \uBD80\uC791\uC6A9 \uC8FC\uC758"],
      // 순도
      [/\uC21C\uB3C4|\uB193\uC740\s*\uC21C\uB3C4/g, " \uC21C\uB3C4 80%"],
      // 산패
      [/\uC0B0\uD328|\uBE44\uB9B0\uB0B4|\uC0C1\uD55C/g, " \uC0B0\uD328 \uBE44\uB9B0\uB0B4 \uD488\uC9C8"],
    ];

    // 확장된 검색용 쿼리 생성
    let expandedQuery = query;
    for (const [pattern, replacement] of synonymMap) {
      expandedQuery = expandedQuery.replace(pattern, replacement);
    }

    // 토큰화: 원본 + 확장 토큰 합치기
    const originalTokens = query.split(/\s+/).filter(t => t.length > 0);
    const expandedTokens = expandedQuery.split(/\s+/).filter(t => t.length > 0);
    const allTokens = [...new Set([...originalTokens, ...expandedTokens])];
    const lowerTokens = allTokens.map(t => t.toLowerCase());

    // ─── [3] DIRECT AIRTABLE SEARCH ─────────────────
    const knowledgeUrl = "https://api.airtable.com/v0/" + BASE_ID + "/knowledge?maxRecords=100";
    const knowledgeRes = await fetch(knowledgeUrl, {
      headers: { Authorization: "Bearer " + TOKEN }
    });

    if (!knowledgeRes.ok) {
      const t = await knowledgeRes.text();
      return new Response(JSON.stringify({
        error: "airtable_knowledge_error",
        status: knowledgeRes.status,
        message: t
      }), { status: 500, headers });
    }
    const knowledgeData = await knowledgeRes.json();

    const fK_keyword = "\uD0A4\uC6CC\uB4DC";
    const fK_oneline = "\uD55C\uC904\uC815\uC758";
    const fK_related = "\uAD00\uB828\uC131\uBD84\uD0A4\uC6CC\uB4DC";
    const fK_category = "\uCE74\uD14C\uACE0\uB9AC";
    const fK_id = "\uC9C0\uC2DDID";
    const fK_answer = "\uB2F5\uBCC0\uC608\uC2DC";
    const fK_evidence = "\uC784\uC0C1\uADFC\uAC70";

    const knowledgeMatched = (knowledgeData.records || [])
      .map(record => {
        const f = record.fields || {};
        const haystack = [
          f[fK_keyword] || "",
          f[fK_oneline] || "",
          f[fK_related] || "",
          f[fK_category] || ""
        ].join(" ").toLowerCase();

        let score = 0;
        for (const token of lowerTokens) {
          if (token.length > 1 && haystack.indexOf(token) !== -1) score++;
        }
        return { record, score, fields: f };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(item => {
        const f = item.fields;
        return {
          id: f[fK_id] || item.record.id,
          category: f[fK_category] || "",
          oneline: f[fK_oneline] || "",
          answer: f[fK_answer] || "",
          evidence: f[fK_evidence] || "",
          related: f[fK_related] || "",
          score: item.score
        };
      });

    // ── FAQ 검색 (v3: 컬럼명 수정) ──────────────────
    // 수정: "질문(사용자 표현)" → "질문 (사용자 표현)" (공백 추가)
    //       "답변(3원칙 적용)" → "답변 (3원칙 적용)" (공백 추가)
    //       "관련 지식 ID (RAG)" → "관련 지식 ID (RAG 매핑)" (매핑 추가)
    const faqTableName = encodeURIComponent("FAQ_\uC624\uBA54\uAC003");
    const faqUrl = "https://api.airtable.com/v0/" + BASE_ID + "/" + faqTableName + "?maxRecords=200";
    let faqMatched = [];
    let faqError = null;

    try {
      const faqRes = await fetch(faqUrl, {
        headers: { Authorization: "Bearer " + TOKEN }
      });

      if (faqRes.ok) {
        const faqData = await faqRes.json();

        // ✅ v3 수정된 컬럼명
        const fF_id  = "FAQ_ID";
        const fF_main = "\uB300\uBD84\uB958";
        const fF_sub  = "\uC18C\uBD84\uB958";
        const fF_q   = "\uC9C8\uBB38 (\uC0AC\uC6A9\uC790 \uD45C\uD604)";   // 수정: 공백 추가
        const fF_a   = "\uB2F5\uBCC0 (3\uC6D0\uCE59 \uC801\uC6A9)";        // 수정: 공백 추가
        const fF_rel = "\uAD00\uB828 \uC9C0\uC2DD ID (RAG \uB9E4\uD551)";   // 수정: 매핑 추가
        const fF_med = "\uC758\uB8CC \uC8FC\uC758\uC0AC\uD56D";

        faqMatched = (faqData.records || [])
          .map(record => {
            const f = record.fields || {};
            const haystack = [
              f[fF_q] || "",
              f[fF_a] || "",
              f[fF_main] || "",
              f[fF_sub] || ""
            ].join(" ").toLowerCase();

            let score = 0;
            for (const token of lowerTokens) {
              if (token.length > 1 && haystack.indexOf(token) !== -1) score++;
            }
            return { record, score, fields: f };
          })
          .filter(item => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map(item => {
            const f = item.fields;
            return {
              id: f[fF_id] || item.record.id,
              mainCategory: f[fF_main] || "",
              subCategory: f[fF_sub] || "",
              question: f[fF_q] || "",
              answer: f[fF_a] || "",
              relatedKnowledge: f[fF_rel] || "",
              medicalNote: f[fF_med] || "",
              score: item.score
            };
          });
      } else {
        faqError = "FAQ status " + faqRes.status;
      }
    } catch (e) {
      faqError = e.message;
    }

    if (knowledgeMatched.length === 0 && faqMatched.length === 0) {
      return new Response(JSON.stringify({
        query: query,
        category: matchedCategory,
        answer: "\uC8C4\uC1A1\uD569\uB2C8\uB2E4. \uD574\uB2F9 \uC9C8\uBB38\uC5D0 \uB300\uD55C \uC815\uBCF4\uAC00 ingredi \uC9C0\uC2DDDB\uC5D0 \uC544\uC9C1 \uC900\uBE44\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uBCF4\uB2E4 \uC815\uD655\uD55C \uB2F5\uBCC0\uC744 \uB4DC\uB9AC\uAE30 \uC704\uD574 \uC9C0\uC2DD\uC774 \uCD94\uAC00\uB418\uB294 \uB300\uB85C \uC11C\uBE44\uC2A4\uB97C \uAC1C\uC120\uD574 \uB098\uAC00\uACA0\uC2B5\uB2C8\uB2E4.",
        sources: [],
        flags: {
          noResults: true,
          tokens: allTokens,
          expandedQuery: expandedQuery,
          faqError: faqError
        }
      }), { status: 200, headers });
    }

    // ─── [4] DETECT MEDICAL RISK KEYWORDS ───────────
    const riskKeywords = {
      pregnancy: ["\uC784\uC0B0\uBD80", "\uC784\uC2E0", "\uC218\uC720"],
      surgery: ["\uC218\uC220", "\uC218\uC220\uC804", "\uC2DC\uC220"],
      bleeding: ["\uCD9C\uD608", "\uD56D\uC751\uACE0", "\uC640\uD30C\uB9B0"],
      highDose: ["2000mg", "2500mg", "3000mg", "\uACE0\uD568\uB7C9", "\uACFC\uB2E4"],
      chronicDisease: ["\uB2F9\uB1A8\uBCD1", "\uACE0\uD63C\uC555", "\uC2EC\uC7A5\uBCD1", "\uAC04\uC9C8\uD658", "\uAC04\uC5FC"]
    };

    const detectedRisks = [];
    for (const riskType in riskKeywords) {
      for (const kw of riskKeywords[riskType]) {
        if (lowerQuery.indexOf(kw.toLowerCase()) !== -1) {
          detectedRisks.push(riskType);
          break;
        }
      }
    }
    const requiresMedicalConsult = detectedRisks.length > 0;

    // ─── [5] BUILD CLAUDE PROMPT ─────────────────────
    const systemPrompt = "\uB2F9\uC2E0\uC740 ingredi\uC758 \uAC74\uAC15\uAE30\uB2A5\uC2DD\uD488 \uC815\uBCF4 \uC5B4\uC2DC\uC2A4\uD134\uD2B8\uC785\uB2C8\uB2E4.\n\n[\uD575\uC2EC \uC6D0\uCE59]\n1. \uAD11\uACE0 \uC5C6\uC74C \u2014 \uD2B9\uC815 \uC81C\uD488\u00B7\uBE0C\uB79C\uB4DC\uB97C \uCD94\uCC9C\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4\n2. \uC784\uC0C1 \uADFC\uAC70 \uAE30\uBC18 \u2014 \uC81C\uACF5\uB41C \uAC80\uC0C9 \uACB0\uACFC\uC758 \uC0AC\uC2E4\uB9CC \uB2F5\uBCC0\uD569\uB2C8\uB2E4\n3. \uC5C4\uACA9 \uBAA8\uB4DC \u2014 \uAC80\uC0C9 \uACB0\uACFC\uC5D0 \uC5C6\uB294 \uB0B4\uC6A9\uC740 \uCD94\uCE21\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4\n\n[\uB2F5\uBCC0 \uC2A4\uD0C0\uC77C]\n- \uD55C\uAD6D\uC5B4, \uC874\uB313\uB9D0\n- \uC9C8\uBB38 \uC131\uACA9\uC5D0 \uB9DE\uB294 \uAE38\uC774 (\uB2E8\uC21C \uC9C8\uBB38: 1~2\uBB38\uC7A5 / \uBCF5\uD569 \uC9C8\uBB38: 4~6\uBB38\uC7A5)\n- \uC758\uD559 \uC790\uBB38\uC774 \uC544\uB2D8\uC744 \uBA85\uC2DC\n- \uC2DC\uC791\uD560 \uB54C \uC778\uC0AC\uB9D0\u00B7\uC74C\u00B7\uC544 \uAC19\uC740 \uBD88\uD544\uC694\uD55C \uBC1B\uCE68\uC744 \uBE7C\uACE0 \uBC14\uB85C \uB2F5\uBCC0\n- \uADFC\uAC70 \uC788\uB294 \uACBD\uC6B0 \"\uC2DD\uC57D\uCC98 \uC778\uC815\", \"PubMed \uC5F0\uAD6C\" \uB4F1\uC73C\uB85C \uCD9C\uCC98 \uBC1D\uD788\uAE30\n- \uB9C8\uD06C\uB2E4\uC6B4 \uC0AC\uC6A9 \uC808\uB300 \uAE08\uC9C0: #, ##, ###, **, *, ---, > \uAC19\uC740 \uAE30\uD638 \uC0AC\uC6A9 \uC548 \uD568\n- \uC774\uBAA8\uC9C0 \uC0AC\uC6A9 \uC808\uB300 \uAE08\uC9C0\n- \uC18C\uC81C\uBAA9, \uAD6C\uBD84\uC120 \uC5C6\uC774 \uD750\uB974\uB294 \uBB38\uC7A5\uC73C\uB85C\uB9CC \uC791\uC131\n- \uD544\uC694\uC2DC \uB2E8\uB77D\uC740 \uC904\uBC14\uAFC8\uC73C\uB85C \uAD6C\uBD84\n- \uAC80\uC0C9 \uACB0\uACFC \uBC94\uC704\uB97C \uBC97\uC5B4\uB098\uB294 \uC9C8\uBB38\uC774\uBA74 \uC194\uC9C1\uD788 \"\uC774 \uBD80\uBD84\uC740 ingredi \uC9C0\uC2DDDB\uC5D0 \uC544\uC9C1 \uC900\uBE44\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4\"\uB85C \uB2F5\uBCC0\n\n[\uC81C\uC57D]\n- \uD2B9\uC815 \uC81C\uD488\uBA85\u00B7\uBE0C\uB79C\uB4DC \uCD94\uCC9C \uAE08\uC9C0\n- \uC9C4\uB2E8\uC9C0\uC2DC No \u2014 \"\uC758\uC0AC\uC640 \uC0C1\uB2F4\uD558\uC138\uC694\"\uB85C \uB300\uC2E0\n- \uACFC\uB2E8\uC801 \uD45C\uD604 \uAE08\uC9C0 (\"\uBC18\uB4DC\uC2DC\", \"\uBC18\uB4DC\uC2DC \uD3EC\uC694\" \uB4F1)\n- \uAC80\uC0C9 \uACB0\uACFC\uC5D0 \uC5C6\uB294 \uC22B\uC790\u00B7\uC9C0\uC218 \uCD94\uCE21 \uAE08\uC9C0";

    let contextBlock = "[\uAC80\uC0C9\uB41C \uC9C0\uC2DD]\n\n";

    if (knowledgeMatched.length > 0) {
      contextBlock += "## knowledge \uD56D\uBAA9 (" + knowledgeMatched.length + "\uAC74)\n";
      knowledgeMatched.forEach((item, idx) => {
        contextBlock += "\n[K" + (idx + 1) + "] " + item.id + " (\uCE74\uD14C\uACE0\uB9AC: " + item.category + ")\n";
        contextBlock += "- " + item.oneline + "\n";
        if (item.evidence) contextBlock += "- \uADFC\uAC70: " + item.evidence + "\n";
      });
    }

    if (faqMatched.length > 0) {
      contextBlock += "\n\n## FAQ \uD56D\uBAA9 (" + faqMatched.length + "\uAC74)\n";
      faqMatched.forEach((item, idx) => {
        contextBlock += "\n[F" + (idx + 1) + "] " + item.id + " (" + item.mainCategory + " > " + item.subCategory + ")\n";
        contextBlock += "Q: " + item.question + "\n";
        contextBlock += "A: " + item.answer + "\n";
        if (item.medicalNote) contextBlock += "\u26A0 \uC758\uB8CC \uC8FC\uC758: " + item.medicalNote + "\n";
      });
    }

    let userPrompt = contextBlock + "\n\n[\uC0AC\uC6A9\uC790 \uC9C8\uBB38]\n" + query;

    if (requiresMedicalConsult) {
      userPrompt += "\n\n[\uB0B4\uBD80 \uD50C\uB798\uADF8] \uC774 \uC9C8\uBB38\uC5D0\uB294 \uC758\uB8CC \uC8FC\uC758\uAC00 \uD544\uC694\uD55C \uD0A4\uC6CC\uB4DC\uAC00 \uD3EC\uD568\uB418\uC5C8\uC2B5\uB2C8\uB2E4 (" + detectedRisks.join(", ") + "). \uB2F5\uBCC0 \uB05D\uC5D0 \"\uBC18\uB4DC\uC2DC \uC758\uC0AC\uC640 \uC0C1\uB2F4\uD558\uC138\uC694\" \uB77C\uB294 \uBB38\uAD6C\uB97C \uD3EC\uD568\uD558\uC138\uC694.";
    }

    // ─── [6] CALL CLAUDE SONNET 4.6 ─────────────────
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
        messages: [{ role: "user", content: userPrompt }]
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
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");

    // ─── [7] POST-PROCESS ────────────────────────────
    const sources = [];
    knowledgeMatched.forEach(k => sources.push({ type: "knowledge", id: k.id, evidence: k.evidence || null }));
    faqMatched.forEach(f => sources.push({ type: "faq", id: f.id }));

    const disclaimer = "\u00A0\uBCF8 \uC815\uBCF4\uB294 \uC758\uB8CC \uC790\uBB38\uC774 \uC544\uB2C8\uBA70, \uAC1C\uBCC4 \uAC74\uAC15 \uC0C1\uD0DC\uC5D0 \uB530\uB77C \uB2E4\uB97C \uC218 \uC788\uC2B5\uB2C8\uB2E4. \uBCF5\uC6A9 \uC804 \uC758\uC0AC\u00B7\uC57D\uC0AC\uC640 \uC0C1\uB2F4\uD558\uC138\uC694.";

    return new Response(JSON.stringify({
      query: query,
      category: matchedCategory,
      answer: answer,
      sources: sources,
      flags: {
        requiresMedicalConsult: requiresMedicalConsult,
        detectedRisks: detectedRisks,
        knowledgeCount: knowledgeMatched.length,
        faqCount: faqMatched.length,
        faqError: faqError
      },
      disclaimer: disclaimer
    }), { status: 200, headers });

  } catch (error) {
    return new Response(JSON.stringify({
      error: "internal_error",
      message: error.message,
      stack: error.stack ? error.stack.substring(0, 500) : null
    }), { status: 500, headers });
  }
}
