/* ============================================================================
   Cliente — Solicitar empréstimo + histórico de solicitações
   ============================================================================ */

function buildFollowupWhatsappUrl(request) {
  const companyPhone = String((App.settings && App.settings.company_whatsapp) || '').replace(/\D/g, '');
  if (!companyPhone) return null;
  const withCountry = companyPhone.startsWith('55') ? companyPhone : '55' + companyPhone;
  const prazo = request.requested_due_type
    ? dueTypeLabel(request.requested_due_type, request.requested_custom_interval_days)
    : '—';
  const texto = [
    '*Acompanhamento de Solicitação de Empréstimo*',
    '',
    `Olá! Meu nome é ${userDisplayName()}.`,
    `Gostaria de acompanhar minha solicitação de empréstimo no valor de ${formatMoney(request.requested_amount)}, com pagamento ${prazo}, enviada em ${formatDate(request.created_at)}.`,
  ].join('\n');
  return `https://wa.me/${withCountry}?text=${encodeURIComponent(texto)}`;
}

async function renderClienteSolicitar() {
  const root = document.getElementById('screen-cliente-solicitar');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const clientId = App.session.user.id;
  let available = 0;
  try {
    const limit = App.client ? Number(App.client.credit_limit) : 0;
    const { data } = await supa.rpc('client_outstanding_balance', { p_client_id: clientId });
    available = Math.max(0, limit - (Number(data) || 0));
  } catch (e) { /* segue com 0 */ }

  const { data: requests } = await supa
    .from('loan_requests').select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });

  root.innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <h3>Solicitar novo empréstimo</h3>
        <p class="text-sm text-soft mt-8">Limite disponível: <strong class="mono">${formatMoney(available)}</strong></p>
        <div id="solicitar-feedback"></div>
        <form id="solicitar-form" class="mt-14">
          <div class="field">
            <label>Valor desejado (R$)</label>
            <input type="text" id="s-amount" placeholder="0,00" required>
            <span class="help">O valor será analisado por um administrador, que pode ajustar as condições finais.</span>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Prazo desejado</label>
              <select id="s-due-type" required>
                <option value="mensal">Mensal</option>
                <option value="quinzenal">Quinzenal</option>
                <option value="personalizado">Personalizado (dias)</option>
              </select>
            </div>
            <div class="field hidden" id="s-custom-days-field">
              <label>A cada quantos dias?</label>
              <input type="number" min="1" step="1" id="s-custom-days" value="3">
            </div>
          </div>
          <div class="field">
            <label>Mensagem (opcional)</label>
            <textarea id="s-message" placeholder="Ex: preciso para..."></textarea>
          </div>
          <button type="submit" class="btn btn-primary btn-block" id="s-submit">Enviar solicitação</button>
        </form>
      </div>

      <div class="card">
        <h3>Minhas solicitações</h3>
        <div class="mt-14" id="solicitacoes-list">
          ${(requests && requests.length) ? requests.map((r) => `
            <div style="padding:10px 0;border-bottom:1px solid var(--line)">
              <div class="flex justify-between items-center">
                <div>
                  <div class="mono" style="font-weight:700">${formatMoney(r.requested_amount)}</div>
                  <div class="text-sm text-soft">${formatDate(r.created_at)}${r.requested_due_type ? ' · ' + dueTypeLabel(r.requested_due_type, r.requested_custom_interval_days) : ''}${r.decision_reason ? ' · ' + escapeHtml(r.decision_reason) : ''}</div>
                </div>
                ${statusBadge(r.status, r.status === 'pendente' ? 'Aguardando aprovação' : r.status === 'aprovada' ? 'Aprovada' : 'Reprovada')}
              </div>
              ${r.status === 'pendente' && buildFollowupWhatsappUrl(r) ? `<a class="btn btn-outline btn-sm mt-8" href="${buildFollowupWhatsappUrl(r)}" target="_blank" rel="noopener">${Icons.alarm} Acompanhar pelo WhatsApp</a>` : ''}
            </div>
          `).join('') : `<div class="empty-state">${Icons.inbox}<p>Nenhuma solicitação ainda.</p></div>`}
        </div>
      </div>
    </div>
  `;

  attachMoneyMask(document.getElementById('s-amount'));
  document.getElementById('s-due-type').onchange = (e) => {
    document.getElementById('s-custom-days-field').classList.toggle('hidden', e.target.value !== 'personalizado');
  };

  document.getElementById('solicitar-form').onsubmit = async (e) => {
    e.preventDefault();
    const feedback = document.getElementById('solicitar-feedback');
    feedback.innerHTML = '';
    const amount = getMoneyValue(document.getElementById('s-amount'));
    const dueType = document.getElementById('s-due-type').value;
    const customDays = dueType === 'personalizado' ? Math.max(1, parseInt(document.getElementById('s-custom-days').value || '3', 10)) : null;
    const message = document.getElementById('s-message').value.trim() || null;

    if (!amount || amount <= 0) { feedback.innerHTML = '<div class="auth-error">Informe um valor válido.</div>'; return; }
    if (available > 0 && amount > available) {
      feedback.innerHTML = `<div class="auth-error">O valor solicitado ultrapassa seu limite disponível (${formatMoney(available)}). Você ainda pode enviar, mas o administrador poderá ajustar.</div>`;
    }

    const btn = document.getElementById('s-submit');
    btn.disabled = true;
    try {
      const { error } = await supa.from('loan_requests').insert({
        client_id: App.session.user.id,
        requested_amount: amount,
        requested_due_type: dueType,
        requested_custom_interval_days: customDays,
        message,
      });
      if (error) throw error;
      notifyEvent('solicitacao_criada', null,
        'Nova solicitação de empréstimo',
        `${userDisplayName()} solicitou ${formatMoney(amount)}.`);
      showToast('Solicitação enviada! O administrador foi notificado.');
      await renderClienteSolicitar();
    } catch (e2) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(e2.message || String(e2))}</div>`;
      btn.disabled = false;
    }
  };
}

registerRoute('cliente/solicitar', { role: 'cliente', screenId: 'cliente-solicitar', title: 'Solicitar Empréstimo', render: renderClienteSolicitar });
