// functions/_lib/axis-scores.js — 건강기능식품 core·축 점수 규칙 (v2.1, 2026-09-14)
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
    [/IFOS\s*5/i, 55, "IFOS5"], [/IFOS/i, 40, "IFOS"], [/GOED/i, 25, "GOED"], [/C?GMP/i, 20, "GMP"], [/NSF/i, 15, "NSF"], [/MSC/i, 15, "MSC"],
    [/ISO\s*22000|FSSC\s*22000/i, 15, "ISO22000"], [/IFFO|MARIN\s*TRUST/i, 10, "IFFO"], [/HACCP/i, 5, "HACCP"],
    [/\bFOS\b|FRIEND/i, 15, "FOS"]
  ],
  "마이크로바이옴": [
    [/FDA\s*NDI|EFSA\s*QPS/i, 20, "REG"], [/C?GMP/i, 20, "GMP"], [/GRAS/i, 15, "GRAS"], [/ISO\s*22000|FSSC?\s*22000/i, 15, "ISO22000"], [/NSF/i, 15, "NSF"],
    [/HACCP/i, 5, "HACCP"], [/BPOM/i, 5, "BPOM"]
  ],
  "비타민C": [
    [/NSF/i, 20, "NSF"], [/C?GMP/i, 20, "GMP"], [/ISO\s*22000|FSSC\s*22000/i, 15, "ISO22000"], [/HACCP/i, 5, "HACCP"]
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
export const PROBIOTICS_V2 = false;
export const QUALITY = {
  "오메가3":       { core: 0.5,  form: 0.3, supplier: 0,   cert: 0.2 },
  "눈":           { core: 0.7,  form: 0,   supplier: 0.3, cert: 0 },
  "비타민C":       { core: 0.6,  form: 0,   supplier: 0.3, cert: 0.1 },
  "마이크로바이옴": PROBIOTICS_V2 ? { core: 0.45, form: 0, supplier: 0, cert: 0.2, strain: 0.35 } : { core: 0.8, form: 0, supplier: 0, cert: 0.2 }
};
export const GRADE_CUTS = [["A", 85], ["B", 70], ["C", 55], ["D", 40]];
export function gradeOf(q) { if (q == null) return null; for (const [g, c] of GRADE_CUTS) if (q >= c) return g; return "E"; }

const STRAIN = { individual: 100, coded: 70, species: 40, none: half(40) };
function strainScore(f) {
  const t = S(f.인정유형); const name = S(f.균주명);
  if (/개별/.test(t)) return STRAIN.individual;
  if (has(name) && /[A-Z]{1,4}[-\s]?\d{2,}|LGG|BB-?12/i.test(name)) return STRAIN.coded;
  if (has(name)) return STRAIN.species;
  return STRAIN.none;
}

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
  if (w.strain) { const v = strainScore(f); parts.strain = v; q += w.strain * v; }
  const quality = Math.round(q * 10) / 10;
  return { ...parts, quality, grade: gradeOf(quality), holdReason: null, label: c.label, value: c.value, unit: c.unit, claimed: c.claimed, overLimit: c.overLimit };
}
