// Cloudflare Pages Function: Supplement combination fit analysis (v1)
// File path: functions/fit.js
// URL: /fit  (POST with JSON body: { supplements: [...], takingMedication: bool })
//
// AI(Claude)가 복용 중인 영양제 조합을 받아 4개 카테고리로 분석:
//   중복(duplication) / 과잉(excess) / 상호작용(interaction) / 시너지(synergy)
// 판단 로직 근거: fit-logic-design.md 참조
// 안전 원칙: 단정적 의료 판단 금지, 약 복용자에게 전문가 상담 권유, 면책 문구 상시

export async function onRequest(context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response("", { status: 200, headers });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed", message: "POST only" }),
      { status: 405, headers });
  }

  const env = context.env;
  const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return new Response(JSON.stringify({
      error: "config_missing",
      message: "ANTHROPIC_API_KEY not set"
    }), { status: 500, headers });
  }

  // ─── 입력 파싱 ───
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "bad_request", message: "Invalid JSON" }),
      { status: 400, headers });
  }

  let supplements = Array.isArray(body.supplements) ? body.supplements : [];
  supplements = supplements
    .map(function (s) { return String(s).trim(); })
    .filter(function (s) { return s.length > 0; })
    .slice(0, 15); // 최대 15개
  const takingMedication = body.takingMedication === true;

  if (supplements.length === 0) {
    return new Response(JSON.stringify({
      error: "no_supplements",
      message: "분석할 영양제를 1개 이상 입력해주세요."
    }), { status: 400, headers });
  }

  const DISCLAIMER = "이 분석은 일반 정보이며 의료 자문이 아니에요. 약을 복용 중이거나 질환이 있으시면 반드시 의사·약사와 상담하세요.";

  // ─── 시스템 프롬프트 (fit-logic-design.md 기반) ───
  const systemPrompt = [
    "당신은 ingredi의 영양제 조합 분석 도우미입니다.",
    "사용자가 복용 중인 영양제 목록과 약 복용 여부를 받아, 아래 4개 카테고리로 분석합니다.",
    "",
    "카테고리:",
    "1) duplication(중복): 서로 다른 제품에 같은 성분이 겹치는 경우 (예: 종합비타민에 이미 마그네슘이 들어있음)",
    "2) excess(과잉): 조합 전체로 특정 성분이 권장량/상한을 넘길 위험 (비타민A·D, 아연, 셀레늄 등)",
    "3) interaction(상호작용): 성분-약물 또는 성분-성분 간 주의 (예: 오메가3와 항응고제 → 출혈 위험)",
    "4) synergy(시너지): 함께 먹으면 흡수·효과에 도움 (예: 마그네슘과 비타민D, 비타민C와 철분)",
    "",
    "안전 규칙 (반드시 지킬 것):",
    "- 의료 자문이 아닙니다. '안전합니다 / 먹어도 됩니다'라고 단정하지 마세요. '주의하세요 / 확인해보세요 / 상담을 권해요' 형태로만 표현하세요.",
    "- 약 복용 여부가 true이면, interaction 항목에서 반드시 약사·의사 상담을 권하세요.",
    "- 확실하지 않으면 '정보가 충분하지 않다, 전문가에게 확인하라'고 답하세요. 추측으로 안전하다고 말하지 마세요.",
    "- 임산부·수유부·소아·만성질환이 입력에 보이면 전문가 상담을 최우선으로 안내하세요.",
    "- 각 메시지는 한국어로, 2~3문장 이내로 친절하고 쉽게 쓰세요.",
    "",
    "severity 값: high(강한 주의) / medium(확인 필요) / low(경미) / none(문제없음 또는 긍정).",
    "해당 카테고리에서 특이사항이 없으면 severity는 'none' 또는 'low'로 하고 간단히 안내하세요.",
    "",
    "반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트·마크다운·설명을 절대 포함하지 마세요.",
    '{',
    '  "combo": "분석한 조합 요약 (예: 오메가3 · 종합비타민 · 마그네슘)",',
    '  "categories": [',
    '    {"type":"duplication","severity":"high|medium|low|none","title":"짧은 제목","message":"설명"},',
    '    {"type":"excess","severity":"...","title":"...","message":"..."},',
    '    {"type":"interaction","severity":"...","title":"...","message":"..."},',
    '    {"type":"synergy","severity":"...","title":"...","message":"..."}',
    '  ]',
    '}'
  ].join("\n");

  const userPrompt = [
    "복용 중인 영양제: " + supplements.join(", "),
    "처방약 복용 여부: " + (takingMedication ? "예 (복용 중)" : "아니요"),
    "",
    "위 조합을 4개 카테고리로 분석해 JSON으로만 응답하세요."
  ].join("\n");

  // ─── Claude 호출 ───
  let parsed = null;
  let claudeError = null;
  try {
    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      })
    });

    if (claudeResponse.ok) {
      const claudeData = await claudeResponse.json();
      let text = (claudeData.content || [])
        .filter(function (b) { return b.type === "text"; })
        .map(function (b) { return b.text; })
        .join("\n");
      // 마크다운 코드펜스 제거 후 JSON 파싱
      text = text.replace(/```json/g, "").replace(/```/g, "").trim();
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        claudeError = "parse_failed";
      }
    } else {
      claudeError = await claudeResponse.text();
    }
  } catch (e) {
    claudeError = String(e);
  }

  // ─── 응답 조립 (실패 시 안전한 기본값) ───
  if (!parsed || !Array.isArray(parsed.categories)) {
    return new Response(JSON.stringify({
      combo: supplements.join(" · "),
      categories: [{
        type: "interaction",
        severity: "medium",
        title: "분석을 완료하지 못했어요",
        message: "일시적인 오류로 자동 분석에 실패했어요. 잠시 후 다시 시도하시거나, 정확한 확인은 약사·의사와 상담해주세요."
      }],
      takingMedication: takingMedication,
      disclaimer: DISCLAIMER,
      _error: claudeError || "unknown"
    }), { status: 200, headers });
  }

  // 카테고리 순서 정규화 (중복→과잉→상호작용→시너지)
  const order = { duplication: 1, excess: 2, interaction: 3, synergy: 4 };
  parsed.categories.sort(function (a, b) {
    return (order[a.type] || 99) - (order[b.type] || 99);
  });

  // 약 복용자인데 interaction이 none/low면 최소 medium으로 끌어올림 (안전장치)
  if (takingMedication) {
    parsed.categories.forEach(function (c) {
      if (c.type === "interaction" && (c.severity === "none" || c.severity === "low")) {
        c.severity = "medium";
        if (!/상담/.test(c.message || "")) {
          c.message = (c.message || "") + " 약을 복용 중이시니, 새 영양제를 더하기 전 약사·의사와 상담하시길 권해요.";
        }
      }
    });
  }

  return new Response(JSON.stringify({
    combo: parsed.combo || supplements.join(" · "),
    categories: parsed.categories,
    takingMedication: takingMedication,
    disclaimer: DISCLAIMER
  }), { status: 200, headers });
}
