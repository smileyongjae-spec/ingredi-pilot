// functions/counsel-api.js  (v7 — 단일 FAQ 테이블 + 검색 우선 라우팅)
//
// 변경 요약
//   - FAQ_오메가3/비타민C/눈/마이크로바이옴 4개 테이블 → FAQ_전체상품 1개로 통합
//   - 게이트 → 검색 순서를 뒤집음: 카테고리 키워드가 없으면 전 행을 검색해 데이터가 카테고리를 말하게 함
//   - 제품카테고리 / 건강도메인 컬럼으로 스코프와 응답 모드를 결정
//   - 응답 모드: counsel(제품 추천 O) / advisory(정보만) / guide(페르소나) / product / ingredient / category_select
//   - 미서비스 성분·효능도 답변하되 제품 추천은 하지 않고, 말미에 4개 카테고리를 안내
//   - ?debug=1 로 매칭된 행 ID 확인 가능

import { getRecords } from "./_lib/airtable.js";

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8" };
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
  }

  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const wantDebug = url.searchParams.get("debug") === "1";
  if (!query) return new Response(JSON.stringify({ error: "missing_query" }), { status: 400, headers });

  const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return new Response(JSON.stringify({ error: "missing_api_key" }), { status: 500, headers });

  const lowerQuery = query.toLowerCase();

  // ─── 상수 ────────────────────────────────────────
  const FAQ_TABLE = "FAQ_전체상품";
  const KNOW_TABLE = "knowledge";

  const CATEGORY_KEYWORDS = {
    omega3:     ["오메가", "omega", "epa", "dha", "ala", "dpa", "rtg", "알티지", "어유", "fish oil", "크릴", "어류"],
    vitaminC:   ["비타민c", "비타민 c", "비타민씨", "vitamin c", "아스코르브산", "ascorbic", "메가도스", "리포좀"],
    eye:        ["루테인", "지아잔틴", "아스타잔틴", "황반", "시력", "안구", "눈건강", "lutein", "zeaxanthin", "마리골드"],
    probiotics: ["프로바이오틱스", "프리바이오틱스", "신바이오틱스", "포스트바이오틱스", "유산균", "윤산균", "장건강", "probiotics", "마이크로바이옴", "유익균", "비피더스", "락토바실러스", "비피도박테리움", "보장균수", "cfu"]
  };
  const CAT_KO    = { omega3: "오메가3", vitaminC: "비타민C", eye: "눈", probiotics: "유산균" };
  const KO_CAT    = { "오메가3": "omega3", "비타민C": "vitaminC", "눈": "eye", "유산균": "probiotics" };
  const CAT_LABEL = { omega3: "오메가3", vitaminC: "비타민C", eye: "눈 건강(루테인)", probiotics: "유산균" };
  const FOUR_CATS = "오메가3, 눈 건강(루테인), 유산균, 비타민C";

  // 증상·효능 표현 → 서비스 카테고리 (조사가 붙어도 잡히도록 정규식)
  const PRODUCT_HINTS = [
    { cat: "probiotics", re: /장\s*(이|은|을|내|건강|기능|트러블|활동|운동)|배변|변비|설사|화장실|대변|묽은변|배\s*(가|를|에).{0,5}(아프|아파|불편|더부룩)/ },
    { cat: "eye",        re: /눈\s*(이|은|을|의|건강|영양제|피로|시림)|시력|황반|안구|침침|뻑뻑/ },
    { cat: "omega3",     re: /혈행|중성지방|콜레스테롤|혈중지질|심혈관/ },
    { cat: "vitaminC",   re: /항산화|괴혈병/ }
  ];
  // 미서비스 건강도메인 힌트
  const DOMAIN_HINTS = [
    { dom: "수면",       re: /수면|불면|잠\s*(이|을|못|안|설치)|숙면|멜라토닌|테아닌/ },
    { dom: "관절",       re: /관절|무릎|연골|글루코사민|보스웰리아/ },
    { dom: "간",         re: /간\s*(이|은|을|에|수치|건강|기능)|숙취|밀크시슬|밀크씨슬|실리마린|음주|술\s*(을|자주|많이|마시)|알코올/ },
    { dom: "피부",       re: /피부|여드름|뾰루지|주름|콜라겐|미백|기미/ },
    { dom: "다이어트",   re: /다이어트|체중|체지방|살\s*(을|이|빼)|가르시니아/ },
    { dom: "뼈",         re: /뼈|골다공증|골밀도|칼슘/ },
    { dom: "혈압",       re: /혈압/ },
    { dom: "인지",       re: /기억력|인지|집중력|치매|두뇌/ },
    { dom: "커큐민",     re: /커큐민|강황|울금/ },
    { dom: "글루타치온", re: /글루타치온|글루타티온/ },
    { dom: "면역",       re: /면역/ }
  ];

  // 카테고리가 특정되지 않은 일반 요청 → 페르소나 가이드로
  const GENERIC_TERMS = ["영양제", "건강기능식품", "건기식", "보충제", "서플리먼트", "supplement", "뭐 먹", "무엇을 먹", "뭘 먹", "뭐가 좋", "뭐 사"];
  // 사람을 가리키는 말이 있으면 페르소나 가이드로 확정
  const PERSONA_WORDS = /남성|여성|남자|여자|아이|어린이|청소년|학생|부모님|시니어|노인|엄마|아빠|아내|남편|임산부|직장인|수험생|갱년기|출산|산후|운동|헬스|\d+\s*(대|살|세)|(이|삼|사|오|육)십\s*대/;
  const MIN_ROUTE_SCORE = 5.0;   // 이보다 낮으면 우연 매칭으로 본다

  // 건기식으로 답할 사안이 아닌 질환·치료 영역. 검색하지 않고 의료 상담으로 안내한다.
  const MEDICAL_REFERRAL = /우울증|우울|불안장애|공황|조현병|자살|암\s*(치료|환자)?|항암|당뇨병|갑상선|백신|코로나|독감|고열|응급|골절|임신중절|생리통|월경|처방|약\s*(을|좀)?\s*(먹|드시|복용)/;

  const CROSS_DOMAINS = new Set(["페르소나", "카페질문"]);
  const DOMAIN_LABEL = {
    "면역": "면역", "인지": "인지·기억력", "뼈": "뼈 건강", "수면": "수면", "피부": "피부 건강",
    "다이어트": "체중 관리", "관절": "관절 건강", "간": "간 건강", "혈압": "혈압 관리",
    "커큐민": "커큐민", "글루타치온": "글루타치온"
  };
  const CATEGORY_OPTIONS = [
    { key: "오메가3", label: "오메가3",  desc: "혈행·뇌·눈 건강" },
    { key: "눈",     label: "눈 건강",  desc: "루테인·지아잔틴" },
    { key: "유산균",  label: "유산균",   desc: "장 건강·면역" },
    { key: "비타민C", label: "비타민C",  desc: "항산화·면역" }
  ];

  const DISCLAIMER = "본 정보는 의료 자문이 아니며, 개별 건강 상태에 따라 다를 수 있습니다. 복용 전 의사·약사와 상담하세요.";

  // ─── HELPERS ─────────────────────────────────────
  function normalizeKey(s) { return String(s).replace(/[\s_\-\(\)\[\]]/g, "").toLowerCase(); }
  function getField(fields, ...candidates) {
    for (const c of candidates) if (fields[c] !== undefined && fields[c] !== null && fields[c] !== "") return fields[c];
    const norm = {};
    for (const k in fields) norm[normalizeKey(k)] = fields[k];
    for (const c of candidates) { const v = norm[normalizeKey(c)]; if (v !== undefined && v !== null && v !== "") return v; }
    return "";
  }
  function asText(v) { return Array.isArray(v) ? v.join(" ") : String(v || ""); }
  function normEntity(s) { return String(s || "").replace(/[\s\-_\u00B7]/g, "").toLowerCase(); }

  // ─── 나이·성별 ───────────────────────────────────
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
  function demoLabel(d) {
    const a = d.age ? (d.age === "60" ? "60대 이상" : d.age + "대") : "";
    const g = d.gender === "female" ? "여성" : d.gender === "male" ? "남성" : "";
    return [a, g].filter(Boolean).join(" ");
  }
  function toPriority(pid) {
    if (pid === "premium_seeker") return "premium";
    if (pid === "budget_seeker") return "budget";
    return "balanced";
  }

  // ─── 오메가3 추천 프로필 ─────────────────────────
  const PROFILES = {
    balanced:       { label: "균형",     weights: { dose: 0.25, form: 0.25, source: 0.20, cert: 0.15, price: 0.15 }, filters: {} },
    premium_seeker: { label: "고품질",   weights: { dose: 0.20, form: 0.30, source: 0.25, cert: 0.20, price: 0.05 }, filters: {} },
    budget_seeker:  { label: "가성비",   weights: { dose: 0.25, form: 0.15, source: 0.10, cert: 0.10, price: 0.40 }, filters: {} },
    pregnancy:      { label: "임산부",   weights: { dose: 0.20, form: 0.25, source: 0.25, cert: 0.25, price: 0.05 }, filters: {} },
    senior:         { label: "시니어",   weights: { dose: 0.30, form: 0.25, source: 0.20, cert: 0.15, price: 0.10 }, filters: { minDailyDose: 1000 } }
  };
  function matchProfileLocal(q) {
    const s = String(q || "");
    if (/임신|임산부|수유/.test(s)) return "pregnancy";
    if (/시니어|노인|고령|60대|70대|80대/.test(s)) return "senior";
    if (/최고|프리미엄|고품질|좋은\s*거|비싸도/.test(s)) return "premium_seeker";
    if (/저렴|싼|가성비|가격|예산/.test(s)) return "budget_seeker";
    return "balanced";
  }
  function scoreDose(d) { if (!d || d <= 0) return 20; if (d >= 1500) return 100; if (d >= 1000) return 80; if (d >= 600) return 60; if (d >= 500) return 40; return 20; }

  // ─── 성분/제품명 감지 (오메가3) ──────────────────
  const INGREDIENTS = [
    { key: "epa", label: "EPA" }, { key: "dha", label: "DHA" },
    { key: "rtg", label: "rTG", form: "rtg" }, { key: "알티지", label: "rTG", form: "rtg" },
    { key: "tg", label: "TG", form: "tg" }, { key: "ee", label: "EE", form: "ee" }
  ];
  function detectIngredient(q) {
    const n = normEntity(q);
    if (n.length > 12) return null;
    for (const ing of INGREDIENTS) if (n === normEntity(ing.key)) return ing;
    return null;
  }
  // 제품명 매칭: 통짜 부분일치 → 실패 시 모든 토큰이 제품명에 포함되는지
  // ("GNM 조정석 오메가3" 는 실제 제품명 중간에 'rTG 알티지'가 끼어 통짜로는 안 걸린다)
  function detectProductName(q, records) {
    const qn = normEntity(q);
    if (qn.length < 3) return null;
    const parts = String(q).split(/\s+/).map(normEntity).filter(t => t.length >= 3);
    for (const r of records || []) {
      const nm = normEntity(getField(r.fields || {}, "제품명", "name"));
      if (nm && nm.indexOf(qn) !== -1) return r;
    }
    if (parts.length >= 2) {
      for (const r of records || []) {
        const nm = normEntity(getField(r.fields || {}, "제품명", "name"));
        if (nm && parts.every(p => nm.indexOf(p) !== -1)) return r;
      }
    }
    return null;
  }

  try {
    const demographics = parseDemographics(query);

    // ─── [1] 토큰 정제 ─────────────────────────────
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

    // ─── [2] 라우팅: 제품명 → 카테고리 → 증상 힌트 → 일반 요청 ──
    let matchedCategory = null;
    let hintDomain = null;
    let isGeneric = false;

    // 질문에서 카테고리 키워드를 뺀 나머지(브랜드명)가 3자 이상일 때만 제품명으로 본다.
    // "오메가3" → 나머지 "" → 제품명 아님 / "프롬바이오 rTG 오메가3" → "프롬바이오" → 제품명
    function brandRemainder(q) {
      let t = normEntity(q);
      for (const cat in CATEGORY_KEYWORDS) for (const k of CATEGORY_KEYWORDS[cat]) t = t.split(normEntity(k)).join("");
      return t.replace(/[0-9]/g, "");
    }
    const remainder = brandRemainder(query);

    // ─── [3] 테이블 로드 ───────────────────────────
    async function safeGet(t) { try { return await getRecords(env, t); } catch (_) { return []; } }
    const needOmegaProducts = !matchedCategory || matchedCategory === "omega3";
    const [kRecords, fRecords, pRecords] = await Promise.all([
      safeGet(KNOW_TABLE),
      safeGet(FAQ_TABLE),
      needOmegaProducts ? safeGet("오메가3_쿠팡업데이트") : Promise.resolve([])
    ]);

    // ─── [3-b] 라우팅 확정 (제품 DB가 로드된 뒤) ────
    let productMatchRecord = null;
    if (remainder.length >= 3) {
      const cand = detectProductName(query, pRecords || []);
      if (cand) {
        const qn = normEntity(query);
        const nn = normEntity(getField(cand.fields || {}, "제품명", "name"));
        if (qn.length >= 4 && nn.indexOf(qn) !== -1) { productMatchRecord = cand; matchedCategory = "omega3"; }
      }
    }
    if (!productMatchRecord) {
      for (const cat in CATEGORY_KEYWORDS) {
        if (CATEGORY_KEYWORDS[cat].some(k => lowerQuery.indexOf(k) !== -1)) { matchedCategory = cat; break; }
      }
      if (!matchedCategory) for (const h of PRODUCT_HINTS) if (h.re.test(query)) { matchedCategory = h.cat; break; }
      if (!matchedCategory) for (const h of DOMAIN_HINTS) if (h.re.test(query)) { hintDomain = h.dom; break; }
      if (!matchedCategory && !hintDomain) {
        const hasGeneric = GENERIC_TERMS.some(t => lowerQuery.indexOf(t) !== -1);
        // 사람이 주어면 페르소나 가이드로 확정, 아니면 검색 투표에 맡긴다
        isGeneric = hasGeneric && PERSONA_WORDS.test(query);
        if (hasGeneric) isGeneric = true;   // 주제어가 없으므로 성분 가이드로
      }
    }
    // 질환·치료 질문이되 우리 카테고리와 무관할 때만 의료 상담으로 회부한다.
    // ("항암치료 중인데 오메가3" 는 오메가3 답변 + 위험 경고가 맞다)
    const needsDoctor = !productMatchRecord && !matchedCategory && !hintDomain && MEDICAL_REFERRAL.test(query);

    // ─── [4] 문서 정규화 ───────────────────────────
    function docFromFaq(r) {
      const f = r.fields || {};
      const kw = asText(getField(f, "keywords"));
      const q  = asText(getField(f, "question"));
      const a  = asText(getField(f, "answer"));
      return {
        kind: "faq",
        id: getField(f, "faq_id") || r.id,
        question: q, answer: a,
        evidence: asText(getField(f, "임상근거")),
        prodCat: asText(getField(f, "제품카테고리")).trim(),
        domain:  asText(getField(f, "건강도메인")).trim(),
        review:  asText(getField(f, "검수상태")).trim(),
        hayKw: (kw + " " + asText(getField(f, "소분류"))).toLowerCase(),
        hayQ: q.toLowerCase(),
        hayA: a.toLowerCase()
      };
    }
    function docFromKnow(r) {
      const f = r.fields || {};
      const kw = asText(getField(f, "키워드")) + " " + asText(getField(f, "관련성분키워드"));
      const one = asText(getField(f, "한줄정의"));
      const a = asText(getField(f, "답변예시"));
      return {
        kind: "knowledge",
        id: getField(f, "지식ID") || r.id,
        topic: asText(getField(f, "카테고리")),
        oneline: one, answer: a,
        evidence: asText(getField(f, "임상근거")),
        prodCat: asText(getField(f, "제품카테고리")).trim(),
        domain:  asText(getField(f, "건강도메인")).trim(),
        hayKw: kw.toLowerCase(),
        hayQ: one.toLowerCase(),
        hayA: a.toLowerCase()
      };
    }
    // 분류 컬럼이 비어 있는 행은 검색에서 제외 (조용한 오염 방지)
    const skipped = { faq: 0, knowledge: 0 };
    const faqDocs = (fRecords || []).map(docFromFaq).filter(d => { if (!d.prodCat || !d.domain) { skipped.faq++; return false; } return true; });
    const knowDocs = (kRecords || []).map(docFromKnow).filter(d => { if (!d.prodCat || !d.domain) { skipped.knowledge++; return false; } return true; });
    const allDocs = faqDocs.concat(knowDocs);

    // ─── [5] 스코어링 (IDF 가중: 흔한 단어의 영향력 축소) ──
    const N = allDocs.length || 1;
    const IDF = {};
    for (const t of lowerTokens) {
      let df = 0;
      for (const d of allDocs) if (d.hayKw.indexOf(t) !== -1 || d.hayQ.indexOf(t) !== -1 || d.hayA.indexOf(t) !== -1) df++;
      IDF[t] = Math.log(1 + N / (1 + df));   // 전 행에 등장하면 ~0.7, 희귀하면 ~7
    }
    function scoreDoc(d) {
      let s = 0;
      for (const t of lowerTokens) {
        const w = IDF[t];
        if (w < 1.0) continue;                // 너무 흔한 단어(효과·있어 등)는 무시
        if (d.hayKw.indexOf(t) !== -1) s += 2.0 * w;
        if (d.hayQ.indexOf(t) !== -1) s += 1.5 * w;
        if (d.hayA.indexOf(t) !== -1) s += 1.0 * w;
      }
      if (s === 0) return 0;
      if (d.kind === "faq") s *= 1.3;
      // 페르소나는 보조 조언, 카페는 실제 사용자 문장이라 표현이 겹쳐 과대평가되기 쉬움
      if (d.domain === "페르소나") s *= 0.8;
      else if (d.domain === "카페질문") s *= 0.45;
      return s;
    }
    const isCross = d => CROSS_DOMAINS.has(d.domain);
    const inCategory = (d, catKo) => d.prodCat === catKo;

    let pool;
    if (matchedCategory) {
      const ko = CAT_KO[matchedCategory];
      pool = allDocs.filter(d => inCategory(d, ko) || isCross(d));
    } else if (hintDomain) {
      pool = allDocs.filter(d => d.domain === hintDomain || isCross(d));
    } else if (isGeneric) {
      pool = allDocs.filter(d => d.domain === "페르소나");
    } else {
      pool = allDocs;
    }
    let scored = pool.map(d => ({ d, s: scoreDoc(d) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);

    // ─── [6] 라우팅 (카테고리 미지정 시 검색 결과가 결정) ──
    let mode = "counsel";
    let advisoryDomain = null;
    let ambiguousCats = null;

    if (needsDoctor) {
      mode = "none";      // 질환·치료 질문 → 카드 + 의료 상담 안내
    } else if (productMatchRecord) {
      mode = "counsel";   // 아래 [8]에서 isProductMode로 제품 리스트 모드가 됨
    } else if (isGeneric) {
      mode = "guide";     // 근거가 안 잡혀도 페르소나 개요로 안내
    } else if (!matchedCategory && hintDomain) {
      mode = "advisory";          // 힌트가 곧 근거. 매칭이 얕으면 아래에서 도메인 문서로 채운다
      advisoryDomain = hintDomain;
    } else if (!matchedCategory) {
      const TOPN = scored.slice(0, 12);
      const served = {}, advisory = {};
      let personaSum = 0;
      for (const { d, s } of TOPN) {
        if (d.prodCat !== "해당없음") served[d.prodCat] = (served[d.prodCat] || 0) + s;
        else if (d.domain === "페르소나") personaSum += s;
        else if (d.domain === "카페질문") { /* 라우팅 근거로 쓰지 않음 */ }
        else if (d.domain !== "해당없음") advisory[d.domain] = (advisory[d.domain] || 0) + s;
      }
      const servedRank = Object.entries(served).sort((a, b) => b[1] - a[1]);
      const advRank = Object.entries(advisory).sort((a, b) => b[1] - a[1]);
      const bestServed = servedRank[0] ? servedRank[0][1] : 0;
      const bestAdv = advRank[0] ? advRank[0][1] : 0;

      if (bestServed < MIN_ROUTE_SCORE && bestAdv < MIN_ROUTE_SCORE && personaSum < MIN_ROUTE_SCORE) {
        mode = "none";   // 우연 매칭 — 근거로 보지 않는다
      } else if (bestServed > 0 && bestServed >= bestAdv) {
        // 서비스 카테고리 두 개가 근접하면 사용자에게 물어본다
        if (servedRank[1] && servedRank[1][1] >= servedRank[0][1] * 0.8) {
          ambiguousCats = [servedRank[0][0], servedRank[1][0]];
          mode = "category_select";
        } else {
          matchedCategory = KO_CAT[servedRank[0][0]] || null;
          mode = "counsel";
        }
      } else if (bestAdv > 0) {
        advisoryDomain = advRank[0][0];
        mode = "advisory";
      } else if (personaSum > 0) {
        mode = "guide";           // 페르소나 조언은 답변 가치가 있음
      } else {
        mode = "none";            // 카페 행만 걸린 건 우연 매칭 — 근거로 보지 않음
      }

      // 카테고리가 정해졌으면 그 스코프로 다시 좁힌다
      if (matchedCategory) {
        const ko = CAT_KO[matchedCategory];
        scored = scored.filter(x => inCategory(x.d, ko) || isCross(x.d));
      } else if (mode === "advisory") {
        scored = scored.filter(x => x.d.domain === advisoryDomain || isCross(x.d));
      } else if (mode === "guide") {
        scored = scored.filter(x => x.d.domain === "페르소나");
      }
    }
    if (mode === "guide") {
      scored = scored.filter(x => x.d.domain === "페르소나");
      if (scored.length === 0) {
        scored = allDocs.filter(d => d.domain === "페르소나").slice(0, 4).map(d => ({ d, s: 0.01 }));
      }
    }

    // ─── [7] 그래도 못 찾으면 카테고리 선택 카드 ────
    if (mode === "none" || mode === "category_select") {
      const who = demoLabel(demographics);
      const forWhom = who ? `${who}에게 맞는 제품을 추천해드릴게요.` : "바로 추천해드릴게요.";
      let answerText, reason;
      if (mode === "category_select" && ambiguousCats) {
        reason = "ambiguous";
        answerText = `말씀하신 내용은 ${ambiguousCats.join("과 ")} 모두와 관련이 있어요.\n\n어느 쪽이 궁금하신지 골라주시면 ${forWhom}`;
      } else if (needsDoctor) {
        reason = "medical";
        answerText = `말씀하신 내용은 진단과 치료가 필요한 영역이라 ingredi가 답변드리기 어려워요.\n\n먼저 의사·약사와 상담하시는 것을 권해드려요. 건강기능식품은 의약품을 대신할 수 없어요.\n\ningredi는 현재 ${FOUR_CATS} 4개 카테고리의 제품 정보를 다루고 있어요.`;
      } else {
        reason = "not_found";
        answerText = `죄송해요. 말씀하신 내용은 ingredi가 근거 데이터로 확인해 드리기 어려운 내용이에요.\n\n증상이 계속되면 의사·약사와 상담해보세요.\n\ningredi는 현재 ${FOUR_CATS} 4개 카테고리를 다루고 있어요. 아래에서 필요한 것을 골라주시면 ${forWhom}`;
      }
      return new Response(JSON.stringify({
        query, category: "needs_category", mode: "category_select",
        answer: answerText, categoryOptions: CATEGORY_OPTIONS,
        demographics, priority: toPriority(matchProfileLocal(query)),
        sources: { knowledge: [], faq: [] },
        flags: { needsCategory: true, reason, ambiguousCats, knowledgeCount: 0, faqCount: 0, skipped },
        recommendation: null, disclaimer: DISCLAIMER
      }), { status: 200, headers });
    }

    // ─── [8] 컨텍스트 상위 8건 ─────────────────────
    // 근거가 빈약하면 해당 카테고리의 핵심 지식(효능·개념·성분)으로 채운다.
    // 이게 없으면 Claude가 "검색된 정보에 관련 내용이 없다"고 답해버린다.
    // 힌트로 도메인이 확정됐는데 매칭이 얕으면 해당 도메인 문서로 채운다 ("골밀도 높이려면")
    if (!matchedCategory && advisoryDomain) {
      const own = scored.filter(x => x.d.domain === advisoryDomain);
      if (own.length < 3) {
        const have = new Set(scored.map(x => x.d.id));
        const filler = allDocs.filter(d => d.domain === advisoryDomain && !have.has(d.id))
          .slice(0, 3 - own.length).map(d => ({ d, s: 0.01 }));
        scored = scored.concat(filler);
        scored.sort((a, b) => {
          const ao = a.d.domain === advisoryDomain ? 1 : 0, bo = b.d.domain === advisoryDomain ? 1 : 0;
          return (bo - ao) || (b.s - a.s);
        });
      }
    }

    const ownCount = matchedCategory ? scored.filter(x => x.d.prodCat === CAT_KO[matchedCategory]).length : 0;
    if (matchedCategory && ownCount < 3) {
      const ko = CAT_KO[matchedCategory];
      const ORDER = { "효능": 0, "성분정의": 1, "개념": 1, "성분": 2, "섭취상한": 3, "제형특징": 4, "제품선택기준": 5 };
      const have = new Set(scored.map(x => x.d.id));
      const filler = allDocs
        .filter(d => d.prodCat === ko && !have.has(d.id))
        .sort((a, b) => ((ORDER[a.topic] ?? 9) - (ORDER[b.topic] ?? 9)))
        .slice(0, 3 - ownCount)
        .map(d => ({ d, s: 0.01 }));
      scored = scored.concat(filler);
      // 카테고리 전용 문서를 앞으로 (카페·페르소나가 컨텍스트를 덮지 않도록)
      const ko2 = CAT_KO[matchedCategory];
      scored.sort((a, b) => {
        const ao = a.d.prodCat === ko2 ? 1 : 0, bo = b.d.prodCat === ko2 ? 1 : 0;
        return (bo - ao) || (b.s - a.s);
      });
    }

    const top = scored.slice(0, 8).map(x => x.d);
    const knowledgeMatched = top.filter(d => d.kind === "knowledge");
    const faqMatched = top.filter(d => d.kind === "faq");

    const isOmega3 = matchedCategory === "omega3";
    const isProductMode = !!productMatchRecord;
    const ingredient = isOmega3 ? detectIngredient(query) : null;
    const canRecommend = mode === "counsel" && isOmega3;

    // ─── [9] 의료 위험 플래그 ──────────────────────
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
    for (const t in riskKeywords) for (const kw of riskKeywords[t]) { if (lowerQuery.indexOf(kw.toLowerCase()) !== -1) { detectedRisks.push(t); break; } }
    const requiresMedicalConsult = detectedRisks.length > 0;

    // ─── [10] Claude 프롬프트 ──────────────────────
    let answer = "", claudeReqBody = null;
    if (isProductMode) {
      const pname = getField(productMatchRecord.fields || {}, "제품명", "name") || query;
      answer = `찾으시는 제품이 이건가요?\n\n${pname}\n\n아래에서 성분·함량·1일 비용을 확인하실 수 있어요. ingredi는 광고 없이 공개된 제품 데이터로만 비교해드려요.`;
    } else {
      const systemPrompt = "당신은 ingredi의 건강기능식품 정보 카운슬러입니다.\n\n[핵심 원칙]\n1. 광고 없음 — 특정 제품·브랜드를 추천하지 않습니다\n2. 근거 기반 — 검색 결과의 사실만 답변합니다\n3. 엄격 모드 — 검색 결과에 없는 내용은 추측하지 않습니다\n\n[답변 스타일]\n- 한국어, 존댓말\n- 특정 제품명 언급 금지\n- 의학 자문 아님을 명시\n- 마크다운 헤더(#,##,###), 굵은체(**), 구분선(---), 인용(>), 이모지 사용 금지\n- 항목이 여러 개면 첫 문장 후 줄바꿈하고 각 항목을 '- ' 로 시작\n- 단순 질문은 한 단락으로 간결하게\n- 항목은 최대 5개, 각 항목 두 문장 이내\n- 문장을 끝맺지 못한 채 마무리하지 말 것\n- 진단 금지, 위험 상황은 '의사·약사와 상담하세요'로 안내";

      let contextBlock = "[검색된 지식]\n";
      knowledgeMatched.forEach((d, i) => {
        contextBlock += `\n[K${i+1}] ${d.id} (${d.topic}): ${d.oneline}`;
        if (d.answer) contextBlock += ` — ${d.answer}`;
        if (d.evidence) contextBlock += ` (근거: ${d.evidence})`;
      });
      faqMatched.forEach((d, i) => {
        contextBlock += `\n[F${i+1}] Q: ${d.question} / A: ${d.answer}`;
        if (d.evidence) contextBlock += ` (근거: ${d.evidence})`;
      });

      let userPrompt = contextBlock + "\n\n[사용자 질문]\n" + query;
      if (mode === "counsel" && matchedCategory) {
        userPrompt += `\n\n[대상 카테고리] ${CAT_LABEL[matchedCategory]}\n사용자의 고민은 이 카테고리와 관련이 있습니다. 검색된 지식을 근거로 이 카테고리 관점에서 답변하세요. 정보가 부족하다는 말로 답변을 대신하지 말고, 확인된 내용만 간결히 안내하세요.`;
      }
      if (requiresMedicalConsult) {
        userPrompt += `\n\n[내부 플래그] 의료 주의가 필요한 키워드 감지됨 (${detectedRisks.join(", ")}). 답변 끝에 "복용 전 의사·약사와 상담하세요"를 포함하세요.`;
      }
      if (mode === "advisory") {
        const dl = DOMAIN_LABEL[advisoryDomain] || advisoryDomain;
        userPrompt += `\n\n[내부 지시] 이 질문은 ${dl} 관련이며, ingredi가 제품을 비교 제공하지 않는 영역입니다. 정보는 충실히 답변하되 마지막 문단에 다음 취지를 자연스러운 한 문장으로 덧붙이세요: ingredi는 현재 ${FOUR_CATS} 4개 카테고리 제품만 비교해드리고 있으며, 이 중 궁금한 점이 있으면 언제든 물어봐달라는 안내. 특정 제품이나 브랜드는 언급하지 마세요.`;
      } else if (mode === "guide") {
        userPrompt += `\n\n[내부 지시] 카테고리가 특정되지 않은 일반 조언 요청입니다. 성분 선택 기준을 중심으로 답변하고, 마지막 문단에 ingredi가 ${FOUR_CATS} 4개 카테고리를 비교 제공한다는 안내를 한 문장으로 덧붙이세요.`;
      }
      claudeReqBody = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, stream: true, system: systemPrompt, messages: [{ role: "user", content: userPrompt }] });
    }

    // ─── [11] 제품 추천 (오메가3, counsel 모드에서만) ──
    let recommendation = { profile: null, top3: [], filteredCount: 0, totalCount: (pRecords || []).length };
    let distributions = null, ingredientProducts = [], listMode = null, listTerm = null;

    if (canRecommend) {
      const matchedProfileId = matchProfileLocal(query);
      const profile = PROFILES[matchedProfileId];
      const records = pRecords || [];
      const scoredP = records.map(r => {
        const f = r.fields || {};
        const productId   = getField(f, "product_id", "productId");
        const productName = getField(f, "제품명", "name") || "";
        const dailyMg     = parseFloat(getField(f, "EPA_DHA_mg", "EPA_DHA_합계_mg")) || 0;
        const form        = getField(f, "제형") || "";
        const supplier    = getField(f, "원료사") || "";
        const certsRaw    = getField(f, "인증");
        const certs       = Array.isArray(certsRaw) ? certsRaw.join(", ") : String(certsRaw || "");
        const dailyCost   = parseFloat(getField(f, "1일비용_원")) || 0;
        const capsuleMg   = parseFloat(getField(f, "캡슐용량_mg", "capsuleMg", "캡슐 용량 (mg)")) || 0;
        const grade       = getField(f, "등급") || "";
        const tier        = grade || getField(f, "Tier등급") || "";
        const passFail    = getField(f, "함량_Pass_Fail") || "";
        const coupangLink = getField(f, "coupang_deeplink")
                         || getField(f, "쿠팡 URL", "쿠팡URL", "쿠팡_URL", "쿠팡링크", "coupang_url")
                         || getField(f, "제품링크") || "";
        let imageUrl = getField(f, "이미지URL", "imageUrl", "image", "이미지", "photo") || "";
        if (Array.isArray(imageUrl) && imageUrl.length > 0) {
          const att = imageUrl[0];
          imageUrl = (att.thumbnails && att.thumbnails.large) ? att.thumbnails.large.url : (att.url || "");
        } else if (typeof imageUrl === 'object' && imageUrl !== null) { imageUrl = imageUrl.url || ""; }
        const vScore = parseFloat(getField(f, "V_Score", "vScore", "V_SCORE")) || 0;
        return { id: productId, name: productName, image: imageUrl, dailyMg, dailyCost: Math.round(dailyCost), capsuleMg, form, supplier, certs, grade, tier, passFail, coupangLink, vScore, highDoseFlag: dailyMg > 2000 };
      });

      let filtered = scoredP.filter(item => {
        if (item.passFail === "Fail") return false;
        if (profile.filters && profile.filters.minDailyDose && item.dailyMg < profile.filters.minDailyDose) return false;
        return true;
      });
      filtered.sort((a, b) => b.vScore - a.vScore);

      function computeDist(vals) { const v = vals.filter(x => x > 0); if (v.length === 0) return null; const sum = v.reduce((a, b) => a + b, 0); return { min: Math.min(...v), max: Math.max(...v), avg: Math.round(sum / v.length) }; }
      distributions = { dose: computeDist(scoredP.map(s => s.dailyMg)), cost: computeDist(scoredP.map(s => s.dailyCost)), capsule: computeDist(scoredP.map(s => s.capsuleMg)) };

      function toCard(item, idx) {
        return { rank: idx + 1, id: item.id, name: item.name, image: item.image || "", vScore: item.vScore,
          keySpec: { dailyMg: item.dailyMg, dailyCost: item.dailyCost, capsuleMg: item.capsuleMg, form: item.form, certs: item.certs, tier: item.tier, grade: item.grade },
          coupangLink: item.coupangLink, highDoseFlag: item.highDoseFlag };
      }

      if (ingredient) {
        listMode = "ingredient"; listTerm = ingredient.label;
        let pool2 = filtered;
        if (ingredient.form) { const ff = ingredient.form; const formed = filtered.filter(it => String(it.form || "").toLowerCase().indexOf(ff) !== -1); if (formed.length > 0) pool2 = formed; }
        ingredientProducts = pool2.map(toCard);
      } else if (isProductMode) {
        listMode = "product"; listTerm = query;
        const qn = normEntity(query);
        ingredientProducts = filtered.filter(it => { const nn = normEntity(it.name); return nn && (nn.indexOf(qn) !== -1 || qn.indexOf(nn) !== -1); }).map(toCard);
      }

      const top3 = filtered.slice(0, 3).map((item, idx) => ({
        rank: idx + 1, id: item.id, name: item.name, image: item.image || "", vScore: item.vScore, detailScores: null,
        keySpec: { dailyMg: item.dailyMg, dailyCost: item.dailyCost, capsuleMg: item.capsuleMg, form: item.form, supplier: item.supplier, certs: item.certs, tier: item.tier, grade: item.grade },
        coupangLink: item.coupangLink, highDoseFlag: item.highDoseFlag
      }));
      recommendation = { profile: { id: matchedProfileId, label: profile.label, weights: profile.weights }, top3, filteredCount: filtered.length, totalCount: records.length };
    }

    // ─── [12] 응답 ─────────────────────────────────
    const meta = {
      query,
      category: matchedCategory || "needs_category",
      productCategory: matchedCategory ? CAT_KO[matchedCategory] : null,
      healthDomain: advisoryDomain,
      demographics,
      priority: toPriority(matchProfileLocal(query)),
      mode: listMode || mode,     // ingredient / product / counsel / advisory / guide
      ingredientTerm: listTerm,
      ingredientProducts,
      distributions,
      categoryOptions: (mode === "advisory" || mode === "guide") ? CATEGORY_OPTIONS : null,
      sources: {
        knowledge: knowledgeMatched.map(d => ({ id: d.id, oneline: d.oneline, evidence: d.evidence || null })),
        faq: faqMatched.map(d => ({ id: d.id, question: d.question }))
      },
      flags: {
        requiresMedicalConsult, detectedRisks,
        knowledgeCount: knowledgeMatched.length, faqCount: faqMatched.length,
        faqTable: FAQ_TABLE, skipped, claudeError: null
      },
      recommendation,
      disclaimer: DISCLAIMER
    };
    if (wantDebug) meta.debug = { matchedIds: top.map(d => `${d.kind === "faq" ? "F" : "K"}:${d.id}`), tokens: lowerTokens, poolSize: pool.length };

    if (wantDebug && url.searchParams.get("json") === "1") {
      return new Response(JSON.stringify(meta, null, 2), { status: 200, headers });
    }

    const ANTHROPIC_BASE = (env.CF_ACCOUNT_ID && env.CF_AI_GATEWAY)
      ? `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AI_GATEWAY}/anthropic`
      : "https://api.anthropic.com";
    const enc = new TextEncoder();
    const ERR_MSG = "기술적 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event, dataObj) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`));
        send("meta", meta);
        try {
          if (!claudeReqBody) {
            if (answer) send("token", { text: answer });
          } else {
            const RETRY_STATUS = [403, 429, 500, 502, 503, 504, 529];
            let resp = null;
            for (let attempt = 0; attempt < 3; attempt++) {
              resp = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
                body: claudeReqBody
              });
              if (resp.ok || RETRY_STATUS.indexOf(resp.status) === -1) break;
              await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
            }
            if (!resp || !resp.ok || !resp.body) {
              send("token", { text: ERR_MSG });
            } else {
              const reader = resp.body.getReader();
              const dec = new TextDecoder();
              let buf = "", gotText = false;
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let nl;
                while ((nl = buf.indexOf("\n")) !== -1) {
                  const line = buf.slice(0, nl).trim();
                  buf = buf.slice(nl + 1);
                  if (!line.startsWith("data:")) continue;
                  const payload = line.slice(5).trim();
                  if (!payload || payload === "[DONE]") continue;
                  try {
                    const evd = JSON.parse(payload);
                    if (evd.type === "content_block_delta" && evd.delta && evd.delta.type === "text_delta" && evd.delta.text) {
                      gotText = true;
                      send("token", { text: evd.delta.text });
                    }
                  } catch (_) { /* 부분 라인 무시 */ }
                }
              }
              if (!gotText) send("token", { text: ERR_MSG });
            }
          }
        } catch (e) {
          send("token", { text: ERR_MSG });
        }
        send("done", {});
        controller.close();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: { ...headers, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: "internal_error", message: error.message }), { status: 500, headers });
  }
}
