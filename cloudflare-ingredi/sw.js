// sw.js — ingredi 미니멀 서비스워커
// 목적: 안드로이드 크롬에서 "홈 화면 설치"(beforeinstallprompt)가 동작하도록
//       설치 가능 조건을 충족시키는 용도. 오프라인 캐싱은 하지 않음(패스스루).

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  // 아무것도 가로채지 않음 — 브라우저 기본 동작에 맡김.
  // (fetch 핸들러 존재 자체가 설치 가능 조건을 만족시킴)
});
