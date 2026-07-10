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
  const term = clientesSearch.trim().toLowerCase();
  const pendingCount = clientesCache.filter((c) => c.approval_status === 'pendente').length;

  const rows = clientesCache.filter((c) => {
    if (c.approval_status !== clientesTab) return false;
    if (!term) return true;
    const p = c.profiles || {};
    return (p.full_name || '').toLowerCase().includes(term) || (p.email || '').toLowerCase().includes(term) || (p.cpf || '').includes(term);
  });

  root.innerHTML = `
    <div class="flex justify-between items-center gap-10" style="flex-wrap:wrap">
      <div class="flex gap-8">
        <button class="btn btn-sm ${clientesTab === 'pendente' ? 'btn-primary' : 'btn-outline'}" id="tab-pendente">Pendentes ${pendingCount ? `(${pendingCount})` : ''}</button>
        <button class="btn btn-sm ${clientesTab === 'aprovado' ? 'btn-primary' : 'btn-outline'}" id="tab-aprovado">Aprovados</button>
        <button class="btn btn-sm ${clientesTab === 'rejeitado' ? 'btn-primary' : 'btn-outline'}" id="tab-rejeitado">Rejeitados</button>
      </div>
      <button class="btn btn-primary" id="novo-cliente-btn">${Icons.plus} Novo Cliente</button>
    </div>

    <div class="mt-14" style="max-width:320px">
      <input type="text" id="clientes-search" placeholder="Buscar por nome, e-mail ou CPF" value="${escapeHtml(clientesSearch)}">
    </div>

    <div class="card mt-14" style="padding:0;overflow:hidden">
      ${rows.length ? `
      <table class="data-table table-scroll">
        <thead><tr>
          <th>Nome</th><th>Contato</th><th>Grupo</th><th>Limite de crédito</th><th>Score</th><th>Ações</th>
        </tr></thead>
        <tbody>
          ${rows.map((c) => {
            const p = c.profiles || {};
            return `
            <tr>
              <td data-label="Nome"><strong>${escapeHtml(p.full_name || '—')}</strong></td>
              <td data-label="Contato"><div><div>${escapeHtml(p.email || '')}</div><div class="text-sm text-soft">${escapeHtml(p.phone || '')}</div></div></td>
              <td data-label="Grupo">${escapeHtml(c.client_group || '—')}</td>
              <td data-label="Limite" class="mono">${formatMoney(c.credit_limit)}</td>
              <td data-label="Score">${c.score} ${scoreTierBadge(c.score_tier)}</td>
              <td data-label="Ações">
                <div class="flex gap-8">
                  ${clientesTab === 'pendente' ? `
                    <button class="btn btn-primary btn-sm approve-client-btn" data-id="${c.profile_id}">Aprovar</button>
                    <button class="btn btn-outline btn-sm reject-client-btn" data-id="${c.profile_id}">Rejeitar</button>
                  ` : ''}
                  <button class="icon-btn edit-client-btn" data-id="${c.profile_id}" title="Editar">${Icons.edit}</button>
                  <button class="icon-btn delete-client-btn" data-id="${c.profile_id}" title="Excluir" style="color:var(--bad)">${Icons.trash}</button>
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
  document.getElementById('clientes-search').oninput = debounce((e) => { clientesSearch = e.target.value; paintClientesScreen(); }, 250);
  document.getElementById('novo-cliente-btn').onclick = () => openClienteModal(null);

  root.querySelectorAll('.edit-client-btn').forEach((btn) => {
    btn.onclick = () => openClienteModal(clientesCache.find((c) => c.profile_id === btn.dataset.id));
  });
  root.querySelectorAll('.approve-client-btn').forEach((btn) => {
    btn.onclick = async () => {
      const { error } = await supa.rpc('approve_client', { p_client_id: btn.dataset.id });
      if (error) { showToast('Erro: ' + error.message); return; }
      notifyEvent('solicitacao_aprovada', btn.dataset.id, 'Cadastro aprovado', 'Sua conta foi aprovada. Você já pode usar o SIGES normalmente.');
      showToast('Cliente aprovado.');
      renderGerenteClientes();
    };
  });
  root.querySelectorAll('.reject-client-btn').forEach((btn) => {
    btn.onclick = () => openRejectClientModal(btn.dataset.id);
  });
  root.querySelectorAll('.delete-client-btn').forEach((btn) => {
    btn.onclick = () => openDeleteClienteConfirm(clientesCache.find((c) => c.profile_id === btn.dataset.id));
  });
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
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;
  document.getElementById('confirm-reject').onclick = async () => {
    const reason = document.getElementById('reject-reason').value.trim();
    const { error } = await supa.rpc('reject_client', { p_client_id: clientId, p_reason: reason || null });
    if (error) { document.getElementById('reject-feedback').innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
    notifyEvent('solicitacao_reprovada', clientId, 'Cadastro não aprovado', reason ? `Motivo: ${reason}` : 'Seu cadastro não foi aprovado.');
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
  document.body.appendChild(overlay);
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
      close();
      showToast('Cliente excluído.');
      renderGerenteClientes();
    } catch (e) {
      document.getElementById('delete-feedback').innerHTML = `<div class="auth-error">${escapeHtml(e.message)}</div>`;
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
        <div class="field"><label>E-mail (login do cliente)</label><input type="email" id="m-email" value="${escapeHtml(p.email || '')}"></div>
        ` : ''}
        <div class="field-row">
          <div class="field"><label>CPF</label><input type="text" id="m-cpf" maxlength="14" value="${escapeHtml(formatCpf(p.cpf || ''))}"></div>
          <div class="field"><label>Telefone</label><input type="tel" id="m-phone" placeholder="(00) 00000-0000" value="${escapeHtml(formatPhoneBR(p.phone || ''))}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Empresa</label><input type="text" id="m-company" value="${escapeHtml((client && client.company) || '')}"></div>
          <div class="field"><label>Cargo</label><input type="text" id="m-job-title" value="${escapeHtml((client && client.job_title) || '')}"></div>
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
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;
  document.getElementById('m-cpf').oninput = (e) => { e.target.value = formatCpf(e.target.value); };
  wirePasswordToggles(overlay);
  attachPhoneMask(document.getElementById('m-phone'));
  attachMoneyMask(document.getElementById('m-limit'));
  setMoneyValue(document.getElementById('m-limit'), client ? client.credit_limit : 0);

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
        await supa.rpc('update_client_profile', {
          p_client_id: result.user_id,
          p_full_name: payload.full_name, p_cpf: payload.cpf, p_phone: payload.phone,
          p_credit_limit: payload.credit_limit,
          p_client_group: payload.client_group, p_notes: payload.notes,
          p_company: payload.company, p_job_title: payload.job_title,
          p_salary: payload.salary, p_pix_key: payload.pix_key,
        });
        // Cliente criado diretamente pelo gerente já nasce aprovado (não precisa de aprovação retroativa).
        await supa.rpc('approve_client', { p_client_id: result.user_id });
      }
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
