/* ============================================================================
   Cliente — histórico de cobranças e avisos recebidos
   ============================================================================ */

const CHANNEL_LABELS = { email: 'E-mail', push: 'Push', in_app: 'App', whatsapp: 'WhatsApp' };

async function renderClienteNotificacoes() {
  const root = document.getElementById('screen-cliente-notificacoes');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const { data, error } = await supa
    .from('notifications_log')
    .select('*')
    .eq('recipient_id', App.session.user.id)
    .order('sent_at', { ascending: false })
    .limit(100);

  if (error) { root.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }

  if (!data || !data.length) {
    root.innerHTML = `<div class="empty-state">${Icons.bell}<p>Nenhum aviso recebido ainda.</p></div>`;
    return;
  }

  root.innerHTML = `
    <div class="card" style="padding:0">
      ${data.map((n) => `
        <div class="notif-item" style="padding:14px 16px">
          <div class="flex justify-between items-center">
            <span class="title">${escapeHtml(n.title)}</span>
            <span class="badge badge-neutral">${CHANNEL_LABELS[n.channel] || n.channel}</span>
          </div>
          <div class="body mt-8">${escapeHtml(n.body)}</div>
          <div class="time">${formatDateTime(n.sent_at)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

registerRoute('cliente/notificacoes', { role: 'cliente', screenId: 'cliente-notificacoes', title: 'Notificações', render: renderClienteNotificacoes });
