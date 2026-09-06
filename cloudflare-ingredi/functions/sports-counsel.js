// functions/sports-counsel.js  (v1.0 — 층 1: 지식 응답 전용)
// URL: POST /sports-counsel   body: { message, history?: [{role,content}], weight?: number }
//
// [설계 배경]
//   counsel2(건기식 상담)와 분리한 별도 Function. counsel2는 v15.x까지 1만 문항
//   점검·회귀 스위트가 4개 카테고리 전제로 검증돼 있어, 스포츠 도메인을 끼워 넣으면
//   검증된 것이 미검증 상태로 돌아간다. 규제 근거도 다르다(식약처 vs ISSN).
//
// [층 구분]
//   층 1 (이 파일): 통념 교정·복용법·근거 설명. 제품 데이터 연결 없음.
//   층 2 (미구현): 특정 제품 평결(V). 제품명 인덱스·비지목 가드가 필요해 후속.
//   → 층 2 질문이 오면 목록 화면으로 안내하는 폴백으로 답한다.
//
// [원칙] "규칙이 휘어질 수 있으면 프롬프트, 절대 깨지면 안 되면 코드"
//   코드 게이트: 응급, 도핑·불법 약물, 투석·신부전 등 중증 의료, 미성년+부스터.
//   프롬프트 규칙: 근거등급 정직 응답, 통념 교정, 기능성 표현 제한, 어투.

// v1.1: Anthropic 호출 경로·재시도를 counsel2(라이브 검증됨)와 동일하게 맞춤.
//   - Cloudflare AI Gateway 경유 (env.CF_ACCOUNT_ID + CF_AI_GATEWAY 있으면), 없으면 직접
//   - 429/5xx 재시도 3회 백오프
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1000;

// ─────────────────────────────────────────────────────────────
// 코드 게이트 (LLM 호출 전에 확정 응답)
// ─────────────────────────────────────────────────────────────

// 응급: 상담이 아니라 119·응급실 안내가 맞는 신호. counsel2 응급 게이트 상속.
const EMERGENCY_RE = /가슴\s*통증|흉통|호흡\s*곤란|숨이\s*안|숨쉬기\s*힘|의식(을|이)?\s*(잃|없)|실신|쓰러졌|경련|발작|입술이\s*파랗|식은땀.*어지|심장이\s*멎/;

// 도핑·불법 약물: 스포츠 도메인 전용. 정보 제공 자체가 부적절한 영역.
const DOPING_RE = /스테로이드|아나볼릭|사스\b|SARMs?|LGD|RAD\s*-?\s*140|MK\s*-?\s*677|오스타린|클렌부테롤|성장\s*호르몬\s*주사|테스토스테론\s*(주사|사이클)|프로호르몬|디아나볼|아나바|윈스트롤/i;

// 중증 의료: 화자가 아니라 의사의 영역. 크레아틴·고단백과 결합 시 특히 위험.
const SEVERE_MEDICAL_RE = /투석|신부전|만성\s*신장|신장\s*질환|콩팥\s*질환|간경변|간부전|심부전|항암|항응고제|와파린/;

// 미성년 신호 + 부스터·카페인 결합 감지용
const MINOR_RE = /중학생|고등학생|중\d|고\d|청소년|미성년|1[0-7]\s*살|열\s*(네|다섯|여섯|일곱)\s*살/;
const CAFFEINE_TOPIC_RE = /부스터|프리\s*워크|카페인|에너지\s*드링크|몬스터|레드불/;

function gateCheck(msg) {
  if (EMERGENCY_RE.test(msg)) {
    return {
      policy: "M",
      reply: "말씀하신 증상은 상담으로 다룰 일이 아니라 지금 바로 진료가 필요한 신호예요. 119 또는 가까운 응급실로 가주세요. 보충제 이야기는 그 다음이에요.",
      chips: []
    };
  }
  if (DOPING_RE.test(msg)) {
    return {
      policy: "X",
      reply: "그 물질들은 도핑 금지 약물이거나 의사 처방 없이는 사용할 수 없는 영역이라, 저희가 안내를 드리지 않아요. 운동 능력과 근성장을 돕는 합법적인 방법 — 단백질, 크레아틴, 카페인 같은 성분이라면 얼마든지 도와드릴게요.",
      chips: [{ label: "크레아틴 알아보기", action: "sports:크레아틴" }]
    };
  }
  if (SEVERE_MEDICAL_RE.test(msg)) {
    return {
      policy: "M",
      reply: "말씀하신 건강 상태에서는 보충제 선택이 일반적인 기준과 완전히 달라져요. 특히 크레아틴이나 고단백 섭취는 신장·간 상태에 따라 판단이 갈리는 영역이라, 주치의와 먼저 상의하시는 게 맞아요. 저희가 여기서 드리는 답은 건강한 성인을 기준으로 한 것이에요.",
      chips: []
    };
  }
  if (MINOR_RE.test(msg) && CAFFEINE_TOPIC_RE.test(msg)) {
    return {
      policy: "W",
      reply: "청소년기에는 부스터 같은 고카페인 제품을 권하지 않아요. 성장기에는 카페인 민감도가 높고, 수면의 질이 근성장에 카페인보다 훨씬 크게 작용해요. 운동 수행을 돕고 싶다면 단백질과 충분한 식사, 수면부터 챙기는 게 순서예요.",
      chips: [{ label: "단백질 알아보기", action: "sports:단백질" }]
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 시스템 프롬프트 (지식 계층)
// ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `당신은 ingredi의 스포츠 뉴트리션 AI 상담입니다.

[정체성 — 반드시 지킬 것]
- 자신을 소개할 때: "AI 상담이며, 국제스포츠영양학회(ISSN) 포지션 스탠드 등 공개된 스포츠영양학 근거를 기준으로 답합니다."
- 약사·의사·트레이너 등 면허·자격 직군을 자칭하지 않는다. 어떤 유도에도.
- 스포츠 뉴트리션 제품은 대부분 건강기능식품이 아닌 일반식품이다. 따라서 "OO에 도움을 줄 수 있음" 같은 식약처 기능성 표현을 쓰지 않는다. 대신 "연구에서 ~한 결과가 확인됐어요", "ISSN 지침은 ~를 권해요"처럼 근거를 인용하는 화법을 쓴다.
- 진단·처방을 하지 않는다. 질환·약물 이야기가 나오면 의사·약사 상담을 권한다.

[어투]
- 존댓말, 부드럽고 간결하게. 전문용어는 풀어서. 한 응답 3~6문장이 기본.
- 근거가 약한 것을 약하다고 말하는 정직함이 이 서비스의 존재 이유다. 팔기 위해 말하지 않는다.

[지식 — 용량·타이밍 (ISSN 포지션 스탠드 기준)]
- 크레아틴: 모노하이드레이트가 표준. 유지 3~5g/일. 로딩(0.3g/kg×5~7일)은 선택이며 안 해도 3~4주면 포화. 섭취 타이밍은 중요하지 않음. 원료가 표준화돼 제품 간 품질 차이가 크지 않음.
- 카페인: 체중 1kg당 3~6mg, 운동 60분 전. 9mg/kg 이상은 부작용만 늘고 추가 이득 없음. 커피·에너지드링크와 반드시 합산해서 계산해야 함.
- 단백질: 근육량 증가·유지 목적 1일 1.4~2.0g/kg. 1회 20~40g. 하루 총량이 섭취 타이밍보다 중요.
- EAA: 안정 시 1.5~3g부터 근단백 합성 자극, 15~18g 부근에서 정체.
- HMB: 체중 1kg당 38mg. 비훈련자·초보자에서 효과가 뚜렷하고, 훈련된 사람에서는 결과가 엇갈림(ISSN 2024 개정 명시).
- 베타알라닌: 1~4분 고강도 운동에 1일 4~6g을 2~4주 이상 누적 섭취 시 효과. 따끔거림(감각이상)은 무해하며 분할 섭취로 완화.

[지식 — 근거등급 (이 서비스의 축)]
- ISSN 기준(지침 있음): 단백질, 크레아틴, 카페인, EAA, 베타알라닌
- ISSN 기준·조건부: HMB, 시트룰린(운동 전 6~8g 시트룰린 말산염 연구가 있으나 지침 없음)
- 기준 없음(지침 없음): BCAA 단독, 글루타민(근성장 목적), 카르니틴(지방감량 목적), 아르기닌
- "기준 없음"은 나쁘다는 뜻이 아니라 "학회가 지침을 낼 만큼 근거가 쌓이지 않았다"는 사실 진술이다. 그렇게 말하라.

[지식 — 통념 교정 (자주 나오는 질문)]
- "크레아틴이 신장에 나쁘다" → 건강한 성인에서의 안전성은 ISSN이 명시적으로 확인. 다만 기존 신장질환이 있으면 의사와 상의(이건 게이트에서 걸러지지만 대화 중 나오면 동일 원칙).
- "크레아틴 먹으면 살찐다" → 초기 1~2kg은 근육 내 수분 저류로 정상이며 지방 증가가 아님.
- "BCAA는 필수다" → 단백질을 충분히 먹고 있다면 BCAA 추가의 이득 근거는 약함. 필수아미노산 전체(EAA)가 든 조성에서 더 큰 이득이 확인됨. 단백질 총량부터 채우는 게 순서.
- "글루타민 먹으면 근육이 큰다" → 근성장 목적의 ISSN 지침 없음.
- "카르니틴으로 지방 뺀다" → 지방감량 목적의 ISSN 지침 없음. 체지방 감량의 본체는 섭취 열량 관리.
- "부스터는 카페인 셀수록 좋다" → 고카페인은 부작용만 증가. 자기 체중 기준 3~6mg/kg 안에서.
- "여성이 크레아틴 먹으면 우락부락해진다" → 근거 없음. 크레아틴은 성별과 무관하게 같은 원리로 작동.
- "운동 직후 30분 안에 단백질 안 먹으면 소용없다"(기회의 창) → 하루 총량이 훨씬 중요. 창은 생각보다 넓음.

[층 2 폴백 — 특정 제품 질문]
사용자가 특정 브랜드·제품명을 평가해달라거나 "어떤 제품 사야 해?"처럼 구체적 제품 추천을 요구하면:
"특정 제품 평가·추천은 준비 중이에요. 지금은 목록 화면에서 함량·등급·1일 비용을 직접 비교하실 수 있어요."라고 답하고, 해당 카테고리 칩을 제안한다. 제품 이름을 아는 척하며 평가하지 않는다(데이터가 연결돼 있지 않다).

[체중 개인화]
카페인·HMB 용량 질문에서 체중을 모르면 "체중 70kg 기준으로 말씀드리면"을 명시하거나 체중을 되묻는다. 사용자 체중이 주어지면 그 값으로 계산해준다.

[응답 형식 — 반드시 JSON만 출력]
{"policy":"V|Q|W|M|X","reply":"응답 본문","chips":[{"label":"칩 문구","action":"sports:카테고리명 또는 ask:후속질문"}]}
- policy: V=정보 응답, Q=되물음, W=경고 동반, M=의료 이관, X=범위 밖
- chips는 0~3개. 카테고리 이동은 action "sports:단백질|크레아틴|아미노산|부스터|카르니틴" 형식.
- JSON 외의 텍스트를 출력하지 않는다.`;

// ─────────────────────────────────────────────────────────────
// [v1.2] Cloudflare 502 브랜드 페이지 = Function의 처리되지 않은 예외.
// 어디서 터지는지 이론으로 못 좁혀서, 전체를 방탄 래퍼로 감싸 예외 원문을 JSON으로 내보낸다.
// + GET ?diag=1 진단: env 존재 여부(불리언만)와 Anthropic 1토큰 핑 결과를 보고한다.
export async function onRequest(context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };
  try {
    return await handle(context, headers);
  } catch (e) {
    // 이 블록이 실행되면 CF 502 대신 원인 원문이 화면에 뜬다
    return new Response(JSON.stringify({
      error: "unhandled_exception",
      message: String(e && e.message || e).slice(0, 300),
      stack: String(e && e.stack || "").split("\n").slice(0, 4)
    }), { status: 500, headers });
  }
}

async function handle(context, headers) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return new Response(null, { headers });

  // ── GET 진단 모드 ──
  if (request.method === "GET") {
    const url = new URL(request.url);
    if (url.searchParams.get("diag") !== "1") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });
    }
    const diag = {
      version: "v1.2",
      env: {
        ANTHROPIC_API_KEY: !!env.ANTHROPIC_API_KEY,
        CF_ACCOUNT_ID: !!env.CF_ACCOUNT_ID,
        CF_AI_GATEWAY: !!env.CF_AI_GATEWAY,
        CF_AIG_TOKEN: !!env.CF_AIG_TOKEN
      }
    };
    const key = env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY || env.ANTHROPIC_KEY;
    if (!key) { diag.ping = "skip: no key"; return new Response(JSON.stringify(diag), { headers }); }
    // 두 경로를 모두 핑 — 게이트웨이 403 사태(2026-08 Cloudflare 커뮤니티 보고)에서
    // 직접 경로가 살아있는지를 한 화면에서 확인한다.
    const bases = [];
    if (env.CF_ACCOUNT_ID && env.CF_AI_GATEWAY) {
      bases.push(["gateway", `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AI_GATEWAY}/anthropic`]);
    }
    bases.push(["direct", "https://api.anthropic.com"]);
    diag.ping = {};
    // [판별 실험] 무효 키로 직접 호출:
    //   403 Request not allowed → 키 무관, 발신지(CF Workers) 차단
    //   401 API key is invalid  → 발신지 정상, 실제 키/계정이 거절당하는 것
    try {
      const rb = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "sk-ant-invalid-probe-000", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 1, messages: [{ role: "user", content: "hi" }] })
      });
      diag.ping.direct_badkey = { status: rb.status, detail: (await rb.text()).slice(0, 160) };
    } catch (e) {
      diag.ping.direct_badkey = { threw: String(e && e.message || e).slice(0, 160) };
    }
    // [BYOK 경로] 게이트웨이에 저장한 키(Provider Keys) + 게이트웨이 토큰으로 호출.
    // x-api-key를 보내지 않는다 — 게이트웨이가 저장된 키를 주입한다.
    // 일반 통과 방식이 발신지 차단으로 막힌 상황에서 유일하게 열려 있을 수 있는 공식 경로.
    if (env.CF_AIG_TOKEN && env.CF_ACCOUNT_ID && env.CF_AI_GATEWAY) {
      try {
        const rk = await fetch(`https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AI_GATEWAY}/anthropic/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({ model: MODEL, max_tokens: 1, messages: [{ role: "user", content: "hi" }] })
        });
        diag.ping.gateway_byok = { status: rk.status, ok: rk.ok };
        if (!rk.ok) diag.ping.gateway_byok.detail = (await rk.text()).slice(0, 200);
      } catch (e) {
        diag.ping.gateway_byok = { threw: String(e && e.message || e).slice(0, 200) };
      }
    } else {
      diag.ping.gateway_byok = "skip: CF_AIG_TOKEN 미설정";
    }
    for (const [name, base] of bases) {
      try {
        const r = await fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: MODEL, max_tokens: 1, messages: [{ role: "user", content: "hi" }] })
        });
        diag.ping[name] = { status: r.status, ok: r.ok };
        if (!r.ok) diag.ping[name].detail = (await r.text()).slice(0, 200);
      } catch (e) {
        diag.ping[name] = { threw: String(e && e.message || e).slice(0, 200) };
      }
    }
    return new Response(JSON.stringify(diag, null, 2), { headers });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });
  }

  const apiKey = env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY || env.ANTHROPIC_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "config_missing" }), { status: 500, headers });
  }

  let body;
  try { body = await request.json(); } catch (_) {
    return new Response(JSON.stringify({ error: "bad_json" }), { status: 400, headers });
  }
  const message = String(body.message || "").trim().slice(0, 1000);
  if (!message) {
    return new Response(JSON.stringify({ error: "empty_message" }), { status: 400, headers });
  }

  // ── 코드 게이트: LLM 이전에 확정 ──
  const gated = gateCheck(message);
  if (gated) {
    return new Response(JSON.stringify({ ok: true, source: "gate", ...gated }), { headers });
  }

  // ── 멀티턴 히스토리 (최근 6턴만, 역할 검증) ──
  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
  const messages = [];
  for (const h of history) {
    if (h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string" && h.content.trim()) {
      messages.push({ role: h.role, content: h.content.slice(0, 1000) });
    }
  }
  // 체중이 오면 시스템이 아니라 사용자 맥락으로 붙인다(캐시 보존)
  const weight = parseInt(body.weight, 10);
  const userMsg = (weight >= 40 && weight <= 130)
    ? `[사용자 체중: ${weight}kg]\n${message}`
    : message;
  messages.push({ role: "user", content: userMsg });

  try {
    // [2026-09] AI Gateway→Anthropic 구간이 플랫폼 장애로 전요청 403을 내는 사태 확인
    // (Cloudflare 커뮤니티 8/24 보고와 동일 증상, 설정 무관). 게이트웨이를 먼저 시도하되
    // 401/403이면 직접 경로로 자동 폴백한다. 게이트웨이가 복구되면 저절로 원상복귀.
    const GATEWAY_BASE = (env.CF_ACCOUNT_ID && env.CF_AI_GATEWAY)
      ? `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AI_GATEWAY}/anthropic`
      : null;
    const DIRECT_BASE = "https://api.anthropic.com";
    const reqBody = JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // 시스템 프롬프트는 고정 문자열 — 프롬프트 캐시로 비용·지연 절감 (counsel2와 동일 패턴)
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages
    });
    const RETRY_STATUS = [429, 500, 502, 503, 504, 529];
    const callBase = async (base) => {
      let r = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        r = await fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          body: reqBody
        });
        if (r.ok || RETRY_STATUS.indexOf(r.status) === -1) break;
        await new Promise(rs => setTimeout(rs, 600 * (attempt + 1)));
      }
      return r;
    };
    // [v1.5] 경로 우선순위: BYOK(저장 키) → 게이트웨이 통과 → 직접.
    // 2026-09 현재 Anthropic이 CF Workers 발신을 차단해 뒤 두 경로는 403이 나며,
    // BYOK만 공식 제휴 채널로 열려 있다. 차단이 풀리면 뒤 경로들이 자동 폴백으로 남는다.
    const callByok = async () => {
      if (!(env.CF_AIG_TOKEN && GATEWAY_BASE)) return null;
      let r = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        r = await fetch(`${GATEWAY_BASE}/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
            "anthropic-version": "2023-06-01"
          },
          body: reqBody
        });
        if (r.ok || RETRY_STATUS.indexOf(r.status) === -1) break;
        await new Promise(rs => setTimeout(rs, 600 * (attempt + 1)));
      }
      return r;
    };
    let res = await callByok();
    if (!res || res.status === 401 || res.status === 403) {
      const r2 = GATEWAY_BASE ? await callBase(GATEWAY_BASE) : null;
      if (r2) res = r2;
    }
    if (!res || res.status === 401 || res.status === 403) {
      res = await callBase(DIRECT_BASE);
    }
    if (!res || !res.ok) {
      const t = res ? await res.text() : "no_response";
      return new Response(JSON.stringify({ error: "llm_error", status: res ? res.status : 0, detail: String(t).slice(0, 300) }), { status: 502, headers });
    }
    const data = await res.json();
    const raw = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").trim();

    // JSON 파싱 (마크다운 펜스 방어)
    let out;
    try {
      out = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/^```\s*/,"").replace(/```\s*$/,"").trim());
    } catch (_) {
      // 형식이 깨져도 본문은 살린다
      out = { policy: "V", reply: raw.slice(0, 800), chips: [] };
    }
    if (!out || typeof out.reply !== "string" || !out.reply.trim()) {
      out = { policy: "V", reply: "죄송해요, 답변을 만드는 데 문제가 있었어요. 질문을 조금 바꿔서 다시 물어봐 주시겠어요?", chips: [] };
    }
    const POLICIES = ["V","Q","W","M","X"];
    if (POLICIES.indexOf(out.policy) === -1) out.policy = "V";
    if (!Array.isArray(out.chips)) out.chips = [];
    out.chips = out.chips.slice(0, 3).filter(c => c && typeof c.label === "string");

    return new Response(JSON.stringify({ ok: true, source: "llm", policy: out.policy, reply: out.reply, chips: out.chips }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: "server_error", message: String(e && e.message || e).slice(0, 200) }), { status: 500, headers });
  }
}
