// functions/counsel2.js  (v9 — 화자 상담: 5정책 분류 + JSON 계약 + 다중 턴 + 통념 도메인 게이트)
//
// 기존 counsel-api.js(v7)와 병행 배포. 프론트 전환 완료 후 v7 폐기.
//
// 변경 요약
//   - POST { messages: [{role, content}...] } 다중 턴 입력 (GET ?q= 도 단발 호환)
//   - 시스템 프롬프트: "정보 카운슬러" → 화자 v1 (평결을 내리는 약사)
//   - 응답: SSE 토큰 스트림 → 단일 JSON (policy / verdict_tone / chips / alternatives ...)
//   - 정책 분류: 코드 게이트(meta·service·급성 이상반응) + Claude 분류(M/X/W/V/Q) 이중 구조
//   - riskKeywords → W 플래그로 프롬프트에 주입
//   - 답변별 DISCLAIMER 제거 (서비스 차원 고지는 프론트 푸터에 1회)
//   - 대안(alternatives)은 현재 오메가3만 실데이터, 타 카테고리는 비교 페이지 폴백
//   - ?debug=1 로 라우팅·검색 근거 확인
//   - v9: 통념 도메인 게이트 추가 — 식약처 미인정 기능(면역 등)은 통념을 승인하지 않고
//         "인정 기능 아님"을 코드로 못박되, 관련해 언급되는 인접 카테고리는 안내(X + 칩).

import { getRecords } from "./_lib/airtable.js";

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8" };
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: { ...headers, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
  }

  const url = new URL(request.url);
  const wantDebug = url.searchParams.get("debug") === "1";

  // ─── 입력: POST messages[] 우선, GET ?q= 호환 ────
  let messages = [];
  if (request.method === "POST") {
    try {
      const body = await request.json();
      if (Array.isArray(body.messages)) {
        messages = body.messages
          .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
          .slice(-12)
          .map(m => ({ role: m.role, content: m.content.trim().slice(0, 1200) }));
      }
    } catch (_) { /* fallthrough */ }
  }
  if (messages.length === 0) {
    const q = (url.searchParams.get("q") || "").trim();
    if (q) messages = [{ role: "user", content: q.slice(0, 1200) }];
  }
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return new Response(JSON.stringify({ error: "missing_query" }), { status: 400, headers });
  }
  const query = messages[messages.length - 1].content;
  const convoText = messages.map(m => m.content).join(" ");
  const lowerQuery = query.toLowerCase();
  const askedBefore = messages.filter(m => m.role === "assistant").length > 0;

  const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return new Response(JSON.stringify({ error: "missing_api_key" }), { status: 500, headers });

  // ─── 상수 (v7 계승) ──────────────────────────────
  const FAQ_TABLE = "FAQ_전체상품";
  const KNOW_TABLE = "knowledge";

  const CATEGORY_KEYWORDS = {
    omega3:     ["오메가", "omega", "epa", "dha", "ala", "dpa", "rtg", "알티지", "어유", "fish oil", "크릴", "어류", "goed", "ifos"],
    vitaminC:   ["비타민c", "비타민 c", "비타민씨", "vitamin c", "아스코르브산", "ascorbic", "메가도스", "리포좀"],
    eye:        ["루테인", "지아잔틴", "아스타잔틴", "황반", "시력", "안구", "눈건강", "lutein", "zeaxanthin", "마리골드"],
    probiotics: ["프로바이오틱스", "프리바이오틱스", "신바이오틱스", "포스트바이오틱스", "유산균", "윤산균", "장건강", "probiotics", "마이크로바이옴", "유익균", "비피더스", "락토바실러스", "비피도박테리움", "lactobacillus", "bifidobacterium", "보장균수", "cfu"]
  };
  const CAT_KO    = { omega3: "오메가3", vitaminC: "비타민C", eye: "눈", probiotics: "유산균" };
  const KO_CAT    = { "오메가3": "omega3", "비타민C": "vitaminC", "눈": "eye", "유산균": "probiotics" };
  const CAT_LABEL = { omega3: "오메가3", vitaminC: "비타민C", eye: "눈 건강(루테인)", probiotics: "유산균" };
  const FOUR_CATS = "오메가3, 눈 건강(루테인), 유산균, 비타민C";

  const PRODUCT_HINTS = [
    { cat: "probiotics", re: /장\s*(이|은|을|도|내|건강|기능|트러블|활동|운동)|장\s*(안\s*좋|나빠|불편)|배변|변비|설사|화장실|대변|묽은변|배\s*(가|를|에).{0,5}(아프|아파|불편|더부룩)/ },
    { cat: "eye",        re: /눈\s*(이|은|을|도|의|건강|관리|영양제|피로|시림|나빠|안\s*좋)|시력|황반|안구|침침|뻑뻑/ },
    { cat: "omega3",     re: /혈행|중성지방|콜레스테롤|혈중지질|심혈관/ },
    { cat: "vitaminC",   re: /항산화|괴혈병/ }
  ];
  const DOMAIN_HINTS = [
    { dom: "수면",       re: /수면|불면|잠\s*(이|을|못|안|설치)|숙면|멜라토닌|테아닌|melatonin|theanine|insomnia|sleep/ },
    { dom: "관절",       re: /관절|무릎|연골|글루코사민|보스웰리아|glucosamine|boswellia|joint/ },
    { dom: "간",         re: /간\s*(이|은|을|도|에|수치|건강|기능)|간\s*(안\s*좋|나빠)|숙취|밀크시슬|밀크씨슬|실리마린|milk\s*thistle|silymarin|음주|술\s*(을|자주|많이|마시)|알코올/ },
    { dom: "피부",       re: /피부|여드름|뾰루지|주름|콜라겐|미백|기미|collagen|biotin|skin/ },
    { dom: "다이어트",   re: /다이어트|diet|체중|체지방|살\s*(을|이|빼|안\s*빠)|가르시니아|garcinia/ },
    { dom: "뼈",         re: /뼈|골다공증|골밀도|칼슘|calcium|bone/ },
    { dom: "혈압",       re: /혈압|blood\s*pressure/ },
    { dom: "인지",       re: /기억력|인지|집중력|치매|두뇌|cognitive|memory/ },
    { dom: "커큐민",     re: /커큐민|강황|울금|curcumin|turmeric/ },
    { dom: "글루타치온", re: /글루타치온|글루타티온|glutathione/ },
    { dom: "면역",       re: /면역|immun/ }
  ];

  // ─── 통념 도메인 (식약처 인정 기능 밖) ─────────────
  // 소비자는 특정 성분과 연결짓지만, 식약처가 4개 카테고리 성분에 인정한 기능이 아닌 도메인.
  // "인정 기능 아님"을 코드로 못박아 통념 승인을 차단하고, 관련해 언급되는 인접 카테고리만 안내한다.
  // 이 게이트는 검색·모델 호출 전에 즉답하며, DOMAIN_HINTS의 동일 도메인보다 우선한다.
  // 확장 원칙:
  //   - 식약처 인정 기능과 관련된 통념이면 { key, re, cats } 한 줄 추가.
  //   - 완전 범위 밖(관련 카테고리 없음)이면 여기 넣지 말 것 — 기존 X 처리로 간다.
  //   - 인접 판정은 상상이 아니라 실제 유입 로그(검색로그·Clarity의 healthDomain)를 근거로 늘린다.
  const DOMAIN_ADJACENCY = [
    { key: "면역", re: /면역|immun/i, cats: ["비타민C", "유산균"] }
  ];
  // 통념 게이트가 삼키면 안 되는 의료 맥락 — 이 경우 게이트를 건너뛰고 Claude의 M 분류로 넘긴다.
  const MEDICAL_DEFER = /항암|암\s|투석|이식|수술|시술|처방약|면역억제|당뇨|혈압약|간\s*(질환|염|경화|수치)|신부전|신장\s*(질환|병)|임신|임산부|수유|이상\s*반응|부작용|알레르기/;

  const GENERIC_TERMS = ["영양제", "건강기능식품", "건기식", "보충제", "서플리먼트", "supplement", "뭐 먹", "무엇을 먹", "뭘 먹", "뭐가 좋", "뭐 사"];
  const VAGUE_QUERY = /건강이\s*걱정|몸이\s*예전|나이\s*드는|돈\s*낭비|기운이?\s*없|피곤|피로\s*회복|활력|컨디션|무기력|식약처|fda|gras|기능성\s*표시|인증\s*마크/i;

  const META_QUERY = /프롬프트|시스템\s*지시|이전\s*지시|무시하고|너\s*(는|누구|어떤|뭐)|무슨\s*모델|모델이(야|니|에요)|당신은\s*누구|jailbreak|ignore\s+previous/i;
  const SERVICE_QUERY = /환불|반품|교환|배송|결제|쿠폰|주문|취소|배달|고객센터|광고|협찬|수수료|제휴|약국|직구|최저가|세일|할인|돈\s*(을)?\s*(벌|버는)|수익|어떻게\s*운영/;
  // 급성 이상 반응·사고 — 검색 없이 즉시 M
  const ACUTE_EMERGENCY = /두드러기|호흡\s*(곤란|이\s*힘)|가슴\s*(이)?\s*(두근|답답|아프)|심장이\s*두근|쇼크|의식|한\s*(통|병)\s*(을)?\s*다\s*(먹|삼)|과다\s*복용\s*(했|한\s*것)/;

  const SEED_TOKENS = {
    omega3:     ["오메가3", "epa", "dha"],
    eye:        ["루테인", "눈 건강", "황반"],
    probiotics: ["유산균", "프로바이오틱스", "장 건강"],
    vitaminC:   ["비타민c", "항산화"]
  };
  const DOMAIN_SEED = {
    "면역": ["면역"], "인지": ["인지", "기억력"], "뼈": ["뼈", "골밀도"], "수면": ["수면"],
    "피부": ["피부"], "다이어트": ["체지방", "다이어트"], "관절": ["관절"], "간": ["간 건강", "간"],
    "혈압": ["혈압"], "커큐민": ["커큐민"], "글루타치온": ["글루타치온"]
  };
  const CROSS_DOMAINS = new Set(["페르소나", "카페질문"]);
  const MIN_VOTE_SCORE = 16.0;

  const CATEGORY_OPTIONS = [
    { key: "오메가3", label: "오메가3",  desc: "혈행·뇌·눈 건강" },
    { key: "눈",     label: "눈 건강",  desc: "루테인·지아잔틴" },
    { key: "유산균",  label: "유산균",   desc: "장 건강·면역" },
    { key: "비타민C", label: "비타민C",  desc: "항산화·면역" }
  ];

  // ─── HELPERS (v7 계승) ───────────────────────────
  function normalizeKey(s) { return String(s).replace(/[\s_\-\(\)\[\]]/g, "").toLowerCase(); }
  // 한글 조사 선택 (받침 유무). 통념 도메인 안내 문구를 도메인 이름에 맞춰 생성한다.
  function hasJong(w) { const s = String(w || ""); if (!s) return false; const c = s.charCodeAt(s.length - 1); return (c >= 0xAC00 && c <= 0xD7A3) ? ((c - 0xAC00) % 28 !== 0) : false; }
  function eunNeun(w) { return w + (hasJong(w) ? "은" : "는"); }
  function gwaWa(w) { return w + (hasJong(w) ? "과" : "와"); }
  function getField(fields, ...candidates) {
    for (const c of candidates) if (fields[c] !== undefined && fields[c] !== null && fields[c] !== "") return fields[c];
    const norm = {};
    for (const k in fields) norm[normalizeKey(k)] = fields[k];
    for (const c of candidates) { const v = norm[normalizeKey(c)]; if (v !== undefined && v !== null && v !== "") return v; }
    return "";
  }
  function asText(v) { return Array.isArray(v) ? v.join(" ") : String(v || ""); }
  function normEntity(s) { return String(s || "").replace(/[\s\-_\u00B7]/g, "").toLowerCase(); }
  function isCategoryWord(t) {
    for (const cat in CATEGORY_KEYWORDS) for (const k of CATEGORY_KEYWORDS[cat]) {
      const nk = normEntity(k);
      if (nk && (t === nk || t.indexOf(nk) !== -1 || nk.indexOf(t) !== -1)) return true;
    }
    return false;
  }
  function detectProductName(q, records) {
    const qn = normEntity(q);
    if (qn.length < 3) return null;
    for (const r of records || []) {
      const nm = normEntity(getField(r.fields || {}, "제품명", "name"));
      if (nm && nm.indexOf(qn) !== -1) return r;
    }
    const parts = String(q).split(/\s+/).map(normEntity).filter(t => t.length >= 2);
    const hasBrand = parts.some(t => t.length >= 3 && !isCategoryWord(t));
    if (parts.length >= 2 && hasBrand) {
      for (const r of records || []) {
        const nm = normEntity(getField(r.fields || {}, "제품명", "name"));
        if (nm && parts.every(p => nm.indexOf(p) !== -1)) return r;
      }
    }
    return null;
  }

  // 대화체 문장("뉴티지 ntg 오메가3 먹어도 되는 거야?")에서 제품 언급을 건진다.
  // 원리: 제품명에 실제로 등장하는 토큰만 점수화 — 대화체 단어(먹어도·되는·거야)는
  // 제품명에 없으니 자연히 0점. 많은 제품명에 흔한 범용 토큰(고함량·프리미엄 등)은
  // 문서빈도 필터로 배제. 브랜드성 매칭 길이 3자 이상일 때만 확정.
  function findProductMention(q, records) {
    const recs = records || [];
    if (!recs.length) return null;
    const names = recs.map(r => normEntity(getField(r.fields || {}, "제품명", "name")));
    const parts = [...new Set(String(q).split(/\s+/).map(normEntity)
      .filter(t => t.length >= 2 && !isCategoryWord(t)))];
    if (!parts.length) return null;
    // 범용 토큰 배제: 전체 제품의 5% 초과(최소 3개 초과)에 등장하면 브랜드가 아님
    const cap = Math.max(3, Math.floor(recs.length * 0.05));
    const usable = parts.filter(t => {
      let df = 0;
      for (const nm of names) { if (nm && nm.indexOf(t) !== -1) { df++; if (df > cap) return false; } }
      return df > 0;
    });
    if (!usable.length) return null;
    let best = null, bestLen = 0;
    for (let i = 0; i < recs.length; i++) {
      const nm = names[i];
      if (!nm) continue;
      let hit = 0;
      for (const t of usable) if (nm.indexOf(t) !== -1) hit += t.length;
      if (hit > bestLen) { bestLen = hit; best = recs[i]; }
    }
    return bestLen >= 3 ? best : null;
  }
  function parseDemographics(q) {
    const text = String(q || "");
    let age = null, gender = null;
    let m = text.match(/(\d{1,3})\s*(?:살|세)/);
    if (m) { const a = parseInt(m[1], 10); if (a >= 10 && a <= 120) age = a >= 60 ? "60" : String(Math.max(20, Math.floor(a / 10) * 10)); }
    if (!age) {
      const KO = { "이십": "20", "삼십": "30", "사십": "40", "오십": "50", "육십": "60" };
      const km = text.match(/(이십|삼십|사십|오십|육십)\s*대/);
      if (km) age = KO[km[1]];
    }
    if (!age) {
      m = text.match(/(\d{1,2})\s*대/);
      if (m) { const d = parseInt(m[1], 10); if (d >= 60) age = "60"; else if (d >= 20) age = String(d); else if (d > 0) age = "20"; }
    }
    if (/여성|여자|엄마|어머니|아내|딸|와이프/.test(text)) gender = "female";
    else if (/남성|남자|아빠|아버지|남편|아들/.test(text)) gender = "male";
    const pregnant = /임신|임산부|수유/.test(text) ? "yes" : null;
    return { age, gender, pregnant };
  }

  // 고정 응답 빌더 (화자 톤, JSON 계약 준수)
  function fixedPayload(policy, body, extra) {
    return Object.assign({
      policy, verdict_tone: "none", verdict: null, body,
      warning: null, question: null, chips: null, chips_prompts: null,
      default_answer: null, alternatives: [], handoff: null
    }, extra || {});
  }
  function respond(payload, meta) {
    const out = { payload, meta };
    return new Response(JSON.stringify(out), { status: 200, headers });
  }

  try {
    const demographics = parseDemographics(convoText);

    // ─── [0] 코드 게이트: 검색·모델 호출 전 차단 ────
    if (META_QUERY.test(query)) {
      return respond(fixedPayload("X",
        "저는 ingredi의 상담 약사예요. 오메가3, 눈, 유산균, 비타민C 네 가지를 깊게 봅니다. 광고를 받지 않고 공개된 제품 데이터로만 판단해요.\n\n어떤 게 궁금하세요?",
        { chips: ["오메가3", "눈 건강", "유산균", "비타민C"],
          chips_prompts: ["오메가3에 대해 물어볼게요", "눈 영양제에 대해 물어볼게요", "유산균에 대해 물어볼게요", "비타민C에 대해 물어볼게요"] }
      ), { gate: "meta", demographics });
    }
    if (SERVICE_QUERY.test(query) && !/오메가|루테인|유산균|비타민/.test(query)) {
      return respond(fixedPayload("X",
        "주문·배송·환불은 구매하신 판매처에서 확인하셔야 해요. ingredi는 제품을 팔지 않고 비교와 판단만 해드립니다.\n\n제품이나 성분이 궁금하시면 도와드릴게요."
      ), { gate: "service", demographics });
    }
    if (ACUTE_EMERGENCY.test(query)) {
      return respond(fixedPayload("M",
        "이건 제가 답할 영역이 아니에요. 지금 겪고 계신 증상은 영양제 상담이 아니라 진료가 필요합니다. 복용 중인 제품이 있다면 지금 중단하시고, 증상이 심하면 바로 병원으로 가세요.",
        { handoff: "병원에 가실 때, 드시던 제품을 그대로 가져가서 보여주세요. 성분 확인이 빨라집니다." }
      ), { gate: "emergency", demographics });
    }

    // ─── [0.5] 통념 도메인 게이트: 식약처 인정 기능 밖 + 인접 카테고리 안내 ──
    // 발동 조건 3개 동시 성립: 통념 키워드 O / 4개 카테고리 키워드 X(병용 질문 보호) / 의료 맥락 X(M 우선).
    // 통념을 "좋다"고 승인하지 않는 판정이므로 LLM에 맡기지 않고 코드에서 즉답한다.
    if (!/오메가|루테인|유산균|비타민|omega|epa|dha|프로바이오|마이크로바이옴/i.test(query) && !MEDICAL_DEFER.test(query)) {
      for (const dom of DOMAIN_ADJACENCY) {
        if (dom.re.test(query)) {
          const catsText = dom.cats.join("·");
          return respond(fixedPayload("X",
            `${eunNeun(dom.key)} 식약처가 특정 성분에 인정한 기능이 아니에요. 그래서 '${dom.key}에 좋은 영양제'를 딱 집어드리진 않아요. 다만 ${gwaWa(dom.key)} 관련해 자주 언급되는 성분 중 ${eunNeun(catsText)} 저희가 깊게 봅니다. 어느 쪽을 보시겠어요?`,
            {
              chips: dom.cats.map(c => `${c} 보기`),
              chips_prompts: dom.cats.map(c => `${c} 추천해줘`)
            }
          ), { gate: "adjacency", healthDomain: dom.key, demographics });
        }
      }
    }

    // ─── [1] 토큰 정제 (v7 계승) ────────────────────
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
    for (const [p, r] of synonymMap) expandedQuery = expandedQuery.replace(p, r);
    const allTokens = [...new Set([...query.split(/\s+/), ...expandedQuery.split(/\s+/)])].filter(Boolean);
    const JOSA = ["으로","로서","로써","에서","에게","한테","이라는","라는","이라고","라고","이란","란","이나","이며","이고","은","는","이","가","을","를","와","과","의","에","도","만","요"];
    const STOPWORDS = new Set(["뭐야","뭔지","뭐냐","뭐","무엇","뭔가","알려줘","설명","설명해줘","해줘","어때","인가요","일까요","되나요","건가요","좋아요","괜찮아요","대해","관해","그리고","근데","추천","추천해줘"]);
    function cleanTok(t) { return t.replace(/[?!.,~"'`()\[\]·…:;]/g, "").trim(); }
    function stripJosa(t) { for (const j of JOSA) { if (t.length > j.length + 1 && t.endsWith(j)) return t.slice(0, t.length - j.length); } return t; }
    const tokenSet = new Set();
    for (const t of allTokens) {
      const c = cleanTok(t);
      if (c && !STOPWORDS.has(c)) tokenSet.add(c.toLowerCase());
      const s = stripJosa(c);
      if (s && s.length > 1 && !STOPWORDS.has(s)) tokenSet.add(s.toLowerCase());
    }
    const lowerTokens = [...tokenSet].filter(t => t.length > 1);

    // ─── [2] 라우팅: 카테고리·도메인 (대화 전체 기준) ──
    let matchedCategory = null;
    let hintDomain = null;
    const routeText = convoText.toLowerCase();
    for (const cat in CATEGORY_KEYWORDS) {
      if (CATEGORY_KEYWORDS[cat].some(k => routeText.indexOf(k) !== -1)) { matchedCategory = cat; break; }
    }
    if (!matchedCategory) for (const h of PRODUCT_HINTS) if (h.re.test(convoText)) { matchedCategory = h.cat; break; }
    if (!matchedCategory) for (const h of DOMAIN_HINTS) if (h.re.test(convoText)) { hintDomain = h.dom; break; }

    // ─── [3] 테이블 로드 ────────────────────────────
    async function safeGet(t) { try { return await getRecords(env, t); } catch (_) { return []; } }
    const needOmegaProducts = !matchedCategory || matchedCategory === "omega3";
    const [kRecords, fRecords, pRecords] = await Promise.all([
      safeGet(KNOW_TABLE),
      safeGet(FAQ_TABLE),
      needOmegaProducts ? safeGet("오메가3_쿠팡업데이트") : Promise.resolve([])
    ]);

    let productMatchRecord = null;
    if (!matchedCategory || matchedCategory === "omega3") {
      productMatchRecord = detectProductName(query, pRecords || [])
        || findProductMention(query, pRecords || [])
        || (askedBefore ? findProductMention(convoText, pRecords || []) : null);
      if (productMatchRecord) matchedCategory = "omega3";
    }

    // ─── [4] 문서 정규화 + IDF 검색 (v7 계승, 축약 없이) ──
    function docFromFaq(r) {
      const f = r.fields || {};
      const kw = asText(getField(f, "keywords"));
      const q  = asText(getField(f, "question"));
      const a  = asText(getField(f, "answer"));
      return {
        kind: "faq", id: getField(f, "faq_id") || r.id,
        question: q, answer: a,
        evidence: asText(getField(f, "임상근거")),
        prodCat: asText(getField(f, "제품카테고리")).trim(),
        domain:  asText(getField(f, "건강도메인")).trim(),
        hayKw: (kw + " " + asText(getField(f, "소분류"))).toLowerCase(),
        hayQ: q.toLowerCase(), hayA: a.toLowerCase()
      };
    }
    function docFromKnow(r) {
      const f = r.fields || {};
      const kw = asText(getField(f, "키워드")) + " " + asText(getField(f, "관련성분키워드"));
      const one = asText(getField(f, "한줄정의"));
      const a = asText(getField(f, "답변예시"));
      return {
        kind: "knowledge", id: getField(f, "지식ID") || r.id,
        topic: asText(getField(f, "카테고리")),
        oneline: one, answer: a,
        evidence: asText(getField(f, "임상근거")),
        prodCat: asText(getField(f, "제품카테고리")).trim(),
        domain:  asText(getField(f, "건강도메인")).trim(),
        hayKw: kw.toLowerCase(), hayQ: one.toLowerCase(), hayA: a.toLowerCase()
      };
    }
    const faqDocs = (fRecords || []).map(docFromFaq).filter(d => d.prodCat && d.domain);
    const knowDocs = (kRecords || []).map(docFromKnow).filter(d => d.prodCat && d.domain);
    const allDocs = faqDocs.concat(knowDocs);

    const seedTokens = ((matchedCategory && SEED_TOKENS[matchedCategory]) ||
                        (hintDomain && DOMAIN_SEED[hintDomain]) || [])
                       .filter(t => lowerTokens.indexOf(t) === -1);
    const N = allDocs.length || 1;
    const IDF = {};
    for (const t of lowerTokens.concat(seedTokens)) {
      let df = 0;
      for (const d of allDocs) if (d.hayKw.indexOf(t) !== -1 || d.hayQ.indexOf(t) !== -1 || d.hayA.indexOf(t) !== -1) df++;
      IDF[t] = Math.log(1 + N / (1 + df));
    }
    const SEED_WEIGHT = 0.35;
    function scoreDoc(d, tokens, seedSet) {
      let s = 0;
      for (const t of tokens) {
        const w = IDF[t];
        if (w < 1.0) continue;
        const k = (seedSet && seedSet.has(t)) ? SEED_WEIGHT : 1.0;
        if (d.hayKw.indexOf(t) !== -1) s += 2.0 * w * k;
        if (d.hayQ.indexOf(t) !== -1) s += 1.5 * w * k;
        if (d.hayA.indexOf(t) !== -1) s += 1.0 * w * k;
      }
      if (s === 0) return 0;
      if (d.kind === "faq") s *= 1.3;
      if (d.domain === "페르소나") s *= 0.8;
      else if (d.domain === "카페질문") s *= 0.45;
      return s;
    }
    const isCross = d => CROSS_DOMAINS.has(d.domain);
    let pool;
    if (matchedCategory) {
      const ko = CAT_KO[matchedCategory];
      pool = allDocs.filter(d => d.prodCat === ko || isCross(d));
    } else if (hintDomain) {
      pool = allDocs.filter(d => d.domain === hintDomain || isCross(d));
    } else {
      pool = allDocs;
    }
    function searchWith(tokens, seedSet) {
      return pool.map(d => ({ d, s: scoreDoc(d, tokens, seedSet) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
    }
    let scored = searchWith(lowerTokens);
    if (seedTokens.length) {
      const scopeKey = matchedCategory ? CAT_KO[matchedCategory] : null;
      const hits = scored.filter(x => scopeKey ? x.d.prodCat === scopeKey : x.d.domain === hintDomain).length;
      if (hits < 2) scored = searchWith(lowerTokens.concat(seedTokens), new Set(seedTokens));
    }

    // 카테고리 미확정이면 검색 투표로 (v7 계승, 근접하면 카테고리 미지정 유지 → Q로 유도)
    let ambiguousCats = null;
    if (!matchedCategory && !hintDomain) {
      const TOPN = scored.slice(0, 12);
      const served = {};
      for (const { d, s } of TOPN) if (d.prodCat !== "해당없음") served[d.prodCat] = (served[d.prodCat] || 0) + s;
      const rank = Object.entries(served).sort((a, b) => b[1] - a[1]);
      if (rank[0] && rank[0][1] >= MIN_VOTE_SCORE) {
        if (rank[1] && rank[1][1] >= rank[0][1] * 0.8) ambiguousCats = [rank[0][0], rank[1][0]];
        else matchedCategory = KO_CAT[rank[0][0]] || null;
      }
    }
    if (matchedCategory) {
      const ko = CAT_KO[matchedCategory];
      scored = scored.filter(x => x.d.prodCat === ko || isCross(x.d));
      const ownCount = scored.filter(x => x.d.prodCat === ko).length;
      if (ownCount < 3) {
        const ORDER = { "효능": 0, "성분정의": 1, "개념": 1, "성분": 2, "섭취상한": 3, "제형특징": 4, "제품선택기준": 5 };
        const have = new Set(scored.map(x => x.d.id));
        const filler = allDocs.filter(d => d.prodCat === ko && !have.has(d.id))
          .sort((a, b) => ((ORDER[a.topic] ?? 9) - (ORDER[b.topic] ?? 9)))
          .slice(0, 3 - ownCount).map(d => ({ d, s: 0.01 }));
        scored = scored.concat(filler);
        scored.sort((a, b) => {
          const ao = a.d.prodCat === ko ? 1 : 0, bo = b.d.prodCat === ko ? 1 : 0;
          return (bo - ao) || (b.s - a.s);
        });
      }
    }
    const top = scored.slice(0, 8).map(x => x.d);

    // ─── [5] W 플래그 (v7 riskKeywords 계승) ────────
    const riskKeywords = {
      pregnancy: ["임산부", "임신", "수유"],
      surgery: ["수술", "시술"],
      bleeding: ["출혈", "항응고", "와파린", "아스피린", "클로피도그렐"],
      highDose: ["2000mg", "2500mg", "3000mg", "고함량", "과다", "메가도스"],
      chronicDisease: ["당뇨병", "당뇨약", "고혈압", "혈압약", "심장병", "간질환", "간염", "신부전", "신장질환", "투석", "갑상선"],
      smoking: ["흡연", "담배", "전자담배", "베타카로틴", "레티놀"],
      immunocompromised: ["면역저하", "항암", "항암치료", "장기이식", "이식", "면역억제", "췌장염", "중심정맥관", "미숙아"],
      vitcRisk: ["신장결석", "결석", "혈색소증", "철과부하", "g6pd"],
      antibiotics: ["항생제"],
      child: ["어린이", "아이", "소아", "초등"]
    };
    const lowerConvo = convoText.toLowerCase();
    const detectedRisks = [];
    for (const t in riskKeywords) for (const kw of riskKeywords[t]) { if (lowerConvo.indexOf(kw.toLowerCase()) !== -1) { detectedRisks.push(t); break; } }

    // ─── [6] 제품 컨텍스트 (오메가3만 실데이터) ─────
    let productContext = [];
    if (matchedCategory === "omega3" && (pRecords || []).length) {
      const items = (pRecords || []).map(r => {
        const f = r.fields || {};
        return {
          product_id: getField(f, "product_id", "productId") || r.id,
          name: getField(f, "제품명", "name") || "",
          epa_dha_mg: parseFloat(getField(f, "EPA_DHA_mg", "EPA_DHA_합계_mg")) || null,
          daily_cost: Math.round(parseFloat(getField(f, "1일비용_원")) || 0) || null,
          form: getField(f, "제형") || null,
          certs: asText(getField(f, "인증")) || null,
          grade: getField(f, "등급") || getField(f, "Tier등급") || null,
          score: parseFloat(getField(f, "quality", "품질점수", "V_Score")) || null,
          pass: getField(f, "함량_Pass_Fail") || null
        };
      }).filter(p => p.name && p.pass !== "Fail");

      // 축별 순위 계산 (전체 모집단 기준) — 화자가 "함량 기준 몇 위"를 말할 수 있게
      const byScore = [...items].sort((a, b) => (b.score || 0) - (a.score || 0));
      const byDose  = [...items].sort((a, b) => (b.epa_dha_mg || 0) - (a.epa_dha_mg || 0));
      const byValue = items.filter(p => (p.epa_dha_mg || 0) >= 1000 && p.daily_cost)
                           .sort((a, b) => a.daily_cost - b.daily_cost);
      byScore.forEach((p, i) => { p.rank_quality = i + 1; });
      byDose.forEach((p, i) => { p.rank_dose = i + 1; });
      byValue.forEach((p, i) => { p.rank_value = i + 1; });

      // 후보군 = 세 축 상위 8의 합집합 (한 축만 잘 보이는 제품도 화자 시야에 들어오게)
      const seen = new Set();
      const topProducts = [];
      for (const pool of [byScore.slice(0, 8), byDose.slice(0, 8), byValue.slice(0, 8)]) {
        for (const p of pool) {
          if (!seen.has(p.product_id)) { seen.add(p.product_id); topProducts.push(p); }
        }
      }
      // 유저가 특정 제품을 물었으면 그 제품을 반드시 포함
      if (productMatchRecord) {
        const pf = productMatchRecord.fields || {};
        const pid = getField(pf, "product_id", "productId") || productMatchRecord.id;
        if (!seen.has(pid)) {
          const hit = items.find(p => p.product_id === pid);
          if (hit) topProducts.push(hit);
          else topProducts.push({
            product_id: pid, name: getField(pf, "제품명", "name") || "",
            epa_dha_mg: parseFloat(getField(pf, "EPA_DHA_mg", "EPA_DHA_합계_mg")) || null,
            daily_cost: Math.round(parseFloat(getField(pf, "1일비용_원")) || 0) || null,
            form: getField(pf, "제형") || null, certs: asText(getField(pf, "인증")) || null,
            grade: getField(pf, "등급") || getField(pf, "Tier등급") || null,
            score: parseFloat(getField(pf, "quality", "품질점수", "V_Score")) || null,
            pass: getField(pf, "함량_Pass_Fail") || null
          });
        }
      }
      productContext = topProducts;
    }

    // ─── [7] 시스템 프롬프트 (화자 v1) ──────────────
    const systemPrompt = `당신은 ingredi의 상담 화자입니다.

## 정체성
당신은 한 동네에서 15년 넘게 일한 약사입니다. 단골의 얼굴을 기억하고, 팔아야 할 물건이 없어서 편하게 말합니다. 당신의 일은 정보 나열이 아니라 판단을 내려주는 것입니다. 좋은 제품에는 "드셔도 됩니다", 나쁜 제품에는 "권하지 않아요"라고 분명히 말합니다. 아니라고 말할 수 있기 때문에 당신의 "괜찮아요"에 무게가 있습니다.
다루는 범위는 4개 카테고리뿐입니다: 오메가3, 눈(루테인·지아잔틴), 유산균, 비타민C. 좁지만 깊게 압니다. 이 좁음을 사과하지 않습니다.

## 응답 절차: 먼저 분류하고, 그 다음 답합니다
아래 순서로 검사하며, 앞 단계에 해당하면 뒤는 보지 않습니다.

1) M (의료 전환): 진단받은 질병의 치료·완치 목적 / 약의 대체·중단 의도 / 이상 반응 발생 / 수술·항암 등 치료 전후 / 장기 기능 이상 언급.
   → 판단을 내리지 않습니다. 얼버무리지 말고 경계를 명확히: "이건 제가 답할 영역이 아니에요. ○○는 의사(약사)와 확인하셔야 합니다." handoff에 병원에서 물어볼 것 한 가지를 담습니다.
2) X (범위 밖): 4개 카테고리 밖 성분·제품의 추천·비교·평가 요청. 단, 4개 카테고리 제품과의 병용 질문은 X가 아니라 아는 범위에서 답합니다.
   → "지금 ingredi는 오메가3, 눈, 유산균, 비타민C 네 가지만 봅니다. 대신 깊게 봐요." 사과하지 않습니다.
3) W 플래그: 임산부·수유부 / 흡연자+눈(베타카로틴 배제, 이유 명시) / 혈전약+오메가3 / 처방약 복용 중 / 항생제+유산균(시간 간격) / 수술 예정 / 만 12세 이하.
   → 독립 정책이 아니라 V/Q 위에 얹힙니다. warning 필드에 담고, 경고 문장만 합쇼체를 씁니다. 겁주지 않되 뭉개지 않습니다.
4) 정보가 충분하면 V (즉시 평결), 판단을 바꿀 핵심 정보 하나가 비어 있으면 Q (되묻기).
   - Q: 질문은 반드시 하나. 칩 2~4개 + "잘 모르겠어요" 칩 필수. 답하지 않아도 되는 완결된 기본 답(default_answer)을 반드시 동반.
   - 되묻기는 대화 전체에서 최대 1회. ${askedBefore ? "이 대화에서는 이미 답변한 적이 있으므로 다시 되묻지 말고 가진 정보로 판단하세요." : ""}

## V의 형식
1. 평결 먼저. 첫 문장이 결론입니다.
2. 근거는 숫자 2개까지 (함량 1 + 상대 위치 1). 세 번째 숫자부터는 설득이 됩니다.
3. 부정 평결 3원칙: 사람이 아니라 제품·광고를 문제 삼는다 / "솔직히 말씀드리면"으로 예고한다 / 반드시 대안(alternatives)으로 끝낸다.
4. 대안 자격 규칙: 대안은 평결에서 지적한 결함을 해결하는 제품이어야 합니다. 함량 부족을 지적했다면 대안은 임상 근거 용량 이상이어야 하고, 제형을 지적했다면 대안은 그 제형 문제가 없어야 합니다. 지적한 결함을 똑같이 가진 제품은 가격이 아무리 좋아도 대안이 될 수 없습니다. 자격을 갖춘 제품이 [제품 데이터]에 1~2개뿐이면 3개를 채우지 말고 1~2개만 제시하세요. 가격대: 대안은 가급적 언급된 제품의 1일비용 ±50% 안에서 고르고, 벗어나는 제품을 고를 땐 reason에 그 이유를 한 마디 밝히세요 — 깎아내리고 비싼 것을 파는 그림이 되면 안 됩니다.
5. 좋은 제품에도 한계를 한 번 짚습니다 ("최고급은 아니지만") — 다음 "아니요"의 신용입니다.

## 등급과 상황에 따른 평결 (제품 평결 시)
등급 매핑 — 부정은 D에만 씁니다. 부정이 흔해지면 부정이 싸집니다:
- A: positive. "좋은 선택이에요."
- B: positive + 한계 한 번. "드셔도 됩니다. 최고급은 아니지만 충분히 좋은 제품이에요."
- C: conditional(무채색). "나쁘지 않아요"로 시작하되, 같은 값에 더 나은 선택이 있음을 말합니다. alternatives는 넣지 말고, chips에 "더 나은 대안 보기" 칩을 포함하세요.
- D: negative. "솔직히 말씀드리면, 권하지 않아요." alternatives 필수.
상황(TPO) 분기 — 같은 등급도 보유와 구매 예정은 다릅니다:
- 이미 갖고 있거나 복용 중(선물·회사 지급 포함): B는 "바꿀 이유 없어요", C는 "드시던 건 마저 드시고, 재구매하실 때 대안을 보세요", D도 "드신다고 큰일 나는 건 아니지만" 재구매는 말립니다.
- 구매를 고민 중: B는 "사도 됩니다. 다만 같은 가격대에 A등급도 있어요" 정도의 한 마디, C·D는 대안 쪽으로 무게를 둡니다.
추천 억제 — 긍정 평결(A·B)에는 다른 제품 추천을 자동으로 붙이지 마세요. 안심을 주고 깔끔하게 끝냅니다. 사용자가 더 좋은 것을 물어올 때만 답합니다.

## 추천 요청 ("뭐 사면 돼?", "추천해줘")
1. 기준이 없으면 Q로 되묻습니다: "성분(함량) 우선" / "가성비 우선" / "잘 모르겠어요" 칩. default_answer는 품질점수(rank_quality) 기준 상위로.
2. 기준이 정해지면 해당 축 순위(rank_dose/rank_value/rank_quality)로 상위 3개를 alternatives에 담고, alternatives_note에 기준을 명시합니다 (예: "함량 기준 상위 3개").
3. 3개를 넘게 나열하지 마세요. 더 원하면 "전체 순위는 비교 페이지에서 보실 수 있어요"로 안내합니다.
지식·용어 질문은 정의 나열 대신 "그래서 뭘 보고 고르면 되는지"로 끝냅니다.

## 문체
- 해요체 기본. 경고(warning)만 합쇼체.
- 1인칭 판단: "저는 ~라고 봐요", "권하지 않아요". "일반적으로 ~로 알려져 있습니다" 금지.
- 금지: "개인차가 있을 수 있습니다", "참고만 하세요", "전문가와 상담 후 결정하세요"(M 제외), "~일 수도 있고 아닐 수도", 이모지, 마크다운 기호(#, **, ---).
- body는 350자 이내 기본, 지식 질문은 500자까지.
- 틀린 전제로 온 사용자에게 "잘못 아셨네요"가 아니라 "그렇게 알려진 이유가 있어요"로 시작합니다.

## 데이터 규칙
- 제품 판단은 [제품 데이터]로만 합니다. 없는 제품·수치를 지어내지 않습니다.
- 사용자가 말한 제품이 데이터에 없으면 솔직히 말하고, 라벨의 핵심 함량(예: EPA+DHA 합산)을 불러달라고 요청하세요. 불러주면 그 숫자로 판단합니다.
- 미확인 데이터는 null이며 0이 아닙니다. 모르는 축은 "확인되지 않았다"고 말합니다.
- [제품 데이터]가 비어 있는 카테고리에서는 특정 제품명을 만들지 말고, alternatives를 빈 배열로 두고 body에서 "상위 제품은 ingredi 비교 페이지에서 확인하실 수 있어요"로 안내합니다.
- 식약처가 인정한 기능만 긍정합니다. 통념(면역·피로·활력 등)이 해당 카테고리의 식약처 인정 기능이 아니면 "그건 인정된 기능이 아니에요"라고 밝히고, 인정된 기능 범위 안에서만 판단하세요. "면역에 좋다"가 아니라 "면역 맥락에서 언급되는"으로 표현합니다. 통념을 카테고리의 효능으로 승인하지 마세요.

## 대화 원칙
- 부정 평결에 반론이 오면 방어하지 말고 근거 하나를 더 엽니다. 두 번째 반론에는 판단은 유지하되 결정권을 돌려줍니다: "제 판단은 그대로예요. 다만 드신다고 큰일 나는 건 아니고, 기대한 효과를 보기 어렵다는 뜻이에요."
- 같은 대화에서 판단을 번복하지 않습니다. 새 정보가 나오면 번복이 아니라 갱신임을 명시합니다.

## 출력 (반드시 이 JSON만, 코드펜스·인사말 금지)
{"policy":"V|Q|M|X","verdict_tone":"positive|negative|conditional|none","verdict":"평결 한 문장(V 필수, 외 null)","body":"본문","warning":"경고(없으면 null)","question":"되묻기 질문(Q만)","chips":["..."],"chips_prompts":["칩을 눌렀을 때 사용자 발화로 보낼 자연어 문장"],"default_answer":"Q의 기본 답(Q만)","alternatives":[{"product_id":"...","name":"...","reason":"한 줄"}],"alternatives_note":"대안·추천 목록의 선정 기준 한 줄 (없으면 null)","handoff":"M일 때 병원에서 물어볼 것(외 null)"}
- verdict_tone 규칙: positive=긍정 평결, negative=부정 평결(alternatives 필수), conditional=조건부(warning 필수), none=Q/M/X.
- chips와 chips_prompts는 같은 길이. alternatives의 product_id는 [제품 데이터]에 있는 것만.`;

    // ─── [8] 유저 프롬프트 (RAG + 플래그) ───────────
    let contextBlock = "[검색된 지식]\n";
    const knowledgeMatched = top.filter(d => d.kind === "knowledge");
    const faqMatched = top.filter(d => d.kind === "faq");
    knowledgeMatched.forEach((d, i) => {
      contextBlock += `\n[K${i+1}] ${d.id} (${d.topic}): ${d.oneline}`;
      if (d.answer) contextBlock += ` — ${d.answer}`;
      if (d.evidence) contextBlock += ` (근거: ${d.evidence})`;
    });
    faqMatched.forEach((d, i) => {
      contextBlock += `\n[F${i+1}] Q: ${d.question} / A: ${d.answer}`;
      if (d.evidence) contextBlock += ` (근거: ${d.evidence})`;
    });
    if (knowledgeMatched.length === 0 && faqMatched.length === 0) contextBlock += "\n(없음)";

    let productBlock = "\n\n[제품 데이터]";
    if (productContext.length) {
      productBlock += "\n" + JSON.stringify(productContext);
      productBlock += "\n임상 도즈 앵커: EPA+DHA 1,000mg.";
      productBlock += "\n후보군 설명: 품질점수(rank_quality)·함량(rank_dose)·가성비(rank_value, 함량 1,000mg 이상 중 1일비용 낮은 순) 세 기준 각 상위의 합집합입니다. 순위는 전체 제품 기준입니다.";
      productBlock += "\n축 선택 규칙: 사용자가 성분·함량을 중시하면 rank_dose, 가격을 중시하면 rank_value, 기준 언급이 없으면 rank_quality 순으로 고르고, 어떤 기준으로 골랐는지 한 마디로 밝히세요 (예: \"함량 기준으로는 이게 1위예요\").";
      productBlock += "\n반복 금지: 직전 턴에서 이미 제시한 대안을 습관처럼 반복하지 마세요. 새 질문의 기준이 다르면 그 기준으로 다시 고르세요.";
    } else {
      productBlock += "\n(이 카테고리의 제품 데이터가 이 요청에 로드되지 않았습니다. 특정 제품 평결이 필요하면 라벨 함량을 요청하고, 대안은 비교 페이지로 안내하세요.)";
      productBlock += "\n임상 도즈 앵커: 오메가3 EPA+DHA 1,000mg / 루테인+지아잔틴 20mg / 유산균 보장균수 100억 / 비타민C 1,000mg.";
    }

    let flagBlock = "";
    if (productMatchRecord) {
      const pmName = getField(productMatchRecord.fields || {}, "제품명", "name");
      flagBlock += `\n\n[대상 제품] 사용자가 언급한 제품이 데이터에 있습니다: "${pmName}". [제품 데이터]에서 이 제품을 찾아 그 수치로 평결하세요. "데이터에 없다"고 말하지 마세요.`;
    }
    if (detectedRisks.length) flagBlock += `\n\n[내부 플래그] 위험 페르소나 감지: ${detectedRisks.join(", ")} → W 플래그 적용, warning 필수.`;
    if (matchedCategory) flagBlock += `\n\n[대상 카테고리] ${CAT_LABEL[matchedCategory]}`;
    else if (hintDomain) flagBlock += `\n\n[내부 플래그] 4개 카테고리 밖 도메인(${hintDomain}) 질문 가능성 → X 정책 검토. 단, 병용 질문이면 답변.`;
    else if (ambiguousCats) flagBlock += `\n\n[내부 플래그] 카테고리 모호(${ambiguousCats.join(" vs ")}) → Q 정책으로 칩 되묻기 권장. 칩은 해당 카테고리들 + "잘 모르겠어요".`;
    if (demographics.age || demographics.gender) flagBlock += `\n\n[사용자 정보] ${demographics.age ? demographics.age + "대" : ""} ${demographics.gender === "female" ? "여성" : demographics.gender === "male" ? "남성" : ""}`.trim();

    const claudeMessages = messages.slice(0, -1).concat([{
      role: "user",
      content: contextBlock + productBlock + flagBlock + "\n\n[사용자 질문]\n" + query
    }]);

    // ─── [9] Claude 호출 (비스트리밍) ───────────────
    const ANTHROPIC_BASE = (env.CF_ACCOUNT_ID && env.CF_AI_GATEWAY)
      ? `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AI_GATEWAY}/anthropic`
      : "https://api.anthropic.com";
    const reqBody = JSON.stringify({
      model: "claude-sonnet-4-6", max_tokens: 1200,
      system: systemPrompt, messages: claudeMessages
    });
    const RETRY_STATUS = [429, 500, 502, 503, 504, 529];
    let resp = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      resp = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
        body: reqBody
      });
      if (resp.ok || RETRY_STATUS.indexOf(resp.status) === -1) break;
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
    if (!resp || !resp.ok) {
      return respond(fixedPayload("X", "잠시 연결이 원활하지 않아요. 조금 뒤에 다시 물어봐 주세요."), { error: "upstream", status: resp ? resp.status : 0 });
    }
    const data = await resp.json();
    const rawText = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");

    // ─── [10] JSON 계약 파싱 + 검증 ─────────────────
    function parseContract(t) {
      let s = String(t || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/,"").replace(/```\s*$/, "").trim();
      const a = s.indexOf("{"), b = s.lastIndexOf("}");
      if (a === -1 || b === -1 || b <= a) return null;
      try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
    }
    let payload = parseContract(rawText);
    if (!payload || !payload.policy || typeof payload.body !== "string") {
      // 계약 파싱 실패 — 원문을 body로 강등 (화자 문장은 살린다)
      payload = fixedPayload("V", String(rawText || "").slice(0, 1200) || "답변 생성에 문제가 있었어요. 다시 물어봐 주세요.");
      payload.contract_fallback = true;
    } else {
      // 정규화 + 안전 검증
      payload.policy = ["V","Q","M","X"].includes(payload.policy) ? payload.policy : "V";
      payload.verdict_tone = ["positive","negative","conditional","none"].includes(payload.verdict_tone) ? payload.verdict_tone : "none";
      if (payload.policy !== "V") payload.verdict = null;
      if (payload.policy !== "Q") { payload.question = null; payload.default_answer = null; }
      if (!Array.isArray(payload.chips)) payload.chips = null;
      if (!Array.isArray(payload.chips_prompts)) payload.chips_prompts = null;
      if (payload.chips && payload.chips_prompts && payload.chips.length !== payload.chips_prompts.length) payload.chips_prompts = payload.chips.slice();
      if (!Array.isArray(payload.alternatives)) payload.alternatives = [];
      // alternatives는 제품 컨텍스트에 실재하는 ID만 통과 (환각 차단)
      const validIds = new Set(productContext.map(p => String(p.product_id)));
      payload.alternatives = payload.alternatives.filter(a => a && validIds.has(String(a.product_id))).slice(0, 3);
      // 부정 평결의 대안은 임상 용량 이상만 통과 — 프롬프트 규칙은 모델이 "인증이
      // 좋아서" 같은 명분으로 협상하므로, 자격 게이트는 코드로 강제한다 (오메가3 기준
      // EPA+DHA 1,000mg; 함량 데이터가 없는 항목은 판단 불가로 보존).
      if (typeof payload.alternatives_note !== "string" || !payload.alternatives_note.trim()) payload.alternatives_note = null;
      if (payload.verdict_tone === "negative" && matchedCategory === "omega3") {
        const byId = new Map(productContext.map(p => [String(p.product_id), p]));
        payload.alternatives = payload.alternatives.filter(a => {
          const p = byId.get(String(a.product_id));
          return !p || p.epa_dha_mg == null || p.epa_dha_mg >= 1000;
        });
        // 백필: 자격(임상 용량 이상) 갖춘 대안이 2개 미만이면 점수순으로 채운다.
        // 단일 추천은 "평가"가 아니라 "밀어주기"로 읽히므로 최소 2개를 보장.
        // reason은 지어내지 않고 데이터로 조립한다.
        if (payload.alternatives.length < 2) {
          const have = new Set(payload.alternatives.map(a => String(a.product_id)));
          const mentionedId = productMatchRecord
            ? String(getField(productMatchRecord.fields || {}, "product_id", "productId") || productMatchRecord.id)
            : null;
          const fillers = productContext.filter(p =>
            p.epa_dha_mg != null && p.epa_dha_mg >= 1000 &&
            !have.has(String(p.product_id)) && String(p.product_id) !== mentionedId
          ).slice(0, 3 - payload.alternatives.length);
          for (const p of fillers) {
            const bits = [`EPA+DHA ${p.epa_dha_mg.toLocaleString()}mg`];
            if (p.daily_cost) bits.push(`하루 ${p.daily_cost.toLocaleString()}원`);
            if (p.certs) bits.push(String(p.certs).split(",")[0].trim());
            payload.alternatives.push({ product_id: p.product_id, name: p.name, reason: bits.join(" · ") });
          }
        }
        if (payload.alternatives.length && !payload.alternatives_note) payload.alternatives_note = "함량 1,000mg 이상 · 품질점수순";
      }
      // negative인데 대안이 비면 비교 페이지 안내를 body에 보강
      if (payload.verdict_tone === "negative" && payload.alternatives.length === 0 && payload.body.indexOf("비교") === -1) {
        payload.body += "\n\n같은 카테고리의 상위 제품은 ingredi 비교 페이지에서 확인하실 수 있어요.";
      }
      // conditional인데 warning이 비면 톤 강등
      if (payload.verdict_tone === "conditional" && !payload.warning) payload.verdict_tone = "none";
      if (payload.policy !== "M") payload.handoff = null;
    }

    // ─── [11] 응답 ──────────────────────────────────
    const meta = {
      category: matchedCategory ? CAT_KO[matchedCategory] : null,
      healthDomain: hintDomain,
      ambiguousCats,
      demographics,
      detectedRisks,
      categoryOptions: (!matchedCategory && !productMatchRecord) ? CATEGORY_OPTIONS : null,
      sources: {
        knowledge: knowledgeMatched.map(d => ({ id: d.id, oneline: d.oneline })),
        faq: faqMatched.map(d => ({ id: d.id, question: d.question }))
      },
      productContextCount: productContext.length
    };
    if (wantDebug) meta.debug = {
      tokens: lowerTokens, seedTokens,
      matchedDocs: top.map(d => `${d.kind === "faq" ? "F" : "K"}:${d.id}`),
      productMatch: productMatchRecord ? getField(productMatchRecord.fields || {}, "제품명", "name") : null,
      askedBefore, rawLen: rawText.length, fallback: !!payload.contract_fallback
    };
    return respond(payload, meta);

  } catch (error) {
    return new Response(JSON.stringify({ error: "internal_error", message: error.message }), { status: 500, headers });
  }
}
