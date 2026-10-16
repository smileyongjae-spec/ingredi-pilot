/* t.js v2.0 (2026-10-16) — ingredi 자체 방문·이벤트 기록 (Clarity와 함께 동작)
   - [v2] 이 기기에서 처음 방문(ing_vid를 새로 만든 경우)이면 'new_vid'를 한 번 보냄 → 신규/재방문 방문자 구분
   - 페이지 열림(pv), 활성 시간(act, 초), Clarity 이벤트(window.clarity('event', name))를 /track으로 보냄
   - Clarity 스니펫 바로 뒤에 <script src="/t.js?v=2"></script> 로 넣는다 */
(function () {
  try {
    if (window.__ingT) return; window.__ingT = 1;
    function rid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
    var vid = 'na', sid, src = '', isNew = false;
    try { vid = localStorage.getItem('ing_vid') || ''; if (!vid) { vid = rid(); localStorage.setItem('ing_vid', vid); isNew = localStorage.getItem('ing_vid') === vid; } } catch (e) {}
    try { sid = sessionStorage.getItem('ing_sid'); if (!sid) { sid = rid(); sessionStorage.setItem('ing_sid', sid); } } catch (e) { sid = rid(); }
    try {
      src = new URLSearchParams(location.search).get('src') || sessionStorage.getItem('ing_src') || '';
      if (src) sessionStorage.setItem('ing_src', src.slice(0, 40));
    } catch (e) {}
    var path = location.pathname.replace(/\.html$/, '') || '/';

    function send(e, v) {
      try {
        var body = JSON.stringify({ e: e, sid: sid, vid: vid, src: src, path: path, v: v });
        if (navigator.sendBeacon) navigator.sendBeacon('/track', new Blob([body], { type: 'text/plain' }));
        else fetch('/track', { method: 'POST', body: body, keepalive: true });
      } catch (err) {}
    }
    send('pv');
    if (isNew) send('new_vid');

    // 활성 시간: 화면이 보이고 최근 30초 안에 조작이 있었던 시간
    var last = Date.now(), active = 0, sent = 0;
    ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(function (t) {
      addEventListener(t, function () { last = Date.now(); }, { passive: true, capture: true });
    });
    setInterval(function () {
      if (document.visibilityState === 'visible' && Date.now() - last < 30000) active += 5;
    }, 5000);
    function flush() { var d = active - sent; if (d > 0) { sent = active; send('act', d); } }
    addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });

    // Clarity 이벤트 가로채기 — 실제 Clarity 스크립트가 window.clarity를 바꿔 끼워도 유지되도록 setter 사용
    var inner = window.clarity;
    function wrapped() {
      try { if (arguments[0] === 'event' && typeof arguments[1] === 'string') send(String(arguments[1]).slice(0, 40)); } catch (e) {}
      return inner && inner.apply(this, arguments);
    }
    if (inner && inner.q) wrapped.q = inner.q; // 스텁 대기열 공유(실제 Clarity가 window.clarity.q를 읽음)
    try {
      Object.defineProperty(window, 'clarity', {
        configurable: true,
        get: function () { return wrapped; },
        set: function (fn) { if (fn !== wrapped) { var q = inner && inner.q; inner = fn; if (q && !fn.q) fn.q = q; } },
      });
    } catch (e) {}
  } catch (e) {}
})();
