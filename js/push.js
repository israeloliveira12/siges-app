/* ============================================================================
   Web Push — registro do service worker + inscrição via VAPID
   (o envio de verdade, assinado com a chave privada, acontece em /api/send-push.js)
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

async function registerPushIfSupported() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const json = sub.toJSON();
    await supa.from('push_subscriptions').upsert({
      profile_id: App.session.user.id,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    }, { onConflict: 'endpoint' });
  } catch (e) {
    console.warn('Push não disponível neste navegador/aparelho:', e);
  }
}
