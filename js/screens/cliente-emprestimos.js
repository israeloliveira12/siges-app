/* ============================================================================
   Cliente — Meus empréstimos (em andamento e finalizados)
   ============================================================================ */

let clienteEmprestimosTab = 'aberto'; // 'aberto' | 'finalizados'

async function renderClienteEmprestimos() {
  const root = document.getElementById('screen-cliente-emprestimos');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const clientId = App.session.user.id;
  const { data: allContracts, error } = await supa
    .from('loan_contracts')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });

  if (error) { root.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
  if (!allContracts || !allContracts.length) {
    root.innerHTML = `<div class="empty-state">${Icons.contract}<p>Você ainda não tem empréstimos.</p></div>`;
    return;
  }

  const ids = allContracts.map((c) => c.id);
  const [{ data: installments }, { data: cycles }] = await Promise.all([
    supa.from('installments').select('*').in('contract_id', ids).order('sequence_number'),
    supa.from('renewal_cycles').select('*').in('contract_id', ids).order('cycle_number'),
  ]);

  paintClienteEmprestimos(root, allContracts, installments || [], cycles || []);
}

// Menor data de vencimento ainda em aberto (pendente/atrasada) de um contrato
// — usada só pra ordenar a aba "Em aberto" (atrasado/vence primeiro no topo),
// mesmo padrão já usado em cliente-indicacoes.js.
function nextDueDateFor(contractId, installments, cycles) {
  const dates = [];
  (installments || []).forEach((i) => { if (i.contract_id === contractId && (i.status === 'pendente' || i.status === 'atrasada')) dates.push(i.due_date); });
  (cycles || []).forEach((r) => { if (r.contract_id === contractId && (r.status === 'pendente' || r.status === 'atrasada')) dates.push(r.new_due_date); });
  dates.sort();
  return dates[0] || null;
}

function paintClienteEmprestimos(root, allContracts, installments, cycles) {
  const contracts = allContracts.filter((c) => {
    const isFinalizado = c.status === 'quitado' || c.status === 'perda';
    return clienteEmprestimosTab === 'aberto' ? !isFinalizado : isFinalizado;
  });

  if (clienteEmprestimosTab === 'aberto') {
    contracts.sort((a, b) => {
      const da = nextDueDateFor(a.id, installments, cycles) || '9999-12-31';
      const db = nextDueDateFor(b.id, installments, cycles) || '9999-12-31';
      return da < db ? -1 : da > db ? 1 : 0;
    });
  }

  const tabsHtml = `
    <div class="flex gap-8">
      <button class="btn btn-sm ${clienteEmprestimosTab === 'aberto' ? 'btn-primary' : 'btn-outline'}" id="tab-emp-aberto">Em aberto</button>
      <button class="btn btn-sm ${clienteEmprestimosTab === 'finalizados' ? 'btn-primary' : 'btn-outline'}" id="tab-emp-finalizados">Finalizados</button>
    </div>`;

  if (!contracts.length) {
    root.innerHTML = tabsHtml + `<div class="empty-state mt-14">${Icons.contract}<p>Nenhum empréstimo ${clienteEmprestimosTab === 'aberto' ? 'em aberto' : 'finalizado'}.</p></div>`;
    document.getElementById('tab-emp-aberto').onclick = () => { clienteEmprestimosTab = 'aberto'; paintClienteEmprestimos(root, allContracts, installments, cycles); };
    document.getElementById('tab-emp-finalizados').onclick = () => { clienteEmprestimosTab = 'finalizados'; paintClienteEmprestimos(root, allContracts, installments, cycles); };
    return;
  }

  root.innerHTML = tabsHtml + contracts.map((c) => {
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
          ${inst.map((i) => {
            const st = effectiveInstallmentStatus(i.status, i.due_date);
            const remaining = i.amount_due - i.principal_paid_partial - i.interest_paid_partial;
            const isPartial = st !== 'paga' && (i.principal_paid_partial > 0 || i.interest_paid_partial > 0);
            // Parcela já renovada: ela é sempre a 1ª entidade da cadeia de
            // renovação, então o rótulo é fixo "Renovação 1" — e o valor
            // exibido é o juros que foi de fato pago NAQUELA renovação
            // (gravado no ciclo pra onde ela foi, não no amount_due da
            // própria parcela, que é o valor CHEIO contratual original).
            const renewedCycle = st === 'renovada' && i.renewed_into_cycle_id ? cyc.find((r) => r.id === i.renewed_into_cycle_id) : null;
            const rowLabel = renewedCycle ? 'Renovação 1' : i.sequence_number;
            const displayValue = renewedCycle ? renewedCycle.interest_only_amount : i.amount_due;
            // Estimativa do valor atualizado com juros/multa de atraso — só
            // exibida quando a parcela realmente já venceu, pra o cliente
            // saber quanto está devendo de verdade, não só o valor original.
            const late = st === 'atrasada' ? estimateLateCharge(remaining, i.due_date, Number(c.late_interest_percent || 0), Number(c.late_fee_percent || 0)) : null;
            return `
            <tr>
              <td data-label="Parcela">${rowLabel}</td>
              <td data-label="Vencimento">${formatDate(i.due_date)}</td>
              <td data-label="Valor"><div><div class="mono">${formatMoney(displayValue)}</div>${isPartial ? `<div class="text-sm text-soft">Pago parcial: ${formatMoney(Number(i.principal_paid_partial) + Number(i.interest_paid_partial))} · resta ${formatMoney(remaining)}</div>` : ''}${late && (late.jurosAtraso > 0 || late.multaAtraso > 0) ? `<div class="text-sm" style="color:var(--bad)">Atualizado com atraso (${late.diasAtraso}d): ${formatMoney(late.total)}</div>` : ''}</div></td>
              <td data-label="Status">${statusBadge(st, { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada', renovada: 'Renovada' }[st])}</td>
            </tr>
          `; }).join('')}
          ${cyc.map((r) => {
            const st = effectiveInstallmentStatus(r.status, r.new_due_date);
            // Rótulo/valor por POSIÇÃO na cadeia, não pela identidade do
            // próprio ciclo — a parcela original ocupou "Renovação 1", então
            // cada ciclo desloca +1 (cycle_number 1 vira "Renovação 2" etc).
            // Se ainda 'renovada' (não é o último elo), o valor é o juros
            // pago na PRÓXIMA renovação da cadeia (localizada via
            // previous_cycle_id), não o do próprio ciclo — senão a linha
            // mostraria o valor de um evento anterior, não o que a superou.
            // O último elo (pendente/atrasada/paga) vira só "1" — é o que
            // hoje representa "a parcela" de fato — valor cheio como sempre.
            const nextCycle = st === 'renovada' ? cyc.find((other) => other.previous_cycle_id === r.id) : null;
            const cycleValue = nextCycle ? nextCycle.interest_only_amount : r.full_debt_amount;
            const rowLabel = st === 'renovada' ? 'Renovação ' + (r.cycle_number + 1) : '1';
            const cycleLate = st === 'atrasada' ? estimateLateCharge(cycleValue, r.new_due_date, Number(c.late_interest_percent || 0), Number(c.late_fee_percent || 0)) : null;
            return `
            <tr>
              <td data-label="Parcela">${rowLabel}</td>
              <td data-label="Vencimento">${formatDate(r.new_due_date)}</td>
              <td data-label="Valor"><div><div class="mono">${formatMoney(cycleValue)}</div>${cycleLate && (cycleLate.jurosAtraso > 0 || cycleLate.multaAtraso > 0) ? `<div class="text-sm" style="color:var(--bad)">Atualizado com atraso (${cycleLate.diasAtraso}d): ${formatMoney(cycleLate.total)}</div>` : ''}</div></td>
              <td data-label="Status">${statusBadge(st, { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada', renovada: 'Renovada' }[st])}</td>
            </tr>
          `; }).join('')}
        </tbody>
      </table>
    </div>`;
  }).join('');

  document.getElementById('tab-emp-aberto').onclick = () => { clienteEmprestimosTab = 'aberto'; paintClienteEmprestimos(root, allContracts, installments, cycles); };
  document.getElementById('tab-emp-finalizados').onclick = () => { clienteEmprestimosTab = 'finalizados'; paintClienteEmprestimos(root, allContracts, installments, cycles); };

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
