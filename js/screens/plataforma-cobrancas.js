/* ============================================================================
   Plataforma SaaS — Assinaturas/Cobranças. Registro manual de pagamento por
   empresa assinante (não existe gateway de pagamento na plataforma; é só
   uma agenda de "empresa X pagou o mês Y", pra acompanhar quem está em dia).
   ============================================================================ */

const TENANT_PAYMENT_STATUS_LABELS = { pendente: 'Pendente', pago: 'Pago', atrasado: 'Atrasado', cancelado: 'Cancelado' };
const TENANT_PAYMENT_STATUS_BADGE_KIND = { pendente: 'pendente', pago: 'quitado', atrasado: 'atrasado', cancelado: 'cancelada' };

let cobrancasCache = [];
let cobrancasTenantsCache = [];
let cobrancasFiltroStatus = '';
let cobrancasFiltroTenant = '';

async function renderPlataformaCobrancas() {
  const root = document.getElementById('screen-plataforma-cobrancas');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const [{ data: payments, error }, { data: tenants }] = await Promise.all([
    supa.rpc('list_tenant_payments'),
    supa.rpc('list_tenants_with_stats'),
  ]);
  if (error) { root.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
  cobrancasCache = payments || [];
  cobrancasTenantsCache = tenants || [];

  paintPlataformaCobrancas(root);
}

function paintPlataformaCobrancas(root) {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const totalPendente = cobrancasCache.filter((p) => p.status === 'pendente').reduce((s, p) => s + Number(p.amount), 0);
  const totalAtrasado = cobrancasCache.filter((p) => p.status === 'atrasado').reduce((s, p) => s + Number(p.amount), 0);
  const totalPagoMes = cobrancasCache
    .filter((p) => p.status === 'pago' && p.paid_date && new Date(p.paid_date + 'T00:00:00') >= monthStart)
    .reduce((s, p) => s + Number(p.amount), 0);

  const filtered = cobrancasCache.filter((p) =>
    (!cobrancasFiltroStatus || p.status === cobrancasFiltroStatus) &&
    (!cobrancasFiltroTenant || p.tenant_id === cobrancasFiltroTenant));

  root.innerHTML = `
    <div class="grid grid-4 kpi-grid-4">
      <div class="card stat-card"><div class="label">Pendente</div><div class="value mono">${formatMoney(totalPendente)}</div></div>
      <div class="card stat-card" style="border-top:3px solid ${totalAtrasado > 0 ? 'var(--bad)' : 'var(--line)'}"><div class="label">Atrasado</div><div class="value mono" style="color:${totalAtrasado > 0 ? 'var(--bad)' : 'var(--ink)'}">${formatMoney(totalAtrasado)}</div></div>
      <div class="card stat-card"><div class="label">Pago este mês</div><div class="value mono">${formatMoney(totalPagoMes)}</div></div>
      <div class="card stat-card"><div class="label">Cobranças cadastradas</div><div class="value mono">${cobrancasCache.length}</div></div>
    </div>

    <div class="flex justify-between items-center mt-14" style="flex-wrap:wrap;gap:10px">
      <div class="flex gap-8" style="flex-wrap:wrap">
        <select id="cb-filtro-empresa" style="min-width:180px">
          <option value="">Todas as empresas</option>
          ${cobrancasTenantsCache.map((t) => `<option value="${t.id}" ${cobrancasFiltroTenant === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
        </select>
        <select id="cb-filtro-status">
          <option value="">Todos os status</option>
          ${Object.keys(TENANT_PAYMENT_STATUS_LABELS).map((k) => `<option value="${k}" ${cobrancasFiltroStatus === k ? 'selected' : ''}>${TENANT_PAYMENT_STATUS_LABELS[k]}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn-primary" id="nova-cobranca-btn">${Icons.plus} Nova cobrança</button>
    </div>

    <div class="mt-14">
      ${filtered.map((p) => `
        <div class="extrato-row">
          <div style="min-width:0;flex:1 1 auto">
            <div class="name">${escapeHtml(p.tenant_name)}</div>
            <div class="meta">${p.method ? escapeHtml(p.method) + ' · ' : ''}${p.due_date ? 'Vencimento ' + formatDate(p.due_date) : 'Sem vencimento definido'}${p.paid_date ? ' · Pago em ' + formatDate(p.paid_date) : ''}${p.notes ? ' · ' + escapeHtml(p.notes) : ''}</div>
          </div>
          <div class="amt-wrap">
            <div class="flex gap-8 items-center" style="justify-content:flex-end;flex-wrap:wrap">
              <span class="value">${formatMoney(p.amount)}</span>
              ${statusBadge(TENANT_PAYMENT_STATUS_BADGE_KIND[p.status], TENANT_PAYMENT_STATUS_LABELS[p.status])}
              ${p.status === 'pendente' || p.status === 'atrasado' ? `<button class="btn btn-outline btn-sm mark-paid-btn" data-id="${p.id}">Marcar pago</button>` : ''}
              <button class="icon-btn edit-cobranca-btn" data-id="${p.id}">${Icons.edit}</button>
            </div>
          </div>
        </div>
      `).join('')}
      ${!filtered.length ? '<p class="text-sm text-soft">Nenhuma cobrança encontrada.</p>' : ''}
    </div>
  `;

  document.getElementById('cb-filtro-empresa').onchange = (e) => { cobrancasFiltroTenant = e.target.value; paintPlataformaCobrancas(root); };
  document.getElementById('cb-filtro-status').onchange = (e) => { cobrancasFiltroStatus = e.target.value; paintPlataformaCobrancas(root); };
  document.getElementById('nova-cobranca-btn').onclick = () => openCobrancaModal(null);
  root.querySelectorAll('.edit-cobranca-btn').forEach((btn) => {
    btn.onclick = () => openCobrancaModal(cobrancasCache.find((p) => p.id === btn.dataset.id));
  });
  root.querySelectorAll('.mark-paid-btn').forEach((btn) => {
    btn.onclick = () => markCobrancaPaid(cobrancasCache.find((p) => p.id === btn.dataset.id));
  });
}

async function markCobrancaPaid(payment) {
  const todayISO = new Date().toISOString().slice(0, 10);
  const { error } = await supa.rpc('upsert_tenant_payment', {
    p_id: payment.id, p_tenant_id: payment.tenant_id, p_amount: payment.amount,
    p_due_date: payment.due_date, p_paid_date: todayISO, p_method: payment.method,
    p_status: 'pago', p_notes: payment.notes,
  });
  if (error) { showToast('Não foi possível marcar como pago.'); return; }
  logAudit('cobranca_editada', `Cobrança de ${payment.tenant_name} marcada como paga`, { tenant_id: payment.tenant_id });
  showToast('Cobrança marcada como paga.');
  renderPlataformaCobrancas();
}

function openCobrancaModal(payment) {
  const isEdit = !!payment;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:440px">
      <div class="modal-head"><h3>${isEdit ? 'Editar cobrança' : 'Nova cobrança'}</h3><button class="icon-btn" id="cb-close">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="cb-feedback"></div>
        <div class="field">
          <label>Empresa</label>
          <select id="cb-tenant">
            ${cobrancasTenantsCache.map((t) => `<option value="${t.id}" ${payment && payment.tenant_id === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Valor (R$)</label><input type="text" id="cb-amount"></div>
        <div class="field-row">
          <div class="field"><label>Vencimento</label><input type="date" id="cb-due-date" value="${payment && payment.due_date ? payment.due_date : ''}"></div>
          <div class="field"><label>Data de pagamento</label><input type="date" id="cb-paid-date" value="${payment && payment.paid_date ? payment.paid_date : ''}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Forma</label><input type="text" id="cb-method" placeholder="Pix, transferência..." value="${payment && payment.method ? escapeHtml(payment.method) : ''}"></div>
          <div class="field">
            <label>Status</label>
            <select id="cb-status">
              ${Object.keys(TENANT_PAYMENT_STATUS_LABELS).map((k) => `<option value="${k}" ${(payment ? payment.status : 'pendente') === k ? 'selected' : ''}>${TENANT_PAYMENT_STATUS_LABELS[k]}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field"><label>Observações</label><input type="text" id="cb-notes" value="${payment && payment.notes ? escapeHtml(payment.notes) : ''}"></div>
      </div>
      <div class="modal-foot" style="justify-content:space-between">
        ${isEdit ? `<button class="btn btn-ghost" id="cb-delete" style="color:var(--bad)">Excluir</button>` : '<span></span>'}
        <div class="flex gap-8">
          <button class="btn btn-ghost" id="cb-cancel">Cancelar</button>
          <button class="btn btn-primary" id="cb-save">${isEdit ? 'Salvar alterações' : 'Criar cobrança'}</button>
        </div>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#cb-close').onclick = close;
  overlay.querySelector('#cb-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const amountInput = overlay.querySelector('#cb-amount');
  attachMoneyMask(amountInput);
  if (isEdit) setMoneyValue(amountInput, payment.amount);

  const deleteBtn = overlay.querySelector('#cb-delete');
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      const feedback = overlay.querySelector('#cb-feedback');
      feedback.innerHTML = '<p class="text-sm text-soft">Clique de novo para confirmar a exclusão.</p>';
      if (!deleteBtn.dataset.confirm) { deleteBtn.dataset.confirm = '1'; return; }
      deleteBtn.disabled = true;
      const { error } = await supa.rpc('delete_tenant_payment', { p_id: payment.id });
      if (error) { feedback.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; deleteBtn.disabled = false; return; }
      logAudit('cobranca_excluida', `Cobrança de ${payment.tenant_name} excluída`, { tenant_id: payment.tenant_id });
      close();
      showToast('Cobrança excluída.');
      renderPlataformaCobrancas();
    };
  }

  overlay.querySelector('#cb-save').onclick = async () => {
    const feedback = overlay.querySelector('#cb-feedback');
    feedback.innerHTML = '';
    const amount = getMoneyValue(amountInput);
    if (!amount || amount <= 0) { feedback.innerHTML = '<div class="auth-error">Informe um valor válido.</div>'; return; }

    const tenantId = overlay.querySelector('#cb-tenant').value;
    const tenantName = (cobrancasTenantsCache.find((t) => t.id === tenantId) || {}).name || '';
    const btn = overlay.querySelector('#cb-save');
    btn.disabled = true;
    try {
      const { error } = await supa.rpc('upsert_tenant_payment', {
        p_id: isEdit ? payment.id : null,
        p_tenant_id: tenantId,
        p_amount: amount,
        p_due_date: overlay.querySelector('#cb-due-date').value || null,
        p_paid_date: overlay.querySelector('#cb-paid-date').value || null,
        p_method: overlay.querySelector('#cb-method').value.trim() || null,
        p_status: overlay.querySelector('#cb-status').value,
        p_notes: overlay.querySelector('#cb-notes').value.trim() || null,
      });
      if (error) throw error;
      logAudit(isEdit ? 'cobranca_editada' : 'cobranca_criada', `Cobrança de ${tenantName} ${isEdit ? 'editada' : 'criada'}`, { tenant_id: tenantId });
      close();
      showToast(isEdit ? 'Cobrança atualizada.' : 'Cobrança criada.');
      renderPlataformaCobrancas();
    } catch (e) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(e.message || String(e))}</div>`;
      btn.disabled = false;
    }
  };
}

registerRoute('plataforma/cobrancas', { role: 'plataforma', screenId: 'plataforma-cobrancas', title: 'Assinaturas', render: renderPlataformaCobrancas });
