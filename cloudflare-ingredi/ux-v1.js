/* ux-v1.js v1.1 (2026-11-02) — [v1.1] 브랜드 검색어(락토핏·종근당·여에스더·드시모네·cj)면 검색창 아래에 브랜드 비교 페이지 안내 한 줄(brand_hint_shown·brand_hint_click) / v1.0 서비스 진단 개선안(Oliver 승인 11/02 "1번 C / 2번 승인 / 3번 승인")
   1) 관심 제품 저장: 기기 브라우저(localStorage)에만 저장, 서버·개인정보 없음. 저장 당시 가격·하루 비용·등급을 기억해
      다시 열었을 때 "저장한 뒤 바뀐 점"을 보여 준다.
   2) 검색 0건: 다른 종류에서 찾은 제품 · 이름이 비슷한 제품 · "이 제품 비교해 주세요" 추가 요청(검색로그 타입 '요청')
   3) 카드 칩 설명: data-xp 가 있는 칩을 누르면 바로 아래에 설명이 펼쳐진다
   측정 이벤트(Clarity → t.js → 세션로그): save_add · save_remove · save_open · save_change_seen · empty_cross_shown · product_request · chip_explain
   app.html·sports.html이 <script src="/ux-v1.js?v=1"></script> 로(t.js 바로 뒤) 불러온다. */
(function () {
  if (window.__ingUx) return; window.__ingUx = 1;
  var KEY = 'ing_saved_v1';
  var APP_CATS = [['오메가3', '오메가3'], ['눈', '눈 건강'], ['마이크로바이옴', '유산균'], ['비타민C', '비타민C'], ['밀크씨슬', '밀크씨슬']];
  var SPORTS_CATS = ['단백질', '크레아틴', '아미노산', '부스터', '카르니틴'];
  function catLabel(page, cat) { if (page === 'app') { for (var i = 0; i < APP_CATS.length; i++) if (APP_CATS[i][0] === cat) return APP_CATS[i][1]; } return cat; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function fmt(n) { return Number(n).toLocaleString('ko-KR'); }
  function ev(n) { try { if (typeof window.clarity === 'function') window.clarity('event', n); } catch (e) {} }
  function srcOf() { try { return (new URLSearchParams(location.search).get('src') || sessionStorage.getItem('ing_src') || '').slice(0, 40); } catch (e) { return ''; } }
  function loadS() { try { var a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function saveS(a) { try { localStorage.setItem(KEY, JSON.stringify(a.slice(0, 60))); } catch (e) {} }
  function hasS(k) { return loadS().some(function (x) { return x.k === k; }); }
  function pageHref(page, cat, name) { return (page === 'app' ? '/app' : '/sports') + '?category=' + encodeURIComponent(cat) + '&q=' + encodeURIComponent(name); }

  var css = ''
    + '.sv-btn{display:inline-flex;align-items:center;gap:3px;height:28px;padding:0 10px;border:1px solid #CFE3D6;background:#fff;border-radius:999px;font:inherit;font-size:12.5px;font-weight:700;color:#2D5F3F;cursor:pointer;white-space:nowrap}'
    + '.sv-btn.on{background:#2D5F3F;border-color:#2D5F3F;color:#fff}.sv-btn:active{transform:scale(.96)}'
    + '.sv-head{display:none;align-items:center;gap:3px;height:30px;padding:0 10px;border:1px solid #CFE3D6;background:#fff;border-radius:999px;font:inherit;font-size:12.5px;font-weight:800;color:#2D5F3F;cursor:pointer;white-space:nowrap;margin-right:4px}'
    + '.sv-head.show{display:inline-flex}'
    + '.sv-toast{position:fixed;left:50%;bottom:92px;transform:translateX(-50%);background:#1f2a24;color:#fff;font-size:13.5px;padding:10px 16px;border-radius:12px;z-index:1200;max-width:86%;text-align:center;line-height:1.45;box-shadow:0 6px 20px rgba(0,0,0,.2)}'
    + '.sv-dim{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:1100}'
    + '.sv-sheet{position:fixed;left:0;right:0;bottom:0;max-height:82vh;overflow:auto;background:#FAF8F3;border-radius:20px 20px 0 0;z-index:1101;padding:18px 16px 26px;box-shadow:0 -8px 30px rgba(0,0,0,.18)}'
    + '.sv-sheet h3{margin:0 0 4px;font-size:18px;color:#1f2a24}.sv-sheet .sv-sub{font-size:12.5px;color:#6b766f;margin:0 0 12px;line-height:1.5}'
    + '.sv-item{background:#fff;border:1px solid #E5EAE6;border-radius:14px;padding:12px;margin-bottom:10px;display:flex;gap:10px}'
    + '.sv-item img{width:46px;height:46px;border-radius:10px;object-fit:cover;background:#EEF1EC;flex-shrink:0}'
    + '.sv-item .sv-n{font-size:14px;font-weight:700;color:#1f2a24;line-height:1.35}.sv-item .sv-m{font-size:12px;color:#6b766f;margin-top:3px}'
    + '.sv-chg{margin-top:6px;font-size:12.5px;font-weight:700}.sv-chg .dn{color:#2D7A4B}.sv-chg .up{color:#A5552B}.sv-chg .eq{color:#8a948d;font-weight:500}'
    + '.sv-acts{display:flex;gap:8px;margin-top:8px}.sv-acts a,.sv-acts button{font:inherit;font-size:12.5px;font-weight:700;padding:6px 10px;border-radius:8px;border:1px solid #CFE3D6;background:#fff;color:#2D5F3F;text-decoration:none;cursor:pointer}'
    + '.sv-cmp{display:block;text-align:center;margin:6px 0 10px;padding:12px;border-radius:12px;background:#2D5F3F;color:#fff;font-weight:800;font-size:14.5px;text-decoration:none}'
    + '.sv-close{display:block;width:100%;margin-top:6px;padding:12px;border:0;background:none;color:#6b766f;font:inherit;font-size:14px;font-weight:600}'
    + '.xs-box{margin:14px 4px 0;padding:13px 14px;border-radius:12px;background:#fff;border:1px solid #DCE8E0;text-align:left}'
    + '.xs-box .xs-t{font-size:14px;font-weight:800;color:#1f2a24;margin-bottom:6px}'
    + '.xs-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 0;border-top:1px solid #EEF1EE;font-size:13.5px;text-decoration:none}'
    + '.xs-row:first-of-type{border-top:0}.xs-row .n{font-weight:700;color:#1f2a24;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.xs-row .c{font-size:12px;color:#2D5F3F;background:#EEF6F1;border-radius:6px;padding:3px 7px;white-space:nowrap}'
    + '.xs-wait{font-size:12.5px;color:#8a948d;margin:12px 4px 0;text-align:center}'
    + '.xs-req{display:inline-block;margin-top:10px;padding:10px 14px;border-radius:10px;border:1px solid #2D5F3F;color:#2D5F3F;font:inherit;font-weight:800;font-size:13.5px;background:#fff;cursor:pointer}'
    + '.xs-req.done{border-color:#CFE3D6;color:#6b766f;cursor:default}'
    + '[data-xp]{cursor:pointer}'
    + '.xp-box{margin:8px 0 2px;padding:10px 12px;border-radius:10px;background:#F3F7F4;border:1px solid #DCE8E0;font-size:12.8px;line-height:1.55;color:#33413A;word-break:keep-all}'
    + '.xp-box b{color:#1f2a24}'
    + '.bh-row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:8px 2px 4px;padding:11px 13px;border-radius:12px;background:#EEF6F1;border:1px solid #CFE3D6;color:#1f2a24;font-size:13.5px;line-height:1.45;text-decoration:none;word-break:keep-all}'
    + '.bh-row .bh-go{font-weight:800;color:#2D5F3F;white-space:nowrap}';
  try { var st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st); } catch (e) {}

  /* ── 1) 저장 ── */
  function toast(msg) {
    try {
      var old = document.querySelector('.sv-toast'); if (old) old.remove();
      var t = document.createElement('div'); t.className = 'sv-toast'; t.textContent = msg; document.body.appendChild(t);
      setTimeout(function () { try { t.remove(); } catch (e) {} }, 2600);
    } catch (e) {}
  }
  function headBtn() {
    var b = document.querySelector('.sv-head');
    if (!b) {
      var anchor = document.querySelector('.header-share') || document.querySelector('.header-spacer');
      if (!anchor) return null;
      b = document.createElement('button'); b.type = 'button'; b.className = 'sv-head'; b.setAttribute('aria-label', '저장한 제품 보기');
      if (anchor.classList.contains('header-spacer')) { anchor.style.display = 'flex'; anchor.style.justifyContent = 'flex-end'; anchor.appendChild(b); }
      else anchor.parentNode.insertBefore(b, anchor);
      b.addEventListener('click', openSheet);
    }
    return b;
  }
  function syncHead() {
    var b = headBtn(); if (!b) return;
    var n = loadS().length;
    b.textContent = '♥ 저장 ' + n;
    b.classList.toggle('show', n > 0);
  }
  function syncBtns(k, on) {
    var list = document.querySelectorAll('.sv-btn[data-svk]');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-svk') !== k) continue;
      list[i].classList.toggle('on', on); list[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      list[i].textContent = on ? '♥ 저장됨' : '♡ 저장';
    }
  }
  window.ingSave = {
    // it = {id, name, cat, page:'app'|'sports', price, daily, grade, img}
    btn: function (it) {
      var k = it.page + ':' + it.cat + ':' + it.id, on = hasS(k);
      return '<button type="button" class="sv-btn' + (on ? ' on' : '') + '" data-svk="' + esc(k) + '" data-sv="' + esc(JSON.stringify(it)) + '" aria-pressed="' + on + '">' + (on ? '♥ 저장됨' : '♡ 저장') + '</button>';
    },
    count: function () { return loadS().length; },
    open: function () { openSheet(); }
  };
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.sv-btn[data-svk]'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var k = b.getAttribute('data-svk'), a = loadS();
    var idx = -1; for (var i = 0; i < a.length; i++) if (a[i].k === k) { idx = i; break; }
    if (idx >= 0) { a.splice(idx, 1); saveS(a); syncBtns(k, false); syncHead(); ev('save_remove'); toast('저장을 지웠어요'); return; }
    var it = {}; try { it = JSON.parse(b.getAttribute('data-sv') || '{}'); } catch (_) {}
    it.k = k; it.at = Date.now(); a.unshift(it); saveS(a); syncBtns(k, true); syncHead(); ev('save_add');
    toast('저장했어요. 위쪽 ♥ 저장에서 다시 볼 수 있어요');
  }, true);

  var cacheP = {};
  function fetchCat(page, cat) {
    var key = page + ':' + cat;
    if (cacheP[key]) return cacheP[key];
    var u = page === 'app' ? '/recommend2?category=' + encodeURIComponent(cat) : '/sports-api?category=' + encodeURIComponent(cat) + '&weight=70';
    cacheP[key] = fetch(u).then(function (r) { return r.ok ? r.json() : {}; }).then(function (d) { return (d && d.products) || []; }).catch(function () { return []; });
    return cacheP[key];
  }
  function changeLine(s, cur) {
    if (!cur) return '<span class="eq">지금 목록에서 찾지 못했어요</span>';
    var out = [];
    var cd = Number(cur.dailyCost) || 0, sd = Number(s.daily) || 0;
    if (cd > 0 && sd > 0 && cd !== sd) out.push(cd < sd ? '<span class="dn">하루 ' + fmt(sd - cd) + '원 내렸어요</span>' : '<span class="up">하루 ' + fmt(cd - sd) + '원 올랐어요</span>');
    var cp = Number(cur.price) || 0, sp = Number(s.price) || 0;
    if (!out.length && cp > 0 && sp > 0 && cp !== sp) out.push(cp < sp ? '<span class="dn">가격 ' + fmt(sp - cp) + '원 내렸어요</span>' : '<span class="up">가격 ' + fmt(cp - sp) + '원 올랐어요</span>');
    var cg = cur.qualityGrade || '', sg = s.grade || '';
    if (cg && sg && cg !== sg) out.push('<span class="' + (cg < sg ? 'dn' : 'up') + '">등급 ' + esc(sg) + ' → ' + esc(cg) + '</span>');
    return out.length ? out.join(' · ') : '<span class="eq">저장한 뒤 바뀐 점 없음</span>';
  }
  function closeSheet() { var d = document.querySelector('.sv-dim'), s = document.querySelector('.sv-sheet'); if (d) d.remove(); if (s) s.remove(); }
  function openSheet() {
    closeSheet();
    var a = loadS(); ev('save_open');
    var dim = document.createElement('div'); dim.className = 'sv-dim'; dim.addEventListener('click', closeSheet);
    var sh = document.createElement('div'); sh.className = 'sv-sheet';
    if (!a.length) {
      sh.innerHTML = '<h3>저장한 제품</h3><p class="sv-sub">아직 저장한 제품이 없어요. 제품 카드의 ♡ 저장을 누르면 여기 모여요.</p><button class="sv-close" type="button">닫기</button>';
    } else {
      var groups = {}; a.forEach(function (s) { var g = s.page + ':' + s.cat; (groups[g] = groups[g] || []).push(s); });
      var cmp = '';
      Object.keys(groups).forEach(function (g) {
        var arr = groups[g]; if (arr[0].page !== 'app' || arr.length < 2) return;
        var ids = arr.slice(0, 4).map(function (s) { return s.id; });
        if (!cmp) cmp = '<a class="sv-cmp" href="/compare?category=' + encodeURIComponent(arr[0].cat) + '&profile=balanced&ids=' + encodeURIComponent(ids.join(',')) + '">저장한 ' + esc(catLabel('app', arr[0].cat)) + ' ' + ids.length + '개 나란히 비교 →</a>';
      });
      sh.innerHTML = '<h3>저장한 제품 ' + a.length + '개</h3><p class="sv-sub">이 기기의 브라우저에만 저장돼요. 저장할 때의 가격과 지금 가격을 비교해 보여 드려요.</p>' + cmp
        + a.map(function (s, i) {
          return '<div class="sv-item"><img src="' + esc(s.img || '') + '" alt="" onerror="this.style.visibility=\'hidden\'"><div style="flex:1;min-width:0">'
            + '<div class="sv-n">' + esc(s.name) + '</div>'
            + '<div class="sv-m">' + esc(catLabel(s.page, s.cat)) + (s.grade ? ' · 저장 때 ' + esc(s.grade) + '등급' : '') + (s.daily ? ' · 하루 ' + fmt(s.daily) + '원' : '') + '</div>'
            + '<div class="sv-chg" data-svchg="' + i + '"><span class="eq">지금 가격 확인 중…</span></div>'
            + '<div class="sv-acts"><a href="' + pageHref(s.page, s.cat, s.name) + '">보기</a><button type="button" data-svdel="' + esc(s.k) + '">지우기</button></div>'
            + '</div></div>';
        }).join('') + '<button class="sv-close" type="button">닫기</button>';
    }
    document.body.appendChild(dim); document.body.appendChild(sh);
    sh.querySelector('.sv-close').addEventListener('click', closeSheet);
    sh.addEventListener('click', function (e) {
      var d = e.target.closest && e.target.closest('[data-svdel]'); if (!d) return;
      var k = d.getAttribute('data-svdel'); saveS(loadS().filter(function (x) { return x.k !== k; }));
      syncBtns(k, false); syncHead(); ev('save_remove'); openSheet();
    });
    var seen = false;
    a.forEach(function (s, i) {
      fetchCat(s.page, s.cat).then(function (list) {
        var cur = null; for (var j = 0; j < list.length; j++) if (String(list[j].id) === String(s.id)) { cur = list[j]; break; }
        var el = sh.querySelector('[data-svchg="' + i + '"]'); if (!el) return;
        el.innerHTML = changeLine(s, cur);
        if (!seen && el.querySelector('.dn,.up')) { seen = true; ev('save_change_seen'); }
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncHead); else syncHead();

  /* ── 2) 검색 0건: 다른 종류 · 비슷한 이름 · 추가 요청 ── */
  function similarIn(list, q) {
    var qS = String(q || '').toLowerCase().replace(/\s+/g, '');
    for (var len = qS.length - 1; len >= Math.max(4, Math.ceil(qS.length * 0.6)); len--) {   // 앞부분 60% 이상·4글자 이상이 같을 때만(뉴트리코어 → 뉴트리원 같은 오탐 방지)
      var pre = qS.slice(0, len), hit = [];
      for (var i = 0; i < list.length && hit.length < 3; i++) {
        if (String(list[i].name || '').toLowerCase().replace(/\s+/g, '').indexOf(pre) !== -1) hit.push(list[i]);
      }
      if (hit.length) return hit;
    }
    return [];
  }
  window.ingCross = {
    // box = 0건 안내가 들어 있는 요소, ctx = {page, cat, list, matcher(name, q)}
    render: function (box, q, ctx) {
      try {
        if (!box || !q) return;
        var ask = box.querySelector('.cat-empty-ask'); if (!ask) return;
        var req = document.createElement('div');
        req.innerHTML = '<button type="button" class="xs-req">＋ 이 제품 비교해 주세요 (추가 요청)</button>';
        ask.appendChild(req);
        req.firstChild.addEventListener('click', function () {
          var b = this; if (b.classList.contains('done')) return;
          b.classList.add('done'); b.textContent = '요청했어요 ✓ 검토 후 추가할게요';
          ev('product_request');
          try { fetch('/log-search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: JSON.stringify({ type: '요청', content: q, category: ctx.cat, src: srcOf() }) }); } catch (e) {}
        });
        var holder = document.createElement('div'); ask.parentNode.insertBefore(holder, ask);
        var sim = similarIn(ctx.list || [], q);
        var simHtml = sim.length ? '<div class="xs-box"><div class="xs-t">이름이 비슷한 제품</div>'
          + sim.map(function (p) { return '<a class="xs-row" href="' + pageHref(ctx.page, ctx.cat, p.name) + '"><span class="n">' + esc(p.name) + '</span><span class="c">보기 →</span></a>'; }).join('') + '</div>' : '';
        holder.innerHTML = simHtml + '<div class="xs-wait">다른 종류에서도 찾는 중…</div>';
        var targets = [];
        APP_CATS.forEach(function (c) { if (!(ctx.page === 'app' && ctx.cat === c[0])) targets.push(['app', c[0]]); });
        SPORTS_CATS.forEach(function (c) { if (!(ctx.page === 'sports' && ctx.cat === c)) targets.push(['sports', c]); });
        var m = ctx.matcher || function (n, qq) { return String(n).toLowerCase().indexOf(String(qq).toLowerCase()) !== -1; };
        Promise.all(targets.map(function (t) { return fetchCat(t[0], t[1]).then(function (list) { return list.filter(function (p) { return m(p.name, q); }).map(function (p) { return { p: p, page: t[0], cat: t[1] }; }); }); }))
          .then(function (res) {
            var hits = [].concat.apply([], res).slice(0, 5);
            var otherHtml = hits.length ? '<div class="xs-box"><div class="xs-t">다른 종류에서 찾았어요 (' + hits.length + '개)</div>'
              + hits.map(function (h) { return '<a class="xs-row" href="' + pageHref(h.page, h.cat, h.p.name) + '"><span class="n">' + esc(h.p.name) + '</span><span class="c">' + esc(catLabel(h.page, h.cat)) + ' · 보기 →</span></a>'; }).join('') + '</div>' : '';
            holder.innerHTML = otherHtml + simHtml;
            if (hits.length || sim.length) ev('empty_cross_shown');
          }).catch(function () { holder.innerHTML = simHtml; });
      } catch (e) {}
    }
  };

  /* ── 3) 칩 설명 ── */
  document.addEventListener('click', function (e) {
    var c = e.target.closest && e.target.closest('[data-xp]'); if (!c) return;
    var host = c.closest('.cv-voc, .cv-form') || c.parentNode;
    var nx = host.nextElementSibling;
    if (nx && nx.classList.contains('xp-box') && nx.getAttribute('data-for') === c.getAttribute('data-xp')) { nx.remove(); return; }
    if (nx && nx.classList.contains('xp-box')) nx.remove();
    var box = document.createElement('div'); box.className = 'xp-box'; box.setAttribute('data-for', c.getAttribute('data-xp'));
    box.innerHTML = c.getAttribute('data-xp');
    host.parentNode.insertBefore(box, host.nextSibling);
    ev('chip_explain');
  });
  /* ── 4) 브랜드 검색 → 브랜드 비교 페이지 안내 (v1.1) ── */
  var BRANDS = [['lactofit', '락토핏', ['락토핏']], ['chongkundang', '종근당', ['종근당']], ['esther', '여에스더', ['여에스더', '에스더']], ['desimone', '드시모네', ['드시모네']], ['cj', 'CJ', ['cj']]];
  function brandOf(q) {
    var s = String(q || '').toLowerCase().replace(/\s+/g, '');
    if (s.length < 2) return null;
    for (var i = 0; i < BRANDS.length; i++) for (var j = 0; j < BRANDS[i][2].length; j++) {
      var k = BRANDS[i][2][j];
      if (k === 'cj' ? s.indexOf('cj') === 0 : s.indexOf(k) !== -1) return BRANDS[i];
    }
    return null;
  }
  function syncBrandHint() {
    var inp = document.getElementById('catSearch'), meta = document.getElementById('catMeta');
    if (!inp || !meta) return;
    var old = document.querySelector('.bh-row'), b = brandOf(inp.value);
    if (!b) { if (old) old.remove(); return; }
    if (old && old.getAttribute('data-b') === b[0] && old.previousElementSibling === meta) return;
    if (old) old.remove();
    var a = document.createElement('a'); a.className = 'bh-row'; a.href = '/brand/' + b[0]; a.setAttribute('data-b', b[0]);
    a.innerHTML = '<span><b>' + esc(b[1]) + '</b> 제품 전체를 종류별 등급·하루 비용으로 한눈에</span><span class="bh-go">보기 →</span>';
    a.addEventListener('click', function () { ev('brand_hint_click'); });
    meta.parentNode.insertBefore(a, meta.nextSibling);
    ev('brand_hint_shown');
  }
  function initBrandHint() {
    var inp = document.getElementById('catSearch'), meta = document.getElementById('catMeta');
    if (!inp || !meta) return;
    var tm = null;
    inp.addEventListener('input', function () { clearTimeout(tm); tm = setTimeout(syncBrandHint, 350); });
    try { new MutationObserver(function () { syncBrandHint(); }).observe(meta, { childList: true }); } catch (e) {}
    syncBrandHint();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBrandHint); else initBrandHint();
})();
