// Cloudflare Pages Function: search Airtable FAQ tables (v2 · 4-category)
// File path: functions/search-faq.js
// URL: /search-faq?q=<query>&category=<omega3|vitaminC|eye|probiotics>  (category 생략 시 q로 자동 판별)
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
  const TOKEN = env.AIRTABLE_TOKEN;
  const BASE_ID = env.AIRTABLE_BASE_ID;
  if (!TOKEN || !BASE_ID) {
    return new Response(JSON.stringify({ error: "config_missing", message: "Environment variables not set" }), { status: 500, headers });
  }

  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  let category = (url.searchParams.get("category") || "").trim();
  if (!query) {
    return new Response(JSON.stringify({ error: "bad_request", message: "Missing q parameter" }), { status: 400, headers });
  }

  const CATEGORY_KEYWORDS = {
    omega3: ["오메가", "omega", "epa", "dha", "알티지", "rtg", "어유", "크릴"],
    vitaminC: ["비타민c", "비타민 c", "비타민씨", "vitamin c", "아스코르브산", "메가도스", "리포좀"],
    eye: ["눈", "루테인", "지아잔틴", "아스타잔틴", "황반", "시력", "안구", "lutein", "마리골드", "베타카로틴", "비타민a"],
    probiotics: ["프로바이오틱스", "유산균", "장건강", "마이크로바이옴", "유익균", "비피더스", "보장균수", "cfu"]
  };
  const FAQ_CONFIG = {
    omega3:    { table: "FAQ_오메가3", id: "FAQ_ID", q: "질문 (사용자 표현)", a: "답변 (3원칙 적용)", main: "대분류", sub: "소분류", med: "의료 주의사항", kw: null, ev: null },
    vitaminC:  { table: "FAQ_비타민C", id: "faq_id", q: "question", a: "answer", cat: "category", kw: "keywords", ev: "임상근거" },
    eye:       { table: "FAQ_눈", id: "faq_id", q: "question", a: "answer", cat: "category", kw: "keywords", ev: "임상근거" },
    probiotics:{ table: "FAQ_마이크로바이옴", id: "faq_id", q: "question", a: "answer", cat: "category", kw: "keywords", ev: "임상근거" }
  };

  const lowerQuery = query.toLowerCase();
  if (!FAQ_CONFIG[category]) {
    category = null;
    for (const cat in CATEGORY_KEYWORDS) {
      if (CATEGORY_KEYWORDS[cat].some(kw => lowerQuery.indexOf(kw.toLowerCase()) !== -1)) { category = cat; break; }
    }
  }
  if (!category) {
    return new Response(JSON.stringify({
      query: query, category: "out_of_scope", count: 0, results: [],
      message: "오메가3·비타민C·눈·마이크로바이옴 중 어떤 카테고리인지 판별하지 못했습니다. category 파라미터를 지정해 주세요."
    }), { status: 200, headers });
  }

  const cfg = FAQ_CONFIG[category];
  const tokens = [...new Set(query.split(/\s+/).filter(t => t.length > 1).map(t => t.toLowerCase()))];

  try {
    const airtableUrl = "https://api.airtable.com/v0/" + BASE_ID + "/" + encodeURIComponent(cfg.table) + "?maxRecords=200";
    const response = await fetch(airtableUrl, { headers: { Authorization: "Bearer " + TOKEN } });
    if (!response.ok) {
      const text = await response.text();
      return new Response(JSON.stringify({ error: "airtable_error", status: response.status, message: text, table: cfg.table }), { status: 500, headers });
    }
    const data = await response.json();

    const matched = (data.records || [])
      .map(function (record) {
        const f = record.fields || {};
        const hay = [
          f[cfg.q] || "",
          f[cfg.a] || "",
          f[cfg.main] || f[cfg.cat] || "",
          f[cfg.sub] || "",
          cfg.kw ? (f[cfg.kw] || "") : ""
        ].join(" ").toLowerCase();
        let score = 0;
        for (const t of tokens) if (hay.indexOf(t) !== -1) score++;
        // 토큰 매칭이 없으면 전체 질의 부분일치도 1점 인정
        if (score === 0 && hay.indexOf(lowerQuery) !== -1) score = 1;
        return { record, score, fields: f };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(function (item) {
        const f = item.fields;
        return {
          id: f[cfg.id] || item.record.id,
          category: f[cfg.main] || f[cfg.cat] || "",
          subCategory: f[cfg.sub] || "",
          question: f[cfg.q] || "",
          answer: f[cfg.a] || "",
          medicalNote: cfg.med ? (f[cfg.med] || "") : "",
          evidence: cfg.ev ? (f[cfg.ev] || "") : ""
        };
      });

    return new Response(JSON.stringify({ query: query, category: category, table: cfg.table, count: matched.length, results: matched }), { status: 200, headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: "internal_error", message: error.message }), { status: 500, headers });
  }
}
