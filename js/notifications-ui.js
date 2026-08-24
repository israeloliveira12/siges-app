/* ============================================================================
   Sino de notificações in-app — Supabase Realtime + histórico
   ============================================================================ */

let notifRealtimeChannel = null;
let notifCache = [];
let notifPageSize = 30;
const NOTIF_PAGE_STEP = 30;
let notifHasMore = false;

// Dispara e-mail + push para um evento pontual via serverless function.
// Falha silenciosamente (não deve travar o fluxo principal do usuário) —
// o registro "in_app" relevante já acontece via RPC/trigger no banco.
//
// SEC-04 (auditoria 2026-08-23): a assinatura mudou. Antes esta função mandava
// `title` e `body` prontos, e o servidor os interpolava CRUS dentro do HTML do
// e-mail — para `solicitacao_criada`, quem dispara é o cliente e quem recebe
// são os administradores, ou seja, um cliente montava o conteúdo de um e-mail
// saindo do domínio verificado da financeira. Agora o navegador manda só
// NÚMEROS e o servidor escreve o texto (ver api/notify-event.js).
async function notifyEvent(event, clientId, context) {
  try {
    await fetch('/api/notify-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + App.session.access_token },
      body: JSON.stringify({ event, client_id: clientId, context: context || {} }),
    });
  } catch (e) {
    console.warn('Falha ao disparar notificação externa:', e);
  }
}

function renderBell() {
  const wrap = document.getElementById('bell-wrap');
  if (!wrap) return;
  const label = App.unreadCount > 0
    ? `Notificações — ${App.unreadCount} não lida${App.unreadCount === 1 ? '' : 's'}`
    : 'Notificações';
  wrap.innerHTML = `
    <button class="icon-btn" id="bell-btn" title="Notificações" aria-label="${escapeHtml(label)}" aria-expanded="false" aria-haspopup="true">
      ${Icons.bell}
      ${App.unreadCount > 0 ? '<span class="bell-dot" aria-hidden="true"></span>' : ''}
    </button>
    <div class="notif-panel hidden" id="notif-panel" role="region" aria-label="Notificações"></div>
  `;
  document.getElementById('bell-btn').onclick = toggleNotifPanel;
}

async function toggleNotifPanel() {
  const panel = document.getElementById('notif-panel');
  const btn = document.getElementById('bell-btn');
  if (!panel) return;
  const willOpen = panel.classList.contains('hidden');
  document.querySelectorAll('.notif-panel').forEach((p) => p.classList.add('hidden'));
  if (!willOpen) { if (btn) btn.setAttribute('aria-expanded', 'false'); return; }
  panel.classList.remove('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  notifPageSize = NOTIF_PAGE_STEP;
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
  if (!wrap.contains(e.target)) {
    panel.classList.add('hidden');
    const btn = document.getElementById('bell-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
});

// Escape fecha o painel — mesmo padrão dos modais (UX-02).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const panel = document.getElementById('notif-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  panel.classList.add('hidden');
  const btn = document.getElementById('bell-btn');
  if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
});

async function loadNotifications() {
  // UX-12: busca uma linha a mais que o pedido só pra saber se ainda existe
  // histórico além desta página — é o que habilita o "Ver mais antigas".
  const { data, error } = await supa
    .from('notifications_log')
    .select('*')
    .eq('recipient_id', App.session.user.id)
    .eq('channel', 'in_app')
    .order('sent_at', { ascending: false })
    .limit(notifPageSize + 1);
  if (error) { console.error(error); return; }
  const rows = data || [];
  notifHasMore = rows.length > notifPageSize;
  notifCache = notifHasMore ? rows.slice(0, notifPageSize) : rows;
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
  `).join('') + (notifHasMore
    ? `<button class="notif-more" id="notif-more">Ver mais antigas</button>`
    : '');

  const more = document.getElementById('notif-more');
  if (more) {
    more.onclick = async () => {
      more.disabled = true;
      more.textContent = 'Carregando...';
      notifPageSize += NOTIF_PAGE_STEP;
      await loadNotifications();
      markAllVisibleAsRead();
    };
  }
}

async function markAllVisibleAsRead() {
  const unreadIds = notifCache.filter((n) => !n.read_at).map((n) => n.id);
  if (!unreadIds.length) return;

  const { error } = await supa.from('notifications_log')
    .update({ read_at: new Date().toISOString() })
    .in('id', unreadIds);
  if (error) return;

  // UX-17 (auditoria 2026-08-23): o contador era zerado direto (`App.unreadCount = 0`)
  // assumindo que a página carregada continha TODAS as não lidas. Com mais de
  // 30 pendentes, o restante continuava não lido no banco mas o sino apagava —
  // a pessoa perdia avisos sem saber. Agora recontamos no servidor, que é a
  // única fonte capaz de responder isso corretamente.
  notifCache = notifCache.map((n) => (unreadIds.includes(n.id) ? { ...n, read_at: new Date().toISOString() } : n));
  await refreshUnreadCount();
  renderNotifList();
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
