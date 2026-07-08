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
      <div class="flex justify-between items-center" style="flex-wrap:wrap;gap:10px">
        <div>
          <strong>Contrato #${c.contract_number}</strong>
          <div class="text-sm text-soft">${formatDate(c.contract_date)} · ${formatMoney(c.principal_amount)} em ${c.installments_count}x ${dueTypeLabel(c.due_type, c.custom_interval_days)}</div>
        </div>
        <div class="flex items-center gap-8">
          ${statusBadge(c.status, statusLabel)}
          <button class="btn btn-outline btn-sm extrato-btn" data-id="${c.id}">${Icons.printer} Extrato</button>
        </div>
      </div>
      <table class="data-table table-scroll mt-14">
        <thead><tr><th>Parcela</th><th>Vencimento</th><th>Valor</th><th>Status</th></tr></thead>
        <tbody>
          ${inst.map((i) => `
            <tr>
              <td data-label="Parcela">${i.sequence_number}</td>
              <td data-label="Vencimento">${formatDate(i.due_date)}</td>
              <td data-label="Valor"><div><div class="mono">${formatMoney(i.amount_due)}</div>${(i.principal_paid_partial > 0 || i.interest_paid_partial > 0) ? `<div class="text-sm text-soft">Pago parcial: ${formatMoney(Number(i.principal_paid_partial) + Number(i.interest_paid_partial))} · resta ${formatMoney(i.amount_due - i.principal_paid_partial - i.interest_paid_partial)}</div>` : ''}</div></td>
              <td data-label="Status">${(() => { const st = effectiveInstallmentStatus(i.status, i.due_date); return statusBadge(st, { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada', renovada: 'Renovada' }[st]); })()}</td>
            </tr>
          `).join('')}
          ${cyc.map((r) => `
            <tr>
              <td data-label="Parcela">Renovação ${r.cycle_number}</td>
              <td data-label="Vencimento">${formatDate(r.new_due_date)}</td>
              <td data-label="Valor" class="mono">${formatMoney(r.full_debt_amount)}</td>
              <td data-label="Status">${(() => { const st = effectiveInstallmentStatus(r.status, r.new_due_date); return statusBadge(st, { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada' }[st]); })()}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
  }).join('');

  root.querySelectorAll('.extrato-btn').forEach((btn) => {
    btn.onclick = async () => {
      const contract = contracts.find((c) => c.id === btn.dataset.id);
      const inst = (installments || []).filter((i) => i.contract_id === contract.id);
      btn.disabled = true;
      try {
        await gerarExtratoPDF({
          contract, installments: inst,
          clientProfile: { full_name: App.profile.full_name, cpf: App.profile.cpf },
          score: App.client ? App.client.score : null,
          companyName: (App.settings && App.settings.company_name) || 'Siges Serviços Financeiros',
        });
      } finally {
        btn.disabled = false;
      }
    };
  });
}

registerRoute('cliente/emprestimos', { role: 'cliente', screenId: 'cliente-emprestimos', title: 'Meus Empréstimos', render: renderClienteEmprestimos });
