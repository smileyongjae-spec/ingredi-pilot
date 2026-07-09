// Cloudflare Pages Function: RAG-based answer generation (v4 · 4-category)
// File path: functions/ask.js
//
// v4 변경점:
// - 카테고리 게이트에 "눈"(루테인/지아잔틴) 추가 → 오메가3·비타민C·눈·마이크로바이옴 4종
// - FAQ 검색을 카테고리별 테이블로 라우팅 (FAQ_오메가3 / FAQ_비타민C / FAQ_눈 / FAQ_마이크로바이옴)
//   · 오메가3 테이블과 신규 3종 테이블의 컬럼명이 달라 config로 분기
// - knowledge 검색에 제품 카테고리 필터 추가 (키워드에 카테고리명 포함된 행 우선)
// - knowledge 컨텍스트에 답변예시(상세) 포함 (기존엔 한줄정의만 전달)
// - knowledge 페이지네이션 (100행 초과 대비)
// - 위험 키워드 사전 보강 (흡연+베타카로틴 / 임신+레티놀 / 면역저하+유산균 / 신장결석 / 항생제 등)

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
  const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY;
  const TOKEN = env.AIRTABLE_TOKEN;
  const BASE_ID = env.AIRTABLE_BASE_ID;
  if (!ANTHROPIC_KEY || !TOKEN || !BASE_ID) {
    return new Response(JSON.stringify({ error: "config_missing", message: "Environment variables not set" }), { status: 500, headers });
  }

  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  if (!query) {
    return new Response(JSON.stringify({ error: "bad_request", message: "Missing q parameter" }), { status: 400, headers });
  }

  // ─── 카테고리 설정 ─────────────────────────────────
  // 게이트 키워드 (질문에 포함되면 해당 카테고리로 판정)
  const CATEGORY_KEYWORDS = {
    omega3: ["오메가", "omega", "epa", "dha", "ala", "dpa", "rtg", "알티지", "어유", "fish oil", "크릴", "ee", "tg", "물고기기름", "헤엄오일", "어류"],
    vitaminC: ["비타민c", "비타민 c", "비타민씨", "vitamin c", "아스코르브산", "ascorbic", "메가도스", "리포좀"],
    eye: ["눈", "루테인", "지아잔틴", "아스타잔틴", "황반", "시력", "안구", "눈건강", "lutein", "zeaxanthin", "마리골드", "베타카로틴", "비타민a"],
    probiotics: ["프로바이오틱스", "유산균", "장건강", "probiotics", "마이크로바이옴", "유익균", "비피더스", "락토바실러스", "비피도박테리움", "보장균수", "cfu"]
  };
  // 제품 카테고리 한글 라벨 (out-of-scope 안내·프롬프트용)
  const CATEGORY_LABEL = { omega3: "오메가3", vitaminC: "비타민C", eye: "눈(루테인)", probiotics: "마이크로바이옴(유산균)" };
  // knowledge 행 필터용 토큰 (행 키워드/정의에 이 중 하나라도 있으면 해당 카테고리로 간주)
  const CATEGORY_TOKENS = {
    omega3: ["오메가", "omega", "epa", "dha"],
    vitaminC: ["비타민c", "비타민 c", "아스코르"],
    eye: ["눈", "루테인", "지아잔틴", "아스타잔틴", "황반", "베타카로틴", "비타민a"],
    probiotics: ["마이크로바이옴", "프로바이오틱스", "유산균", "유익균"]
  };
  // FAQ 테이블 + 컬럼 매핑 (오메가3 ≠ 신규 3종)
  const FAQ_CONFIG = {
    omega3:    { table: "FAQ_오메가3", id: "FAQ_ID", q: "질문 (사용자 표현)", a: "답변 (3원칙 적용)", main: "대분류", sub: "소분류", med: "의료 주의사항", kw: null, ev: null },
    vitaminC:  { table: "FAQ_비타민C", id: "faq_id", q: "question", a: "answer", cat: "category", kw: "keywords", ev: "임상근거" },
    eye:       { table: "FAQ_눈", id: "faq_id", q: "question", a: "answer", cat: "category", kw: "keywords", ev: "임상근거" },
    probiotics:{ table: "FAQ_마이크로바이옴", id: "faq_id", q: "question", a: "answer", cat: "category", kw: "keywords", ev: "임상근거" }
  };

  try {
    // ─── [1] CATEGORY GATE ──────────────────────────
    const lowerQuery = query.toLowerCase();
    let matchedCategory = null;
    for (const cat in CATEGORY_KEYWORDS) {
      const kws = CATEGORY_KEYWORDS[cat];
      for (let i = 0; i < kws.length; i++) {
        if (lowerQuery.indexOf(kws[i].toLowerCase()) !== -1) { matchedCategory = cat; break; }
      }
      if (matchedCategory) break;
    }

    if (!matchedCategory) {
      return new Response(JSON.stringify({
        query: query,
        category: "out_of_scope",
        answer: "죄송합니다. ingredi는 현재 오메가3, 비타민C, 눈(루테인), 마이크로바이옴(유산균) 4개 카테고리의 건강기능식품 정보만 제공합니다. 말씀하신 내용은 이 범위를 벗어나 정확히 답하기 어렵습니다.",
        sources: [],
        flags: { outOfScope: true }
      }), { status: 200, headers });
    }

    // ─── [2] 구어체 → 검색 토큰 확장 ─────────────────
    const synonymMap = [
      [/오래\s*(먹|복용|드시|섭취)/g, " 장기 복용 오래"],
      [/계속\s*(먹어|먹으면|복용하면|드시면)/g, " 장기 복용 계속"],
      [/임신\s*(중|했|했을|하면)?/g, " 임산부 임신"],
      [/아이|애기|어린이|초등생|어린애|소아/g, " 어린이 소아"],
      [/수술\s*(전|앞두|예정|하기\s*전)/g, " 수술 수술전 중단"],
      [/언제\s*(먹|복용|드시)/g, " 복용시간 식후 식사"],
      [/부작용|효과가\s*없|효과없/g, " 부작용 주의"],
      [/담배\s*(피|핀|펴)|흡연/g, " 흡연 담배 베타카로틴"],
      [/면역\s*(력)?\s*(저하|약|낮)/g, " 면역저하 상담"],
      [/항생제/g, " 항생제 간격"]
    ];
    let expandedQuery = query;
    for (const [pattern, replacement] of synonymMap) expandedQuery = expandedQuery.replace(pattern, replacement);

    const originalTokens = query.split(/\s+/).filter(t => t.length > 0);
    const expandedTokens = expandedQuery.split(/\s+/).filter(t => t.length > 0);
    const allTokens = [...new Set([...originalTokens, ...expandedTokens])];

    // 검색 토큰 정제: 한글 조사·문장부호 제거 + 불용어 제거 (조사로 인한 0건 매칭 방지)
    const JOSA = ["으로","로서","로써","에서","에게","한테","이라는","라는","이라고","라고","이란","란","이나","이며","이고","은","는","이","가","을","를","와","과","의","에","도","만","요"];
    const STOPWORDS = new Set(["뭐야","뭔지","뭐냐","뭐","무엇","뭔가","알려줘","설명","설명해줘","해줘","어때","인가요","일까요","되나요","건가요","좋아요","괜찮아요","대해","관해","그리고","근데"]);
    function cleanTok(t) { return t.replace(/[?!.,~"'`()\[\]·…:;]/g, "").trim(); }
    function stripJosa(t) { for (const j of JOSA) { if (t.length > j.length + 1 && t.endsWith(j)) return t.slice(0, t.length - j.length); } return t; }
    const tokenSet = new Set();
    for (const t of allTokens) {
      const c = cleanTok(t);
      if (c && !STOPWORDS.has(c)) tokenSet.add(c.toLowerCase());
      const s = stripJosa(c);
      if (s && s.length > 1 && !STOPWORDS.has(s)) tokenSet.add(s.toLowerCase());
    }
    const lowerTokens = [...tokenSet];

    // ─── Airtable 페이지네이션 헬퍼 ──────────────────
    async function fetchAll(table) {
      let records = [], offset = null, guard = 0;
      do {
        let u = "https://api.airtable.com/v0/" + BASE_ID + "/" + encodeURIComponent(table) + "?pageSize=100";
        if (offset) u += "&offset=" + encodeURIComponent(offset);
        const r = await fetch(u, { headers: { Authorization: "Bearer " + TOKEN } });
        if (!r.ok) { const t = await r.text(); throw { __airtable: true, status: r.status, message: t, table: table }; }
        const d = await r.json();
        records = records.concat(d.records || []);
        offset = d.offset; guard++;
      } while (offset && guard < 8);
      return records;
    }

    // ─── [3] KNOWLEDGE 검색 (카테고리 필터 + 스코어) ──
    const fK_keyword = "키워드", fK_oneline = "한줄정의", fK_related = "관련성분키워드",
          fK_category = "카테고리", fK_id = "지식ID", fK_answer = "답변예시", fK_evidence = "임상근거";

    let knowledgeRecords;
    try { knowledgeRecords = await fetchAll("knowledge"); }
    catch (e) {
      return new Response(JSON.stringify({ error: "airtable_knowledge_error", status: e.status || 500, message: e.message || String(e) }), { status: 500, headers });
    }

    const catTokens = CATEGORY_TOKENS[matchedCategory] || [];
    function rowHaystack(f) {
      return [f[fK_keyword] || "", f[fK_oneline] || "", f[fK_related] || "", f[fK_category] || "", f[fK_answer] || ""].join(" ").toLowerCase();
    }
    // 1차: 카테고리 토큰이 포함된 행만. 비면 전체로 폴백.
    let scopedKnowledge = knowledgeRecords.filter(rec => {
      const hay = rowHaystack(rec.fields || {});
      return catTokens.some(tok => hay.indexOf(tok.toLowerCase()) !== -1);
    });
    if (scopedKnowledge.length === 0) scopedKnowledge = knowledgeRecords;

    let knowledgeMatched = scopedKnowledge
      .map(record => {
        const f = record.fields || {};
        const hay = rowHaystack(f);
        let score = 0;
        for (const token of lowerTokens) if (token.length > 1 && hay.indexOf(token) !== -1) score++;
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

    // ─── FAQ 검색 (카테고리별 테이블 라우팅) ──────────
    const cfg = FAQ_CONFIG[matchedCategory];
    let faqMatched = [], faqError = null;
    try {
      const faqRecords = await fetchAll(cfg.table);
      faqMatched = faqRecords
        .map(record => {
          const f = record.fields || {};
          const hay = [
            f[cfg.q] || "",
            f[cfg.a] || "",
            f[cfg.main] || f[cfg.cat] || "",
            f[cfg.sub] || "",
            cfg.kw ? (f[cfg.kw] || "") : ""
          ].join(" ").toLowerCase();
          let score = 0;
          for (const token of lowerTokens) if (token.length > 1 && hay.indexOf(token) !== -1) score++;
          return { record, score, fields: f };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(item => {
          const f = item.fields;
          return {
            id: f[cfg.id] || item.record.id,
            category: (f[cfg.main] || f[cfg.cat] || ""),
            subCategory: f[cfg.sub] || "",
            question: f[cfg.q] || "",
            answer: f[cfg.a] || "",
            medicalNote: cfg.med ? (f[cfg.med] || "") : "",
            evidence: cfg.ev ? (f[cfg.ev] || "") : "",
            score: item.score
          };
        });
    } catch (e) {
      faqError = (e && e.message) ? ("FAQ(" + cfg.table + ") " + e.message) : ("FAQ status");
    }

    // 개요 폴백: 토큰이 빗나갔지만 카테고리는 유효한 경우, 핵심 지식(효능/개념)으로 답변
    if (knowledgeMatched.length === 0 && faqMatched.length === 0 && scopedKnowledge.length > 0) {
      const ORDER = { "효능": 0, "개념": 1, "성분": 2, "섭취량": 3, "구성": 4, "균수": 5 };
      knowledgeMatched = scopedKnowledge.slice()
        .sort((a, b) => ((ORDER[(a.fields || {})[fK_category]] ?? 9) - (ORDER[(b.fields || {})[fK_category]] ?? 9)))
        .slice(0, 4)
        .map(rec => { const f = rec.fields || {}; return { id: f[fK_id] || rec.id, category: f[fK_category] || "", oneline: f[fK_oneline] || "", answer: f[fK_answer] || "", evidence: f[fK_evidence] || "", related: f[fK_related] || "", score: 0 }; });
    }

    if (knowledgeMatched.length === 0 && faqMatched.length === 0) {
      return new Response(JSON.stringify({
        query: query,
        category: matchedCategory,
        answer: "그 부분은 ingredi가 근거 데이터로 확인해 드리기 어려운 내용입니다. 대신 " + CATEGORY_LABEL[matchedCategory] + "의 함량·제형·복용법 같은 일반 정보는 안내해 드릴 수 있습니다.",
        sources: [],
        flags: { noResults: true, tokens: allTokens, expandedQuery: expandedQuery, faqError: faqError }
      }), { status: 200, headers });
    }

    // ─── [4] 위험 키워드 감지 ────────────────────────
    const riskKeywords = {
      pregnancy: ["임산부", "임신", "수유"],
      surgery: ["수술", "수술전", "시술"],
      bleeding: ["출혈", "항응고", "와파린"],
      highDose: ["2000mg", "2500mg", "3000mg", "고함량", "과다", "메가도스"],
      chronicDisease: ["당뇨병", "고혈압", "심장병", "간질환", "간염", "신부전", "신장질환", "투석"],
      smoking: ["흡연", "담배", "전자담배", "베타카로틴", "레티놀"],
      immunocompromised: ["면역저하", "항암", "항암치료", "장기이식", "이식", "면역억제", "췌장염", "중심정맥관", "미숙아"],
      vitcRisk: ["신장결석", "결석", "혈색소증", "철과부하", "g6pd"],
      antibiotics: ["항생제"]
    };
    const detectedRisks = [];
    for (const riskType in riskKeywords) {
      for (const kw of riskKeywords[riskType]) {
        if (lowerQuery.indexOf(kw.toLowerCase()) !== -1) { detectedRisks.push(riskType); break; }
      }
    }
    const requiresMedicalConsult = detectedRisks.length > 0;

    // ─── [5] 프롬프트 구성 ───────────────────────────
    const systemPrompt = [
      "당신은 ingredi의 건강기능식품 정보 어시스턴트입니다.",
      "",
      "[핵심 원칙]",
      "1. 광고 없음 — 특정 제품·브랜드를 추천하지 않습니다",
      "2. 근거 기반 — 제공된 검색 결과의 사실만 답변합니다",
      "3. 엄격 모드 — 검색 결과에 없는 내용은 추측하지 않습니다",
      "",
      "[답변 스타일]",
      "- 한국어, 존댓말",
      "- 질문 성격에 맞는 길이 (단순 질문: 1~2문장 / 복합 질문: 4~6문장)",
      "- 의학 자문이 아님을 명시",
      "- 시작할 때 인사말·음·아 같은 불필요한 받침을 빼고 바로 답변",
      "- 근거 있는 경우 \"식약처 인정\", \"PubMed 연구\" 등으로 출처 밝히기",
      "- 마크다운(#, **, ---, > 등)·이모지 사용 절대 금지, 흐르는 문장으로만",
      "- 검색 결과 범위를 벗어나는 질문이면 \"이 부분은 ingredi 지식DB에 아직 준비되지 않았습니다\"로 답변",
      "",
      "[제약]",
      "- 특정 제품명·브랜드 추천 금지",
      "- 진단 금지 — \"의사와 상담하세요\"로 대신",
      "- 과단적 표현 금지(\"반드시\" 등)",
      "- 검색 결과에 없는 숫자·지수 추측 금지"
    ].join("\n");

    let contextBlock = "[검색된 지식]\n\n";
    if (knowledgeMatched.length > 0) {
      contextBlock += "## knowledge 항목 (" + knowledgeMatched.length + "건)\n";
      knowledgeMatched.forEach((item, idx) => {
        contextBlock += "\n[K" + (idx + 1) + "] " + item.id + " (카테고리: " + item.category + ")\n";
        contextBlock += "- " + item.oneline + "\n";
        if (item.answer) contextBlock += "- 설명: " + item.answer + "\n";
        if (item.evidence) contextBlock += "- 근거: " + item.evidence + "\n";
      });
    }
    if (faqMatched.length > 0) {
      contextBlock += "\n\n## FAQ 항목 (" + faqMatched.length + "건)\n";
      faqMatched.forEach((item, idx) => {
        contextBlock += "\n[F" + (idx + 1) + "] " + item.id + (item.category ? " (" + item.category + ")" : "") + "\n";
        contextBlock += "Q: " + item.question + "\n";
        contextBlock += "A: " + item.answer + "\n";
        if (item.evidence) contextBlock += "근거: " + item.evidence + "\n";
        if (item.medicalNote) contextBlock += "주의: " + item.medicalNote + "\n";
      });
    }

    let userPrompt = contextBlock + "\n\n[사용자 질문]\n" + query;
    if (requiresMedicalConsult) {
      userPrompt += "\n\n[내부 플래그] 이 질문에는 의료 주의가 필요한 키워드가 포함되었습니다 (" + detectedRisks.join(", ") + "). 답변 끝에 \"복용 전 의사·약사와 상담하세요\"라는 문구를 포함하세요.";
    }

    // ─── [6] CLAUDE 호출 ─────────────────────────────
    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1024, system: systemPrompt, messages: [{ role: "user", content: userPrompt }] })
    });
    if (!claudeResponse.ok) {
      const errorText = await claudeResponse.text();
      return new Response(JSON.stringify({ error: "claude_api_error", status: claudeResponse.status, message: errorText }), { status: 500, headers });
    }
    const claudeData = await claudeResponse.json();
    const answer = (claudeData.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");

    // ─── [7] 후처리 ──────────────────────────────────
    const sources = [];
    knowledgeMatched.forEach(k => sources.push({ type: "knowledge", id: k.id, evidence: k.evidence || null }));
    faqMatched.forEach(f => sources.push({ type: "faq", id: f.id }));

    const disclaimer = "본 정보는 의료 자문이 아니며, 개별 건강 상태에 따라 다를 수 있습니다. 복용 전 의사·약사와 상담하세요.";

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
        faqTable: cfg.table,
        faqError: faqError
      },
      disclaimer: disclaimer
    }), { status: 200, headers });

  } catch (error) {
    return new Response(JSON.stringify({ error: "internal_error", message: error.message, stack: error.stack ? error.stack.substring(0, 500) : null }), { status: 500, headers });
  }
}
