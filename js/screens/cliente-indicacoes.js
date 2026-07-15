/* ============================================================================
   Cliente — Indicações (empréstimos de quem você indicou ao Siges)
   ============================================================================ */

let clienteIndicacoesTab = 'aberto'; // 'aberto' | 'finalizados'

async function renderClienteIndicacoes() {
  const root = document.getElementById('screen-cliente-indicacoes');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const { data: referred, error: refError } = await supa.rpc('list_my_referred_clients');
  if (refError) { root.innerHTML = `<div class="auth-error">${escapeHtml(refError.message)}</div>`; return; }
  if (!referred || !referred.length) {
    root.innerHTML = `<div class="empty-state">${Icons.userPlus}<p>Você ainda não indicou ninguém.</p></div>`;
    return;
  }

  const namesById = {};
  referred.forEach((r) => { namesById[r.client_id] = r.full_name; });
  const referredIds = referred.map((r) => r.client_id);

  const { data: allContracts, error } = await supa
    .from('loan_contracts')
    .select('*')
    .in('client_id', referredIds)
    .order('created_at', { ascending: false });

  if (error) { root.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
  if (!allContracts || !allContracts.length) {
    root.innerHTML = `<div class="empty-state">${Icons.contract}<p>Nenhum empréstimo entre as pessoas que você indicou.</p></div>`;
    return;
  }

  const ids = allContracts.map((c) => c.id);
  const [{ data: installments }, { data: cycles }] = await Promise.all([
    supa.from('installments').select('*').in('contract_id', ids).order('sequence_number'),
    supa.from('renewal_cycles').select('*').in('contract_id', ids).order('cycle_number'),
  ]);

  paintClienteIndicacoes(root, allContracts, installments || [], cycles || [], namesById);
}

// Menor data de vencimento ainda em aberto (pendente/atrasada) de um contrato
// — usada só pra ordenar a aba "Em aberto" (atrasado/vence primeiro no topo).
function nextDueDateFor(contractId, installments, cycles) {
  const dates = [];
  (installments || []).forEach((i) => { if (i.contract_id === contractId && (i.status === 'pendente' || i.status === 'atrasada')) dates.push(i.due_date); });
  (cycles || []).forEach((r) => { if (r.contract_id === contractId && (r.status === 'pendente' || r.status === 'atrasada')) dates.push(r.new_due_date); });
  dates.sort();
  return dates[0] || null;
}

function paintClienteIndicacoes(root, allContracts, installments, cycles, namesById) {
  const contracts = allContracts.filter((c) => {
    const isFinalizado = c.status === 'quitado' || c.status === 'perda';
    return clienteIndicacoesTab === 'aberto' ? !isFinalizado : isFinalizado;
  });

  if (clienteIndicacoesTab === 'aberto') {
    contracts.sort((a, b) => {
      const da = nextDueDateFor(a.id, installments, cycles) || '9999-12-31';
      const db = nextDueDateFor(b.id, installments, cycles) || '9999-12-31';
      return da < db ? -1 : da > db ? 1 : 0;
    });
  }

  const tabsHtml = `
    <div class="flex gap-8">
      <button class="btn btn-sm ${clienteIndicacoesTab === 'aberto' ? 'btn-primary' : 'btn-outline'}" id="tab-ind-aberto">Em aberto</button>
      <button class="btn btn-sm ${clienteIndicacoesTab === 'finalizados' ? 'btn-primary' : 'btn-outline'}" id="tab-ind-finalizados">Finalizados</button>
    </div>`;

  if (!contracts.length) {
    root.innerHTML = tabsHtml + `<div class="empty-state mt-14">${Icons.contract}<p>Nenhum empréstimo ${clienteIndicacoesTab === 'aberto' ? 'em aberto' : 'finalizado'} entre os indicados.</p></div>`;
    wireClienteIndicacoesTabs(root, allContracts, installments, cycles, namesById);
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
          <strong>${escapeHtml(namesById[c.client_id] || '—')}</strong>
          <div class="text-sm text-soft">Contrato #${c.contract_number} · ${formatDate(c.contract_date)} · ${formatMoney(c.principal_amount)} em ${c.installments_count}x ${dueTypeLabel(c.due_type, c.custom_interval_days)}</div>
        </div>
        <div class="flex items-center gap-8">
          ${statusBadge(c.status, statusLabel)}
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
            // previous_cycle_id), não o do próprio ciclo. O último elo
            // (pendente/atrasada/paga) vira só "1" — valor cheio como sempre.
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

  wireClienteIndicacoesTabs(root, allContracts, installments, cycles, namesById);
}

function wireClienteIndicacoesTabs(root, allContracts, installments, cycles, namesById) {
  document.getElementById('tab-ind-aberto').onclick = () => { clienteIndicacoesTab = 'aberto'; paintClienteIndicacoes(root, allContracts, installments, cycles, namesById); };
  document.getElementById('tab-ind-finalizados').onclick = () => { clienteIndicacoesTab = 'finalizados'; paintClienteIndicacoes(root, allContracts, installments, cycles, namesById); };
}

registerRoute('cliente/indicacoes', { role: 'cliente', referralOnly: true, screenId: 'cliente-indicacoes', title: 'Indicações', render: renderClienteIndicacoes });
