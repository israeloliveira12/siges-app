/* ============================================================================
   Cadastro / gestão de clientes (gerente)
   ============================================================================ */

let clientesCache = [];
let clientesSearch = '';

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
  const rows = clientesCache.filter((c) => {
    if (!term) return true;
    const p = c.profiles || {};
    return (p.full_name || '').toLowerCase().includes(term) || (p.email || '').toLowerCase().includes(term) || (p.cpf || '').includes(term);
  });

  root.innerHTML = `
    <div class="flex justify-between items-center gap-10 mt-8" style="flex-wrap:wrap">
      <div style="max-width:320px;flex:1">
        <input type="text" id="clientes-search" placeholder="Buscar por nome, e-mail ou CPF" value="${escapeHtml(clientesSearch)}">
      </div>
      <button class="btn btn-primary" id="novo-cliente-btn">${Icons.plus} Novo Cliente</button>
    </div>

    <div class="card mt-14" style="padding:0;overflow:hidden">
      ${rows.length ? `
      <table class="data-table table-scroll">
        <thead><tr>
          <th>Nome</th><th>Contato</th><th>Região / Grupo</th><th>Limite de crédito</th><th>Score</th><th>Ações</th>
        </tr></thead>
        <tbody>
          ${rows.map((c) => {
            const p = c.profiles || {};
            return `
            <tr>
              <td data-label="Nome"><strong>${escapeHtml(p.full_name || '—')}</strong></td>
              <td data-label="Contato"><div><div>${escapeHtml(p.email || '')}</div><div class="text-sm text-soft">${escapeHtml(p.phone || '')}</div></div></td>
              <td data-label="Região/Grupo">${escapeHtml(c.region || '—')} ${c.client_group ? '· ' + escapeHtml(c.client_group) : ''}</td>
              <td data-label="Limite" class="mono">${formatMoney(c.credit_limit)}</td>
              <td data-label="Score">${c.score} ${scoreTierBadge(c.score_tier)}</td>
              <td data-label="Ações">
                <button class="icon-btn edit-client-btn" data-id="${c.profile_id}" title="Editar">${Icons.edit}</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : `<div class="empty-state">${Icons.users}<p>Nenhum cliente encontrado.</p></div>`}
    </div>
  `;

  document.getElementById('clientes-search').oninput = debounce((e) => { clientesSearch = e.target.value; paintClientesScreen(); }, 250);
  document.getElementById('novo-cliente-btn').onclick = () => openClienteModal(null);
  root.querySelectorAll('.edit-client-btn').forEach((btn) => {
    btn.onclick = () => openClienteModal(clientesCache.find((c) => c.profile_id === btn.dataset.id));
  });
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
        <div class="field"><label>Senha inicial</label><input type="password" id="m-password" minlength="6" required></div>
        ` : ''}
        <div class="field"><label>Nome completo</label><input type="text" id="m-name" value="${escapeHtml(p.full_name || '')}"></div>
        <div class="field-row">
          <div class="field"><label>CPF</label><input type="text" id="m-cpf" value="${escapeHtml(p.cpf || '')}"></div>
          <div class="field"><label>Telefone</label><input type="tel" id="m-phone" value="${escapeHtml(p.phone || '')}"></div>
        </div>
        <div class="field"><label>Limite de crédito (R$)</label><input type="number" min="0" step="0.01" id="m-limit" value="${client ? client.credit_limit : 0}"></div>
        <div class="field-row">
          <div class="field"><label>Região</label><input type="text" id="m-region" value="${escapeHtml((client && client.region) || '')}"></div>
          <div class="field"><label>Grupo</label><input type="text" id="m-group" placeholder="Ex: Carteira Assinada" value="${escapeHtml((client && client.client_group) || '')}"></div>
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

  document.getElementById('save-modal').onclick = async () => {
    const feedback = document.getElementById('modal-feedback');
    feedback.innerHTML = '';
    const payload = {
      full_name: document.getElementById('m-name').value.trim(),
      cpf: document.getElementById('m-cpf').value.trim() || null,
      phone: document.getElementById('m-phone').value.trim() || null,
      credit_limit: Number(document.getElementById('m-limit').value || 0),
      region: document.getElementById('m-region').value.trim() || null,
      client_group: document.getElementById('m-group').value.trim() || null,
      notes: document.getElementById('m-notes').value.trim() || null,
    };
    const btn = document.getElementById('save-modal');
    btn.disabled = true;
    try {
      if (isEdit) {
        const { error } = await supa.rpc('update_client_profile', {
          p_client_id: client.profile_id,
          p_full_name: payload.full_name, p_cpf: payload.cpf, p_phone: payload.phone,
          p_credit_limit: payload.credit_limit, p_region: payload.region,
          p_client_group: payload.client_group, p_notes: payload.notes,
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
          p_credit_limit: payload.credit_limit, p_region: payload.region,
          p_client_group: payload.client_group, p_notes: payload.notes,
        });
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
