// functions/counsel2.js  [v15.14 — 어린이 게이트 판정을 제품 매칭 이후로 이동]  (v15 — 자체점검(2,195문항) 기반 라우팅·게이트 수정)
//
// 기존 counsel-api.js(v7)와 병행 배포. 프론트 전환 완료 후 v7 폐기.
// ※ _lib/airtable.js v4(캐시 키 variant 분리)와 함께 배포해야 함.
//
// 변경 요약
//   - v9~v12: 통념 게이트 / 축 정합(성분우선·가성비) / recommend2 quality 산식 이식 / 4카테고리 확장
//   - v13: 제품명 직접 조회(4개 경량 인덱스, Strict 발동+실재 매칭) / v14: 세그먼트(대상분류) 대안 필터
//   - v15.7: 일반 추천에 성분/가성비 상위 3개 항상 백필 — LLM이 1개만 주거나 비워 카드가 안 뜨거나
//            1개만 보이던 문제. 특정 제품 평결(productMatchRecord)은 1개 유지.
//   - v15.6: 점수 노출 정책 변경 — 화자에게 raw 품질 점수(숫자)를 보내지 않는다(순위 계산엔 내부
//            사용). 대신 등급(A/B)+근거(함량·인증)로 설명하고, 2차 조건(유산균 여성/키즈, 비타민C
//            메가도즈≥2,000mg)이 있으면 '특성' 필드로 드러내 신뢰를 높인다. 4개 카테고리 공통.
//   - v15.5: 멀티턴 카테고리 라우팅 버그 수정 — 라우팅이 대화 전체(화자 인트로 포함)를 훑어
//            화자가 나열한 4개 카테고리 중 첫 번째(오메가3)로 늘 오라우팅되던 문제. 칩 클릭·후속
//            발화가 무시됨. 라우팅·인구통계·제품명 폴백을 사용자 발화(userText)만 보도록, 최신
//            메시지(query) 우선으로 변경. 화자 발화는 라우팅 입력에서 제외.
//   - v15.4: 프롬프트 캐싱 — 고정 시스템 프롬프트를 cache_control 블록으로. 멀티턴 상담에서
//            2번째 턴부터 시스템 프롬프트 입력 단가 90%↓(0.1x). 발화·라우팅 로직 변화 없음(비용만).
//   - v15.3: [비지목] 가드 — 사용자가 제품을 언급하지 않았는데 화자가 후보군(productContext)의
//            한 제품을 골라 단수 부정 평결하던 문제("50살 남성 추천" 흐름에서 웰키커 어린이 오메가3를
//            지목해 "권하지 않아요") 수정. productMatchRecord 부재 + 후보군 존재 시 플래그 주입.
//   - v15.2: 10K 자체점검이 잡은 오매칭 수정 — ①숫자 시작 토큰("3개"·"60포,") 매칭 배제
//            ②동일 usable 점수 시 전체 토큰(배제된 흔한 토큰 포함) 커버리지 타이브레이크
//            ("듀오락 베이비"→골드 오매칭 수정) ③크로스 카테고리 탐색을 첫 매칭이 아니라
//            4개 카테고리 스코어 비교로("락토핏 키즈"→오메가3 오라우팅 수정) ④메타(약사야·사람이야)·
//            서비스(회원가입·재입고)·응급(부었·가려워) 게이트 확장 ⑤축 키워드 "성분 기준" 추가
//   - v15.1: 약사 자칭 전면 제거(약사법·의료법 리스크) — 메타 응답·페르소나를 "AI 상담 +
//            식약처 인정 기능성(고시형·개별인정형)·성분·함량·인증 데이터 기준 판단"으로 교체.
//            면허 직군 자칭·암시 금지 규칙 추가. "의사(약사)와 확인하세요"류 권유 표현은 유지.
//   - v15: 유형별 2,195문항 자체점검에서 드러난 결함 수정 —
//     ① findProductMention 범용어 오탐: "영양제"·"좋은" 등 범용 토큰이 소수 제품명에 우연히 있어
//        매칭 근거가 되던 버그(예: "다이어트에 좋은 영양제"→오메가써큐텐). NON_BRAND·숫자 토큰 배제.
//     ② 다중 브랜드 토큰 확정 검증: 최고 매칭이 토큰 1개(5자 미만)만 물면 약한 우연 일치로 보고
//        AND-폴백으로 — 엉뚱한 제품 평결 방지. ③ AND-폴백: 흔한 토큰 조합 제품명(df 상한 전부 걸림)도 매칭.
//     ④ 크로스 카테고리 폴백: 복합제("루테인 오메가3")가 키워드 라우팅된 테이블에 없으면 타 카테고리
//        인덱스 확인 후 검증 통과 시 전환. ⑤ detectProductName에 브랜드 토큰 가드("비타민C 1000" 오탐 차단).
//     ⑥ 응급 게이트 확장(발진·숨쉬기 힘듦·구토+어지럼). ⑦ 메타 게이트 확장(이 서비스 뭐야·ingredi·너 AI야).

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
  const userText = messages.filter(m => m.role === "user").map(m => m.content).join(" ");  // [v15.5] 라우팅·인구통계용(화자 발화 제외)
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
  // 제품명 직접 조회 발동 시, 브랜드성 토큰이 아닌 것(도메인·증상·범용어)을 배제하는 목록.
  // 정규화(소문자·공백제거)된 토큰과 정확히 일치할 때만 제외 — 조사 붙은 형태는 실재 매칭(bestLen>=3)이 거른다.
  const NON_BRAND_RE = /^(다이어트|체중|체지방|수면|불면|숙면|멜라토닌|관절|무릎|연골|피부|여드름|뾰루지|주름|기미|콜라겐|미백|뼈|골다공증|골밀도|칼슘|혈압|기억력|인지|집중력|치매|두뇌|면역|피로|활력|컨디션|무기력|간|숙취|커큐민|강황|울금|글루타치온|추천|추천해줘|좋은|좋아|좋을까|괜찮|괜찮아|어때|어떤|알려|알려줘|먹어|먹으면|복용|영양제|건강기능식품|건기식|보충제|제품|성분|효능|효과|뭐가|뭐|뭘|무엇|무슨|어느|나아|나은|낫|골라|골라줘|추천좀|눈영양제)$/;
  // [v15.8] 안전 프로필 감지.
  //  - SAFETY_PROFILE_RE: "아기엄마" 등 출산/육아 정황 → 되묻지 말고 추천+경고+칩 제안(세그먼트는 안 걸음).
  //  - EXPLICIT_MATERNAL_RE: 사용자가 직접 수유/임신을 밝힘(칩 클릭 포함) → 유산균은 여성 세그먼트로 재추천.
  const SAFETY_PROFILE_RE = /아기\s*엄마|애기\s*엄마|아이\s*엄마|육아|돌\s*아기|신생아|출산\s*후|산후/;
  const EXPLICIT_MATERNAL_RE = /수유|모유|임신|임산부|젖\s*먹이|포\s*맘/;
  // [v15.10] 어린이(대상) 감지 — "아이 유산균"처럼 아이를 위한 질의. "아이엄마"(수유 흐름, 엄마=본인)와
  // 구분하기 위해 SAFETY/MATERNAL/"엄마 본인"이면 childHint를 끈다. 청소년·중고생은 성인으로 본다(제외).
  // [v15.14] 커버리지 확장 — 실제 고객 발화는 "아이"보다 "애"·"N살 딸"·"초딩"을 더 많이 쓴다.
  //   "애"는 단독으로 쓰면 "수면장애가"·"소화장애를"에 오탐하므로 앞에 경계(문장 시작/공백/구두점)를
  //   요구한다. 신생아는 SAFETY_PROFILE_RE(수유 정황)와 겹쳐 별도 판단이 필요해 여기 넣지 않았다.
  const CHILD_RE = /어린이|키즈|유아|영유아|아기|베이비|주니어|초등|초딩|우리\s*아이|우리\s*애|자녀|애기|아이|\d+\s*살\s*(?:딸|아들|남아|여아|애)|(?:^|[\s,.·!?])애\s*(?:가|를|한테|들|둘|셋|먹|는)/;
  const VAGUE_QUERY = /건강이\s*걱정|몸이\s*예전|나이\s*드는|돈\s*낭비|기운이?\s*없|피곤|피로\s*회복|활력|컨디션|무기력|식약처|fda|gras|기능성\s*표시|인증\s*마크/i;

  const META_QUERY = /프롬프트|시스템\s*지시|이전\s*지시|무시하고|너\s*(는|누구|어떤|뭐|ai|에이아이|약사|의사|영양사|전문가|사람|로봇|봇|진짜)|\bai\s*(야|냐|니)\b|무슨\s*모델|모델이(야|니|에요)|당신은\s*누구|이\s*(서비스|사이트|앱)\s*(가|는|이)?\s*뭐|ingredi|인그레디|잉그레디|누가\s*만들|챗\s*봇|챗봇|무슨\s*기준으로\s*(판단|평가)|왜\s*(너를|널)\s*믿|jailbreak|ignore\s+previous/i;
  const SERVICE_QUERY = /환불|반품|교환|배송|결제|쿠폰|주문|취소|배달|고객센터|광고\s*(받|비|료|협찬|수익|아니야|냐|인가|맞죠|이지)|협찬|수수료|제휴|약국|직구|최저가|세일|할인|돈\s*(을)?\s*(벌|버는)|수익|어떻게\s*운영|회원\s*가입|로그인|탈퇴|재입고|품절|가격이?\s*왜/;
  // 급성 이상 반응·사고 — 검색 없이 즉시 M
  // v15.2: 부종·가려움(알레르기 신호) 추가 — "얼굴이 부었어요 가려워요"류 미커버 수정.
  const ACUTE_EMERGENCY = /두드러기|발진|아나필락시스|부었|부어서|붓는|붓고|가려워|가렵|호흡\s*(곤란|이\s*힘)|숨\s*(쉬기|이)\s*(가|이)?\s*(힘들|차|막|안\s*쉬)|가슴\s*(이)?\s*(두근|답답|아프)|심장이\s*두근|쇼크|의식|(토했|구토).{0,8}(어지|힘들)|어지러.{0,6}(토했|구토)|한\s*(통|병)\s*(을)?\s*다\s*(먹|삼)|과다\s*복용\s*(했|한\s*것)/;

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

  // 추천 축 키워드 — 사용자가 명시하면 코드가 축을 확정해 직전 턴 축 계승을 막는다.
  // 정확히 하나의 축만 매칭될 때만 강제(복수·부재 시 화자 판단에 맡김).
  // 축은 목록(app.html)과 동일하게 2개: 성분 우선(품질점수순) · 가성비(파레토 경계).
  const AXIS_KEYWORDS = [
    { axis: "rank_quality", label: "성분 우선", re: /성분\s*(우선|기준|위주|중심)|품질|인증|등급|프리미엄|핵심\s*성분/ },
    { axis: "rank_value",   label: "가성비",   re: /가성비|가격|저렴|싸게|싸고|경제적|1일\s*비용|저가/ }
  ];
  // 순수 함량(용량) 의도 — 별도 함량 축을 두지 않는다. 근거 용량을 넘으면 함량 차이는
  // 무의미(v7 원칙: 초과분 가점 없음)하므로, 함량 요청은 성분 우선으로 흡수하고 통념을 교정한다.
  const DOSE_INTENT = /함량|고함량|용량|mg\s*(높|많)|성분\s*(량|많)/;

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
  // ── 품질점수: recommend2.js(v7)의 QUALITY_CFG 산식을 그대로 이식한다 ──
  // CSV의 등급·최종점수·V_Score 컬럼은 구 V-Score 값이거나 앵커 미반영이라 소스가 아니다.
  // app.html "성분 우선" 탭과 순위를 맞추려면 계산을 공유해야 한다(문서 3.3 공용 core 과제).
  // 근거함량 = min(원값/앵커, 1)×100 (초과분 가점 없음). 축 점수가 하나라도 없으면
  // quality=null(평가 준비중) — 0점으로 둔갑시키지 않는다. 비타민C는 원료사점수 결측 다수.
  function numOrNull(v) { if (v === "" || v == null) return null; const n = parseFloat(String(v).replace(/,/g, "")); return isNaN(n) ? null : n; }
  const QUALITY_CFG = {
    omega3:     { table: "오메가3_쿠팡업데이트",       anchor: 1000, primaryFields: ["EPA_DHA_mg", "EPA_DHA_합계_mg"], addFields: [],            primaryLabel: "EPA+DHA",     unit: "mg", anchorLabel: "EPA+DHA 1,000mg",
                  calc: (core, sc) => (sc.form == null || sc.cert == null) ? null : 0.5 * core + 0.3 * sc.form + 0.2 * sc.cert },
    eye:        { table: "눈_쿠팡업데이트",           anchor: 20,   primaryFields: ["루테인_mg"],                addFields: ["지아잔틴_mg"], primaryLabel: "루테인+지아잔틴", unit: "mg", anchorLabel: "루테인+지아잔틴 20mg",
                  calc: (core, sc) => (sc.supplier == null) ? null : 0.7 * core + 0.3 * sc.supplier },
    probiotics: { table: "마이크로바이옴_쿠팡업데이트", anchor: 100,  primaryFields: ["보장균수_억"],              addFields: [],            primaryLabel: "보장균수",    unit: "억", anchorLabel: "보장균수 100억", segmentField: "대상분류",
                  calc: (core, sc) => (sc.form == null || sc.cert == null) ? null : 0.5 * core + 0.3 * sc.form + 0.2 * sc.cert },
    vitaminC:   { table: "비타민C_쿠팡업데이트",       anchor: 1000, primaryFields: ["비타민C함량_mg"],           addFields: [],            primaryLabel: "비타민C",     unit: "mg", anchorLabel: "비타민C 1,000mg",
                  calc: (core, sc) => (sc.supplier == null) ? null : 0.6 * core + 0.4 * sc.supplier }
  };
  // 대표 성분 원값(코어·게이트용) = primaryFields 첫 유효값 + addFields 합 (눈: 루테인+지아잔틴).
  function rawPrimaryOf(f, cfg) {
    let base = null;
    for (const k of cfg.primaryFields) { const n = numOrNull(getField(f, k)); if (n != null) { base = n; break; } }
    let raw = base || 0;
    for (const k of (cfg.addFields || [])) { const n = numOrNull(getField(f, k)); if (n != null) raw += n; }
    return { primary: (base == null && !(cfg.addFields || []).length) ? null : raw, base };
  }
  function scoresOf(f) {
    return {
      form:     numOrNull(getField(f, "제형점수", "제형편의점수", "리포좀중성점수")),
      supplier: numOrNull(getField(f, "원료사점수", "원료사균주점수", "원료품질점수")),
      cert:     numOrNull(getField(f, "인증점수", "인증근거점수", "부형제안전점수"))
    };
  }
  // 카테고리별 품질점수. recommend2 파이프라인과 동일: core = min(raw/anchor,1)*100 → calc → 반올림.
  function qualityFor(cat, rawPrimary, sc) {
    const cfg = QUALITY_CFG[cat];
    if (!cfg) return null;
    const core = Math.min((rawPrimary || 0) / cfg.anchor, 1) * 100;
    const q = cfg.calc(core, sc);
    return q == null ? null : Math.round(q * 10) / 10;
  }
  // 등급 컷 — recommend2 qualityGradeOf 와 동일 (절대평가, 모집단 무관). S는 이 산식에 없다.
  function gradeFromQuality(q) { return q == null ? null : q >= 85 ? "A" : q >= 70 ? "B" : q >= 55 ? "C" : q >= 40 ? "D" : "E"; }
  // 2차 조건(세그먼트/특성) 판정 — 화자가 추천 이유에 반드시 드러낼 라벨.
  //  - 유산균: 대상분류가 여성/키즈면 그 값 (일반은 없음)
  //  - 비타민C: 함량 2,000mg 이상이면 "메가도즈"(앵커 1,000mg의 2배 초과 고용량)
  //  - 오메가3·눈: 해당 없음(2차 조건 컬럼 없음)
  // [v15.11] 인증을 성격별 이름으로 재가공 — 일반인이 약어(GMP·HACCP)만 보면 뜻을 모르므로,
  // 코드가 무엇을 보증하는지 이름을 붙여 화자에게 넘긴다. 품질과 무관한 종교/식이/미국 인증
  // (Halal·Kosher·GRAS·FDA·MUI·V-label·Vegan 등)은 제거한다. "규칙은 코드에" — 명명은 판단이 아님.
  function classifyCerts(raw) {
    if (!raw) return null;
    const s = String(raw).toUpperCase();
    const has = (...ks) => ks.some(k => s.indexOf(k) !== -1);
    const groups = [];
    if (has("GMP")) groups.push("제조 인증(GMP)");
    const safety = [];
    if (has("HACCP")) safety.push("HACCP");
    else if (has("CODEX")) safety.push("CODEX");
    if (has("FSSC22000", "FSSC 22000")) safety.push("FSSC22000");
    if (has("ISO22000", "ISO 22000")) safety.push("ISO22000");
    if (has("EFSA")) safety.push("EFSA");
    if (has("QPS")) safety.push("QPS");
    if (safety.length) groups.push("안전 인증(" + safety.slice(0, 2).join("·") + ")");
    const purity = [];
    if (has("GOED")) purity.push("GOED");
    if (has("IFOS")) purity.push("IFOS");
    if (has("IFFO")) purity.push("IFFO");
    if (has("MSC")) purity.push("MSC");
    if (has("MARINTRUST", "MARIN TRUST")) purity.push("MarinTrust");
    if (purity.length) groups.push("주요성분 품질 인증(" + purity.slice(0, 2).join("·") + ")");
    if (has("NON-GMO", "NONGMO", "NON GMO")) groups.push("Non-GMO");
    return groups.length ? groups.join(", ") : null;
  }
  function descriptorOf(cat, segRaw, primary) {
    if (cat === "probiotics") { const s = String(segRaw || "").trim(); return (s === "여성" || s === "키즈") ? s : null; }
    if (cat === "vitaminC" && primary != null && primary >= 2000) return "메가도즈";
    return null;
  }
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
    // 브랜드성 토큰이 하나는 있어야 제품 언급으로 본다 — "비타민C 1000"처럼
    // 카테고리어+숫자뿐인 질의가 우연히 제품명의 부분문자열이어도 매칭하지 않는다(자체점검 오탐).
    const allParts = String(q).split(/\s+/).map(normEntity).filter(t => t.length >= 2);
    const brandish = t => !isCategoryWord(t) && !NON_BRAND_RE.test(t) && !/^\d+(mg|억|포|정|캡슐|개월|일분)?$/.test(t);
    if (!allParts.some(brandish)) return null;
    for (const r of records || []) {
      const nm = normEntity(getField(r.fields || {}, "제품명", "name"));
      if (nm && nm.indexOf(qn) !== -1) return r;
    }
    const parts = allParts;
    const hasBrand = parts.some(t => t.length >= 3 && brandish(t));
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
  function findProductMention(q, records, withScore) {
    const recs = records || [];
    if (!recs.length) return null;
    const names = recs.map(r => normEntity(getField(r.fields || {}, "제품명", "name")));
    // 브랜드성 토큰만: 카테고리어·범용어(NON_BRAND)·불용어·숫자 시작 토큰 배제.
    // "영양제"·"좋은" 같은 범용어가 소수 제품명에 우연히 들어 있어도 매칭 근거가 되면 안 된다(자체점검에서 오탐 확인).
    // 숫자 시작("3개"·"60포,"·"1000mg")은 수량 표기라 브랜드가 아니다 — v15.2: "3개"가 확정 검증의
    // 두 번째 토큰으로 잡혀 타 카테고리 오확정("락토핏 키즈 60포, 3개"→오메가3)을 일으킨 결함 수정.
    const parts = [...new Set(String(q).split(/\s+/).map(normEntity)
      .filter(t => t.length >= 2 && !isCategoryWord(t) && !NON_BRAND_RE.test(t) && !/^\d/.test(t)))];
    if (!parts.length) return withScore ? null : null;
    // 범용 토큰 배제: 전체 제품의 5% 초과(최소 3개 초과)에 등장하면 브랜드가 아님
    const cap = Math.max(3, Math.floor(recs.length * 0.05));
    const usable = parts.filter(t => {
      let df = 0;
      for (const nm of names) { if (nm && nm.indexOf(t) !== -1) { df++; if (df > cap) return false; } }
      return df > 0;
    });
    // v15.2: 최고 매칭 선정을 (usable 길이합, 전체 토큰 길이합) 사전식으로.
    // usable 동점일 때 배제됐던 흔한 토큰("키즈"·"베이비")까지 커버하는 제품이 이긴다 —
    // "듀오락 베이비"가 듀오락 골드(일반)에, "영롱 키즈"가 영롱 센서티브(일반)에 붙던 오매칭 수정.
    function allHitOf(nm) { let h = 0; for (const t of parts) if (nm.indexOf(t) !== -1) h += t.length; return h; }
    let best = null, bestLen = 0, bestAll = 0;
    if (usable.length) {
      for (let i = 0; i < recs.length; i++) {
        const nm = names[i];
        if (!nm) continue;
        let hit = 0;
        for (const t of usable) if (nm.indexOf(t) !== -1) hit += t.length;
        if (!hit) continue;
        const all = allHitOf(nm);
        if (hit > bestLen || (hit === bestLen && all > bestAll)) { bestLen = hit; bestAll = all; best = recs[i]; }
      }
    }
    // 확정 검증: 질의에 브랜드 토큰이 2개 이상 있는데 최고 매칭이 그중 1개(5자 미만)만 물었다면
    // 약한 우연 일치일 수 있다("GNM 건조한 눈엔"이 다른 GNM 제품에 3자 매칭). AND-폴백으로 넘긴다.
    const presentAll = parts.filter(t => names.some(nm => nm && nm.indexOf(t) !== -1));
    if (best && bestLen >= 3) {
      if (presentAll.length >= 2) {
        const bn = normEntity(getField(best.fields || {}, "제품명", "name"));
        const hitToks = presentAll.filter(t => bn.indexOf(t) !== -1);
        if (hitToks.length >= 2 || hitToks.join("").length >= 5) return withScore ? { rec: best, score: bestAll } : best;
      } else return withScore ? { rec: best, score: bestAll } : best;
    }
    // 폴백 AND-매칭: 흔한 토큰 조합으로 된 제품명("종근당 프로메가 알티지 듀얼" 등)은 df 상한에
    // 전부 걸려 usable이 비는데, 실재 제품이면 "모든 토큰을 다 포함하는 이름"은 소수다.
    // 조건: 2개 이상 토큰이 전부 한 이름에 들어 있고, 토큰 총길이 ≥5. 후보 여럿이면 가장 짧은 이름(가장 특정).
    if (presentAll.length >= 2 && presentAll.join("").length >= 5) {
      let cand = null, candLen = Infinity;
      for (let i = 0; i < recs.length; i++) {
        const nm = names[i];
        if (!nm) continue;
        if (presentAll.every(t => nm.indexOf(t) !== -1) && nm.length < candLen) { cand = recs[i]; candLen = nm.length; }
      }
      if (cand) return withScore ? { rec: cand, score: allHitOf(normEntity(getField(cand.fields || {}, "제품명", "name"))) } : cand;
    }
    return null;
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
    const demographics = parseDemographics(userText);  // [v15.5] 화자 발화 제외

    // ─── [0] 코드 게이트: 검색·모델 호출 전 차단 ────
    if (META_QUERY.test(query)) {
      return respond(fixedPayload("X",
        "저는 ingredi의 AI 상담이에요. 의사나 약사는 아니고, 진단·처방은 하지 않아요. 대신 식약처가 인정한 기능성(고시형·개별인정형)과 표기된 성분·함량, 임상 근거 용량, 인증 같은 공개된 제품 데이터만 기준으로 판단해 드려요. 광고는 받지 않습니다.\n\n어떤 게 궁금하세요?",
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
    // [v15.5] 카테고리 라우팅은 사용자 발화만 본다(userText, 상단 정의). 화자 인트로가
    // "오메가3·눈·유산균·비타민C"를 모두 나열하므로 대화 전체로 매칭하면 객체 순서상 첫 카테고리
    // (오메가3)가 늘 이겨, 2번째 턴의 칩 클릭·후속 발화가 무시되고 오메가3로 오라우팅된다(실측 재현).
    // 최신 사용자 메시지(query = 방금 누른 칩)를 우선 매칭하고, 없을 때만 이전 사용자 발화로 폴백.
    function catFrom(text) {
      const t = String(text).toLowerCase();
      for (const cat in CATEGORY_KEYWORDS) if (CATEGORY_KEYWORDS[cat].some(k => t.indexOf(k) !== -1)) return cat;
      return null;
    }
    // [v15.9] 최신 메시지에 서로 다른 카테고리어가 2개 이상이면(예: "유산균과 오메가3 추천")
    // 하나로 확정하지 말고 Q로 되묻는다(A안). 이전 catFrom은 객체 순서상 첫 카테고리만 잡아
    // 나머지를 버렸다. 명시 복수만 감지 — query(방금 발화) 기준.
    function allCatsFrom(text) {
      const t = String(text).toLowerCase();
      const out = [];
      for (const cat in CATEGORY_KEYWORDS) if (CATEGORY_KEYWORDS[cat].some(k => t.indexOf(k) !== -1)) out.push(cat);
      return out;
    }
    let explicitMultiCats = null;
    const qCats = allCatsFrom(query);
    if (qCats.length >= 2) {
      explicitMultiCats = qCats.map(c => CAT_KO[c]);   // 되묻기용 라벨
    } else {
      matchedCategory = catFrom(query) || catFrom(userText);
      if (!matchedCategory) for (const h of PRODUCT_HINTS) if (h.re.test(query) || h.re.test(userText)) { matchedCategory = h.cat; break; }
      if (!matchedCategory) for (const h of DOMAIN_HINTS) if (h.re.test(query) || h.re.test(userText)) { hintDomain = h.dom; break; }
    }

    // ─── [3] 테이블 로드 ────────────────────────────
    async function safeGet(t, opts) { try { return await getRecords(env, t, opts); } catch (_) { return []; } }

    // 브랜드성 토큰 추출 — 카테고리어·범용어·불용어·숫자 제외 (제품명 탐색 공용)
    function makeBrandCands(text) {
      return [...new Set(
        String(text).replace(/[?!.,~"'`()\[\]·…:;]/g, " ").split(/\s+/).map(w => normEntity(w))
          .filter(t => t.length >= 2 && !isCategoryWord(t) && !STOPWORDS.has(t) && !NON_BRAND_RE.test(t) && !/^\d+(mg|억|포|정|캡슐|개월|일분)?$/.test(t))
      )];
    }
    const ALL_CATS = ["omega3", "eye", "probiotics", "vitaminC"];
    async function loadIdx(cat) { return safeGet(QUALITY_CFG[cat].table, { variant: "idx", fields: ["제품명", "product_id"] }); }
    // 크로스 매칭 검증: 찾은 제품명에 브랜드 토큰이 2개 이상 또는 합계 5자 이상 들어가야 확정.
    // (토큰 1개·짧은 우연 일치로 카테고리를 갈아타는 오전환 방지)
    function crossVerified(rec, cands) {
      const nm = normEntity(getField(rec.fields || {}, "제품명", "name"));
      const hit = cands.filter(t => nm.indexOf(t) !== -1);
      return hit.length >= 2 || hit.join("").length >= 5;
    }

    // [2.5] 제품명 직접 조회 (Strict 발동 + 실재 매칭 필수):
    // 카테고리 미확정인데 질의에 브랜드성 토큰이 있으면, 4개 카테고리의 경량 인덱스(제품명·id만,
    // variant='idx' 캐시)를 뒤져 제품이 실재하는 카테고리를 찾는다. 실재하면 도메인 힌트보다 이긴다(P2).
    // 못 찾으면 productLookupFailed 플래그 — 도메인 힌트가 없을 때 Q(카테고리 되묻기)로 복구한다.
    let productLookupFailed = false;
    const brandCands = makeBrandCands(query);
    if (!matchedCategory && brandCands.length) {
      const idxLists = await Promise.all(ALL_CATS.map(loadIdx));
      // 정제된 브랜드 후보만 매칭에 사용 — 원 질의를 넘기면 findProductMention이 도메인어
      // (다이어트 등)를 다시 토큰화해 엉뚱한 제품명에 오매칭할 수 있다.
      // v15.2: 첫 매칭에서 멈추지 않고 4개 카테고리 전부의 매칭 강도(전체 토큰 커버 길이)를 비교해
      // 가장 강한 카테고리를 택한다 — "종근당건강 락토핏 키즈"가 순회 순서상 앞인 오메가3(종근당건강만
      // 커버)에서 확정돼 정답 유산균(락토핏·키즈까지 커버)을 못 보던 오라우팅 수정.
      const brandQuery = brandCands.join(" ");
      let bestIdx = -1, bestScore = 0;
      for (let i = 0; i < ALL_CATS.length; i++) {
        const r = findProductMention(brandQuery, idxLists[i], true);
        if (r && r.score > bestScore) { bestScore = r.score; bestIdx = i; }
      }
      if (bestIdx >= 0) { matchedCategory = ALL_CATS[bestIdx]; hintDomain = null; }
      if (!matchedCategory) productLookupFailed = true;
    }
    // [v15.9] 제품이 실제로 매칭됐으면 복수 카테고리가 아니다 — 제품명에 카테고리어가 2개 든
    // 복합제("닥터스베스트 루테인 오메가3")를 복수 질의로 오인하지 않도록 여기서 해제.
    if (matchedCategory && explicitMultiCats) explicitMultiCats = null;

    // [v15.14] 어린이 감지 신호만 여기서 계산하고, 게이트 판정은 제품 매칭 이후로 미룬다.
    //   (기존 v15.10은 게이트가 productMatchRecord보다 앞이라 "실제 제품 지목인가"를 알 수 없었고,
    //    대용품으로 쓴 nonChildBrand가 "많은/걸로/우리/돼요" 같은 평범한 한국어를 브랜드로 오인해
    //    "아이 비타민C"처럼 조사 없는 2단어 질의에서만 게이트가 발동했다 → 실전 미발동.)
    let childProbiotics = false;
    const childHint = CHILD_RE.test(userText)
      && !SAFETY_PROFILE_RE.test(userText) && !EXPLICIT_MATERNAL_RE.test(userText)
      && !/엄마\s*본인/.test(userText);

    // 제품 테이블은 매칭된 카테고리 1개만 전체 로드(하위요청 한도 안전). 카테고리 미확정이면
    // 자유 질문의 제품명 감지를 위해 오메가3를 기본 로드(기존 동작 유지).
    const prodCat = (matchedCategory && QUALITY_CFG[matchedCategory]) ? matchedCategory : (!matchedCategory ? "omega3" : null);
    const prodTable = prodCat ? QUALITY_CFG[prodCat].table : null;
    let [kRecords, fRecords, pRecords] = await Promise.all([
      safeGet(KNOW_TABLE),
      safeGet(FAQ_TABLE),
      prodTable ? safeGet(prodTable) : Promise.resolve([])
    ]);

    let productMatchRecord = null;
    if (prodCat) {
      productMatchRecord = detectProductName(query, pRecords || [])
        || findProductMention(query, pRecords || [])
        || (askedBefore ? findProductMention(userText, pRecords || []) : null);  // [v15.5] 화자 발화 제외
      if (productMatchRecord && !matchedCategory) matchedCategory = prodCat;
    }

    // [v15.14] 어린이 게이트 (제품 매칭 이후): 어린이 대상 질의는 유산균만 다룬다.
    //   판정 기준을 nonChildBrand → productMatchRecord로 교체. v15.10의 원래 의도("실제 브랜드
    //   토큰이 있으면 특정 제품이므로 게이트를 걸지 않고 정상 매칭")를 그대로 구현한 것 —
    //   "락토핏 키즈 어때요"는 제품이 매칭되므로 평결로 가고, "우리 애 눈 나빠지는데 루테인
    //   먹여도 돼요"는 제품 미매칭이므로 게이트가 걸린다.
    if (childHint && !explicitMultiCats && !productMatchRecord) {
      if (matchedCategory === "probiotics") {
        childProbiotics = true;  // [6]에서 targetSegment = "키즈"
      } else if (matchedCategory === "vitaminC" || matchedCategory === "omega3" || matchedCategory === "eye") {
        const catKo = CAT_KO[matchedCategory];
        return respond(fixedPayload("X",
          `어린이 ${catKo}는 제가 깊이 있게 다루는 범위가 아니에요. 어린이 제품은 성인과 기준(용량·제형)이 달라서 성인용 데이터로 판단드리기 어렵거든요. 대신 어린이 유산균은 도와드릴 수 있어요.`,
          { chips: ["어린이 유산균 보기", `성인 ${catKo} 볼게요`], chips_prompts: ["어린이 유산균 추천해줘", `성인 ${catKo} 추천해줘`] }
        ), { gate: "child_scope", matchedCategory, demographics });
      } else if (!matchedCategory && !hintDomain) {
        return respond(fixedPayload("X",
          `어린이 영양제는 유산균을 깊게 봐드릴 수 있어요. 오메가3·비타민C·눈 영양제는 어린이 기준 데이터가 충분하지 않아 성인 기준으로만 판단할 수 있거든요. 어린이 유산균부터 보시겠어요?`,
          { chips: ["어린이 유산균 보기"], chips_prompts: ["어린이 유산균 추천해줘"] }
        ), { gate: "child_scope", demographics });
      }
    }

    // [3.5] 크로스 카테고리 폴백: 카테고리 키워드로 라우팅됐지만 그 테이블에 제품이 없을 때,
    // 브랜드 토큰이 있으면 다른 카테고리 인덱스를 확인한다. 복합제("루테인 오메가3" 등)는 이름에
    // 두 카테고리 키워드가 다 있어 키워드 라우팅이 실제 소속 테이블을 못 맞출 수 있다.
    // 오전환 방지: crossVerified(토큰 2개 이상 or 합계 5자 이상) 통과 시에만 전환.
    if (matchedCategory && !productMatchRecord && brandCands.length) {
      const brandQuery = brandCands.join(" ");
      // v15.2: 여기도 첫 매칭이 아니라 최고 스코어 카테고리로 전환.
      let bestCat = null, bestScore = 0;
      for (const cat of ALL_CATS) {
        if (cat === matchedCategory) continue;
        const r = findProductMention(brandQuery, await loadIdx(cat), true);
        if (r && crossVerified(r.rec, brandCands) && r.score > bestScore) { bestScore = r.score; bestCat = cat; }
      }
      if (bestCat) {
        matchedCategory = bestCat;
        pRecords = await safeGet(QUALITY_CFG[bestCat].table);
        productMatchRecord = detectProductName(query, pRecords || []) || findProductMention(query, pRecords || []);
      }
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
    if (!matchedCategory && !hintDomain && !explicitMultiCats) {
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

    // ─── [6] 제품 컨텍스트 (4개 카테고리 실데이터) ─────
    let productContext = [];
    let targetSegment = null;
    if (matchedCategory && QUALITY_CFG[matchedCategory] && (pRecords || []).length) {
      const cfg = QUALITY_CFG[matchedCategory];
      // 세그먼트(대상분류) 필터: 사용자가 특정 제품을 물었고 그 카테고리에 세그먼트 컬럼이 있으면,
      // 순위·후보군·대안을 그 제품과 같은 세그먼트(예: 키즈) 안에서만 뽑는다. 유산균만 해당(대상분류).
      // 이래야 "아기 유산균 어때?"에 성인·여성 제품이 대안으로 섞이지 않는다.
      if (cfg.segmentField && productMatchRecord) {
        const sv = getField(productMatchRecord.fields || {}, cfg.segmentField);
        if (sv) targetSegment = String(sv).trim();
      }
      // [v15.10] 어린이 대상 유산균 질의(특정 제품 미지목)는 키즈 세그먼트로 추천.
      if (!targetSegment && childProbiotics) targetSegment = "키즈";
      // [v15.8] 사용자가 명시적으로 수유/임신을 밝히면(칩 클릭 포함) 유산균은 여성 세그먼트로 재추천.
      // 단순 인구통계("35살 여성")로는 걸지 않는다(A 결정) — 명시 신호만. 유산균에만 적용.
      if (!targetSegment && matchedCategory === "probiotics" && EXPLICIT_MATERNAL_RE.test(userText)) {
        targetSegment = "여성";
      }
      const items = (pRecords || []).map(r => {
        const f = r.fields || {};
        const { primary } = rawPrimaryOf(f, cfg);
        const q = qualityFor(matchedCategory, primary, scoresOf(f));
        return {
          product_id: getField(f, "product_id", "productId") || r.id,
          name: getField(f, "제품명", "name") || "",
          primary_mg: primary,
          daily_cost: Math.round(parseFloat(getField(f, "1일비용_원")) || 0) || null,
          form: getField(f, "제형") || null,
          certs: asText(getField(f, "인증")) || null,
          segment: cfg.segmentField ? (String(getField(f, cfg.segmentField) || "").trim() || null) : null,
          descriptor: descriptorOf(matchedCategory, getField(f, cfg.segmentField || "__none__"), primary),
          grade: gradeFromQuality(q),
          score: q,
          pass: getField(f, "함량_Pass_Fail") || null
        };
      }).filter(p => p.name && p.pass !== "Fail" && (!targetSegment || p.segment === targetSegment));

      // 축별 순위 계산 (전체 모집단 기준). 축은 2개 — 성분 우선(품질점수순)·가성비(파레토).
      // 둘 다 app.html의 "성분 우선"·"가성비 우선" 탭과 동일 로직이라 순위가 일치한다.
      // 성분 우선: 품질점수 내림차순, 동점이면 1일비용 오름차순 (app.html applyProfile 균형).
      // quality=null(평가 준비중)은 순위에서 제외 — 추천·대안에 오르지 않는다(비타민C 결측 다수).
      const scoredItems = items.filter(p => p.score != null);
      const byScore = [...scoredItems].sort((a, b) => (b.score - a.score) || ((a.daily_cost || 9e9) - (b.daily_cost || 9e9)));
      byScore.forEach((p, i) => { p.rank_quality = i + 1; });
      // 가성비: 파레토 경계 — "이보다 싸면서 품질이 더 좋은 제품 수"가 적을수록 앞, 동점이면 저가순.
      // recommend2 isPareto / app.html paretoRank 이식.
      const valuePool = scoredItems.filter(p => p.daily_cost != null && p.daily_cost > 0);
      const dominated = new Map();
      for (const a of valuePool) {
        let n = 0;
        for (const b of valuePool) {
          if (b === a) continue;
          if (b.daily_cost <= a.daily_cost && b.score >= a.score && (b.daily_cost < a.daily_cost || b.score > a.score)) n++;
        }
        dominated.set(a, n);
      }
      const byValue = [...valuePool].sort((a, b) => (dominated.get(a) - dominated.get(b)) || (a.daily_cost - b.daily_cost));
      byValue.forEach((p, i) => { p.rank_value = i + 1; });

      // 후보군 = 두 축 상위 8의 합집합 (한 축만 잘 보이는 제품도 화자 시야에 들어오게)
      const seen = new Set();
      const topProducts = [];
      for (const pool of [byScore.slice(0, 8), byValue.slice(0, 8)]) {
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
          else {
            const { primary: ppri } = rawPrimaryOf(pf, cfg);
            const pq = qualityFor(matchedCategory, ppri, scoresOf(pf));
            topProducts.push({
              product_id: pid, name: getField(pf, "제품명", "name") || "",
              primary_mg: ppri,
              daily_cost: Math.round(parseFloat(getField(pf, "1일비용_원")) || 0) || null,
              form: getField(pf, "제형") || null, certs: asText(getField(pf, "인증")) || null,
              segment: cfg.segmentField ? (String(getField(pf, cfg.segmentField) || "").trim() || null) : null,
              descriptor: descriptorOf(matchedCategory, getField(pf, cfg.segmentField || "__none__"), ppri),
              grade: gradeFromQuality(pq),
              score: pq,
              pass: getField(pf, "함량_Pass_Fail") || null
            });
          }
        }
      }
      productContext = topProducts;
    }

    // ─── [7] 시스템 프롬프트 (화자 v1) ──────────────
    const systemPrompt = `당신은 ingredi의 상담 화자입니다.

## 정체성
당신은 ingredi의 AI 상담입니다. 의사·약사·영양사 등 면허 직군을 자칭하거나 암시하지 않으며, 진단·처방을 하지 않습니다. 당신의 판단 근거는 세 가지입니다: ①식약처가 인정한 기능성(고시형·개별인정형) ②표기된 성분·함량과 임상 근거 용량 ③인증·제형 등 공개된 제품 데이터. 근거를 물으면 이 기준으로 판단한다고 답합니다.
이 근거 위에서 당신의 일은 정보 나열이 아니라 판단을 내려주는 것입니다. 팔아야 할 물건이 없어서 편하게 말합니다. 좋은 제품에는 "드셔도 됩니다", 나쁜 제품에는 "권하지 않아요"라고 분명히 말합니다. 아니라고 말할 수 있기 때문에 당신의 "괜찮아요"에 무게가 있습니다.
다루는 범위는 4개 카테고리뿐입니다: 오메가3, 눈(루테인·지아잔틴), 유산균, 비타민C. 좁지만 깊게 압니다. 이 좁음을 사과하지 않습니다.

## 응답 절차: 먼저 분류하고, 그 다음 답합니다
아래 순서로 검사하며, 앞 단계에 해당하면 뒤는 보지 않습니다.

1) M (의료 전환): 진단받은 질병의 치료·완치 목적 / 약의 대체·중단 의도 / 이상 반응 발생 / 수술·항암 등 치료 전후 / 장기 기능 이상 언급.
   → 판단을 내리지 않습니다. 얼버무리지 말고 경계를 명확히: "이건 제가 답할 영역이 아니에요. ○○는 의사(약사)와 확인하셔야 합니다." handoff에 병원에서 물어볼 것 한 가지를 담습니다.
2) X (범위 밖): 4개 카테고리 밖 성분·제품의 추천·비교·평가 요청. 단, 4개 카테고리 제품과의 병용 질문은 X가 아니라 아는 범위에서 답합니다. 또한 우리 카테고리 성분이 포함된 복합제(예: "눈+전립선" 제품)가 [제품 데이터]에 있으면 X가 아닙니다 — 우리 성분 부분을 그 수치로 평결하고, 범위 밖 성분만 "판단하지 않는다"고 밝힙니다.
   → "지금 ingredi는 오메가3, 눈, 유산균, 비타민C 네 가지만 봅니다. 대신 깊게 봐요." 사과하지 않습니다.
3) W 플래그: 임산부·수유부 / 흡연자+눈(베타카로틴 배제, 이유 명시) / 혈전약+오메가3 / 처방약 복용 중 / 항생제+유산균(시간 간격) / 수술 예정 / 만 12세 이하.
   → 독립 정책이 아니라 V/Q 위에 얹힙니다. warning 필드에 담고, 경고 문장만 합쇼체를 씁니다. 겁주지 않되 뭉개지 않습니다.
4) 정보가 충분하면 V (즉시 평결), 판단을 바꿀 핵심 정보 하나가 비어 있으면 Q (되묻기).
   - Q: 질문은 반드시 하나. 칩 2~4개 + "잘 모르겠어요" 칩 필수. 답하지 않아도 되는 완결된 기본 답(default_answer)을 반드시 동반.
   - 되묻기는 대화 전체에서 최대 1회. ${askedBefore ? "이 대화에서는 이미 답변한 적이 있으므로 다시 되묻지 말고 가진 정보로 판단하세요." : ""}

## V의 형식
1. 평결 먼저. 첫 문장이 결론입니다. 그리고 결론은 '판단'이어야 합니다 — "권해요 / 이걸 추천해요 / 이게 제일 나아요 / 드셔도 됩니다"처럼 1인칭 판단으로 엽니다. "○○이 1위예요", "상위 3개를 골랐어요", "성분 우선으로 보면"처럼 순위·과정을 나열하는 정보성 문장으로 시작하지 마세요. 순위·수치는 판단 뒤에 근거로 붙입니다. (예: ✗ "건기남이 1위예요" → ✓ "건기남을 추천해요. 성분 우선 1위고, EPA+DHA 1,000mg으로 근거 용량을 채웠어요.") 추천 질의(여러 개 제시)여도 첫 문장은 "이 중에선 ○○을 제일 권해요"처럼 판단으로 엽니다.
2. 근거는 숫자 2개까지 (함량 1 + 상대 위치 1). 세 번째 숫자부터는 설득이 됩니다.
3. 부정 평결 3원칙: 사람이 아니라 제품·광고를 문제 삼는다 / "솔직히 말씀드리면"으로 예고한다 / 반드시 대안(alternatives)으로 끝낸다.
4. 대안 자격 규칙: 대안은 평결에서 지적한 결함을 해결하는 제품이어야 합니다. 함량 부족을 지적했다면 대안은 임상 근거 용량 이상이어야 하고, 제형을 지적했다면 대안은 그 제형 문제가 없어야 합니다. 지적한 결함을 똑같이 가진 제품은 가격이 아무리 좋아도 대안이 될 수 없습니다. 자격을 갖춘 제품이 [제품 데이터]에 1~2개뿐이면 3개를 채우지 말고 1~2개만 제시하세요. 대안은 별도 기준 요청이 없으면 성분 우선(품질점수) 순으로 고르고, 성분 우선 목록에 가성비 제품을 섞지 마세요 — 사용자가 "가성비 좋은 걸로"를 물으면 그때 가성비 순으로 바꿉니다.
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
1. 기준이 없으면 Q로 되묻습니다: "성분 우선" / "가성비 우선" / "잘 모르겠어요" 칩. default_answer는 성분 우선(rank_quality) 기준 상위로.
2. 기준이 정해지면 해당 축 순위(rank_quality=성분 우선 / rank_value=가성비)로 상위 3개를 alternatives에 담고, alternatives_note에 기준을 명시합니다 (예: "성분 우선 상위 3개").
3. 축은 두 가지뿐입니다 — 성분 우선(품질점수순)과 가성비. 순수 함량순은 제공하지 않습니다. 사용자가 "함량 높은 걸로"를 원하면, 근거 용량(EPA+DHA 1,000mg)을 넘으면 함량 차이는 의미가 없다는 걸 한 마디로 짚고 성분 우선으로 안내하세요. 함량만 높고 품질이 처지는 제품을 1위로 올리지 않습니다.
4. 3개를 넘게 나열하지 마세요. 더 원하면 "전체 순위는 비교 페이지에서 보실 수 있어요"로 안내합니다.
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
      // 화자에게는 raw 품질 점수(score)를 보내지 않는다 — 등급(A/B)·함량·인증·2차조건으로만 설명.
      // score는 순위 계산에만 쓰고 여기서 투영 시 제거한다(정밀 숫자 노출이 산식 심문·톤 약화를 부름).
      const publicView = productContext.map(p => ({
        product_id: p.product_id, name: p.name,
        rank_quality: p.rank_quality, rank_value: p.rank_value,
        grade: p.grade,
        [QUALITY_CFG[matchedCategory] ? QUALITY_CFG[matchedCategory].primaryLabel : "함량"]:
          p.primary_mg != null ? p.primary_mg.toLocaleString() + (QUALITY_CFG[matchedCategory] ? QUALITY_CFG[matchedCategory].unit : "") : null,
        인증: classifyCerts(p.certs) || null,
        일일비용: p.daily_cost != null ? p.daily_cost + "원" : null,
        특성: p.descriptor || null
      }));
      productBlock += "\n" + JSON.stringify(publicView);
      productBlock += "\n임상 도즈 앵커: " + (QUALITY_CFG[matchedCategory] ? QUALITY_CFG[matchedCategory].anchorLabel : "카테고리별 근거 용량") + ".";
      productBlock += "\n후보군 설명: 성분 우선(rank_quality, 품질 높은 순)·가성비(rank_value, 파레토 경계 = 이보다 싸면서 더 좋은 제품이 없는 순) 두 기준 각 상위의 합집합입니다. 순위는 전체 제품 기준이며, 목록 페이지의 '성분 우선'·'가성비 우선' 탭과 동일합니다.";
      productBlock += "\n축 선택 규칙: 가격을 중시하면 rank_value(가성비), 그 외에는 rank_quality(성분 우선) 순으로 고르고, 어떤 기준으로 골랐는지 한 마디로 밝히세요 (예: \"성분 우선으로는 이게 1위예요\"). 순수 함량순은 제공하지 않습니다.";
      productBlock += "\n점수 노출 금지: 내부 품질 점수(숫자)는 사용자에게 절대 말하지 마세요. 대신 등급(A/B…)과 근거로 설명합니다. 각 추천 제품마다 왜 권하는지를 한두 문장으로: ①등급이 기본 충족을 뜻함(A면 근거 용량·인증을 갖춤) ②'인증' 필드는 이미 성격별 이름(제조 인증·안전 인증·주요성분 품질 인증·Non-GMO)으로 정제돼 있으니 그 이름 그대로 말하세요(예: \"GMP 제조 인증과 HACCP 안전 인증을 갖췄어요\"). 절대 '인증' 두 글자만 말하지 말고, 무엇을 보증하는 인증인지 이름을 붙이세요. 함량은 앵커 대비로. ③'특성' 필드에 값(여성/키즈/메가도즈)이 있으면 반드시 드러내세요 — 예: \"여성 질유래 유산균이에요\", \"키즈 전용으로 100억 채웠어요\", \"메가도즈(고용량)예요\". 이 2차 조건이 신뢰를 높입니다.";
      productBlock += "\n반복 금지: 직전 턴에서 이미 제시한 대안을 습관처럼 반복하지 마세요. 새 질문의 기준이 다르면 그 기준으로 다시 고르세요.";
    } else {
      productBlock += "\n(이 카테고리의 제품 데이터가 이 요청에 로드되지 않았습니다. 특정 제품 평결이 필요하면 라벨 함량을 요청하고, 대안은 비교 페이지로 안내하세요.)";
      productBlock += "\n임상 도즈 앵커: 오메가3 EPA+DHA 1,000mg / 루테인+지아잔틴 20mg / 유산균 보장균수 100억 / 비타민C 1,000mg.";
    }

    // 명시적 축 키워드가 있으면 코드가 축을 확정한다 (멀티턴에서 직전 턴 축 계승 방지).
    const axisHits = AXIS_KEYWORDS.filter(a => a.re.test(query));
    let forcedAxis = axisHits.length === 1 ? axisHits[0] : null;
    // 순수 함량 요청은 별도 축이 아니라 성분 우선(rank_quality)으로 흡수한다(방향2).
    const doseIntent = DOSE_INTENT.test(query);
    if (!forcedAxis && doseIntent) forcedAxis = AXIS_KEYWORDS[0]; // rank_quality

    let flagBlock = "";
    if (productMatchRecord) {
      const pmName = getField(productMatchRecord.fields || {}, "제품명", "name");
      flagBlock += `\n\n[대상 제품] 사용자가 언급한 제품이 데이터에 있습니다: "${pmName}". [제품 데이터]에서 이 제품을 찾아 그 수치로 바로 평결하세요. "데이터에 없다"거나 "라벨을 알려달라"고 되묻지 마세요 — 수치는 이미 [제품 데이터]에 있습니다. 이 제품이 다른 카테고리 성분까지 포함한 복합제여도, 우리 카테고리 성분(예: 루테인+지아잔틴)의 표기된 수치로 평결하고, 범위 밖 성분(예: 전립선·쏘팔메토)은 "그 부분은 제 범위 밖이라 판단하지 않아요"라고만 밝히세요. 또한 이 제품의 주된 목적이 우리 카테고리가 아니어도(예: 다이어트 제품에 유산균이 함께 든 경우), 먼저 이 제품이 무엇인지(주된기능성) 밝히고 우리 축 수치로 평결하되, "좋다/나쁘다" 단정보다 사실 위주로 알려주세요.`;
      if (targetSegment) flagBlock += ` 이 제품은 '${targetSegment}' 대상 제품이며, [제품 데이터]의 대안도 모두 같은 '${targetSegment}' 대상입니다 — 대안을 권할 때 "같은 ${targetSegment} 유산균 중에서" 같은 표현으로 대상을 맞춰 안내하세요.`;
    } else if (productContext.length) {
      flagBlock += `\n\n[비지목] 사용자는 특정 제품을 언급하지 않았습니다. [제품 데이터]의 후보 중 하나를 골라 "이 제품은 권하지 않아요" 식의 단수 평결을 하지 마세요 — 추천 질의에는 추천(성분 우선 상위)으로 답합니다. 후보군에 사용자 상황과 안 맞는 제품(예: 어린이용)이 섞여 있어도 그것을 평결 대상으로 삼지 말고 조용히 제외하세요.`;
      // [v15.8] 명시적 수유/임신으로 여성 세그먼트가 걸렸을 때(제품 미지목) 프레이밍.
      if (targetSegment === "여성") flagBlock += `\n\n[여성 대상] 사용자가 수유/임신을 밝혀 [제품 데이터]를 여성(질유래·임산부·수유부) 유산균으로 좁혔습니다. "임산부·수유부용으로 골라드릴게요" 같이 대상을 밝히고 이 안에서 상위 3개를 추천하세요.`;
      if (targetSegment === "키즈") flagBlock += `\n\n[어린이 대상] 사용자가 어린이용을 찾아 [제품 데이터]를 어린이(키즈) 유산균으로 좁혔습니다. "어린이 유산균 중에서 골라드릴게요" 같이 대상을 밝히고 이 안에서 상위 3개를 추천하세요. 나이를 되묻지 마세요(Q 금지).`;
    }
    // [v15.8] 안전 프로필(아기엄마 등)이되 아직 수유/임신을 명시하지 않았고 유산균이면:
    // "수유 중이세요?"라고 되묻지(Q) 말고, 일반 유산균 상위 3개를 바로 추천(V)한 뒤,
    // "수유/임신 중이시면 여성·임산부용으로 다시 추천드릴게요"라고 안내하고 칩으로 길을 연다.
    if (matchedCategory === "probiotics" && SAFETY_PROFILE_RE.test(userText) && !EXPLICIT_MATERNAL_RE.test(userText) && targetSegment !== "여성") {
      flagBlock += `\n\n[안전 프로필] 출산/육아 정황이 보입니다. 하지만 수유·임신 여부를 "수유 중이세요?"처럼 되묻지 마세요(Q 금지). 대신 policy V로 유산균 상위 3개를 바로 추천하고, warning에 "수유 중이거나 임신 중이시면 여성·임산부용 유산균으로 다시 추천해 드릴게요"를 넣으세요. chips에 "수유 중이에요", "임신 중이에요"를 포함하고, chips_prompts는 각각 "수유 중이에요", "임신 중이에요"로 두세요(누르면 여성용으로 재추천됩니다). 유산균은 대부분 수유부에 안전하니 겁주지 마세요.`;
    }
    if (detectedRisks.length) flagBlock += `\n\n[내부 플래그] 위험 페르소나 감지: ${detectedRisks.join(", ")} → W 플래그 적용, warning 필수.`;
    if (matchedCategory) flagBlock += `\n\n[대상 카테고리] ${CAT_LABEL[matchedCategory]}`;
    else if (explicitMultiCats) flagBlock += `\n\n[복수 카테고리] 사용자가 여러 카테고리(${explicitMultiCats.join(", ")})를 한 번에 물었습니다. 한 응답에 다 담지 말고 Q 정책으로 "어느 쪽부터 볼까요?"라고 하나만 되물으세요. chips는 ${explicitMultiCats.map(c => `"${c}"`).join(", ")}와 "다 궁금해요"로, chips_prompts는 각 카테고리의 추천 요청 문장(예: "${explicitMultiCats[0]} 추천해줘")으로 두세요. 카운셀링은 한 번에 한 카테고리를 깊게 봅니다 — 사과하지 말고 자연스럽게 하나씩 안내하세요.`;
    else if (hintDomain) flagBlock += `\n\n[내부 플래그] 4개 카테고리 밖 도메인(${hintDomain}) 질문 가능성 → X 정책 검토. 단, 병용 질문이면 답변.`;
    else if (productLookupFailed) flagBlock += `\n\n[제품 미발견] 사용자가 특정 제품을 언급한 것 같으나 오메가3·눈·유산균·비타민C 데이터에서 찾지 못했습니다. Q 정책으로 "혹시 어느 카테고리 제품인가요?"라고 되물으세요. 칩: 오메가3·눈 건강·유산균·비타민C + "잘 모르겠어요". 범위 밖(X)으로 단정하지 마세요.`;
    else if (ambiguousCats) flagBlock += `\n\n[내부 플래그] 카테고리 모호(${ambiguousCats.join(" vs ")}) → Q 정책으로 칩 되묻기 권장. 칩은 해당 카테고리들 + "잘 모르겠어요".`;
    if (demographics.age || demographics.gender) flagBlock += `\n\n[사용자 정보] ${demographics.age ? demographics.age + "대" : ""} ${demographics.gender === "female" ? "여성" : demographics.gender === "male" ? "남성" : ""}`.trim();
    if (forcedAxis && matchedCategory && QUALITY_CFG[matchedCategory] && productContext.length) {
      flagBlock += `\n\n[축 강제] 사용자가 '${forcedAxis.label}' 기준을 명시했습니다. 직전 턴에서 어떤 기준을 썼든 계승하지 말고, 이번 추천은 반드시 ${forcedAxis.axis} 순으로 고르세요. 목록을 제시하면 alternatives_note에 "${forcedAxis.label}"임을 밝히세요.`;
      if (doseIntent && forcedAxis.axis === "rank_quality") {
        flagBlock += `\n\n[함량 통념 교정] 사용자가 함량을 언급했지만 순수 함량순은 제공하지 않습니다. 근거 용량(${QUALITY_CFG[matchedCategory].anchorLabel})을 넘으면 함량 차이는 의미 없다는 점을 한 마디로 짚고, 성분 우선(품질점수)으로 안내하세요. 함량만 높고 품질이 처지는 제품을 1위로 올리지 마세요.`;
      }
    }

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
      // 프롬프트 캐싱: 시스템 프롬프트(페르소나·5정책·산식 설명, ~2,800토큰)는 매 호출 100% 동일하다.
      // 캐시 블록으로 표시하면 같은 프롬프트를 5분 내 재호출 시 이 부분 입력 단가가 0.1배로 떨어진다
      // (첫 기록만 1.25배). 상담은 멀티턴이라 2번째 턴부터 바로 절감. 캐시 최소 길이(Sonnet 1,024토큰) 충족.
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: claudeMessages
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

  // ─── [C가드] 화자 발화 규칙 기계 검출 ────────────────
  // 규칙 체크리스트의 🟦 항목을 응답 텍스트에서 검출한다. 이 버전은 "검출→debug 노출"만 한다
  // (검증 안 된 정규식으로 라이브 발화를 자동 수정하면 문장을 깨뜨릴 위험). 검출 결과가 안정적이면
  // 안전한 항목만 자동 수정으로 승격한다. 목적: 사람이 찾던 위반을 시스템이 먼저 표시.
  function checkSpeakerRules(pl, cat) {
    // 화자 산문(body·warning·verdict·default_answer)만 검사한다. alternatives[].reason은
    // 코드가 buildReason으로 생성(항상 정제된 인증명)하므로 검사에서 제외 — 포함하면 카드 이유가
    // body의 위반을 가린다.
    const parts = [pl.body, pl.warning, pl.verdict, pl.default_answer].filter(Boolean);
    const text = parts.join("\n");
    const v = [];
    // 3.3 내부 품질 점수(숫자) 노출 — "점수 97" / "97점"류. 함량(100억·1000mg·1764원)·순위(97위)는 제외.
    if (/점수\s*(?:는|가|를|이)?\s*\d{1,3}(?:\.\d)?/.test(text) ||
        /\d{2,3}(?:\.\d)?\s*점(?!\s*(?:포|정|캡슐|알|이상|위))/.test(text)) v.push("score_number(3.3)");
    // 3.5 "인증"이 성격 이름 없이 단독 — 허용 형태(제조/안전/주요성분 품질/성분/품질 인증, Non-GMO)가
    //     하나도 없이 "인증"만 등장하면 플래그.
    if (/인증/.test(text) && !/(제조|안전|주요성분\s*품질|성분|품질)\s*인증|non-?gmo/i.test(text)) v.push("bare_cert(3.5)");
    // 3.6 제거 대상 인증(종교·미국·식이) 등장 — 데이터에선 제거됐으나 환각/제품명 유입 감시.
    if (/할랄|코셔|halal|kosher|\bgras\b|\bfda\b|vegan|비건|v-?label|mui\b/i.test(text)) v.push("removed_cert(3.6)");
    // 1.1 면허 직군 자칭·암시.
    if (/(제가|저는|저희는)?\s*(약사|의사|영양사|한약사)\s*(입니다|이에요|예요|랍니다|로서|로써)|처방(해\s*드릴|을\s*내려|해\s*줄)/.test(text)) v.push("license_claim(1.1)");
    // 3.8 근거 없는 성분-효능 연결(휴리스틱): 우리 카테고리가 아닌 성분을 "좋다"고 연결. 약한 신호만.
    //     (의미 판정은 B 검수 몫; 여기선 대표 오연결 패턴만.)
    if (cat && /수유|임신/.test(text) && new RegExp(`(오메가3|루테인|비타민c).{0,10}(좋|도움|효과)`, "i").test(text) && cat !== "omega3") v.push("weak_link(3.8)");
    return v;
  }

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
      // 카테고리별 결함 게이트·대안 재정렬에 쓸 설정과 reason 빌더 (recommend2 앵커 기준).
      const cfg2 = matchedCategory ? QUALITY_CFG[matchedCategory] : null;
      const buildReason = (p) => {
        const bits = [];
        if (cfg2 && p.primary_mg != null) bits.push(`${cfg2.primaryLabel} ${p.primary_mg.toLocaleString()}${cfg2.unit}`);
        if (p.daily_cost) bits.push(`하루 ${p.daily_cost.toLocaleString()}원`);
        const certTxt = classifyCerts(p.certs);
        if (certTxt) bits.push(certTxt.split(",")[0].trim());
        return bits.join(" · ");
      };
      if (payload.verdict_tone === "negative" && cfg2) {
        const anchor = cfg2.anchor;
        const byId = new Map(productContext.map(p => [String(p.product_id), p]));
        payload.alternatives = payload.alternatives.filter(a => {
          const p = byId.get(String(a.product_id));
          return !p || p.primary_mg == null || p.primary_mg >= anchor;
        });
        // 백필: 자격(임상 앵커 이상) 갖춘 대안이 2개 미만이면 채운다(최소 2개 보장).
        if (payload.alternatives.length < 2) {
          const have = new Set(payload.alternatives.map(a => String(a.product_id)));
          const mentionedId = productMatchRecord
            ? String(getField(productMatchRecord.fields || {}, "product_id", "productId") || productMatchRecord.id)
            : null;
          const fillers = productContext.filter(p =>
            p.primary_mg != null && p.primary_mg >= anchor &&
            !have.has(String(p.product_id)) && String(p.product_id) !== mentionedId
          ).slice(0, 3 - payload.alternatives.length);
          for (const p of fillers) payload.alternatives.push({ product_id: p.product_id, name: p.name, reason: buildReason(p) });
        }
        if (payload.alternatives.length && !payload.alternatives_note) payload.alternatives_note = `${cfg2.anchorLabel} 이상 · 성분 우선순`;
      }
      // negative인데 대안이 비면 비교 페이지 안내를 body에 보강
      if (payload.verdict_tone === "negative" && payload.alternatives.length === 0 && payload.body.indexOf("비교") === -1) {
        payload.body += "\n\n같은 카테고리의 상위 제품은 ingredi 비교 페이지에서 확인하실 수 있어요.";
      }
      // [v15.7] 일반 추천(추천 질의)에는 성분/가성비 상위 3개를 항상 채운다.
      // LLM이 1개만 주거나 비워서 카드가 안 뜨거나 1개만 보이던 문제. 특정 제품을 물은 평결
      // (productMatchRecord 있음)은 그 제품 1개가 맞으므로 제외. 부정 평결은 위에서 이미 처리.
      if (payload.policy === "V" && (payload.verdict_tone === "positive" || payload.verdict_tone === "conditional") && !productMatchRecord && cfg2 && productContext.length) {
        const axKey = (forcedAxis || AXIS_KEYWORDS[0]);
        const top3 = productContext.filter(p => p[axKey.axis] != null).sort((a, b) => a[axKey.axis] - b[axKey.axis]).slice(0, 3);
        if (top3.length) {
          const prior = new Map((payload.alternatives || []).map(a => [String(a.product_id), a]));
          payload.alternatives = top3.map(p => {
            const had = prior.get(String(p.product_id));
            return { product_id: p.product_id, name: p.name, reason: (had && had.reason) ? had.reason : buildReason(p) };
          });
          if (!payload.alternatives_note) payload.alternatives_note = `${axKey.label} 상위 ${payload.alternatives.length}개`;
        }
      }

      // conditional인데 warning이 비면 톤 강등
      if (payload.verdict_tone === "conditional" && !payload.warning) payload.verdict_tone = "none";
      if (payload.policy !== "M") payload.handoff = null;

      // 대안 정렬 축 확정: 명시 축(forcedAxis)이 있으면 그 축, 없고 부정 평결이면 성분 우선을
      // 기본 축으로 둔다. 화자가 부정 평결 대안에 가성비 제품을 섞지 못하게 코드가 순서를 확정.
      // (rank_*는 전체 모집단 기준, productContext는 각 축 상위 8 포함 → 상위 3 정확.)
      const effectiveAxis = forcedAxis || (payload.verdict_tone === "negative" ? AXIS_KEYWORDS[0] : null);
      if (effectiveAxis && cfg2 && productContext.length &&
          payload.policy === "V" && Array.isArray(payload.alternatives) && payload.alternatives.length >= 2) {
        const rk = effectiveAxis.axis;
        let ranked = productContext.filter(p => p[rk] != null);
        // 부정 평결이면 결함 해결(임상 앵커 이상) 자격을 유지한다.
        if (payload.verdict_tone === "negative") ranked = ranked.filter(p => p.primary_mg == null || p.primary_mg >= cfg2.anchor);
        ranked = ranked.sort((a, b) => a[rk] - b[rk]).slice(0, 3);
        if (ranked.length >= 2) {
          const prior = new Map(payload.alternatives.map(a => [String(a.product_id), a]));
          payload.alternatives = ranked.map(p => {
            const had = prior.get(String(p.product_id));
            if (had && had.reason) return { product_id: p.product_id, name: p.name, reason: had.reason };
            return { product_id: p.product_id, name: p.name, reason: buildReason(p) };
          });
          payload.alternatives_note = (payload.verdict_tone === "negative")
            ? `결함 해결 · ${effectiveAxis.label} 상위 ${payload.alternatives.length}개`
            : `${effectiveAxis.label} 상위 ${payload.alternatives.length}개`;
        }
      }
    }

    // ─── [11] 응답 ──────────────────────────────────
    const guardViolations = checkSpeakerRules(payload, matchedCategory);
    const meta = {
      category: matchedCategory ? CAT_KO[matchedCategory] : null,
      healthDomain: hintDomain,
      ambiguousCats,
      demographics,
      detectedRisks,
      categoryOptions: (!matchedCategory && !productMatchRecord) ? CATEGORY_OPTIONS : null,
      guard: guardViolations.length ? guardViolations : undefined,
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
      matchedCategory, hintDomain, productLookupFailed, targetSegment,
      forcedAxis: forcedAxis ? forcedAxis.axis : null, doseIntent,
      askedBefore, rawLen: rawText.length, fallback: !!payload.contract_fallback
    };
    return respond(payload, meta);

  } catch (error) {
    return new Response(JSON.stringify({ error: "internal_error", message: error.message }), { status: 500, headers });
  }
}
