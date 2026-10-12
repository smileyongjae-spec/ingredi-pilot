// functions/ops-collect.js  v1.0 (2026-10-13)
// 매일 04:30(KST) GitHub Actions가 호출 → 어제 하루 데이터를 API로 모아 Airtable에 기록.
//   GET /ops-collect?key=<OPS_SECRET>[&date=YYYY-MM-DD][&dry=1][&only=meta,coupang,clarity,self]
// 결과:
//   광고_일별성과  : 소재별(키 = 날짜_소재ID) 지출·노출·클릭·LPV(Meta) + 세션·UV·활성시간·세션당페이지뷰·쿠팡클릭·비교·카운슬링·AI평가(자체 기록)
//   일별_사이트지표: 날짜별 사이트 전체(자체 기록) + 쿠팡 파트너스 + Clarity 품질 지표 + 수집상태
//   세션로그        : 집계 후 3일 지난 행 삭제

import {
  json, checkSecret, kstDate, T,
  atList, atUpsert, atDelete,
  metaAdInsights, coupangReport, sumNumeric, clarityExport,
} from './_lib/ops.js';

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  if (!checkSecret(env, u.searchParams.get('key'))) return json({ ok: false, error: 'forbidden' }, 403);

  const date = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('date') || '') ? u.searchParams.get('date') : kstDate(-1);
  const dry = u.searchParams.get('dry') === '1';
  const only = (u.searchParams.get('only') || 'meta,coupang,clarity,self').split(',');
  const status = {};
  const out = { ok: true, date, dry };

  // 소재 목록: 광고명 → 소재 레코드, src → 소재 레코드
  const creatives = await atList(env, T.creative, null, ['소재ID', '광고명', 'src', '채널']);
  const byName = new Map(), bySrc = new Map();
  for (const r of creatives) {
    const f = r.fields;
    if (f['광고명']) byName.set(String(f['광고명']).trim(), r);
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

  /* 3) 쿠팡 파트너스 (전날 값은 오후에 확정될 수 있음 → 다음 날 재수집으로 덮어씀) */
  if (only.includes('coupang')) {
    try {
      const [clicks, orders, commission] = await Promise.all([
        coupangReport(env, 'clicks', date), coupangReport(env, 'orders', date), coupangReport(env, 'commission', date),
      ]);
      const c = sumNumeric(clicks), o = sumNumeric(orders), m = sumNumeric(commission);
      site['쿠팡_JSON'] = JSON.stringify({ clicks: c, orders: o, commission: m }).slice(0, 5000);
      status.coupang = `ok (clicks ${c.rows}행, orders ${o.rows}행, commission ${m.rows}행)`;
      out.coupang = { clicks, orders, commission };
    } catch (e) { status.coupang = '실패: ' + e.message; }
  }

  /* 4) Clarity (최근 24시간, 하루 10회 한도) */
  if (only.includes('clarity')) {
    try {
      const all = await clarityExport(env, []);
      const byUrl = await clarityExport(env, ['URL']);
      site['Clarity_JSON'] = JSON.stringify({ all, byUrl }).slice(0, 90000);
      status.clarity = 'ok (최근 24시간 기준)';
      out.clarity = { all, byUrl };
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
      await atUpsert(env, T.site, ['날짜'], [site]);
      // 3일 지난 세션로그 삭제
      const cutoff = kstDate(-3);
      const old = await atList(env, T.evlog, `DATETIME_FORMAT(SET_TIMEZONE(CREATED_TIME(),'Asia/Seoul'),'YYYY-MM-DD')<'${cutoff}'`, ['이벤트']);
      out.deleted = old.length ? await atDelete(env, T.evlog, old.map((r) => r.id)) : 0;
    } catch (e) { out.ok = false; out.writeError = e.message; }
  }
  return json(out);
}
