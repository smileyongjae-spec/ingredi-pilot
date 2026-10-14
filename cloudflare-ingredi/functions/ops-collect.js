// functions/ops-collect.js  v1.2 (2026-10-15) — [v1.2] 소재 매칭 필드 '광고명(매체 표기)', Meta 토큰 만료일 점검
//   v1.1 (2026-10-14) — 쿠팡 전날 재수집·숫자 열, Clarity 하루 1회(재시도 시 건너뜀)
// 매일 04:30(KST) GitHub Actions가 호출 → 어제 하루 데이터를 API로 모아 Airtable에 기록.
//   GET /ops-collect?key=<OPS_SECRET>[&date=YYYY-MM-DD][&dry=1][&only=meta,coupang,clarity,self]
// 결과:
//   광고_일별성과  : 소재별(키 = 날짜_소재ID) 지출·노출·클릭·LPV(Meta) + 세션·UV·활성시간·세션당페이지뷰·쿠팡클릭·비교·카운슬링·AI평가(자체 기록)
//   일별_사이트지표: 날짜별 사이트 전체(자체 기록) + 쿠팡 파트너스 + Clarity 품질 지표 + 수집상태
//   세션로그        : 집계 후 3일 지난 행 삭제

import {
  json, checkSecret, kstDate, T,
  atList, atUpsert, atDelete,
  metaAdInsights, metaTokenInfo, coupangReport, sumNumeric, clarityExport,
} from './_lib/ops.js';

export async function onRequestGet(ctx) {
  try { return await run(ctx); } catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
}

async function run({ request, env }) {
  const u = new URL(request.url);
  if (!checkSecret(env, u.searchParams.get('key'))) return json({ ok: false, error: 'forbidden' }, 403);

  const date = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('date') || '') ? u.searchParams.get('date') : kstDate(-1);
  const dry = u.searchParams.get('dry') === '1';
  const only = (u.searchParams.get('only') || 'meta,coupang,clarity,self').split(',');
  const status = {};
  const out = { ok: true, date, dry };

  // 소재 목록: 광고명 → 소재 레코드, src → 소재 레코드
  const creatives = await atList(env, T.creative, null);
  const byName = new Map(), bySrc = new Map();
  for (const r of creatives) {
    const f = r.fields;
    const adName = f['광고명(매체 표기)'] || f['광고명'];
    if (adName) byName.set(String(adName).trim(), r);
    if (f['src']) bySrc.set(String(f['src']).trim(), r);
  }
  const rows = new Map(); // 키 → fields
  const rowFor = (rec) => {
    const key = `${date}_${rec.fields['소재ID']}`;
    if (!rows.has(key)) rows.set(key, { 키: key, 날짜: date, 소재: [rec.id] });
    return rows.get(key);
  };
  const site = { 날짜: date };

  /* 1) Meta */
  if (only.includes('meta')) {
    try {
      const ins = await metaAdInsights(env, date);
      let spend = 0;
      const unmatched = [];
      for (const r of ins) {
        spend += r.spend;
        const rec = byName.get(String(r.ad_name).trim());
        if (!rec) { unmatched.push(r.ad_name); continue; }
        Object.assign(rowFor(rec), { 지출: r.spend, 노출: r.impressions, 클릭: r.clicks, LPV: r.lpv });
      }
      site['Meta_지출'] = spend;
      status.meta = `ok ${ins.length}개 광고` + (unmatched.length ? `, 소재 미연결: ${unmatched.join(' / ')}` : '');
      out.meta = ins;
    } catch (e) { status.meta = '실패: ' + e.message; }
    // [v1.2] 토큰 만료일 — 14일 이내면 수집상태에 '갱신 필요'로 남겨 05시 분석·07시 보고가 알린다
    try {
      const t = await metaTokenInfo(env);
      if (t.expires_at) {
        const daysLeft = Math.floor((t.expires_at * 1000 - Date.now()) / 86400e3);
        const exp = kstDate(0, t.expires_at * 1000);
        status.meta_token = (daysLeft <= 14 ? '갱신 필요: ' : 'ok: ') + `만료 ${exp} (${daysLeft}일 남음)`;
      } else if (t.is_valid) status.meta_token = 'ok: 만료 없음';
      else status.meta_token = '무효 — 재발급 필요';
    } catch (e) { status.meta_token = '확인 실패: ' + e.message; }
  }

  /* 2) 자체 기록(세션로그) → src별·사이트 전체 */
  if (only.includes('self')) {
    try {
      const f = `DATETIME_FORMAT(SET_TIMEZONE(CREATED_TIME(),'Asia/Seoul'),'YYYY-MM-DD')='${date}'`;
      const evs = await atList(env, T.evlog, f, ['이벤트', 'sid', 'vid', 'src', '경로', '값']);
      const agg = (list) => {
        const sids = new Set(), vids = new Set();
        let pv = 0, act = 0;
        const cnt = {};
        for (const r of list) {
          const x = r.fields;
          if (x.sid) sids.add(x.sid);
          if (x.vid) vids.add(x.vid);
          if (x['이벤트'] === 'pv') pv++;
          else if (x['이벤트'] === 'act') act += Number(x['값'] || 0);
          else cnt[x['이벤트']] = (cnt[x['이벤트']] || 0) + 1;
        }
        const s = sids.size;
        return { 세션: s, UV: vids.size, 페이지뷰: pv, 활성초: act, cnt,
          세션당페이지뷰: s ? Math.round((pv / s) * 100) / 100 : null,
          세션당활성초: s ? Math.round(act / s) : null };
      };
      // 이벤트별 '세션 수'(같은 세션의 반복은 1회) — Clarity 기준과 맞춤
      const sessCount = (list, name) => new Set(list.filter((r) => r.fields['이벤트'] === name).map((r) => r.fields.sid)).size;

      const all = agg(evs);
      Object.assign(site, {
        세션: all.세션, UV: all.UV, 페이지뷰: all.페이지뷰, 활성시간_초: all.세션당활성초,
        쿠팡클릭_자체: sessCount(evs, 'purchase_click'),
        이벤트_JSON: JSON.stringify(all.cnt),
      });
      const srcs = new Set(evs.map((r) => r.fields.src).filter(Boolean));
      const perSrc = {};
      for (const s of srcs) {
        const list = evs.filter((r) => r.fields.src === s);
        const a = agg(list);
        perSrc[s] = { ...a, purchase: sessCount(list, 'purchase_click') };
        const rec = bySrc.get(s);
        if (!rec) continue;
        Object.assign(rowFor(rec), {
          세션: a.세션, UV: a.UV, 활성시간_초: a.세션당활성초, 세션당페이지뷰: a.세션당페이지뷰,
          쿠팡클릭: sessCount(list, 'purchase_click'),
          비교: sessCount(list, 'compare_add') || sessCount(list, 'compare_go'),
          카운슬링: sessCount(list, 'consult_open'),
          AI평가: sessCount(list, 'aieval_name_tap'),
        });
      }
      status.self = `ok 이벤트 ${evs.length}건, 세션 ${all.세션}`;
      out.self = { all, perSrc };
    } catch (e) { status.self = '실패: ' + e.message; }
  }

  /* 3) 쿠팡 파트너스 — 전날 값은 다음 날 오후에 집계되므로 그 전날(date-1)도 다시 받아 덮어쓴다 */
  const extraSite = [];
  if (only.includes('coupang')) {
    const cp = async (d) => {
      const [clicks, orders, commission] = await Promise.all([
        coupangReport(env, 'clicks', d), coupangReport(env, 'orders', d), coupangReport(env, 'commission', d),
      ]);
      const c = sumNumeric(clicks), o = sumNumeric(orders), m = sumNumeric(commission);
      return {
        fields: {
          쿠팡_JSON: JSON.stringify({ clicks: c, orders: o, commission: m }).slice(0, 5000),
          쿠팡클릭_파트너스: c.sum.click || 0, 쿠팡주문행: o.rows, 쿠팡수익: Math.round(m.sum.commission || 0),
        },
        note: `clicks ${c.sum.click || 0}, orders ${o.rows}행, 수익 ₩${Math.round(m.sum.commission || 0)}`,
        raw: { clicks, orders, commission },
      };
    };
    try {
      const a = await cp(date);
      Object.assign(site, a.fields);
      status.coupang = `ok (${a.note})`;
      out.coupang = a.raw;
    } catch (e) { status.coupang = '실패: ' + e.message; }
    try {
      const prev = kstDate(-1, Date.parse(date + 'T12:00:00+09:00'));
      const b = await cp(prev);
      extraSite.push({ 날짜: prev, ...b.fields });
      status.coupang_prev = `${prev} 재수집 ok (${b.note})`;
    } catch (e) { status.coupang_prev = '실패: ' + e.message; }
  }

  /* 4) Clarity (최근 24시간, 하루 10회 한도) */
  // 같은 날짜로 하루 여러 번 돌 수 있으므로(예약 재시도), 이미 성공했으면 Clarity는 다시 부르지 않는다(하루 10회 한도)
  let clarityDone = false;
  if (only.includes('clarity') && u.searchParams.get('force') !== '1') {
    try {
      const ex = await atList(env, T.site, `{날짜}='${date}'`, ['수집상태']);
      clarityDone = ex.some((r) => /clarity: ok/.test(String(r.fields['수집상태'] || '')));
    } catch (_) {}
  }
  if (clarityDone) status.clarity = 'ok (이전 실행에서 수집됨)';
  if (only.includes('clarity') && !clarityDone) {
    try {
      const all = await clarityExport(env, []);
      const byUrl = await clarityExport(env, ['URL']);
      // URL별 결과(광고 클릭마다 fbclid가 달라 행이 많음)를 src별로 합친다
      const bySrc = {};
      for (const m of byUrl || []) {
        for (const row of m.information || []) {
          let src = '(없음)', path = '';
          try { const uu = new URL(row.Url || row.url || ''); src = uu.searchParams.get('src') || '(없음)'; path = uu.pathname; } catch (_) {}
          if (/pages\.dev/.test(row.Url || '')) continue; // 미리보기 도메인 제외
          const b = (bySrc[src] = bySrc[src] || {});
          const k = m.metricName;
          b[k] = b[k] || { sessions: 0, withMetric: 0, subTotal: 0 };
          const sc = Number(row.sessionsCount || 0);
          b[k].sessions += sc;
          b[k].withMetric += Math.round(sc * Number(row.sessionsWithMetricPercentage || 0) / 100);
          b[k].subTotal += Number(row.subTotal || 0);
        }
      }
      const summary = {};
      for (const m of all || []) summary[m.metricName] = m.information;
      site['Clarity_JSON'] = JSON.stringify({ 기준: '최근 24시간(UTC)', 전체: summary, src별: bySrc }).slice(0, 90000);
      status.clarity = 'ok (최근 24시간 기준)';
      out.clarity = { summary, bySrc };
    } catch (e) { status.clarity = '실패: ' + e.message; }
  }

  site['수집상태'] = Object.entries(status).map(([k, v]) => `${k}: ${v}`).join('\n');
  site['수집시각'] = new Date().toISOString();
  out.status = status;
  out.rows = [...rows.values()];
  out.site = site;

  if (!dry) {
    try {
      if (rows.size) await atUpsert(env, T.daily, ['키'], [...rows.values()]);
      await atUpsert(env, T.site, ['날짜'], [site, ...extraSite]);
      // 3일 지난 세션로그 삭제
      const cutoff = kstDate(-3);
      const old = await atList(env, T.evlog, `DATETIME_FORMAT(SET_TIMEZONE(CREATED_TIME(),'Asia/Seoul'),'YYYY-MM-DD')<'${cutoff}'`, ['이벤트']);
      out.deleted = old.length ? await atDelete(env, T.evlog, old.map((r) => r.id)) : 0;
    } catch (e) { out.ok = false; out.writeError = e.message; }
  }
  return json(out);
}
