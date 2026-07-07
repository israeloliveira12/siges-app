/* ============================================================================
   Sino de notificações in-app — Supabase Realtime + histórico
   ============================================================================ */

let notifRealtimeChannel = null;
let notifCache = [];

// Dispara e-mail + push para um evento pontual via serverless function.
// Falha silenciosamente (não deve travar o fluxo principal do usuário) —
// o registro "in_app" relevante já acontece via RPC/trigger no banco.
async function notifyEvent(event, clientId, title, body) {
  try {
    await fetch('/api/notify-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + App.session.access_token },
      body: JSON.stringify({ event, client_id: clientId, title, body }),
    });
  } catch (e) {
    console.warn('Falha ao disparar notificação externa:', e);
  }
}

function renderBell() {
  const wrap = document.getElementById('bell-wrap');
  if (!wrap) return;
  wrap.innerHTML = `
    <button class="icon-btn" id="bell-btn" title="Notificações">
      ${Icons.bell}
      ${App.unreadCount > 0 ? '<span class="bell-dot"></span>' : ''}
    </button>
    <div class="notif-panel hidden" id="notif-panel"></div>
  `;
  document.getElementById('bell-btn').onclick = toggleNotifPanel;
}

async function toggleNotifPanel() {
  const panel = document.getElementById('notif-panel');
  if (!panel) return;
  const willOpen = panel.classList.contains('hidden');
  document.querySelectorAll('.notif-panel').forEach((p) => p.classList.add('hidden'));
  if (!willOpen) return;
  panel.classList.remove('hidden');
  await loadNotifications();
  markAllVisibleAsRead();
}

// Fecha o quadrante ao clicar em qualquer lugar fora dele (não só no sino).
// Registrado uma única vez — funciona mesmo depois de renderBell() recriar
// o botão/painel, porque olha pelo id a cada clique, não por referência.
document.addEventListener('click', (e) => {
  const wrap = document.getElementById('bell-wrap');
  const panel = document.getElementById('notif-panel');
  if (!wrap || !panel || panel.classList.contains('hidden')) return;
  if (!wrap.contains(e.target)) panel.classList.add('hidden');
});

async function loadNotifications() {
  const { data, error } = await supa
    .from('notifications_log')
    .select('*')
    .eq('recipient_id', App.session.user.id)
    .eq('channel', 'in_app')
    .order('sent_at', { ascending: false })
    .limit(30);
  if (error) { console.error(error); return; }
  notifCache = data || [];
  renderNotifList();
}

function renderNotifList() {
  const panel = document.getElementById('notif-panel');
  if (!panel) return;
  if (!notifCache.length) {
    panel.innerHTML = `<div class="empty-state">${Icons.bell}<p>Nenhuma notificação ainda.</p></div>`;
    return;
  }
  panel.innerHTML = notifCache.map((n) => `
    <div class="notif-item ${n.read_at ? '' : 'unread'}">
      <div class="title">${escapeHtml(n.title)}</div>
      <div class="body">${escapeHtml(n.body)}</div>
      <div class="time">${formatDateTime(n.sent_at)}</div>
    </div>
  `).join('');
}

async function markAllVisibleAsRead() {
  const unreadIds = notifCache.filter((n) => !n.read_at).map((n) => n.id);
  if (!unreadIds.length) return;
  App.unreadCount = 0;
  renderBell();
  document.getElementById('bell-btn') && (document.getElementById('bell-btn').onclick = toggleNotifPanel);
  await supa.from('notifications_log').update({ read_at: new Date().toISOString() }).in('id', unreadIds);
}

async function refreshUnreadCount() {
  const { count } = await supa
    .from('notifications_log')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', App.session.user.id)
    .eq('channel', 'in_app')
    .is('read_at', null);
  App.unreadCount = count || 0;
  renderBell();
}

function subscribeNotifications() {
  if (!App.session) return;
  refreshUnreadCount();

  if (notifRealtimeChannel) supa.removeChannel(notifRealtimeChannel);
  notifRealtimeChannel = supa
    .channel('notifications-' + App.session.user.id)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'notifications_log',
      filter: `recipient_id=eq.${App.session.user.id}`,
    }, (payload) => {
      if (payload.new.channel !== 'in_app') return;
      App.unreadCount += 1;
      renderBell();
      showToast(payload.new.title);
    })
    .subscribe();
}
