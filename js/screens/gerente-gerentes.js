/* ============================================================================
   Gerente — gestão de contas de gerente (sem cadastro público; só um gerente
   já existente pode criar outro, de dentro do painel)
   ============================================================================ */

async function renderGerenteGerentes() {
  const root = document.getElementById('screen-gerente-gerentes');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const { data, error } = await supa.from('profiles').select('*').eq('role', 'gerente').order('created_at');
  if (error) { root.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }

  root.innerHTML = `
    <div class="flex justify-between items-center">
      <p class="text-sm text-soft">Contas de gerente têm acesso total ao sistema. Só crie para pessoas de confiança da equipe.</p>
      <button class="btn btn-primary" id="novo-gerente-btn">${Icons.userPlus} Novo Gerente</button>
    </div>
    <div class="card mt-14" style="padding:0">
      <table class="data-table table-scroll">
        <thead><tr><th>Nome</th><th>E-mail</th><th>Status</th><th>Criado em</th></tr></thead>
        <tbody>
          ${(data || []).map((g) => `
            <tr>
              <td data-label="Nome">${escapeHtml(g.full_name || '—')}</td>
              <td data-label="E-mail">${escapeHtml(g.email)}</td>
              <td data-label="Status">${g.active ? statusBadge('quitado', 'Ativo') : statusBadge('reprovada', 'Inativo')}</td>
              <td data-label="Criado em">${formatDate(g.created_at)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('novo-gerente-btn').onclick = openNovoGerenteModal;
}

function openNovoGerenteModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h3>Novo gerente</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="ng-feedback"></div>
        <div class="field"><label>Nome completo</label><input type="text" id="ng-name"></div>
        <div class="field"><label>E-mail</label><input type="email" id="ng-email"></div>
        <div class="field"><label>Senha inicial</label><input type="password" id="ng-password" minlength="6"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-primary" id="save-modal">Criar gerente</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;
  document.getElementById('save-modal').onclick = async () => {
    const feedback = document.getElementById('ng-feedback');
    feedback.innerHTML = '';
    const email = document.getElementById('ng-email').value.trim();
    const password = document.getElementById('ng-password').value;
    const fullName = document.getElementById('ng-name').value.trim();
    if (!email || password.length < 6) { feedback.innerHTML = '<div class="auth-error">Preencha e-mail e senha (mín. 6 caracteres).</div>'; return; }

    const btn = document.getElementById('save-modal');
    btn.disabled = true;
    try {
      const resp = await fetch('/api/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + App.session.access_token },
        body: JSON.stringify({ email, password, full_name: fullName, role: 'gerente' }),
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Falha ao criar gerente.');
      close();
      showToast('Gerente criado com sucesso.');
      renderGerenteGerentes();
    } catch (e) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(e.message)}</div>`;
      btn.disabled = false;
    }
  };
}

registerRoute('gerente/gerentes', { role: 'gerente', screenId: 'gerente-gerentes', title: 'Gerentes', render: renderGerenteGerentes });
