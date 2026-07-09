// Cloudflare Pages Function: 영양제 조합 점검 RAG
// File path: functions/fit.js
// URL: /fit?items=오메가3,비타민D&pregnancy=true&surgery=false&meds=warfarin

export async function onRequest(context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

  // ── 입력 파싱 (GET / POST 둘 다 지원) ──
  let items = [];
  let context_info = { pregnancy: false, surgery: false, medications: [], conditions: [] };

  if (request.method === "POST") {
    try {
      const body = await request.json();
      items = body.items || [];
      context_info.pregnancy = !!body.pregnancy;
      context_info.surgery   = !!body.surgery;
      context_info.medications = body.medications || [];
      context_info.conditions  = body.conditions || [];
    } catch (e) {
      return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400, headers });
    }
  } else {
    const url = new URL(request.url);
    const itemsParam = url.searchParams.get("items") || "";
    items = itemsParam.split(",").map(s => s.trim()).filter(Boolean);
    context_info.pregnancy = url.searchParams.get("pregnancy") === "true";
    context_info.surgery   = url.searchParams.get("surgery") === "true";
    const meds = url.searchParams.get("meds") || "";
    context_info.medications = meds.split(",").map(s => s.trim()).filter(Boolean);
  }

  if (items.length === 0) {
    return new Response(JSON.stringify({
      error: "no_items",
      message: "복용 중인 영양제를 1개 이상 입력해주세요."
    }), { status: 400, headers });
  }

  // ── 영양제명 정규화 (한글 표기 통일) ──
  const synonymMap = {
    "오메가": "오메가3", "오메가3": "오메가3", "omega": "오메가3", "epa": "오메가3", "dha": "오메가3", "피쉬오일": "오메가3", "어유": "오메가3",
    "비타민d": "비타민D", "비타민 d": "비타민D", "vitamin d": "비타민D",
    "비타민c": "비타민C", "비타민 c": "비타민C", "vitamin c": "비타민C",
    "비타민a": "비타민A", "비타민 a": "비타민A",
    "비타민e": "비타민E", "비타민 e": "비타민E",
    "비타민k": "비타민K", "비타민 k": "비타민K", "비타민k2": "비타민K",
    "철분": "철분", "iron": "철분",
    "칼슘": "칼슘", "calcium": "칼슘",
    "마그네슘": "마그네슘", "magnesium": "마그네슘",
    "아연": "아연", "zinc": "아연",
    "유산균": "프로바이오틱스", "프로바이오틱스": "프로바이오틱스", "probiotic": "프로바이오틱스",
    "코큐텐": "코엔자임Q10", "코엔자임q10": "코엔자임Q10", "coq10": "코엔자임Q10", "ubiquinol": "코엔자임Q10",
    "종합비타민": "멀티비타민", "멀티비타민": "멀티비타민", "multivitamin": "멀티비타민",
    "와파린": "와파린", "warfarin": "와파린",
    "아스피린": "아스피린", "aspirin": "아스피린",
    "은행": "은행잎추출물", "은행잎": "은행잎추출물",
    "마늘": "마늘", "생강": "생강", "강황": "강황", "커큐민": "강황",
    "세인트존스워트": "세인트존스워트", "stjohn": "세인트존스워트",
  };

  function normalize(name) {
    const lower = String(name).trim().toLowerCase().replace(/\s+/g, "");
    for (const key in synonymMap) {
      if (lower.indexOf(key.toLowerCase()) !== -1) return synonymMap[key];
    }
    return String(name).trim();
  }

  const normalizedItems = items.map(normalize);
  const uniqueItems = [...new Set(normalizedItems)];

  // 약 + 영양제 통합 (상호작용 검색용)
  const allItems = [...uniqueItems, ...context_info.medications.map(normalize)];

  // ── Airtable fit_knowledge 조회 ──
  const fitTableName = encodeURIComponent("fit_knowledge");
  const fitUrl = `https://api.airtable.com/v0/${BASE_ID}/${fitTableName}?maxRecords=100`;

  let allRecords = [];
  try {
    const res = await fetch(fitUrl, { headers: { Authorization: "Bearer " + TOKEN } });
    if (res.ok) {
      const data = await res.json();
      allRecords = data.records || [];
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: "airtable_error", message: e.message }), { status: 500, headers });
  }

  // ── 카테고리별 매칭 ──
  // 영양제A 또는 영양제B가 사용자 입력에 매칭되는 레코드 추출
  const matched = {
    상호작용: [],
    중복_과잉: [],
    복용시간: [],
    대상별_주의: [],
    시너지: []
  };

  function fieldMatch(field, items) {
    if (!field) return false;
    const f = String(field).toLowerCase();
    for (const it of items) {
      if (f.indexOf(it.toLowerCase()) !== -1) return true;
    }
    return false;
  }

  for (const rec of allRecords) {
    const f = rec.fields || {};
    const cat = f["카테고리"] || "";
    const a = f["영양제A"] || "";
    const b = f["영양제B"] || "";

    let hit = false;

    if (cat === "상호작용") {
      // A와 B 둘 다 사용자 입력에 있어야 함 (페어 매칭)
      const aMatch = fieldMatch(a, allItems);
      const bMatch = fieldMatch(b, allItems);
      if (aMatch && bMatch) hit = true;
    } else if (cat === "중복_과잉") {
      // A만 매칭되면 됨 (단일 영양소)
      if (fieldMatch(a, uniqueItems)) hit = true;
    } else if (cat === "복용시간") {
      if (fieldMatch(a, uniqueItems)) hit = true;
    } else if (cat === "대상별_주의") {
      // A는 영양제, B는 대상 그룹
      const aMatch = fieldMatch(a, uniqueItems);
      if (!aMatch) continue;
      // 대상 그룹 매칭
      const bLower = String(b).toLowerCase();
      if (context_info.pregnancy && (bLower.indexOf("임산") !== -1 || bLower.indexOf("수유") !== -1)) hit = true;
      if (context_info.surgery && bLower.indexOf("수술") !== -1) hit = true;
      // 약 복용자 (만성질환)
      if (context_info.medications.length > 0 && (bLower.indexOf("당뇨") !== -1 || bLower.indexOf("신장") !== -1)) hit = true;
    } else if (cat === "시너지") {
      const aMatch = fieldMatch(a, uniqueItems);
      const bMatch = fieldMatch(b, uniqueItems);
      if (aMatch && bMatch) hit = true;
    }

    if (hit) {
      const targetCat = cat.replace("_권고", "");
      if (matched[targetCat]) {
        matched[targetCat].push({
          id: f["지식_ID"] || rec.id,
          category: cat,
          a: a,
          b: b,
          type: f["유형"] || "",
          severity: f["심각도"] || "",
          evidence: f["근거수준"] || "",
          description: f["설명"] || "",
          recommendation: f["권고사항"] || "",
          extra: f["추가정보"] || ""
        });
      }
    }
  }

  // ── 심각도별 정렬 (위험한 것 먼저) ──
  const severityOrder = { "금기": 4, "경고": 3, "주의": 2, "안전": 1, "": 0 };
  matched["상호작용"].sort((a, b) => (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0));
  matched["대상별_주의"].sort((a, b) => (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0));

  // ── AI 요약 생성 ──
  let aiSummary = "";
  let claudeError = null;

  const totalHits = matched["상호작용"].length + matched["중복_과잉"].length + matched["대상별_주의"].length;

  if (totalHits === 0 && matched["시너지"].length === 0 && matched["복용시간"].length === 0) {
    aiSummary = `${uniqueItems.join(", ")} 조합에 대한 특별한 주의사항이나 시너지 정보는 ingredi 지식DB에서 확인되지 않았습니다. 일반적인 영양제 조합으로 보이지만, 처방약 복용 중이거나 특이 건강 상태가 있다면 의료진과 상담하시기 바랍니다.`;
  } else {
    const systemPrompt = "당신은 ingredi의 영양제 조합 분석 카운슬러입니다.\n\n[핵심 원칙]\n1. 광고 없음 — 특정 제품·브랜드를 추천하지 않습니다\n2. 근거 기반 — 검색 결과의 사실만 답변합니다\n3. 엄격 모드 — 검색 결과에 없는 내용은 추측하지 않습니다\n\n[답변 스타일]\n- 한국어, 존댓말\n- 3~5문장으로 간결하게 핵심 요약\n- 위험도 순서로 언급 (금기 > 경고 > 주의 > 안전)\n- 마크다운 헤더(#), 굵은체(**), 구분선(---), 이모지 사용 금지\n- 의학 자문 아님을 명시";

    let contextBlock = `[사용자 복용 정보]\n영양제: ${uniqueItems.join(", ")}\n`;
    if (context_info.medications.length > 0) contextBlock += `약: ${context_info.medications.join(", ")}\n`;
    if (context_info.pregnancy) contextBlock += "임산부·수유부: 예\n";
    if (context_info.surgery) contextBlock += "수술 예정: 예\n";

    contextBlock += "\n[검색된 정보]\n";

    matched["상호작용"].slice(0, 5).forEach((m, i) => {
      contextBlock += `\n[상호작용 ${i+1}] ${m.a} + ${m.b} (${m.severity}, 근거:${m.evidence}): ${m.description}`;
    });
    matched["중복_과잉"].slice(0, 3).forEach((m, i) => {
      contextBlock += `\n[중복/과잉 ${i+1}] ${m.a}: ${m.description}`;
    });
    matched["대상별_주의"].slice(0, 5).forEach((m, i) => {
      contextBlock += `\n[대상별 주의 ${i+1}] ${m.a} - ${m.b} (${m.severity}): ${m.description}`;
    });
    matched["시너지"].slice(0, 3).forEach((m, i) => {
      contextBlock += `\n[시너지 ${i+1}] ${m.a} + ${m.b}: ${m.description}`;
    });

    const userPrompt = contextBlock + "\n\n위 정보를 바탕으로 이 영양제 조합에 대한 핵심 요약을 3~5문장으로 작성해주세요. 가장 중요한 주의사항을 먼저 언급하세요.";

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
          max_tokens: 500,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }]
        })
      });

      if (claudeResponse.ok) {
        const claudeData = await claudeResponse.json();
        aiSummary = (claudeData.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      } else {
        claudeError = await claudeResponse.text();
        aiSummary = "AI 요약 생성에 일시적인 문제가 있어요. 아래 세부 정보를 참고해주세요.";
      }
    } catch (e) {
      claudeError = e.message;
      aiSummary = "AI 요약 생성에 일시적인 문제가 있어요. 아래 세부 정보를 참고해주세요.";
    }
  }

  // ── 응답 ──
  // 최고 심각도 계산
  let highestSeverity = "";
  for (const cat of ["상호작용", "대상별_주의"]) {
    for (const m of matched[cat]) {
      const cur = severityOrder[m.severity] || 0;
      const high = severityOrder[highestSeverity] || 0;
      if (cur > high) highestSeverity = m.severity;
    }
  }

  return new Response(JSON.stringify({
    input: {
      items: uniqueItems,
      medications: context_info.medications,
      pregnancy: context_info.pregnancy,
      surgery: context_info.surgery
    },
    aiSummary: aiSummary,
    sections: {
      interactions:  matched["상호작용"],
      overlaps:      matched["중복_과잉"],
      timing:        matched["복용시간"],
      targetCautions: matched["대상별_주의"],
      synergies:     matched["시너지"]
    },
    stats: {
      totalMatches: matched["상호작용"].length + matched["중복_과잉"].length + matched["복용시간"].length + matched["대상별_주의"].length + matched["시너지"].length,
      highestSeverity: highestSeverity,
      hasWarnings: ["경고", "금기"].includes(highestSeverity)
    },
    flags: { claudeError },
    disclaimer: " 본 정보는 의료 자문이 아니며, 개별 건강 상태에 따라 다를 수 있습니다. 처방약 복용 중이거나 특이 상황이 있으면 반드시 의사·약사와 상담하세요."
  }), { status: 200, headers });
}
