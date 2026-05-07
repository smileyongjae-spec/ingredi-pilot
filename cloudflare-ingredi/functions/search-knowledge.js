// Cloudflare Pages Function: search Airtable knowledge table
// File path: functions/search-knowledge.js
// URL: /search-knowledge

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
      message: "Environment variables not set",
      debug: {
        hasToken: !!TOKEN,
        hasBaseId: !!BASE_ID,
        tokenLength: TOKEN ? TOKEN.length : 0,
        baseIdValue: BASE_ID || "EMPTY",
        allEnvKeys: env ? Object.keys(env) : "env_is_undefined"
      }
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

  const airtableUrl = "https://api.airtable.com/v0/" + BASE_ID + "/knowledge?maxRecords=50";

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
    
        // ─── 임시 디버그: raw 데이터 확인 ───
    if (query === "DEBUG") {
      return new Response(JSON.stringify({
        recordCount: (data.records || []).length,
        firstRecord: (data.records || [])[0] || null,
        allFieldNames: (data.records || [])[0] ? Object.keys((data.records || [])[0].fields || {}) : []
      }), { status: 200, headers });
    }
    // ─── 임시 디버그 끝 ───
    
    const lowerQuery = query.toLowerCase();

    const fieldKeyword = "\uD0A4\uC6CC\uB4DC";
    const fieldOneline = "\uD55C\uC904\uC815\uC758";
    const fieldRelated = "\uAD00\uB828\uC131\uBD84\uD0A4\uC6CC\uB4DC";
    const fieldCategory = "\uCE74\uD14C\uACE0\uB9AC";
    const fieldId = "\uC9C0\uC2DDID";
    const fieldAnswer = "\uB2F5\uBCC0\uC608\uC2DC";
    const fieldEvidence = "\uC784\uC0C1\uADFC\uAC70";

    const matched = (data.records || [])
      .filter(function(record) {
        const f = record.fields || {};
        const targets = [
          f[fieldKeyword] || "",
          f[fieldOneline] || "",
          f[fieldRelated] || "",
          f[fieldCategory] || ""
        ].join(" ").toLowerCase();
        return targets.indexOf(lowerQuery) !== -1;
      })
      .slice(0, 10)
      .map(function(record) {
        const f = record.fields;
        return {
          id: f[fieldId] || record.id,
          category: f[fieldCategory] || "",
          keyword: f[fieldKeyword] || "",
          oneline: f[fieldOneline] || "",
          answer: f[fieldAnswer] || "",
          evidence: f[fieldEvidence] || "",
          related: f[fieldRelated] || ""
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
