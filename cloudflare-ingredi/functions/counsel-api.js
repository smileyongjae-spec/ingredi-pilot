// Cloudflare Pages Function: Integrated counseling endpoint
// File path: functions/counsel-api.js
// URL: /counsel-api?q=<user_question>
//
// v6 (4-category): AI 카운슬링을 4개 카테고리로 확장
//   - 카테고리 게이트에 '눈' 추가 (오메가3·비타민C·눈·마이크로바이옴), out_of_scope 메시지 4종
//   - knowledge 카테고리 필터 + 답변예시(상세) 컨텍스트 포함
//   - FAQ 카테고리별 테이블 라우팅 (FAQ_오메가3 / FAQ_비타민C / FAQ_눈 / FAQ_마이크로바이옴)
//   - 위험 키워드 보강 (흡연+베타카로틴 / 임신+레티놀 / 면역저하+유산균 / 신장결석 / 항생제 등)
//   - 제품 추천(top3)은 오메가3 전용 로직이라 omega3일 때만 산출, 그 외 카테고리는 답변만(추천 빈 구조)
//
// (이전 버전 주석 생략)

import { getRecords } from "./_lib/airtable.js";

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
    return new Response(JSON.stringify({ error: "config_missing" }), { status: 500, headers });
  }

  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  if (!query) {
    return new Response(JSON.stringify({ error: "bad_request", message: "Missing q parameter" }), { status: 400, headers });
  }

  // ─── 카테고리 설정 (ask.js와 동일) ─────────────────
  const CATEGORY_KEYWORDS = {
    omega3: ["오메가", "omega", "epa", "dha", "ala", "dpa", "rtg", "알티지", "어유", "fish oil", "크릴", "ee", "tg", "어류"],
    vitaminC: ["비타민c", "비타민 c", "비타민씨", "vitamin c", "아스코르브산", "ascorbic", "메가도스", "리포좀"],
    eye: ["눈", "루테인", "지아잔틴", "아스타잔틴", "황반", "시력", "안구", "눈건강", "lutein", "zeaxanthin", "마리골드", "베타카로틴", "비타민a"],
    probiotics: ["프로바이오틱스", "유산균", "장건강", "probiotics", "마이크로바이옴", "유익균", "비피더스", "락토바실러스", "비피도박테리움", "보장균수", "cfu"]
  };
  const CATEGORY_LABEL = { omega3: "오메가3", vitaminC: "비타민C", eye: "눈(루테인)", probiotics: "마이크로바이옴(유산균)" };
  const CATEGORY_TOKENS = {
    omega3: ["오메가", "omega", "epa", "dha"],
    vitaminC: ["비타민c", "비타민 c", "아스코르"],
    eye: ["눈", "루테인", "지아잔틴", "아스타잔틴", "황반", "베타카로틴", "비타민a"],
    probiotics: ["마이크로바이옴", "프로바이오틱스", "유산균", "유익균"]
  };
  const FAQ_CONFIG = {
    omega3:    { table: "FAQ_오메가3", id: "FAQ_ID", q: "질문 (사용자 표현)", a: "답변 (3원칙 적용)", main: "대분류", sub: "소분류", med: "의료 주의사항", kw: null, ev: null },
    vitaminC:  { table: "FAQ_비타민C", id: "faq_id", q: "question", a: "answer", cat: "category", kw: "keywords", ev: "임상근거" },
    eye:       { table: "FAQ_눈", id: "faq_id", q: "question", a: "answer", cat: "category", kw: "keywords", ev: "임상근거" },
    probiotics:{ table: "FAQ_마이크로바이옴", id: "faq_id", q: "question", a: "answer", cat: "category", kw: "keywords", ev: "임상근거" }
  };
  const OUT_OF_SCOPE_MSG = "죄송합니다. ingredi는 현재 오메가3, 비타민C, 눈(루테인), 마이크로바이옴(유산균) 4개 카테고리의 건강기능식품 정보만 제공합니다. 말씀하신 내용은 이 범위를 벗어나 정확히 답하기 어렵습니다.";

  // ─── HELPERS ─────────────────────────────────────
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
  function normEntity(s) { return String(s || "").replace(/[\s\-_\u00B7]/g, "").toLowerCase(); }

  // ─── PROFILE WEIGHTS (오메가3 추천 전용) ──────────
  const PROFILES = {
    "premium_seeker": { label: "최고 품질 선호", weights: { dose: 30, form: 20, source: 20, cert: 20, price: 10 }, medicalConsult: false },
    "budget_seeker":  { label: "가성비 선호", weights: { dose: 20, form: 15, source: 15, cert: 10, price: 40 }, medicalConsult: false },
    "balanced":       { label: "교형형 (기본값)", weights: { dose: 30, form: 20, source: 20, cert: 20, price: 10 }, medicalConsult: false },
    "pregnancy":      { label: "임산부·수유부", weights: { dose: 15, form: 15, source: 30, cert: 35, price: 5 }, medicalConsult: true },
    "senior":         { label: "시니어 (50+)", weights: { dose: 35, form: 25, source: 15, cert: 15, price: 10 }, medicalConsult: false, filters: { minDailyDose: 1000 } }
  };
  function matchProfileLocal(q) {
    const lower = q.toLowerCase();
    const keywordMap = [
      { profile: "pregnancy",      keywords: ["임산부", "임신", "수유", "pregnant"] },
      { profile: "senior",         keywords: ["시니어", "노인", "부모님", "50대", "60대", "70대", "어버지", "어머니", "senior"] },
      { profile: "budget_seeker",  keywords: ["가성비", "저렴", "싸는", "경제적", "예산", "cheap", "budget"] },
      { profile: "premium_seeker", keywords: ["최고", "프리미엄", "고급", "비싸도", "premium", "best"] }
    ];
    for (const km of keywordMap) for (const kw of km.keywords) if (lower.indexOf(kw.toLowerCase()) !== -1) return km.profile;
    return "balanced";
  }
  function scoreDose(d) { if (!d || d <= 0) return 20; if (d >= 1500) return 100; if (d >= 1000) return 80; if (d >= 600) return 60; if (d >= 500) return 40; return 20; }
  function scoreForm(form) { if (!form) return 50; const f = String(form).toLowerCase(); if (f.indexOf("rtg") !== -1) return 100; if (f.indexOf("phospholipid") !== -1) return 95; if (f === "tg") return 90; if (f === "ee") return 60; return 50; }
  function scoreSource(supplier) { if (!supplier) return 40; const s = String(supplier).toLowerCase(); for (const t of ["dsm", "basf", "epax", "croda", "solutex", "kd"]) if (s.indexOf(t) !== -1) return 90; return 60; }
  function scoreCert(certs) { if (!certs || String(certs).trim() === "") return 0; let score = 0; const c = String(certs).toUpperCase(); if (c.indexOf("IFOS") !== -1) { score += (c.indexOf("5-STAR") !== -1 || c.indexOf("5스타") !== -1) ? 40 : 25; } if (c.indexOf("GMP") !== -1) score += 20; if (c.indexOf("GOED") !== -1) score += 20; if (c.indexOf("MSC") !== -1) score += 15; if (c.indexOf("NSF") !== -1) score += 15; if (c.indexOf("ISO") !== -1) score += 10; return Math.min(100, score); }
  function scorePrice(p) { if (!p || p <= 0) return 50; if (p <= 200) return 100; if (p <= 400) return 90; if (p <= 600) return 80; if (p <= 900) return 60; if (p <= 1200) return 40; return 20; }

  // ─── 성분 엔티티 감지 (오메가3 성분 단독 입력) ────
  const INGREDIENT_TERMS = [
    { key: "epadha", label: "EPA+DHA", aliases: ["epa+dha", "epadha"] },
    { key: "epa",    label: "EPA",     aliases: ["epa"] },
    { key: "dha",    label: "DHA",     aliases: ["dha"] },
    { key: "omega3", label: "오메가3", aliases: ["오메가3", "omega3", "오메가쓰리"] },
    { key: "rtg",    label: "rTG",     aliases: ["rtg", "알티지"], form: "rtg" },
    { key: "tg",     label: "TG",      aliases: ["tg"], form: "tg" },
    { key: "ee",     label: "EE",      aliases: ["ee", "에틸에스터", "에틸에스테르"], form: "ee" },
    { key: "ala",    label: "ALA",     aliases: ["ala"] },
    { key: "dpa",    label: "DPA",     aliases: ["dpa"] }
  ];
  function detectIngredient(q) {
    const n = normEntity(q);
    if (!n || n.length > 10) return null;
    for (const t of INGREDIENT_TERMS) if (t.aliases.some(a => normEntity(a) === n)) return t;
    return null;
  }
  function detectProductName(q, records) {
    const n = normEntity(q);
    if (!n || n.length < 2) return null;
    for (const r of (records || [])) {
      const name = getField(r.fields, "제품명", "name") || "";
      const nn = normEntity(name);
      if (!nn) continue;
      if (nn.indexOf(n) !== -1 || n.indexOf(nn) !== -1) return r;
    }
    return null;
  }

  try {
    // ─── [1] CATEGORY GATE (4종) ─────────────────────
    const lowerQuery = query.toLowerCase();
    let matchedCategory = null;
    for (const cat in CATEGORY_KEYWORDS) {
      for (const kw of CATEGORY_KEYWORDS[cat]) {
        if (lowerQuery.indexOf(kw.toLowerCase()) !== -1) { matchedCategory = cat; break; }
      }
      if (matchedCategory) break;
    }

    const healthKeywords = ["혈행", "혈중", "지방", "염증", "심혈관", "뇌", "시력", "고혈압", "당뇨", "콜레스테롤", "관절", "장", "면역", "눈", "피부"];
    const isHealthQuery = healthKeywords.some(k => lowerQuery.indexOf(k) !== -1);

    // 카테고리·건강 키워드 둘 다 없으면 '오메가3 제품명일 수 있음'으로 보고 진행(기존 동작 유지)
    let maybeProduct = false;
    if (!matchedCategory && !isHealthQuery) maybeProduct = true;
    if (!matchedCategory) matchedCategory = "omega3";
    const isOmega3 = matchedCategory === "omega3";

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
    const lowerTokens = allTokens.map(t => t.toLowerCase());

    // ─── [3] LOAD TABLES (KV 캐시) ───────────────────
    const cfg = FAQ_CONFIG[matchedCategory];
    async function safeGet(table) { try { return await getRecords(env, table); } catch (_) { return []; } }
    const [kRecords, fRecords, pRecords] = await Promise.all([
      safeGet("knowledge"),
      safeGet(cfg.table),
      isOmega3 ? safeGet("product_v2") : Promise.resolve([])
    ]);

    // knowledge 매칭 (카테고리 필터 + 답변예시 포함)
    const fK_keyword="키워드", fK_oneline="한줄정의", fK_related="관련성분키워드",
          fK_category="카테고리", fK_id="지식ID", fK_answer="답변예시", fK_evidence="임상근거";
    const catTokens = CATEGORY_TOKENS[matchedCategory] || [];
    function rowHaystack(f) { return [f[fK_keyword]||"", f[fK_oneline]||"", f[fK_related]||"", f[fK_category]||"", f[fK_answer]||""].join(" ").toLowerCase(); }
    let scopedK = (kRecords || []).filter(r => { const hay = rowHaystack(r.fields || {}); return catTokens.some(t => hay.indexOf(t.toLowerCase()) !== -1); });
    if (scopedK.length === 0) scopedK = kRecords || [];

    const knowledgeMatched = scopedK
      .map(r => {
        const f = r.fields || {};
        const hay = rowHaystack(f);
        let score = 0;
        for (const t of lowerTokens) if (t.length > 1 && hay.indexOf(t) !== -1) score++;
        return { record: r, score, fields: f };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(item => ({
        id: item.fields[fK_id] || item.record.id,
        category: item.fields[fK_category] || "",
        oneline: item.fields[fK_oneline] || "",
        answer: item.fields[fK_answer] || "",
        evidence: item.fields[fK_evidence] || "",
        score: item.score
      }));

    // FAQ 매칭 (카테고리 테이블 cfg)
    const faqMatched = (fRecords || [])
      .map(r => {
        const f = r.fields || {};
        const hay = [f[cfg.q]||"", f[cfg.a]||"", f[cfg.main]||f[cfg.cat]||"", f[cfg.sub]||"", cfg.kw?(f[cfg.kw]||""):""].join(" ").toLowerCase();
        let score = 0;
        for (const t of lowerTokens) if (t.length > 1 && hay.indexOf(t) !== -1) score++;
        return { record: r, score, fields: f };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(item => ({
        id: item.fields[cfg.id] || item.record.id,
        question: item.fields[cfg.q] || "",
        answer: item.fields[cfg.a] || "",
        medicalNote: cfg.med ? (item.fields[cfg.med] || "") : "",
        evidence: cfg.ev ? (item.fields[cfg.ev] || "") : ""
      }));

    // ─── [4] DETECT MEDICAL RISK (보강) ──────────────
    const riskKeywords = {
      pregnancy: ["임산부", "임신", "수유"],
      surgery: ["수술", "시술"],
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
      for (const kw of riskKeywords[riskType]) { if (lowerQuery.indexOf(kw.toLowerCase()) !== -1) { detectedRisks.push(riskType); break; } }
    }
    const requiresMedicalConsult = detectedRisks.length > 0;

    // ─── [5] 제품명 매칭 (오메가3 maybeProduct만) ────
    let productMatchRecord = null;
    if (isOmega3 && maybeProduct) {
      productMatchRecord = detectProductName(query, pRecords || []);
      if (!productMatchRecord) {
        return new Response(JSON.stringify({
          query, category: "out_of_scope", answer: OUT_OF_SCOPE_MSG,
          sources: [], flags: { outOfScope: true }, recommendation: null
        }), { status: 200, headers });
      }
    }
    const isProductMode = !!productMatchRecord;
    const ingredient = isOmega3 ? detectIngredient(query) : null;

    // ─── [6] CALL CLAUDE (RAG) ───────────────────────
    let answer = "", claudeError = null;
    if (isProductMode) {
      answer = "";
    } else if (knowledgeMatched.length === 0 && faqMatched.length === 0) {
      answer = "그 부분은 ingredi가 근거 데이터로 확인해 드리기 어려운 내용입니다. 대신 " + CATEGORY_LABEL[matchedCategory] + "의 함량·제형·복용법 같은 일반 정보는 안내해 드릴 수 있습니다.";
    } else {
      const systemPrompt = "당신은 ingredi의 건강기능식품 정보 카운슬러입니다.\n\n[핵심 원칙]\n1. 광고 없음 — 특정 제품·브랜드를 추천하지 않습니다\n2. 임상 근거 기반 — 검색 결과의 사실만 답변합니다\n3. 엄격 모드 — 검색 결과에 없는 내용은 추측하지 않습니다\n\n[답변 스타일]\n- 한국어, 존댓말\n- 특정 제품명 언급 금지\n- 의학 자문 아님을 명시\n- 마크다운 헤더(#,##,###), 굵은체(**), 구분선(---), 인용(>), 이모지 사용 금지\n- 항목이 여러 개면 첫 문장 후 줄바꿈하고 각 항목을 '- ' 로 시작\n- 단순 질문은 한 단락으로 간결하게\n- 진단 금지, 위험 상황은 '의사·약사와 상담하세요'로 안내";

      let contextBlock = "[검색된 지식]\n";
      knowledgeMatched.forEach((item, idx) => {
        contextBlock += `\n[K${idx+1}] ${item.id} (${item.category}): ${item.oneline}`;
        if (item.answer) contextBlock += ` — ${item.answer}`;
        if (item.evidence) contextBlock += ` (근거: ${item.evidence})`;
      });
      faqMatched.forEach((item, idx) => {
        contextBlock += `\n[F${idx+1}] Q: ${item.question} / A: ${item.answer}`;
        if (item.evidence) contextBlock += ` (근거: ${item.evidence})`;
        if (item.medicalNote) contextBlock += ` [주의: ${item.medicalNote}]`;
      });

      let userPrompt = contextBlock + "\n\n[사용자 질문]\n" + query;
      if (requiresMedicalConsult) {
        userPrompt += `\n\n[내부 플래그] 의료 주의가 필요한 키워드 감지됨 (${detectedRisks.join(", ")}). 답변 끝에 "복용 전 의사·약사와 상담하세요"를 포함하세요.`;
      }

      const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 500, stream: true, system: systemPrompt, messages: [{ role: "user", content: userPrompt }] })
      });

      if (claudeResponse.ok && claudeResponse.body) {
        const reader = claudeResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") break;
            try {
              const evt = JSON.parse(data);
              if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") answer += evt.delta.text;
            } catch (_) {}
          }
        }
      } else {
        claudeError = await claudeResponse.text();
        answer = "기술적 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
      }
    }

    // ─── [7] RECOMMEND PRODUCTS (오메가3 전용) ───────
    let recommendation = { profile: null, top3: [], filteredCount: 0, totalCount: (pRecords || []).length };
    let distributions = null, ingredientProducts = [], listMode = null, listTerm = null;

    if (isOmega3) {
      const matchedProfileId = matchProfileLocal(query);
      const profile = PROFILES[matchedProfileId];
      const records = pRecords || [];
      const scored = records.map(r => {
        const f = r.fields || {};
        const productId   = getField(f, "product_id", "productId");
        const productName = getField(f, "제품명", "name") || "";
        const dailyMg     = parseFloat(getField(f, "EPA_DHA_합계_mg")) || 0;
        const form        = getField(f, "제형") || "";
        const supplier    = getField(f, "원료사") || "";
        const certsRaw    = getField(f, "인증");
        const certs       = Array.isArray(certsRaw) ? certsRaw.join(", ") : String(certsRaw || "");
        const dailyCost   = parseFloat(getField(f, "1일비용_원")) || 0;
        const capsuleMg   = parseFloat(getField(f, "캡슐용량_mg", "capsuleMg", "캡슐 용량 (mg)")) || 0;
        const tier        = getField(f, "Tier등급") || "";
        const passFail    = getField(f, "함량_Pass_Fail") || "";
        const coupangLink = getField(f, "coupang_url", "coupangUrl", "coupangLink", "쿠팡_파트너스_링크") || "";
        let imageUrl = getField(f, "이미지URL", "imageUrl", "image", "이미지", "photo") || "";
        if (Array.isArray(imageUrl) && imageUrl.length > 0) {
          const att = imageUrl[0];
          imageUrl = (att.thumbnails && att.thumbnails.large) ? att.thumbnails.large.url : (att.url || "");
        } else if (typeof imageUrl === 'object' && imageUrl !== null) { imageUrl = imageUrl.url || ""; }

        const w = profile.weights;
        const dose=scoreDose(dailyMg), formScore=scoreForm(form), srcScore=scoreSource(supplier), certScore=scoreCert(certs), priceScore=scorePrice(dailyCost);
        let total = Math.round(dose*w.dose/100 + formScore*w.form/100 + srcScore*w.source/100 + certScore*w.cert/100 + priceScore*w.price/100);
        let highDoseFlag = false;
        if (dailyMg > 2000) { total = Math.min(80, total); highDoseFlag = true; }
        return { id: productId, name: productName, image: imageUrl, dailyMg, dailyCost: Math.round(dailyCost), capsuleMg, form, supplier, certs, tier, passFail, coupangLink, scores: { dose, form: formScore, source: srcScore, cert: certScore, price: priceScore, total }, highDoseFlag };
      });

      let filtered = scored.filter(item => {
        if (item.passFail === "Fail") return false;
        if (profile.filters && profile.filters.minDailyDose && item.dailyMg < profile.filters.minDailyDose) return false;
        return true;
      });
      filtered.sort((a, b) => b.scores.total - a.scores.total);

      function computeDist(vals) { const v = vals.filter(x => x > 0); if (v.length === 0) return null; const sum = v.reduce((a, b) => a + b, 0); return { min: Math.min(...v), max: Math.max(...v), avg: Math.round(sum / v.length) }; }
      distributions = { dose: computeDist(scored.map(s => s.dailyMg)), cost: computeDist(scored.map(s => s.dailyCost)), capsule: computeDist(scored.map(s => s.capsuleMg)) };

      function toCard(item, idx) {
        return { rank: idx + 1, id: item.id, name: item.name, image: item.image || "", vScore: item.scores.total,
          keySpec: { dailyMg: item.dailyMg, dailyCost: item.dailyCost, capsuleMg: item.capsuleMg, form: item.form, certs: item.certs, tier: item.tier },
          coupangLink: item.coupangLink, highDoseFlag: item.highDoseFlag };
      }

      if (ingredient) {
        listMode = "ingredient"; listTerm = ingredient.label;
        let pool = filtered;
        if (ingredient.form) { const ff = ingredient.form; const formed = filtered.filter(it => String(it.form || "").toLowerCase().indexOf(ff) !== -1); if (formed.length > 0) pool = formed; }
        ingredientProducts = pool.slice(0, 60).map(toCard);
      } else if (isProductMode) {
        listMode = "product"; listTerm = query;
        const qn = normEntity(query);
        ingredientProducts = filtered.filter(it => { const nn = normEntity(it.name); return nn && (nn.indexOf(qn) !== -1 || qn.indexOf(nn) !== -1); }).slice(0, 60).map(toCard);
      }

      const top3 = filtered.slice(0, 3).map((item, idx) => ({
        rank: idx + 1, id: item.id, name: item.name, image: item.image || "", vScore: item.scores.total, detailScores: item.scores,
        keySpec: { dailyMg: item.dailyMg, dailyCost: item.dailyCost, capsuleMg: item.capsuleMg, form: item.form, supplier: item.supplier, certs: item.certs, tier: item.tier },
        coupangLink: item.coupangLink, highDoseFlag: item.highDoseFlag
      }));
      recommendation = { profile: { id: matchedProfileId, label: profile.label, weights: profile.weights }, top3, filteredCount: filtered.length, totalCount: records.length };
    }

    return new Response(JSON.stringify({
      query, category: matchedCategory, answer,
      mode: listMode || "counsel",
      ingredientTerm: listTerm,
      ingredientProducts,
      distributions,
      sources: {
        knowledge: knowledgeMatched.map(k => ({ id: k.id, oneline: k.oneline, evidence: k.evidence || null })),
        faq: faqMatched.map(f => ({ id: f.id, question: f.question }))
      },
      flags: { requiresMedicalConsult, detectedRisks, knowledgeCount: knowledgeMatched.length, faqCount: faqMatched.length, faqTable: cfg.table, claudeError },
      recommendation,
      disclaimer: "본 정보는 의료 자문이 아니며, 개별 건강 상태에 따라 다를 수 있습니다. 복용 전 의사·약사와 상담하세요."
    }), { status: 200, headers });

  } catch (error) {
    return new Response(JSON.stringify({ error: "internal_error", message: error.message }), { status: 500, headers });
  }
}
