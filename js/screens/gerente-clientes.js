/* ============================================================================
   Cadastro / gestão de clientes (gerente/administrador)
   ============================================================================ */

let clientesCache = [];
let clientesSearch = '';
let clientesTab = 'aprovado'; // 'pendente' | 'aprovado' | 'rejeitado'

async function renderGerenteClientes() {
  const root = document.getElementById('screen-gerente-clientes');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;
  await loadClientesCache();
  paintClientesScreen();
}

async function loadClientesCache() {
  const { data, error } = await supa
    .from('clients')
    .select('*, profiles!clients_profile_id_fkey(full_name, email, cpf, phone, active)')
    .order('created_at', { ascending: false });
  if (error) { console.error(error); clientesCache = []; return; }
  clientesCache = data || [];
}

function paintClientesScreen() {
  const root = document.getElementById('screen-gerente-clientes');
  // Preserva foco/cursor da busca entre repaints — sem isso, cada tecla
  // digitada recria o <input> do zero e o cursor "some" até o usuário
  // clicar de novo no campo.
  const searchElBefore = document.getElementById('clientes-search');
  const hadFocus = !!searchElBefore && document.activeElement === searchElBefore;
  const cursorPos = hadFocus ? searchElBefore.selectionStart : null;

  const term = clientesSearch.trim().toLowerCase();
  const pendingCount = clientesCache.filter((c) => c.approval_status === 'pendente').length;

  const rows = clientesCache.filter((c) => {
    if (c.approval_status !== clientesTab) return false;
    if (!term) return true;
    const p = c.profiles || {};
    return (p.full_name || '').toLowerCase().includes(term) || (p.email || '').toLowerCase().includes(term) || (p.cpf || '').includes(term);
  }).sort((a, b) => (a.profiles || {}).full_name?.localeCompare((b.profiles || {}).full_name || '', 'pt-BR') || 0);

  root.innerHTML = `
    <div class="flex justify-between items-center gap-10" style="flex-wrap:wrap">
      <div class="flex gap-8">
        <button class="btn btn-sm ${clientesTab === 'aprovado' ? 'btn-primary' : 'btn-outline'}" id="tab-aprovado">Aprovados</button>
        <button class="btn btn-sm ${clientesTab === 'pendente' ? 'btn-primary' : 'btn-outline'}" id="tab-pendente">Pendentes ${pendingCount ? `(${pendingCount})` : ''}</button>
        <button class="btn btn-sm ${clientesTab === 'rejeitado' ? 'btn-primary' : 'btn-outline'}" id="tab-rejeitado">Rejeitados</button>
      </div>
      <button class="btn btn-primary" id="novo-cliente-btn">${Icons.plus} Novo Cliente</button>
    </div>

    <div class="flex items-center justify-between gap-10 mt-14" style="flex-wrap:wrap">
      <div style="max-width:320px;flex:1">
        <input type="text" id="clientes-search" placeholder="Buscar por nome, e-mail ou CPF" value="${escapeHtml(clientesSearch)}">
      </div>
      <p class="text-sm text-soft">${rows.length} cliente${rows.length === 1 ? '' : 's'}${term ? ' encontrado' + (rows.length === 1 ? '' : 's') : ''}</p>
    </div>

    <div class="card mt-14" style="padding:0;overflow:hidden">
      ${rows.length ? `
      <table class="data-table table-scroll">
        <thead><tr>
          <th>Nome</th><th>CPF</th><th>Contato</th><th>Limite de crédito</th><th>Ações</th>
        </tr></thead>
        <tbody>
          ${rows.map((c) => {
            const p = c.profiles || {};
            const phoneDigits = String(p.phone || '').replace(/\D/g, '');
            const waUrl = phoneDigits ? `https://wa.me/${phoneDigits.startsWith('55') ? phoneDigits : '55' + phoneDigits}` : null;
            return `
            <tr>
              <td data-label="Nome"><div class="flex items-center gap-8">${avatarHtml(p.full_name, 28)}<strong>${escapeHtml(p.full_name || '—')}</strong></div></td>
              <td data-label="CPF" class="mono">${escapeHtml(formatCpf(p.cpf || '') || '—')}</td>
              <td data-label="Contato" class="mobile-hide"><div><div>${escapeHtml(p.email || '')}</div><div class="text-sm text-soft">${escapeHtml(formatPhoneBR(p.phone || ''))}</div></div></td>
              <td data-label="Limite" class="mono mobile-hide">${formatMoney(c.credit_limit)}</td>
              <td data-label="Ações">
                <div class="flex gap-8">
                  ${clientesTab === 'pendente' ? `
                    <button class="btn btn-primary btn-sm approve-client-btn" data-id="${c.profile_id}">Aprovar</button>
                    <button class="btn btn-outline btn-sm reject-client-btn" data-id="${c.profile_id}">Rejeitar</button>
                  ` : ''}
                  <button class="icon-btn view-contracts-btn" data-id="${c.profile_id}" title="Ver contratos em aberto">${Icons.contract}</button>
                  ${waUrl ? `<a class="icon-btn" href="${waUrl}" target="_blank" rel="noopener" title="Contatar via WhatsApp">${Icons.whatsapp}</a>` : ''}
                  <button class="icon-btn row-more-btn" data-id="${c.profile_id}" title="Mais ações">${Icons.more}</button>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : `<div class="empty-state">${Icons.users}<p>Nenhum cliente ${clientesTab === 'pendente' ? 'pendente' : clientesTab === 'aprovado' ? 'aprovado' : 'rejeitado'}.</p></div>`}
    </div>
  `;

  document.getElementById('tab-pendente').onclick = () => { clientesTab = 'pendente'; paintClientesScreen(); };
  document.getElementById('tab-aprovado').onclick = () => { clientesTab = 'aprovado'; paintClientesScreen(); };
  document.getElementById('tab-rejeitado').onclick = () => { clientesTab = 'rejeitado'; paintClientesScreen(); };
  const searchEl = document.getElementById('clientes-search');
  searchEl.oninput = debounce((e) => { clientesSearch = e.target.value; paintClientesScreen(); }, 250);
  if (hadFocus) { searchEl.focus(); if (cursorPos != null) searchEl.setSelectionRange(cursorPos, cursorPos); }
  document.getElementById('novo-cliente-btn').onclick = () => openClienteModal(null);

  root.querySelectorAll('.row-more-btn').forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); openRowMoreMenu(btn, btn.dataset.id); };
  });
  root.querySelectorAll('.view-contracts-btn').forEach((btn) => {
    btn.onclick = () => {
      const client = clientesCache.find((c) => c.profile_id === btn.dataset.id);
      contratosTab = 'aberto';
      contratosSearch = (client && client.profiles && client.profiles.full_name) || '';
      router.navigate('#/gerente/contratos');
    };
  });
  root.querySelectorAll('.approve-client-btn').forEach((btn) => {
    btn.onclick = async () => {
      const client = clientesCache.find((c) => c.profile_id === btn.dataset.id);
      const { error } = await supa.rpc('approve_client', { p_client_id: btn.dataset.id });
      if (error) { showToast('Erro: ' + error.message); return; }
      notifyEvent('solicitacao_aprovada', btn.dataset.id, 'Cadastro aprovado', 'Sua conta foi aprovada. Você já pode usar o SIGES normalmente.');
      logAudit('cliente_aprovado', `Cadastro de ${((client || {}).profiles || {}).full_name || btn.dataset.id} aprovado`, { client_id: btn.dataset.id });
      showToast('Cliente aprovado.');
      renderGerenteClientes();
    };
  });
  root.querySelectorAll('.reject-client-btn').forEach((btn) => {
    btn.onclick = () => openRejectClientModal(btn.dataset.id);
  });
}

// Menu flutuante "⋮" (Editar/Excluir) — anexado em #app (não dentro do
// card, que tem overflow:hidden pra arredondar a tabela) e posicionado via
// getBoundingClientRect(), pra nunca ficar cortado perto do fim da lista.
function openRowMoreMenu(anchorBtn, clientId) {
  document.querySelectorAll('.row-more-menu').forEach((m) => m.remove());
  const rect = anchorBtn.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'row-more-menu';
  menu.style.cssText = `position:fixed;z-index:50;top:${rect.bottom + 4}px;right:${window.innerWidth - rect.right}px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-sm);box-shadow:var(--shadow);min-width:140px;overflow:hidden`;
  menu.innerHTML = `
    <button type="button" class="row-more-edit row-more-item" style="display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;background:none;border:none;text-align:left;cursor:pointer;color:var(--ink);font-size:13.5px">${Icons.edit} Editar</button>
    <button type="button" class="row-more-delete row-more-item" style="display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;background:none;border:none;border-top:1px solid var(--line);text-align:left;cursor:pointer;color:var(--bad);font-size:13.5px">${Icons.trash} Excluir</button>
  `;
  document.getElementById('app').appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener('click', onOutsideClick); };
  const onOutsideClick = (e) => { if (!menu.contains(e.target) && e.target !== anchorBtn) close(); };
  setTimeout(() => document.addEventListener('click', onOutsideClick), 0);
  menu.querySelector('.row-more-edit').onclick = () => { close(); openClienteModal(clientesCache.find((c) => c.profile_id === clientId)); };
  menu.querySelector('.row-more-delete').onclick = () => { close(); openDeleteClienteConfirm(clientesCache.find((c) => c.profile_id === clientId)); };
}

function openRejectClientModal(clientId) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h3>Rejeitar cadastro</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="reject-feedback"></div>
        <div class="field"><label>Motivo (opcional)</label><textarea id="reject-reason"></textarea></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-danger" id="confirm-reject">Rejeitar cadastro</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;
  document.getElementById('confirm-reject').onclick = async () => {
    const reason = document.getElementById('reject-reason').value.trim();
    const { error } = await supa.rpc('reject_client', { p_client_id: clientId, p_reason: reason || null });
    if (error) { document.getElementById('reject-feedback').innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
    notifyEvent('solicitacao_reprovada', clientId, 'Cadastro não aprovado', reason ? `Motivo: ${reason}` : 'Seu cadastro não foi aprovado.');
    logAudit('cliente_rejeitado', `Cadastro de cliente rejeitado`, { client_id: clientId, reason: reason || null });
    close();
    showToast('Cadastro rejeitado.');
    renderGerenteClientes();
  };
}

function openDeleteClienteConfirm(client) {
  const p = (client && client.profiles) || {};
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h3 style="color:var(--bad)">Excluir cliente</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <p class="text-sm">Tem certeza que deseja excluir <strong>${escapeHtml(p.full_name || '')}</strong> permanentemente? Essa ação não pode ser desfeita.</p>
        <p class="text-sm text-soft mt-8">Se este cliente já tiver contratos registrados, a exclusão será bloqueada (para preservar o histórico financeiro) — nesse caso, prefira apenas desativar/editar o cadastro.</p>
        <div id="delete-feedback" class="mt-8"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-danger" id="confirm-delete">Excluir permanentemente</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;
  document.getElementById('confirm-delete').onclick = async () => {
    const btn = document.getElementById('confirm-delete');
    btn.disabled = true;
    try {
      const resp = await fetch('/api/delete-client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + App.session.access_token },
        body: JSON.stringify({ client_id: client.profile_id }),
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Falha ao excluir cliente.');
      logAudit('cliente_excluido', `Cliente ${p.full_name || ''} excluído`, { client_id: client.profile_id });
      close();
      showToast('Cliente excluído.');
      renderGerenteClientes();
    } catch (e) {
      document.getElementById('delete-feedback').innerHTML = `<div class="auth-error">${escapeHtml(e.message)}</div>`;
      btn.disabled = false;
    }
  };
}

function openResetClientPasswordModal(client, p) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h3>Redefinir senha</h3><button class="icon-btn" id="rp-close">${Icons.x}</button></div>
      <div class="modal-body">
        <p class="text-sm text-soft">Nova senha para ${escapeHtml(p.full_name || 'o cliente')}.</p>
        <div class="field mt-14"><label>Nova senha</label>${passwordFieldHtml('rp-password', 'minlength="6" placeholder="Nova senha (mín. 6 caracteres)"')}</div>
        <div id="rp-feedback"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="rp-cancel">Cancelar</button>
        <button class="btn btn-primary" id="rp-confirm">Redefinir</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);
  // Escopado em `overlay` (nunca `document.getElementById`) — este popup
  // fica empilhado por cima do modal de editar cliente, que já usa os IDs
  // genéricos "close-modal"/"cancel-modal". Um modal aberto por cima do
  // outro com IDs repetidos faz `document.getElementById` pegar sempre o
  // elemento do modal de baixo (o primeiro no DOM), religando os botões do
  // popup pro modal errado — bug real corrigido (2026-07-14): X/Cancelar do
  // popup não fechavam nada porque o clique ia pro botão escondido atrás.
  const close = () => overlay.remove();
  overlay.querySelector('#rp-close').onclick = close;
  overlay.querySelector('#rp-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  wirePasswordToggles(overlay);

  overlay.querySelector('#rp-confirm').onclick = async () => {
    const feedback = overlay.querySelector('#rp-feedback');
    const input = overlay.querySelector('#rp-password');
    const newPassword = input.value;
    feedback.innerHTML = '';
    if (newPassword.length < 6) { feedback.innerHTML = `<div class="auth-error">A senha precisa ter pelo menos 6 caracteres.</div>`; return; }
    const btn = overlay.querySelector('#rp-confirm');
    btn.disabled = true;
    try {
      const { data: { session } } = await supa.auth.getSession();
      const resp = await fetch('/api/reset-client-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
        body: JSON.stringify({ user_id: client.profile_id, new_password: newPassword }),
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Falha ao redefinir a senha.');
      logAudit('senha_redefinida', `Senha redefinida para o cliente ${p.full_name || ''}`, { client_id: client.profile_id });
      showToast('Senha do cliente redefinida.');
      close();
    } catch (e) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(e.message || String(e))}</div>`;
      btn.disabled = false;
    }
  };
}

function openClienteModal(client) {
  const isEdit = !!client;
  const p = (client && client.profiles) || {};
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>${isEdit ? 'Editar cliente' : 'Novo cliente'}</h3>
        <button class="icon-btn" id="close-modal">${Icons.x}</button>
      </div>
      <div class="modal-body">
        <div id="modal-feedback"></div>
        ${!isEdit ? `
        <div class="field"><label>E-mail (login do cliente)</label><input type="email" id="m-email" required></div>
        <div class="field"><label>Senha inicial</label>${passwordFieldHtml('m-password', 'minlength="6" required')}</div>
        ` : ''}
        <div class="field"><label>Nome completo</label><input type="text" id="m-name" value="${escapeHtml(p.full_name || '')}"></div>
        ${isEdit ? `
        <div class="field">
          <label>E-mail (login do cliente)</label>
          <div class="flex gap-8" style="align-items:center">
            <input type="email" id="m-email" value="${escapeHtml(p.email || '')}" style="flex:1">
            <button type="button" class="btn btn-outline btn-sm" id="reset-password-btn" style="flex:none">Redefinir senha</button>
          </div>
        </div>
        ` : ''}
        <div class="field-row">
          <div class="field"><label>CPF</label><input type="text" id="m-cpf" maxlength="14" value="${escapeHtml(formatCpf(p.cpf || ''))}"></div>
          <div class="field"><label>Telefone</label><input type="tel" id="m-phone" placeholder="(00) 00000-0000" value="${escapeHtml(formatPhoneBR(p.phone || ''))}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Empresa</label><input type="text" id="m-company" value="${escapeHtml((client && client.company) || '')}"></div>
          <div class="field"><label>Cargo</label><input type="text" id="m-job-title" value="${escapeHtml((client && client.job_title) || '')}"></div>
        </div>
        <div class="field">
          <label>Indicado por (opcional)</label>
          <div style="position:relative">
            <div class="flex gap-8" style="align-items:center">
              <input type="text" id="m-referred-by" placeholder="Buscar cliente por nome..." style="flex:1" autocomplete="off">
              <button type="button" class="icon-btn" id="m-referred-by-clear" title="Remover indicação" style="display:none">${Icons.x}</button>
            </div>
            <div id="m-referred-by-results" class="hidden" style="position:absolute;z-index:5;top:100%;left:0;right:0;margin-top:4px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-sm);max-height:200px;overflow-y:auto;box-shadow:var(--shadow)"></div>
          </div>
          <div id="m-referred-by-feedback" class="text-sm mt-8"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Renda Mensal</label><select id="m-salary">${incomeBracketOptionsHtml((client && client.salary) || null, true)}</select></div>
          <div class="field"><label>Chave Pix</label><input type="text" id="m-pix-key" value="${escapeHtml((client && client.pix_key) || '')}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Limite de crédito (R$)</label><input type="text" id="m-limit" placeholder="0,00"></div>
          <div class="field"><label>Grupo</label><select id="m-group">${clientGroupOptionsHtml((client && client.client_group) || null, true)}</select></div>
        </div>
        <div class="field"><label>Observações</label><textarea id="m-notes">${escapeHtml((client && client.notes) || '')}</textarea></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-primary" id="save-modal">${isEdit ? 'Salvar alterações' : 'Criar cliente'}</button>
      </div>
    </div>
  `;
  document.getElementById('app').appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;
  document.getElementById('m-cpf').oninput = (e) => { e.target.value = formatCpf(e.target.value); };
  wirePasswordToggles(overlay);
  attachPhoneMask(document.getElementById('m-phone'));
  attachMoneyMask(document.getElementById('m-limit'));
  setMoneyValue(document.getElementById('m-limit'), client ? client.credit_limit : 0);

  // "Indicado por" — autocomplete por nome (server-side, via
  // search_clients_for_referral), com dropdown de resultados clicáveis.
  // selectedReferrerId é o que realmente vai pro banco — o texto do input é
  // só pra digitar/exibir o nome escolhido.
  let selectedReferrerId = null;
  let selectedReferrerName = '';
  const referredInput = document.getElementById('m-referred-by');
  const referredClearBtn = document.getElementById('m-referred-by-clear');
  const referredFeedback = document.getElementById('m-referred-by-feedback');
  const referredResults = document.getElementById('m-referred-by-results');

  function setReferrerFeedback(text, ok) {
    referredFeedback.textContent = text;
    referredFeedback.style.color = ok ? 'var(--good)' : 'var(--ink-soft)';
  }
  function hideReferrerResults() {
    referredResults.classList.add('hidden');
    referredResults.innerHTML = '';
  }
  function selectReferrer(row) {
    selectedReferrerId = row.profile_id;
    selectedReferrerName = row.full_name;
    referredInput.value = row.full_name;
    hideReferrerResults();
    setReferrerFeedback(`✓ Indicado por ${row.full_name}`, true);
    referredClearBtn.style.display = '';
  }
  function clearReferrer() {
    selectedReferrerId = null;
    selectedReferrerName = '';
    referredInput.value = '';
    hideReferrerResults();
    referredFeedback.textContent = '';
    referredClearBtn.style.display = 'none';
  }
  async function searchReferrer(query) {
    if (query.length < 2) { hideReferrerResults(); return; }
    const { data, error } = await supa.rpc('search_clients_for_referral', {
      p_query: query,
      p_exclude_client_id: isEdit ? client.profile_id : null,
    });
    if (error || !data || !data.length) {
      referredResults.innerHTML = `<div class="text-sm text-soft" style="padding:10px 12px">Nenhum cliente encontrado.</div>`;
      referredResults.classList.remove('hidden');
      return;
    }
    referredResults.innerHTML = data.map((r) => `
      <div class="referrer-result-row" data-id="${r.profile_id}" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--line)">
        <div>${escapeHtml(r.full_name)}</div>
        <div class="text-sm text-soft">${escapeHtml(formatCpf(r.cpf || '') || '—')}</div>
      </div>
    `).join('');
    referredResults.classList.remove('hidden');
    referredResults.querySelectorAll('.referrer-result-row').forEach((row) => {
      row.onclick = () => {
        const found = data.find((r) => r.profile_id === row.dataset.id);
        if (found) selectReferrer(found);
      };
    });
  }
  referredInput.oninput = debounce((e) => {
    // Editar o texto depois de já ter selecionado alguém invalida a seleção antiga.
    if (selectedReferrerId && e.target.value !== selectedReferrerName) {
      selectedReferrerId = null;
      referredFeedback.textContent = '';
      referredClearBtn.style.display = 'none';
    }
    searchReferrer(e.target.value.trim());
  }, 300);
  // Blur com pequeno atraso — dá tempo do clique num resultado registrar
  // antes do dropdown sumir (padrão comum de autocomplete).
  referredInput.onblur = () => setTimeout(hideReferrerResults, 150);
  referredClearBtn.onclick = clearReferrer;
  if (isEdit && client.referred_by_client_id) {
    supa.from('profiles').select('id, full_name').eq('id', client.referred_by_client_id).maybeSingle()
      .then(({ data: referrer }) => {
        if (!referrer) return;
        selectedReferrerId = referrer.id;
        selectedReferrerName = referrer.full_name;
        referredInput.value = referrer.full_name;
        setReferrerFeedback(`✓ Indicado por ${referrer.full_name}`, true);
        referredClearBtn.style.display = '';
      });
  }

  if (isEdit) {
    document.getElementById('reset-password-btn').onclick = () => openResetClientPasswordModal(client, p);
  }

  document.getElementById('save-modal').onclick = async () => {
    const feedback = document.getElementById('modal-feedback');
    feedback.innerHTML = '';
    const payload = {
      full_name: document.getElementById('m-name').value.trim(),
      cpf: document.getElementById('m-cpf').value.trim() || null,
      phone: document.getElementById('m-phone').value.replace(/\D/g, '') || null,
      credit_limit: getMoneyValue(document.getElementById('m-limit')),
      client_group: document.getElementById('m-group').value || null,
      notes: document.getElementById('m-notes').value.trim() || null,
      company: document.getElementById('m-company').value.trim() || null,
      job_title: document.getElementById('m-job-title').value.trim() || null,
      salary: document.getElementById('m-salary').value || null,
      pix_key: document.getElementById('m-pix-key').value.trim() || null,
      referred_by_client_id: selectedReferrerId,
    };
    const btn = document.getElementById('save-modal');
    btn.disabled = true;
    try {
      if (isEdit) {
        const newEmail = document.getElementById('m-email').value.trim().toLowerCase();
        if (newEmail && newEmail !== (p.email || '').toLowerCase()) {
          const { data: { session } } = await supa.auth.getSession();
          const resp = await fetch('/api/update-user-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
            body: JSON.stringify({ user_id: client.profile_id, new_email: newEmail }),
          });
          const result = await resp.json();
          if (!resp.ok) throw new Error(result.error || 'Falha ao atualizar o e-mail.');
        }
        const { error } = await supa.rpc('update_client_profile', {
          p_client_id: client.profile_id,
          p_full_name: payload.full_name, p_cpf: payload.cpf, p_phone: payload.phone,
          p_credit_limit: payload.credit_limit,
          p_client_group: payload.client_group, p_notes: payload.notes,
          p_company: payload.company, p_job_title: payload.job_title,
          p_salary: payload.salary, p_pix_key: payload.pix_key,
          p_referred_by_client_id: payload.referred_by_client_id,
        });
        if (error) throw error;
      } else {
        const email = document.getElementById('m-email').value.trim();
        const password = document.getElementById('m-password').value;
        if (!email || password.length < 6) throw new Error('Preencha e-mail e senha (mínimo 6 caracteres).');
        const { data: { session } } = await supa.auth.getSession();
        const resp = await fetch('/api/create-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
          body: JSON.stringify({ email, password, full_name: payload.full_name, role: 'cliente' }),
        });
        const result = await resp.json();
        if (!resp.ok) throw new Error(result.error || 'Falha ao criar cliente.');
        const { error: profileError } = await supa.rpc('update_client_profile', {
          p_client_id: result.user_id,
          p_full_name: payload.full_name, p_cpf: payload.cpf, p_phone: payload.phone,
          p_credit_limit: payload.credit_limit,
          p_client_group: payload.client_group, p_notes: payload.notes,
          p_company: payload.company, p_job_title: payload.job_title,
          p_salary: payload.salary, p_pix_key: payload.pix_key,
          p_referred_by_client_id: payload.referred_by_client_id,
        });
        if (profileError) throw profileError;
        // Cliente criado diretamente pelo gerente já nasce aprovado (não precisa de aprovação retroativa).
        const { error: approveError } = await supa.rpc('approve_client', { p_client_id: result.user_id });
        if (approveError) throw approveError;
      }
      logAudit(isEdit ? 'cliente_editado' : 'cliente_criado', `Cliente ${payload.full_name} ${isEdit ? 'editado' : 'criado'}`, { client_id: isEdit ? client.profile_id : undefined });
      close();
      showToast(isEdit ? 'Cliente atualizado.' : 'Cliente criado com sucesso.');
      await renderGerenteClientes();
    } catch (e) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(e.message || String(e))}</div>`;
    } finally {
      btn.disabled = false;
    }
  };
}

registerRoute('gerente/clientes', { role: 'gerente', screenId: 'gerente-clientes', title: 'Clientes', render: renderGerenteClientes });
