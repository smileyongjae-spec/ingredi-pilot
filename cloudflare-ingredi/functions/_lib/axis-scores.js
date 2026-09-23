// functions/_lib/axis-scores.js — 건강기능식품 core·축 점수 규칙 (v2.4, 2026-09-23)
// [v2.4] 유산균 PROBIOTICS_V2 확정 — [Core 0.6] + [개별인정 0.1] + [균주 strain 표기 0.2] + [인증 0.1].
//        2026-09-22 마이크로바이옴 DB(균주명·인체적용시험·개별인정 컬럼)로 185개 시뮬레이션 후 결정.
//        · 개별인정(on/off): 식약처 개별인정형 원료면 100, 아니면 0 — 기능성 종류 구분 없이 전부 on.
//        · strain 표기(on/off): 균주명에 균주 코드(LGG·CBT-BG7·LA-11 등)가 있으면 100, 속·종만이면 0.
//        · 균주 종류 수·인체적용시험 표기는 점수 아님 — 카드 정보(probioticInfo)로만 낸다.
//          (균주 수는 가격·균수와 무상관(-0.16/-0.07), 인체적용시험 컬럼은 "상세설명에 결과가 있는 경우"라 광고 성실도 지표)
//        · 결과 분포(185개): A 12(전부 개별인정) / B 36(100억+strain) / C 16 / D 15 / E 105. 현행 A 9개는 B로.
//        · 알려진 한계: 균수 50억 이하 개별인정(질 유산균 등)은 C, 갱년기 유산균(1억)은 E — 100억 앵커의 문제, 별도 아젠다.
// [v2.3] 인증 가산 교정(팩트체크 반영): GMP 20→10 — 국내 건기식은 2020년부터 GMP 전면 의무라
//        변별 요소가 아니며 표기 성실성 수준의 가점만 남긴다. HACCP 5→0(삭제) — 일반식품 인증으로
//        건기식 제도와 무관. BPOM 5→0(삭제) — 국내 소비자 변별력 없음. 자발적 3rd party
//        (IFOS·GOED·NSF·NDI·QPS·GRAS)와 국제 FSMS(ISO22000)는 유지. 적용 시 일부 제품 등급 이동 가능.
// [v2.2] 유산균 임시 산식 [Core 0.8]+[인증 0.2] — 제형점수 의존 제거(병합 불필요).
// [v2.1] 눈 core: 루테인+지아잔틴 합산(ANCHORS.눈.multi[0].addFields) — 근거는 아래 주석 참조.
//
// 기준표 v2.1(세부등급 기준표)을 그대로 코드로 옮긴 것. 모든 숫자는 아래 상수에 있으므로 결정이 바뀌면
// 상수만 고친다. 규칙의 사람이 읽는 판본은 문서(ingredi_세부등급_기준표_v2.1)이며 둘은 항상 같아야 한다.
//
// 검수 잣대(9/11~14): ① 앵커 출처 식약처→복지부→연구 ② 검증 가능한 사실만 축으로, 원산지·제조사 주장은 정보
//   ③ 미표기: 함량 보류 / 부축 최하의 50% / 인증 0 ④ 복합 제품 core = 하한 이상 표방 성분 core의 평균
//   ⑤ 이중 계산 경계 ⑥ 복수 표기는 주원료 기준 ⑦ 인증은 종류별 가산, 배합 속성 0
//
// 내보내는 것
//   coreOf(cat, f)     → { core, label, value, unit, claimed:[...], overLimit } | null(함량 미표기 → 보류)
//   probioticInfo(f)   → { strainCount, strainCoded, individual, individualLabel, humanTrial }  (유산균 카드 정보)
//   axisScores(cat, f) → { form, supplier, cert }  (해당 축이 없는 카테고리는 null 값)
//   qualityOf(cat, f, external) → { core, form, supplier, cert, quality, grade, holdReason, label, value, unit, claimed, overLimit }
//
// external = Airtable 점수 컬럼 값({form,supplier,cert}) — 규칙이 없는 축(유산균 v1 제형점수)만 사용.

const S = v => (v == null ? "" : String(v)).trim();
const N = v => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : null; };
const has = v => { const t = S(v); return t !== "" && t !== "-" && t.toUpperCase() !== "NAN"; };
const half = v => Math.round(v * 0.5);

// ───────────────────────── 앵커 (core) ─────────────────────────
// 출처 ①식약처 ②복지부 ③연구. 상한(limit)은 감점 없이 경고 배지.
export const ANCHORS = {
  "오메가3":       { fields: ["EPA_DHA_mg", "EPA+DHA_mg"], anchor: 1000, limit: 2000, label: "EPA+DHA", unit: "mg", source: "식약처 일일섭취량 500~2,000mg 중 1,000mg" },
  "마이크로바이옴": { fields: ["보장균수_억"],               anchor: 100,  limit: null, label: "보장균수", unit: "억", source: "식약처 일일섭취량 1억~100억 CFU 중 상한 100억" },
  "비타민C":       { fields: ["비타민C함량_mg"],            anchor: 1000, limit: 2000, label: "비타민C", unit: "mg", source: "보건복지부 섭취기준 내 보충 목적 1,000mg (식약처 별도 기준 없음)" },
  // 눈: 표방 성분 평균 — 루테인(≥10mg ÷ 20) · 아스타잔틴(≥4mg ÷ 12). 지아잔틴은 식약처 단독 기준 없음 → 정보.
  // [2026-09-14] 루테인+지아잔틴 합산. 근거: 고시형 루테인(마리골드꽃추출물) "루테인으로서 10~20mg"과
  //   개별인정형 루테인지아잔틴복합추출물(인정 2018-4) "루테인과 지아잔틴의 합으로서 10~20mg"의 상한이 20으로 같다.
  //   제품이 어느 원료를 썼는지 구분할 컬럼(기능성원료명·인정번호)이 아직 없어 잠정 통합 적용 — 컬럼 확보 시 제품별 앵커로 전환
  //   (개별인정 중 합 12~30mg(2025-35), 12mg(DSM) 등 다른 상한 존재).
  "눈": { multi: [
    { key: "루테인·지아잔틴", fields: ["루테인_mg"], addFields: ["지아잔틴_mg"], anchor: 20, min: 10, unit: "mg", source: "고시형 루테인 10~20mg / 개별인정 복합추출물 합 10~20mg" },
    { key: "아스타잔틴",     fields: ["아스타잔틴_mg"],                          anchor: 12, min: 4,  unit: "mg", source: "고시형 헤마토코쿠스추출물 4~12mg 상한" }
  ], label: "루테인·지아잔틴", unit: "mg", source: "식약처 — 표방 성분별 앵커 평균" }
};

function readNum(f, fields) { for (const k of fields) { const n = N(f[k]); if (n != null) return n; } return null; }

export function coreOf(cat, f) {
  const a = ANCHORS[cat]; if (!a) return null;
  if (a.multi) {
    const claimed = [];
    for (const m of a.multi) {
      let v = readNum(f, m.fields);
      // addFields: 같은 기능성으로 합산하는 성분(눈 — 지아잔틴). 주성분이 있을 때만 더한다.
      if (v != null) for (const k of (m.addFields || [])) { const add = N(f[k]); if (add != null) v += add; }
      if (v != null && v >= m.min) claimed.push({ key: m.key, value: v, core: Math.min(v / m.anchor, 1) * 100, unit: m.unit });
    }
    if (!claimed.length) return null;                           // 표방 성분 없음 → 함량 미표기 → 보류
    const core = claimed.reduce((s, c) => s + c.core, 0) / claimed.length;
    const main = claimed.slice().sort((x, y) => y.core - x.core)[0];
    return { core, label: main.key, value: main.value, unit: main.unit, claimed: claimed.map(c => c.key), overLimit: false };
  }
  const v = readNum(f, a.fields);
  if (!(v > 0)) return null;
  return { core: Math.min(v / a.anchor, 1) * 100, label: a.label, value: v, unit: a.unit, claimed: [a.label], overLimit: !!(a.limit && v > a.limit) };
}

// ───────────────────────── 축 규칙 ─────────────────────────
// 오메가3 제형: rTG 100 / nTG·MAG·MEG-3 75 / EE 50 / 미기재 25(최하 50의 50%)
const OMEGA_FORM = { rtg: 100, ntg: 75, ee: 50, none: half(50) };
function omegaForm(raw) {
  const t = S(raw).toUpperCase();
  if (!has(t)) return OMEGA_FORM.none;
  if (/RTG|R-TG|알티지|재에스테르/.test(t)) return OMEGA_FORM.rtg;
  if (/\bEE\b|에틸/.test(t)) return OMEGA_FORM.ee;
  return OMEGA_FORM.ntg;                                        // nTG · TG · 자연형 · MAG · MEG-3 등
}
// 원료사 3단 (브랜드 원료 85 / 그 외 표기 70 / 미기재 35) — 원산지 단계 폐지
const BRAND = {
  "오메가3": /DSM|KD\s*PHARMA|KD-?PUR|SOLUTEX|GC\s*RIEBER|VIVO\s*MEGA|VIVOMEGA|EPAX/i,
  "눈":      /FLORAGLO|KEMIN|LUTEMAX|OMNIACTIVE|ASTAPURE|ALGATECH|ASTAREAL|ALGAMO|ALGA\s*TECH/i,
  "비타민C":  /DSM|QUALI-?C|VALIMENTA/i,
  "마이크로바이옴": /DUPONT|IFF|DANISCO|CHR\.?\s*HANSEN|PROBI|LALLEMAND|SABINSA/i
};
const SUPPLIER = { brand: 85, listed: 70, none: half(70) };
function supplierScore(cat, raw) {
  const t = S(raw); if (!has(t)) return SUPPLIER.none;
  return (BRAND[cat] && BRAND[cat].test(t)) ? SUPPLIER.brand : SUPPLIER.listed;
}
// 인증 가산표 (상한 100). [정규식, 점수, 태그]. 배합 속성(Halal·Kosher·Non-GMO·Vegan 등)은 표에 없으므로 0.
const CERT_TABLES = {
  "오메가3": [
    [/IFOS\s*5/i, 55, "IFOS5"], [/IFOS/i, 40, "IFOS"], [/GOED/i, 25, "GOED"], [/C?GMP/i, 10, "GMP"], [/NSF/i, 15, "NSF"], [/MSC/i, 15, "MSC"],
    [/ISO\s*22000|FSSC\s*22000/i, 15, "ISO22000"], [/IFFO|MARIN\s*TRUST/i, 10, "IFFO"],
    [/\bFOS\b|FRIEND/i, 15, "FOS"]
  ],
  "마이크로바이옴": [
    [/FDA\s*NDI|EFSA\s*QPS/i, 20, "REG"], [/C?GMP/i, 10, "GMP"], [/GRAS/i, 15, "GRAS"], [/ISO\s*22000|FSSC?\s*22000/i, 15, "ISO22000"], [/NSF/i, 15, "NSF"]
  ],
  "비타민C": [
    [/NSF/i, 20, "NSF"], [/C?GMP/i, 10, "GMP"], [/ISO\s*22000|FSSC\s*22000/i, 15, "ISO22000"]
  ]
};
function certScore(cat, raw) {
  const table = CERT_TABLES[cat]; const s = S(raw);
  if (!table || !has(s)) return 0;
  const tokens = s.split(/[,/·]/).map(t => t.trim()).filter(Boolean);
  const hit = new Map();
  for (const tok of tokens) {
    for (const [re, pts, tag] of table) { if (re.test(tok)) { if (!hit.has(tag)) hit.set(tag, pts); break; } }
  }
  if (cat === "오메가3") {
    if (hit.has("IFOS5")) hit.delete("IFOS");                   // 5-Star는 IFOS를 포함
    if (hit.has("FOS") && (hit.has("IFOS5") || hit.has("IFOS"))) hit.delete("FOS");   // IFOS 보유 시 FOS 미가산
  }
  let total = 0; for (const v of hit.values()) total += v;
  return Math.min(total, 100);
}

export function axisScores(cat, f) {
  switch (cat) {
    case "오메가3":       return { form: omegaForm(f.제형), supplier: supplierScore(cat, f.원료사), cert: certScore(cat, f.인증) };
    case "눈":           return { form: null, supplier: supplierScore(cat, f.원료사), cert: null };
    case "비타민C":       return { form: null, supplier: supplierScore(cat, f.원료사), cert: certScore(cat, f.인증) };
    case "마이크로바이옴": return { form: null, supplier: null, cert: certScore(cat, f.인증) };
    default: return null;
  }
}

// ───────────────────────── 등급 산식 ─────────────────────────
// 유산균은 균주 근거 축(인정유형·균주명 컬럼) 도입 전까지 임시 산식 [Core × 0.8] + [인증 × 0.2].
// [2026-09-16] 옛 제형점수 병합(v1)은 폐기 — "제형·안정성은 점수가 아니라 정보"라는 결정과 모순이었다. 병합 불필요.
export const PROBIOTICS_V2 = true;   // [v2.4] 확정
export const QUALITY = {
  "오메가3":       { core: 0.5,  form: 0.3, supplier: 0,   cert: 0.2 },
  "눈":           { core: 0.7,  form: 0,   supplier: 0.3, cert: 0 },
  "비타민C":       { core: 0.6,  form: 0,   supplier: 0.3, cert: 0.1 },
  "마이크로바이옴": PROBIOTICS_V2 ? { core: 0.6, form: 0, supplier: 0, cert: 0.1, individual: 0.1, strain: 0.2 } : { core: 0.8, form: 0, supplier: 0, cert: 0.2 }
};
export const GRADE_CUTS = [["A", 85], ["B", 70], ["C", 55], ["D", 40]];
export function gradeOf(q) { if (q == null) return null; for (const [g, c] of GRADE_CUTS) if (q >= c) return g; return "E"; }

// ───────────────────────── 유산균 근거 축·카드 정보 ─────────────────────────
// Airtable 컬럼명이 길고 괄호 설명이 붙어 있어(예: "개별인정 원료(상세설명에 …)") 접두어로 찾는다.
function fieldByPrefix(f, ...prefixes) {
  for (const p of prefixes) {
    if (f[p] !== undefined) return f[p];
    const k = Object.keys(f).find(key => key.replace(/\s+/g, "").startsWith(p.replace(/\s+/g, "")));
    if (k) return f[k];
  }
  return undefined;
}
const YES = v => { const t = S(v).toUpperCase(); return t === "Y" || t === "O" || t === "YES" || t === "TRUE" || t === "CHECKED" || v === true; };
// 균주 코드 표기: 라틴 약어+숫자(LA-11, CBT-BG7, HY7601), 또는 관용 코드(LGG, BB-12, DDS-1).
const STRAIN_CODE_RE = /[A-Za-z]{1,6}[-\s]?\d{2,}|\bLGG\b|\bBB-?12\b|DDS-?1|CBT-|\bGG\b/;
export function probioticInfo(f) {
  const name = S(f.균주명);
  const parts = name.replace(/\n/g, ",").split(",").map(t => t.trim()).filter(t => t && t !== "-" && t !== "무");
  const individual = YES(fieldByPrefix(f, "개별인정 원료", "개별인정")) || /개별/.test(S(f.인정유형));
  const func = S(f.주된기능성);
  // 개별인정 기능성 이름 — 주된기능성 문구에서 대표 키워드로 표시(없으면 "개별인정")
  const FUNC_LABELS = [[/체지방/, "체지방 감소"], [/갱년기/, "갱년기 여성 건강"], [/질내|질\s*건강/, "질 건강"], [/코\s*상태|면역과민/, "코 상태 개선"],
    [/운동수행/, "운동수행능력"], [/요로/, "요로 건강"], [/헬리코박터|위\s*건강/, "위 건강"], [/간\s*건강/, "간 건강"], [/장\s*면역|장\s*건강|배변|유익균/, "장 건강"]];
  let individualLabel = null;
  if (individual) { const hit = FUNC_LABELS.find(([re]) => re.test(func)); individualLabel = hit ? hit[1] : "개별인정"; }
  return {
    strainCount: parts.length || null,
    strainCoded: has(name) && STRAIN_CODE_RE.test(name),
    individual,
    individualLabel,
    humanTrial: YES(fieldByPrefix(f, "인체적용시험 결과 여부", "인체적용시험"))
  };
}
function strainScore(f) { return probioticInfo(f).strainCoded ? 100 : 0; }     // [v2.4] on/off
function individualScore(f) { return probioticInfo(f).individual ? 100 : 0; }   // [v2.4] on/off

export function qualityOf(cat, f, external) {
  const w = QUALITY[cat]; if (!w) return null;
  const c = coreOf(cat, f);
  const base = { label: (ANCHORS[cat] || {}).label || null };
  if (!c) return { ...base, core: null, quality: null, grade: null, holdReason: "함량 미표기" };
  const ax = axisScores(cat, f) || {}; const ext = external || {};
  let q = w.core * c.core; const parts = { core: Math.round(c.core * 10) / 10 };
  if (w.form) {
    const v = ax.form != null ? ax.form : (ext.form != null ? ext.form : null);
    if (v == null) return { ...base, label: c.label, core: parts.core, quality: null, grade: null, holdReason: "제형 점수 없음" };
    parts.form = v; q += w.form * v;
  }
  if (w.supplier) { const v = ax.supplier != null ? ax.supplier : (ext.supplier != null ? ext.supplier : SUPPLIER.none); parts.supplier = v; q += w.supplier * v; }
  if (w.cert) { const v = ax.cert != null ? ax.cert : (ext.cert != null ? ext.cert : 0); parts.cert = v; q += w.cert * v; }
  if (w.individual) { const v = individualScore(f); parts.individual = v; q += w.individual * v; }   // [v2.4]
  if (w.strain) { const v = strainScore(f); parts.strain = v; q += w.strain * v; }
  const quality = Math.round(q * 10) / 10;
  return { ...parts, quality, grade: gradeOf(quality), holdReason: null, label: c.label, value: c.value, unit: c.unit, claimed: c.claimed, overLimit: c.overLimit };
}
