/* ============================================================================
   Service worker — cache básico para funcionar offline (PWA)
   IMPORTANTE: atualize FILES_TO_CACHE sempre que adicionar um arquivo novo
   .js/.css, e suba CACHE_NAME quando a lista mudar de forma significativa.
   ============================================================================ */

const CACHE_NAME = 'siges-cache-v47';

const FILES_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './js/icons.js',
  './js/utils.js',
  './js/state.js',
  './js/auth.js',
  './js/router.js',
  './js/charts.js',
  './js/notifications-ui.js',
  './js/push.js',
  './js/screens/login.js',
  './js/screens/cliente-dashboard.js',
  './js/screens/cliente-solicitar.js',
  './js/screens/cliente-emprestimos.js',
  './js/screens/cliente-indicacoes.js',
  './js/screens/cliente-score.js',
  './js/screens/cliente-notificacoes.js',
  './js/screens/gerente-dashboard.js',
  './js/screens/gerente-clientes.js',
  './js/screens/gerente-gerentes.js',
  './js/screens/gerente-solicitacoes.js',
  './js/screens/gerente-contrato-novo.js',
  './js/screens/gerente-contratos-lista.js',
  './js/screens/gerente-contrato-receber.js',
  './js/screens/gerente-cobrar.js',
  './js/screens/gerente-relatorios.js',
  './js/screens/gerente-score.js',
  './js/screens/gerente-planejamento.js',
  './js/screens/gerente-auditoria.js',
  './js/screens/gerente-configuracoes.js',
  './js/screens/pdf-gerador.js',
  './js/screens/backup-export.js',
  './js/main.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(
        FILES_TO_CACHE.map((url) => cache.add(url).catch(() => { /* arquivo ainda não existe nesta fase, ignora */ }))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // Nunca intercepta/cacheia chamadas de outra origem (Supabase, Resend,
  // etc.) — só o "shell" estático do próprio site (HTML/CSS/JS/ícones) deve
  // passar pela estratégia de cache-com-fallback abaixo. Sem esse filtro, o
  // service worker cacheava respostas de leitura da API (dados financeiros
  // do cliente) sob a URL do recurso, sem levar em conta o token de sessão
  // (PostgREST não envia Vary: Authorization) — numa oscilação de rede, o
  // .catch() servia esse cache sem nenhum aviso de "dado desatualizado", e
  // em dispositivo compartilhado o mesmo cache podia ser reaproveitado por
  // outra conta que logasse em seguida.
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { /* push vazio, mostra texto genérico */ }
  const title = payload.title || 'SIGES';
  const body = payload.body || 'Você tem uma nova notificação. Abra o app para ver os detalhes.';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { url: payload.url || './' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const c of clients) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
