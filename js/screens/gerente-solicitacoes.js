/* ============================================================================
   Gerente — aprovar/reprovar solicitações de empréstimo
   ============================================================================ */

let pendingContractPrefill = null; // usado para pré-preencher o wizard de novo contrato

async function renderGerenteSolicitacoes() {
  const root = document.getElementById('screen-gerente-solicitacoes');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const { data, error } = await supa
    .from('loan_requests')
    .select('*, clients!loan_requests_client_id_fkey(profile_id, profiles!clients_profile_id_fkey(full_name, email))')
    .order('created_at', { ascending: false });

  if (error) { root.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }

  const pendentes = (data || []).filter((r) => r.status === 'pendente');
  const decididas = (data || []).filter((r) => r.status !== 'pendente');

  const rowHtml = (r, showActions) => {
    const client = r.clients || {};
    const p = client.profiles || {};
    return `
    <div class="card" style="margin-bottom:10px">
      <div class="flex justify-between items-center" style="flex-wrap:wrap;gap:10px">
        <div>
          <strong>${escapeHtml(p.full_name || '—')}</strong>
          <div class="text-sm text-soft">${escapeHtml(p.email || '')} · ${formatDate(r.created_at)}</div>
          <div class="mono mt-8" style="font-size:17px">${formatMoney(r.requested_amount)}</div>
          ${r.requested_due_type ? `<div class="text-sm text-soft">Prazo desejado: ${dueTypeLabel(r.requested_due_type, r.requested_custom_interval_days)}</div>` : ''}
          ${r.message ? `<div class="text-sm mt-8">"${escapeHtml(r.message)}"</div>` : ''}
          ${r.decision_reason ? `<div class="text-sm text-soft mt-8">Motivo: ${escapeHtml(r.decision_reason)}</div>` : ''}
        </div>
        <div class="flex items-center gap-10">
          ${showActions ? `
            <button class="btn btn-outline btn-sm reject-btn" data-id="${r.id}">Reprovar</button>
            <button class="btn btn-primary btn-sm approve-btn" data-id="${r.id}">Aprovar</button>
          ` : statusBadge(r.status, r.status === 'aprovada' ? 'Aprovada' : 'Reprovada')}
        </div>
      </div>
    </div>`;
  };

  root.innerHTML = `
    <h3 class="mt-8">Pendentes (${pendentes.length})</h3>
    <div class="mt-14">${pendentes.length ? pendentes.map((r) => rowHtml(r, true)).join('') : `<div class="empty-state">${Icons.inbox}<p>Nenhuma solicitação pendente.</p></div>`}</div>

    <h3 class="mt-20">Histórico</h3>
    <div class="mt-14">${decididas.length ? decididas.map((r) => rowHtml(r, false)).join('') : `<div class="empty-state"><p>Sem histórico ainda.</p></div>`}</div>
  `;

  root.querySelectorAll('.approve-btn').forEach((btn) => {
    btn.onclick = () => {
      const req = pendentes.find((r) => r.id === btn.dataset.id);
      pendingContractPrefill = {
        origin_request_id: req.id,
        client_id: req.clients.profile_id,
        client_name: (req.clients.profiles || {}).full_name,
        principal_amount: req.requested_amount,
        due_type: req.requested_due_type || undefined,
        custom_interval_days: req.requested_custom_interval_days || undefined,
      };
      router.navigate('#/gerente/contratos/novo');
    };
  });

  root.querySelectorAll('.reject-btn').forEach((btn) => {
    btn.onclick = () => openRejectModal(btn.dataset.id);
  });
}

function openRejectModal(requestId) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h3>Reprovar solicitação</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="reject-feedback"></div>
        <div class="field"><label>Motivo (visível para o cliente)</label><textarea id="reject-reason" placeholder="Ex: histórico de atraso recente"></textarea></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-danger" id="confirm-reject">Reprovar solicitação</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;
  document.getElementById('confirm-reject').onclick = async () => {
    const reason = document.getElementById('reject-reason').value.trim();
    const btn = document.getElementById('confirm-reject');
    btn.disabled = true;
    try {
      const { data: reqRow } = await supa.from('loan_requests').select('client_id').eq('id', requestId).maybeSingle();
      const { error } = await supa.rpc('reject_request', { p_request_id: requestId, p_reason: reason || null });
      if (error) throw error;
      if (reqRow) {
        notifyEvent('solicitacao_reprovada', reqRow.client_id, 'Solicitação reprovada',
          reason ? `Motivo: ${reason}` : 'Sua solicitação de empréstimo foi reprovada.');
      }
      close();
      showToast('Solicitação reprovada.');
      renderGerenteSolicitacoes();
    } catch (e) {
      document.getElementById('reject-feedback').innerHTML = `<div class="auth-error">${escapeHtml(e.message)}</div>`;
      btn.disabled = false;
    }
  };
}

registerRoute('gerente/solicitacoes', { role: 'gerente', screenId: 'gerente-solicitacoes', title: 'Solicitações', render: renderGerenteSolicitacoes });
