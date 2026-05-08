// Cloudflare Pages Function: search Airtable FAQ table
// File path: functions/search-faq.js
// URL: /search-faq?q=<query>
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
  const query = (url.searchParams.get("q") || "").trim();
  if (!query) {
    return new Response(JSON.stringify({
      error: "bad_request",
      message: "Missing q parameter"
    }), { status: 400, headers });
  }
  // Airtable 한글 테이블명: FAQ_오메가3
  const tableName = "FAQ_%EC%98%A4%EB%A9%94%EA%B0%803";
  const airtableUrl = "https://api.airtable.com/v0/" + BASE_ID + "/" + tableName + "?maxRecords=100";
  try {
    const response = await fetch(airtableUrl, {
      headers: { Authorization: "Bearer " + TOKEN }
    });
    if (!response.ok) {
      const text = await response.text();
      return new Response(JSON.stringify({
        error: "airtable_error",
        status: response.status,
        message: text
      }), { status: 500, headers });
    }
    const data = await response.json();
    const lowerQuery = query.toLowerCase();
    // FAQ 시트 컬럼명 (캡처에서 확인한 구조)
    const fieldFaqId = "FAQ_ID";
    const fieldMainCat = "\uB300\uBD84\uB958";              // 대분류
    const fieldSubCat = "\uC18C\uBD84\uB958";               // 소분류
    const fieldQuestion = "\uC9C8\uBB38(\uC0AC\uC6A9\uC790 \uD45C\uD604)";  // 질문(사용자 표현)
    const fieldAnswer = "\uB2F5\uBCC0(3\uC6D0\uCE59 \uC801\uC6A9)";          // 답변(3원칙 적용)
    const fieldRelatedKnowledge = "\uAD00\uB828 \uC9C0\uC2DD ID (RAG)";       // 관련 지식 ID (RAG)
    const fieldCta = "CTA \uBC84\uD2BC";                    // CTA 버튼
    const fieldMedicalNote = "\uC758\uB8CC \uC8FC\uC758\uC0AC\uD56D";          // 의료 주의사항
    const matched = (data.records || [])
      .filter(function(record) {
        const f = record.fields || {};
        const targets = [
          f[fieldQuestion] || "",
          f[fieldAnswer] || "",
          f[fieldMainCat] || "",
          f[fieldSubCat] || ""
        ].join(" ").toLowerCase();
        return targets.indexOf(lowerQuery) !== -1;
      })
      .slice(0, 5)
      .map(function(record) {
        const f = record.fields;
        return {
          id: f[fieldFaqId] || record.id,
          mainCategory: f[fieldMainCat] || "",
          subCategory: f[fieldSubCat] || "",
          question: f[fieldQuestion] || "",
          answer: f[fieldAnswer] || "",
          relatedKnowledge: f[fieldRelatedKnowledge] || "",
          cta: f[fieldCta] || "",
          medicalNote: f[fieldMedicalNote] || ""
        };
      });
    return new Response(JSON.stringify({
      query: query,
      count: matched.length,
      results: matched
    }), { status: 200, headers });
  } catch (error) {
    return new Response(JSON.stringify({
      error: "internal_error",
      message: error.message
    }), { status: 500, headers });
  }
}
