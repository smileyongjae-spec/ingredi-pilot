// functions/brand/[slug].js  v1.0  (2026-11-02) — 브랜드별 비교 페이지(검색엔진 노출용, Oliver 승인 11/02 서비스 진단 개선안 4 "5개 승인")
// /brand/lactofit · /brand/cj · /brand/chongkundang · /brand/esther · /brand/desimone
// 서버에서 같은 사이트의 /recommend2(영양제 5종)를 불러 브랜드 이름이 들어간 제품만 골라 HTML로 그린다(검색엔진이 읽을 수 있게 서버 렌더).
// 등급·하루 비용·품질점수 순서는 recommend2가 내려준 값 그대로. 밀크씨슬은 등급이 없는 카테고리라 등급·순서를 쓰지 않는다.

const BRANDS = {
  lactofit:     { name: '락토핏',  full: '종근당 락토핏', match: ['락토핏'] },
  cj:           { name: 'CJ',      full: 'CJ 바이오코어', match: ['cj바이오', 'cj '] },
  chongkundang: { name: '종근당',  full: '종근당·종근당건강', match: ['종근당'] },
  esther:       { name: '여에스더', full: '여에스더(에스더포뮬러)', match: ['여에스더', '에스더포뮬러'] },
  desimone:     { name: '드시모네', full: '드시모네', match: ['드시모네'] },
};
const CATS = [['마이크로바이옴', '유산균'], ['오메가3', '오메가3'], ['눈', '눈 건강'], ['비타민C', '비타민C'], ['밀크씨슬', '밀크씨슬']];
const UNSCORED = { '밀크씨슬': true };

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (n) => Number(n).toLocaleString('ko-KR');
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
function isBrand(name, b) {
  const n = String(name || '').toLowerCase(), ns = n.replace(/\s+/g, '');
  return b.match.some((m) => (m.endsWith(' ') ? (n.startsWith(m) || n.includes(' ' + m) || n.startsWith(m.trim())) : ns.includes(m.replace(/\s+/g, ''))));
}
function appHref(cat, name) { return '/app?category=' + encodeURIComponent(cat) + '&q=' + encodeURIComponent(name); }

export async function onRequestGet(ctx) {
  const slug = String(ctx.params.slug || '').toLowerCase();
  const b = BRANDS[slug];
  if (!b) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const origin = new URL(ctx.request.url).origin;

  const sections = [];
  let total = 0, okCats = 0;
  for (const [cat, label] of CATS) {
    let products = [];
    try {
      const r = await fetch(origin + '/recommend2?category=' + encodeURIComponent(cat));
      if (r.ok) { const d = await r.json(); products = (d && d.products) || []; if (products.length) okCats++; }
    } catch (_) {}
    if (!products.length) continue;
    const unscored = !!UNSCORED[cat];
    const ranked = unscored ? products.slice() : products.slice().sort((x, y) => num(y.quality) - num(x.quality));
    const rankOf = new Map(ranked.map((p, i) => [String(p.id), i + 1]));
    const mine = ranked.filter((p) => isBrand(p.name, b));
    if (!mine.length) continue;
    total += mine.length;
    // 같은 카테고리에서 이 브랜드 제품보다 하루 비용이 낮은 A등급(브랜드 제품 제외) 2개
    let alt = [];
    if (!unscored) {
      const minCost = Math.min(...mine.map((p) => num(p.dailyCost)).filter((v) => v > 0));
      if (isFinite(minCost)) alt = ranked.filter((p) => p.qualityGrade === 'A' && !isBrand(p.name, b) && num(p.dailyCost) > 0 && num(p.dailyCost) < minCost).slice(0, 2);
    }
    sections.push({ cat, label, unscored, mine, all: products.length, rankOf, alt });
  }

  // 데이터를 하나도 못 불러오면 빈 페이지를 검색엔진에 내보내지 않는다
  if (!okCats) return new Response('잠시 후 다시 시도해 주세요', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '120', 'x-robots-tag': 'noindex' } });
  const title = `${b.name} 영양제 비교 — ${total}개 제품 등급·하루 비용 · ingredi 잉그레디`;
  const desc = `${b.full} 제품 ${total}개를 ingredi의 같은 기준(근거 함량·제형·인증)으로 비교했어요. 종류별 등급, 하루 비용, 같은 종류 안에서의 품질점수 순서를 한 페이지에서 봅니다.`;
  const body = sections.length ? sections.map((s) => `
  <section>
    <h2>${esc(b.name)} ${esc(s.label)} ${s.mine.length}개</h2>
    <p class="muted">${s.unscored ? `${esc(s.label)}은 등급을 매기지 않는 종류라 하루 비용만 비교해요.` : `순서는 ${esc(s.label)} ${s.all}개 전체에서의 품질점수 순서예요.`}</p>
    <div class="tbl-wrap"><table>
      <thead><tr><th>제품</th>${s.unscored ? '' : '<th>등급</th><th>순서</th>'}<th>하루 비용</th></tr></thead>
      <tbody>${s.mine.map((p) => `<tr><td><a href="${appHref(s.cat, p.name)}">${esc(p.name)}</a></td>${s.unscored ? '' : `<td>${p.qualityGrade ? `<span class="g g${esc(p.qualityGrade)}">${esc(p.qualityGrade)}</span>` : '–'}</td><td class="num">${s.rankOf.get(String(p.id))}위 / ${s.all}</td>`}<td class="num">${num(p.dailyCost) > 0 ? fmt(Math.round(num(p.dailyCost))) + '원' : '–'}</td></tr>`).join('')}</tbody>
    </table></div>
    ${s.alt.length ? `<div class="note"><b>${esc(b.name)} 제품보다 하루 비용이 낮은 A등급 ${esc(s.label)}</b><br>${s.alt.map((p) => `<a href="${appHref(s.cat, p.name)}">${esc(p.name)}</a> · 하루 ${fmt(Math.round(num(p.dailyCost)))}원`).join('<br>')}</div>` : ''}
    <div class="actions"><a class="btn primary" href="/app?category=${encodeURIComponent(s.cat)}">${esc(s.label)} ${s.all}개 전체 비교 →</a></div>
  </section>`).join('') : `<section><p>지금 비교 목록에 ${esc(b.name)} 제품이 없어요.</p></section>`;

  const others = Object.keys(BRANDS).filter((k) => k !== slug).map((k) => `<a href="/brand/${k}">${esc(BRANDS[k].name)}</a>`).join(' · ');
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#1B3A2E">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://ingredi.kr/brand/${slug}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="https://ingredi.kr/brand/${slug}">
<meta property="og:image" content="https://ingredi.kr/og-image.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<script type="text/javascript">
  (function(c,l,a,r,i,t,y){ c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)}; t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i; y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y); })(window, document, "clarity", "script", "xilfyj7s52");
  try { var _src = new URLSearchParams(location.search).get("src"); if (_src) window.clarity("set", "src", _src.slice(0, 40)); } catch (e) {}
</script>
<script src="/t.js?v=2"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css">
<link rel="stylesheet" href="/tokens-v1.css">
<link rel="stylesheet" href="/content-v1.css">
</head>
<body>
<header class="bar"><div class="wrap">
  <a class="logo" href="/app">ingredi</a>
  <nav class="nav" aria-label="주요 메뉴">
    <a href="/app">영양제 비교</a>
    <a href="/sports">운동 보충제</a>
    <a href="/guide">등급 기준</a>
    <a href="/insights">데이터 리포트</a>
    <a href="/consult">AI 상담</a>
    <a href="/about">소개</a>
  </nav>
</div></header>
<main class="wrap">
  <section style="padding-top:40px">
    <p class="muted">브랜드별 비교</p>
    <h1>${esc(b.name)} 영양제 ${total}개, 같은 기준으로 비교했어요</h1>
    <p class="lead">${esc(b.full)} 제품을 ingredi의 <a href="/guide">등급 기준</a>(근거 함량·제형·인증)으로 다른 제품과 똑같이 채점했어요. 가격과 리뷰는 등급에 넣지 않아요.</p>
  </section>
  ${body}
  <section><p class="muted">다른 브랜드 비교: ${others}</p></section>
</main>
<footer class="wrap foot">
  ingredi는 제품사로부터 광고비를 받지 않고, 공개된 제품 정보로 비교합니다. 쿠팡 파트너스 활동의 일환으로 수수료를 받을 수 있으며, 수수료는 등급과 순위에 영향을 주지 않습니다. 이 서비스는 의료 자문이 아닙니다. 가격은 수시로 바뀌어 지금 판매가와 다를 수 있어요.
  <br><a href="/about">소개 · 문의</a>
</footer>
</body>
</html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=1800' } });
}
