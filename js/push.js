/* ============================================================================
   Web Push — registro do service worker + inscrição via VAPID
   (o envio de verdade, assinado com a chave privada e com o payload cifrado
   conforme a RFC 8291, acontece em api/_lib/webpush.js, chamado por
   notify-event.js e cron-daily-check.js)
   ============================================================================ */

// Chave pública VAPID (gerada uma vez para este projeto — é pública por design,
// pode ficar no código do navegador). A privada correspondente NUNCA vai no
// código — só como env var VAPID_PRIVATE_KEY no Vercel (veja README).
const VAPID_PUBLIC_KEY = 'BEF9PcjT8CrFRd_tv2sbRkIdYMPhELbXj-gekH98iavjdpZjcqmkq6cl8FwfEOd1XnYELumw2JJEOo8ot2FaKhQ';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// UX-21 (auditoria 2026-08-23): a versão anterior chamava
// Notification.requestPermission() LOGO NO LOGIN, sem nenhuma explicação. O
// Chrome penaliza esse padrão (o pedido vira um ícone discreto que ninguém
// vê), o Safari e o iOS exigem gesto do usuário — o resultado prático era
// muita negativa permanente, e uma negativa permanente não tem volta pela
// interface do app. Agora o login só REAPROVEITA uma permissão já concedida;
// pedir a permissão é uma ação explícita, a partir de um botão que diz o que
// vai acontecer (ver enablePushFromUserGesture, usada em Configurações).

// Chamada no boot: nunca abre caixa de permissão. Só garante que quem já
// autorizou continue com a inscrição registrada e atualizada.
async function registerPushIfSupported() {
  if (!pushSupported()) return;
  if (Notification.permission !== 'granted') return;
  try {
    await subscribeAndStore();
  } catch (e) {
    console.warn('Push não disponível neste navegador/aparelho:', e);
  }
}

// Chamada a partir de um clique. Devolve o estado final para a tela mostrar
// a mensagem certa.
async function enablePushFromUserGesture() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
    if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'dismissed';
    await subscribeAndStore();
    return 'granted';
  } catch (e) {
    console.warn('Falha ao ativar notificações:', e);
    return 'error';
  }
}

async function subscribeAndStore() {
  const reg = await navigator.serviceWorker.register('./sw.js');
  await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const json = sub.toJSON();
  // O upsert por `endpoint` depende da policy de UPDATE criada em
  // migration_048.sql (achado OPS-03): sem ela, TODO login depois do primeiro
  // caía no conflito, tentava o UPDATE e era barrado pela RLS — erro que este
  // catch engolia, deixando o push silenciosamente parado.
  const { error } = await supa.from('push_subscriptions').upsert({
    profile_id: App.session.user.id,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
  }, { onConflict: 'endpoint' });
  if (error) throw error;
}

// SEC-12: chamada por handleSignOut() ANTES de encerrar a sessão. Sem isso,
// num aparelho compartilhado o usuário anterior continuava recebendo avisos
// (parcela vencendo, pagamento recebido) até que outra pessoa entrasse e a
// inscrição fosse reatribuída. Precisa da sessão ainda válida — depois do
// signOut a RLS barra o DELETE.
async function unregisterPushOnSignOut() {
  if (!pushSupported() || !App.session) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.toJSON().endpoint;
    await sub.unsubscribe();
    await supa.from('push_subscriptions').delete().eq('endpoint', endpoint);
  } catch (e) { /* melhor esforço — nunca deve impedir o logout */ }
}

// Estado legível pra tela de Configurações.
function pushStatus() {
  if (!pushSupported()) return { key: 'unsupported', label: 'Não disponível neste navegador' };
  if (Notification.permission === 'granted') return { key: 'granted', label: 'Ativadas' };
  if (Notification.permission === 'denied') return { key: 'denied', label: 'Bloqueadas no navegador' };
  return { key: 'default', label: 'Desativadas' };
}
