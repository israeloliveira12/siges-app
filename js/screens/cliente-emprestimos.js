/* ============================================================================
   Cliente — Meus empréstimos (em andamento e finalizados)
   ============================================================================ */

async function renderClienteEmprestimos() {
  const root = document.getElementById('screen-cliente-emprestimos');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const clientId = App.session.user.id;
  const { data: contracts, error } = await supa
    .from('loan_contracts')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });

  if (error) { root.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
  if (!contracts || !contracts.length) {
    root.innerHTML = `<div class="empty-state">${Icons.contract}<p>Você ainda não tem empréstimos.</p></div>`;
    return;
  }

  const ids = contracts.map((c) => c.id);
  const [{ data: installments }, { data: cycles }] = await Promise.all([
    supa.from('installments').select('*').in('contract_id', ids).order('sequence_number'),
    supa.from('renewal_cycles').select('*').in('contract_id', ids).order('cycle_number'),
  ]);

  root.innerHTML = contracts.map((c) => {
    const inst = (installments || []).filter((i) => i.contract_id === c.id);
    const cyc = (cycles || []).filter((r) => r.contract_id === c.id);
    const statusLabel = { em_aberto: 'Em aberto', atrasado: 'Atrasado', quitado: 'Quitado', perda: 'Em cobrança' }[c.status];
    return `
    <div class="card mt-14">
      <div class="flex justify-between items-center">
        <div>
          <strong>Contrato #${c.contract_number}</strong>
          <div class="text-sm text-soft">${formatDate(c.contract_date)} · ${formatMoney(c.principal_amount)} em ${c.installments_count}x ${dueTypeLabel(c.due_type)}</div>
        </div>
        ${statusBadge(c.status, statusLabel)}
      </div>
      <table class="data-table table-scroll mt-14">
        <thead><tr><th>Parcela</th><th>Vencimento</th><th>Valor</th><th>Status</th></tr></thead>
        <tbody>
          ${inst.map((i) => `
            <tr>
              <td data-label="Parcela">${i.sequence_number}</td>
              <td data-label="Vencimento">${formatDate(i.due_date)}</td>
              <td data-label="Valor" class="mono">${formatMoney(i.amount_due)}</td>
              <td data-label="Status">${statusBadge(i.status, { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada', renovada: 'Renovada' }[i.status])}</td>
            </tr>
          `).join('')}
          ${cyc.map((r) => `
            <tr>
              <td data-label="Parcela">Renovação ${r.cycle_number}</td>
              <td data-label="Vencimento">${formatDate(r.new_due_date)}</td>
              <td data-label="Valor" class="mono">${formatMoney(r.full_debt_amount)}</td>
              <td data-label="Status">${statusBadge(r.status, { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada' }[r.status])}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
  }).join('');
}

registerRoute('cliente/emprestimos', { role: 'cliente', screenId: 'cliente-emprestimos', title: 'Meus Empréstimos', render: renderClienteEmprestimos });
