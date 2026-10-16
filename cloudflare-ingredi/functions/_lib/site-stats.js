// functions/_lib/site-stats.js  v1.1  (2026-10-17)
// v1.1: 기준일 = 사이트에 보이는 제품 정보가 실제로 바뀐 마지막 날(갱신 주 2~3회, Oliver 2026-10-17 B안).
//       종류별 제품 목록의 표시 항목(가격·하루 비용·등급·함량·원료사·인증 등)을 지문(fp)으로 요약해 어제와 비교. 변경 없는 날은 날짜를 올리지 않는다
// 사이트 설명 숫자(종류별 제품 수·하루 비용 범위·가운데 값·기준일) 자동 반영 — Oliver 승인 2026-10-17(사전 승인 없이 매일 반영, 데일리 보고에 내용만 추가)
//   1) ops-collect가 매일 refreshSiteStats()로 /recommend2·/sports-api(사람이 보는 목록과 같은 값)를 읽어 KV site_stats_v1에 저장
//   2) functions/_middleware.js가 /, /app, /about, /consult, /sports, /llms.txt 응답에서 숫자를 KV 값으로 바꿔 내보낸다
//      정적 파일의 숫자는 KV가 비었을 때의 대체값(2026-10-17 값)
// 안전장치: 한 종류라도 0개·조회 실패이거나, 제품 수가 전날보다 50% 넘게 변하면 반영하지 않고 '보류'로 남긴다
//   (상태 문구에 '실패'를 쓰지 않는다 — 수집상태의 '실패'는 광고 자율 실행 멈춤 조건이라서)

export const HEALTH = [
  ['오메가3', '오메가3'], ['마이크로바이옴', '유산균'], ['눈', '눈 건강'], ['비타민C', '비타민C'], ['밀크씨슬', '밀크씨슬'],
];
export const SPORTS = ['단백질', '크레아틴', '아미노산', '부스터', '카르니틴'];
const KV_KEY = 'site_stats_v1';
const KV_LOG = 'site_stats_log_v1';

const won = (n) => Math.round(n).toLocaleString('en-US');

// 사이트에 보이는 항목만 골라 지문을 만든다(FNV-1a 32bit). 이미지·링크처럼 화면 내용과 무관한 값은 뺀다
const FP_KEYS = ['id', 'name', 'price', 'dailyCost', 'grade', 'vScore', 'qualityGrade', 'quality', 'form', 'supplier', 'certs',
  'primaryValue', 'capsuleMg', 'dailyCapsules', 'reviewCount', 'function', 'mfdsFunction', 'flavor'];
function fp(products) {
  const rows = products.map((x) => FP_KEYS.map((k) => (x[k] == null ? '' : String(x[k]))).join('|')).sort();
  let h = 0x811c9dc5;
  const str = rows.join('\n');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

function dist(arr) {
  const a = arr.map(Number).filter((x) => x > 0).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  return { min: Math.round(a[0]), med: Math.round(m), max: Math.round(a[a.length - 1]) };
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'ingredi-site-stats/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${new URL(url).pathname}`);
  return r.json();
}

// 사이트 API로 지금 사람이 보는 값을 센다
export async function computeStats(origin) {
  const health = {}, sports = {};
  for (const [key] of HEALTH) {
    const j = await getJson(`${origin}/recommend2?category=${encodeURIComponent(key)}`);
    const p = j.products || [];
    health[key] = { n: p.length, fp: fp(p), ...(dist(p.map((x) => x.dailyCost)) || {}) };
  }
  for (const cat of SPORTS) {
    const j = await getJson(`${origin}/sports-api?category=${encodeURIComponent(cat)}&weight=70`);
    const subs = {};
    const all = [], fps = [];
    for (const s of j.subs || []) {
      const k = typeof s === 'string' ? s : s.key;
      const jj = await getJson(`${origin}/sports-api?category=${encodeURIComponent(cat)}&sub=${encodeURIComponent(k)}&weight=70`);
      const p = jj.products || [];
      p.forEach((x) => all.push(x.dailyCost));
      fps.push(k + ':' + fp(p));
      subs[k] = { label: (s && s.label) || k, n: p.length, ...(dist(p.map((x) => x.dailyCost)) || {}) };
    }
    sports[cat] = { n: Object.values(subs).reduce((t, x) => t + x.n, 0), fp: fps.join(','), subs, ...(dist(all) || {}) };
  }
  const totH = Object.values(health).reduce((t, x) => t + x.n, 0);
  const totS = Object.values(sports).reduce((t, x) => t + x.n, 0);
  return { health, sports, tot: { h: totH, s: totS, all: totH + totS } };
}

// data-stat 키 → 표시 문자열
export function values(st, asof) {
  const v = {};
  const [y, m, d] = asof.split('-');
  v['asof'] = `${y}년 ${Number(m)}월 ${Number(d)}일`;
  v['asof.iso'] = asof;
  v['tot.h'] = won(st.tot.h); v['tot.s'] = won(st.tot.s); v['tot'] = won(st.tot.all);
  for (const [k, x] of Object.entries(st.health)) {
    v[`h.${k}.n`] = won(x.n);
    if (x.min) { v[`h.${k}.range`] = `${won(x.min)}~${won(x.max)}원`; v[`h.${k}.med`] = `${won(x.med)}원`; }
  }
  for (const [k, x] of Object.entries(st.sports)) {
    v[`s.${k}.n`] = won(x.n);
    if (x.min) { v[`s.${k}.range`] = `${won(x.min)}~${won(x.max)}원`; v[`s.${k}.med`] = `${won(x.med)}원`; }
    for (const [sk, sx] of Object.entries(x.subs || {})) {
      v[`s.${k}.${sk}.n`] = won(sx.n);
      if (sx.min) v[`s.${k}.${sk}.range`] = `${won(sx.min)}~${won(sx.max)}원`;
    }
  }
  return v;
}

// HTML: data-stat 요소의 글자를 바꾸고, 문장 속 전체 제품 수를 바꾼다
export function applyHtml(html, saved) {
  const v = values(saved.data, saved.asof);
  let s = html.replace(/(<(b|span|div|strong)\b[^>]*\sdata-stat="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/g,
    (all, open, tag, key, inner, close) => (key in v ? open + v[key] + close : all));
  s = applyTotals(s, saved);
  return s;
}

function applyTotals(s, saved) {
  const v = values(saved.data, saved.asof);
  return s
    .replace(/(영양제와 운동 보충제 )[\d,]+(개)/g, `$1${v['tot']}$2`)
    .replace(/(운동 보충제 )[\d,]+(개 · ingredi)/g, `$1${v['tot']}$2`)
    .replace(/[\d,]+(개 제품의 성분표)/g, `${v['tot']}$1`)
    .replace(/((?:카르니틴|아미노산) )[\d,]+(개를)/g, `$1${v['tot.s']}$2`);
}

// llms.txt: "## 비교 대상" 절을 새로 쓰고, 기준일·전체 수를 바꾼다
export function applyLlms(text, saved) {
  const st = saved.data, a = saved.asof, v = values(st, a);
  const H = (k, label, extra = '', url = `/app?category=${k}`) => {
    const x = st.health[k];
    if (!x) return '';
    const cost = x.min ? `, 하루 비용 ${v[`h.${k}.range`]}(가운데 값 ${v[`h.${k}.med`]})` : '';
    return `- ${label}: ${v[`h.${k}.n`]}개${cost}.${extra} https://ingredi.kr${url}\n`;
  };
  const S = (k, body) => `- ${k}: ${body} https://ingredi.kr/sports?category=${k}\n`;
  const sp = st.sports, whey = (sp['단백질'].subs || {})['웨이프로틴'], gain = (sp['단백질'].subs || {})['웨이트게이너'];
  const sec =
    `## 비교 대상 (${a} 기준)\n\n` +
    `영양제 5종류, ${v['tot.h']}개\n` +
    H('오메가3', '오메가3') + H('마이크로바이옴', '유산균') + H('눈', '눈 건강(루테인·지아잔틴)') + H('비타민C', '비타민C') +
    H('밀크씨슬', '밀크씨슬', ' 등급 없이 함량과 비용만 비교.') +
    `\n운동 보충제 5종류, ${v['tot.s']}개 (국제스포츠영양학회 ISSN 기준 용량)\n` +
    S('단백질', `${v['s.단백질.n']}개(단백질 파우더 ${whey ? whey.n : '-'}, 게이너 ${gain ? gain.n : '-'}).`) +
    S('크레아틴', `${v['s.크레아틴.n']}개, 하루 ${v['s.크레아틴.range'] || '-'}.`) +
    S('아미노산', `${v['s.아미노산.n']}개(EAA, 베타알라닌, HMB, BCAA, 글루타민, 아르기닌·시트룰린).`) +
    S('부스터', `${v['s.부스터.n']}개. 카페인은 몸무게 1kg당 3mg 기준.`) +
    S('카르니틴', `${v['s.카르니틴.n']}개. 등급 없이 함량과 비용만 비교.`) + '\n';
  let s = text;
  const i = s.indexOf('## 비교 대상'), j = s.indexOf('## 계산 방법');
  if (i >= 0 && j > i) s = s.slice(0, i) + sec + s.slice(j);
  s = s.replace(/(마지막 갱신일 )\d{4}-\d{2}-\d{2}/g, `$1${a}`)
       .replace(/(ingredi\(잉그레디\) 데이터, )\d{4}-\d{2}-\d{2}/g, `$1${a}`);
  return applyTotals(s, saved);
}

// 매일 1회 이상 호출(ops-collect). 같은 날 여러 번 불려도 결과는 같다
export async function refreshSiteStats(env, origin, today, dry = false) {
  if (!env.CACHE) return { status: '보류: KV 없음' };
  let st;
  try { st = await computeStats(origin); } catch (e) { return { status: '보류: 조회 오류 ' + (e.message || e) }; }
  const empty = [...Object.entries(st.health), ...Object.entries(st.sports)].filter(([, x]) => !(x.n > 0)).map(([k]) => k);
  if (empty.length) return { status: '보류: 0개로 나온 종류 ' + empty.join(', '), data: st };
  const prev = await env.CACHE.get(KV_KEY, 'json');
  const changes = [], jumps = [];
  if (prev && prev.data) {
    const cmp = (label, a, b) => {
      if (!a || !b) return;
      if (a.n !== b.n) {
        changes.push(`${label} ${a.n}→${b.n}개`);
        if (a.n > 0 && Math.abs(b.n - a.n) / a.n > 0.5) jumps.push(label);
      }
      const costMoved = a.min && b.min && (a.min !== b.min || a.max !== b.max);
      if (costMoved) changes.push(`${label} 하루 ${won(a.min)}~${won(a.max)}원→${won(b.min)}~${won(b.max)}원`);
      // 제품 수·비용 범위는 그대로인데 화면의 제품 정보(가격·등급·함량 등)가 바뀐 경우
      if (a.n === b.n && !costMoved && a.fp && b.fp && a.fp !== b.fp) changes.push(`${label} 제품 정보 갱신`);
    };
    for (const [k, label] of HEALTH) cmp(label, prev.data.health[k], st.health[k]);
    for (const k of SPORTS) cmp(k, prev.data.sports[k], st.sports[k]);
  }
  if (jumps.length) return { status: '보류: 제품 수 50% 넘게 변함 — ' + jumps.join(', ') + ' (확인 필요)', changes, data: st };
  if (dry) return { status: 'dry', changes, data: st };
  // asof = 마지막으로 값이 바뀐 날. 변경 없으면 이전 날짜 유지(매일 날짜만 올려 '최신'처럼 보이지 않게)
  const asof = (!prev || changes.length) ? today : (prev.asof || today);
  await env.CACHE.put(KV_KEY, JSON.stringify({ asof, checkedAt: today, updatedAt: new Date().toISOString(), data: st }));
  // 같은 날 변경 내역은 모아 둔다(재실행 때 '변경 없음'으로 덮이지 않게)
  let log = await env.CACHE.get(KV_LOG, 'json');
  if (!log || log.date !== today) log = { date: today, first: !prev, changes: [] };
  for (const c of changes) if (!log.changes.includes(c)) log.changes.push(c);
  await env.CACHE.put(KV_LOG, JSON.stringify(log));
  const text = log.first && !log.changes.length
    ? `${today} 첫 기록: 전체 ${st.tot.all}개(영양제 ${st.tot.h} · 운동 보충제 ${st.tot.s})`
    : log.changes.length
      ? `${today} 반영: ` + log.changes.join(' / ')
      : `${today} 확인: 변경 없음(전체 ${st.tot.all}개)`;
  return { status: 'ok', text, changes: log.changes };
}

export async function readSiteStats(env) {
  return env.CACHE ? env.CACHE.get(KV_KEY, 'json') : null;
}
