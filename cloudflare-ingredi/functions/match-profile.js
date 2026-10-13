// Cloudflare Pages Function: Map free-text query to V-Score profile
// File path: functions/match-profile.js
// URL: /match-profile?q=<free text query>
//
// Returns: best matching profile (premium_seeker / budget_seeker / balanced / 
//          pregnancy / senior / vegan / kid)
// Requires: ANTHROPIC_API_KEY (결제 풀리면 작동)

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

  if (!ANTHROPIC_KEY) {
    return new Response(JSON.stringify({
      error: "config_missing",
      message: "ANTHROPIC_API_KEY not set"
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

  // ─── KEYWORD-BASED FAST MATCH (LLM 호출 전 시도) ──
  const lowerQuery = query.toLowerCase();
  const keywordMap = [
    { profile: "pregnancy", keywords: ["\uC784\uC0B0\uBD80", "\uC784\uC2E0", "\uC218\uC720", "pregnant"] },
    { profile: "kid", keywords: ["\uC544\uC774", "\uC5B4\uB9B0\uC774", "\uC790\uB140", "\uC544\uB4E4", "\uB538", "\uC18C\uC544", "child", "kid"] },
    { profile: "senior", keywords: ["\uC2DC\uB2C8\uC5B4", "\ub178\uC778", "\ubd80\ubaa8\ub2d8", "50\ub300", "60\ub300", "70\ub300", "\uC5B4\ubc84\uc9c0", "\uc5B4\uba38\ub2c8", "senior"] },
    { profile: "vegan", keywords: ["\ube44\uac74", "\ucc44\uc2dd", "\uc2dd\ubb3c\uc131", "vegan", "vegetarian", "\ub3d9\ubb3c\uc131 \uc548", "algae", "\uc870\ub958"] },
    { profile: "budget_seeker", keywords: ["\uac00\uc131\ube44", "\uc800\ub834", "\uc2f8\ub294", "\uacbd\uc81c\uc801", "\uc608\uc0b0", "\uc548\uc8fc\uba38\ub2c8", "\uc548\uc8fc\uba38\ub2c8\uc6a9", "cheap", "budget"] },
    { profile: "premium_seeker", keywords: ["\ucd5c\uace0", "\ud504\ub9ac\ubbf8\uc5c4", "\uace0\uae09", "\ube44\uc2f8\ub3c4", "\ud488\uc9c8", "premium", "best"] }
  ];

  // 키워드 매칭 시도
  for (let i = 0; i < keywordMap.length; i++) {
    const km = keywordMap[i];
    for (let j = 0; j < km.keywords.length; j++) {
      if (lowerQuery.indexOf(km.keywords[j].toLowerCase()) !== -1) {
        return new Response(JSON.stringify({
          query: query,
          matchedProfile: km.profile,
          method: "keyword",
          confidence: "high",
          matchedKeyword: km.keywords[j]
        }), { status: 200, headers });
      }
    }
  }

  // ─── LLM-BASED MATCH (키워드 매칭 실패 시) ──
  const systemPrompt = "\uB2F9\uC2E0\uC740 ingredi\uC758 \uC0AC\uC6A9\uC790 \uD504\ub85c\ud544 \ub9E4\uCE6D \uC5B4\uC2DC\uC2A4\uD134\uD2B8\uC785\ub2C8\ub2E4. \uC0AC\uC6A9\uC790 \uC9C8\ubb38\uC744 \uB2E4\uC74C 7\uAC1C \ud504\ub85c\ud544 \uC911 \ud558\ub098\ub85c \ub9E4\uCE6D\ud558\uC5EC JSON\uC73c\ub85c \uC751\ub2F5\ud558\uC138\uc694.\n\n\ud504\ub85c\ud544 \ubaa9\ub85d:\n1. premium_seeker: \ucd5c\uace0 \ud488\uc9c8 \uc120\ud638 (\ube44\uc2f8\ub354\ub77c\ub3c4 \uc88b\uc740 \uc81c\ud488)\n2. budget_seeker: \uac00\uc131\ube44 \uc120\ud638\n3. balanced: \uad50\ud615\ud615 (\uae30\ubcf8\uac12, \uc560\ub9e4\ud55c \uacbd\uc6b0)\n4. pregnancy: \uc784\uc0b0\ubd80\u00b7\uc218\uc720\ubd80\n5. senior: \uc2dc\ub2c8\uc5b4 50\uc138 \uc774\uc0c1\n6. vegan: \ube44\uac74/\uc2dd\ubb3c\uc131\n7. kid: \uc5b4\ub9b0\uc774\u00b7\uc790\ub140\u00b7\uc544\uc774\n\n\uc751\ub2f5\uc740 \ub2e4\uc74c JSON \ud615\uc2dd\uc73c\ub85c\ub9cc \ud558\uc138\uc694 (\ub2e4\ub978 \ud14d\uc2a4\ud2b8 \uc5c6\uc774):\n{\"profile\":\"<id>\",\"reason\":\"<\uac04\ub2e8\ud55c \uc774\uc720 1\ubb38\uc7a5>\"}";

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: "user", content: query }]
    })
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    // LLM 실패 시 balanced로 fallback
    return new Response(JSON.stringify({
      query: query,
      matchedProfile: "balanced",
      method: "fallback",
      confidence: "low",
      error: "claude_api_error: " + errText
    }), { status: 200, headers });
  }

  const claudeData = await claudeRes.json();
  const responseText = (claudeData.content || [])
    .filter(function(b) { return b.type === "text"; })
    .map(function(b) { return b.text; })
    .join("");

  // JSON 파싱 시도
  let parsed = null;
  try {
    // ```json 같은 마크다운 제거
    const cleaned = responseText.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // 파싱 실패 → balanced fallback
    return new Response(JSON.stringify({
      query: query,
      matchedProfile: "balanced",
      method: "fallback",
      confidence: "low",
      rawResponse: responseText
    }), { status: 200, headers });
  }

  const validProfiles = ["premium_seeker", "budget_seeker", "balanced", "pregnancy", "senior", "vegan", "kid"];
  const matchedProfile = validProfiles.indexOf(parsed.profile) !== -1 ? parsed.profile : "balanced";

  return new Response(JSON.stringify({
    query: query,
    matchedProfile: matchedProfile,
    method: "llm",
    confidence: "medium",
    reason: parsed.reason || ""
  }), { status: 200, headers });
}
