/* ============================================================================
   Gerente — Lista de contratos (Em aberto / Finalizados) + detalhe do contrato
   ============================================================================ */

let contratosTab = 'aberto';
let contratosSearch = '';

// Último carregamento do banco, guardado em memória. A BUSCA filtra isto no
// navegador e não volta à rede — ver o comentário grande em
// renderGerenteContratosLista() sobre por que isso importa.
let contratosCache = null;
// Contador de requisições: descarta resposta de uma busca/aba antiga que
// chegue DEPOIS de uma mais nova (respostas de rede não voltam em ordem).
let contratosReqSeq = 0;

async function renderGerenteContratosLista() {
  const root = document.getElementById('screen-gerente-contratos');
  const myReq = ++contratosReqSeq;

  // Bug real corrigido (2026-08-24, reportado pelo usuário: "digito e a barra
  // buga, apaga o que escrevo ou joga as letras pro começo").
  //
  // Causa: o `oninput` da busca chamava ESTA função, que faz três consultas
  // em sequência ao banco (contratos, pagamentos, parcelas) e só então
  // reconstrói a tela inteira com root.innerHTML — destruindo e recriando o
  // <input> da busca. Como a reconstrução usa `value="${contratosSearch}"`,
  // que é o valor de quando o debounce disparou, tudo o que a pessoa digitou
  // durante os ~500ms de rede era APAGADO, e o cursor voltava para a posição
  // capturada antes das consultas.
  //
  // O detalhe que resolve: a busca NUNCA precisou ir ao banco. O filtro
  // sempre foi feito no navegador (`rows.filter` abaixo) sobre dados que já
  // estavam carregados. A ida à rede era desperdício puro — e era justamente
  // ela que criava a corrida.
  //
  // Agora: esta função carrega do banco (troca de aba, primeira abertura,
  // volta de um contrato); a busca chama só paintContratosRows(), que filtra
  // o cache e repinta APENAS a lista. O <input> não é mais destruído, então
  // cursor, seleção, teclado do celular e a composição de texto preditivo
  // continuam vivos enquanto a lista atualiza.
  if (!document.getElementById('contratos-list')) {
    root.innerHTML = `<div class="text-soft">Carregando...</div>`;
  } else {
    document.getElementById('contratos-list').innerHTML = `<div class="text-soft" style="padding:14px">Carregando...</div>`;
  }

  const statuses = contratosTab === 'aberto' ? ['em_aberto', 'atrasado'] : ['quitado', 'perda'];
  const { data, error } = await supa
    .from('loan_contracts')
    .select('*, clients!loan_contracts_client_id_fkey(profile_id, profiles!clients_profile_id_fkey(full_name, cpf))')
    .in('status', statuses)
    .order('created_at', { ascending: false });

  if (error) { root.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }

  const contractIds = (data || []).map((c) => c.id);
  let paymentsByContract = {};
  let outstandingByContract = {};
  if (contractIds.length) {
    const { data: payments } = await supa.from('payments').select('contract_id, amount_received, interest_component').in('contract_id', contractIds);
    (payments || []).forEach((p) => {
      paymentsByContract[p.contract_id] = paymentsByContract[p.contract_id] || { total: 0, interest: 0 };
      paymentsByContract[p.contract_id].total += Number(p.amount_received);
      paymentsByContract[p.contract_id].interest += Number(p.interest_component);
    });
    const { data: openInst } = await supa.from('installments').select('contract_id, amount_due, principal_paid_partial, interest_paid_partial').in('contract_id', contractIds).in('status', ['pendente', 'atrasada']);
    (openInst || []).forEach((i) => {
      // Saldo remanescente (não o valor cheio) — parcela com pagamento
      // parcial já recebido não deve contar o total original como "dívida atual".
      const remaining = Number(i.amount_due) - Number(i.principal_paid_partial || 0) - Number(i.interest_paid_partial || 0);
      outstandingByContract[i.contract_id] = (outstandingByContract[i.contract_id] || 0) + remaining;
    });
    const { data: openCycles } = await supa.from('renewal_cycles').select('contract_id, full_debt_amount, principal_paid_partial, interest_paid_partial, cycle_number').in('contract_id', contractIds).in('status', ['pendente', 'atrasada']);
    (openCycles || []).forEach((c) => {
      if (!outstandingByContract['cycle_' + c.contract_id] || c.cycle_number > outstandingByContract['cycle_' + c.contract_id].n) {
        outstandingByContract['cycle_' + c.contract_id] = { n: c.cycle_number, v: cycleRemaining(c) };
      }
    });
  }

  // Uma resposta mais nova (outra aba, ou uma recarga disparada depois) já
  // chegou enquanto esta estava no ar — descarta esta, que é obsoleta.
  if (myReq !== contratosReqSeq) return;

  contratosCache = { data: data || [], paymentsByContract, outstandingByContract };

  // Monta o casco (abas + busca + container da lista) só quando ele ainda não
  // existe. Trocar de aba ou voltar de um contrato reaproveita o casco atual,
  // então o <input> da busca sobrevive.
  if (!document.getElementById('contratos-list')) {
    root.innerHTML = `
      <div class="flex justify-between items-center gap-10" style="flex-wrap:wrap">
        <div class="flex gap-8">
          <button class="btn btn-sm" id="tab-aberto">Em aberto</button>
          <button class="btn btn-sm" id="tab-finalizados">Finalizados</button>
        </div>
        <div class="flex gap-8" style="flex-wrap:wrap">
          <label for="contratos-search" class="sr-only-table">Buscar contrato</label>
          <input type="text" id="contratos-search" placeholder="Buscar cliente ou nº contrato" value="${escapeHtml(contratosSearch)}" style="max-width:240px">
          <button class="btn btn-primary" id="novo-contrato-btn">${Icons.plus} Novo Contrato</button>
        </div>
      </div>

      <p class="text-sm text-soft mt-8" id="contratos-count"></p>
      <div class="card mt-14" style="padding:0" id="contratos-list"></div>
    `;

    document.getElementById('tab-aberto').onclick = () => { contratosTab = 'aberto'; renderGerenteContratosLista(); };
    document.getElementById('tab-finalizados').onclick = () => { contratosTab = 'finalizados'; renderGerenteContratosLista(); };
    document.getElementById('novo-contrato-btn').onclick = () => router.navigate('#/gerente/contratos/novo');
    // A busca repinta SÓ a lista, a partir do cache — sem rede, sem recriar
    // este <input>. É isso que mantém o cursor e o teclado no lugar.
    document.getElementById('contratos-search').oninput = debounce(() => {
      contratosSearch = document.getElementById('contratos-search').value;
      paintContratosRows();
    }, 200);
  }

  // Estado visual das abas, sem recriar os botões.
  document.getElementById('tab-aberto').className = `btn btn-sm ${contratosTab === 'aberto' ? 'btn-primary' : 'btn-outline'}`;
  document.getElementById('tab-finalizados').className = `btn btn-sm ${contratosTab === 'finalizados' ? 'btn-primary' : 'btn-outline'}`;

  paintContratosRows();
}

// Filtra o cache e repinta apenas #contratos-list. Nunca toca no <input>.
function paintContratosRows() {
  const listEl = document.getElementById('contratos-list');
  const countEl = document.getElementById('contratos-count');
  if (!listEl || !contratosCache) return;

  const { data, paymentsByContract, outstandingByContract } = contratosCache;
  const term = contratosSearch.trim().toLowerCase();
  const rows = data.filter((c) => {
    if (!term) return true;
    const p = (c.clients || {}).profiles || {};
    return (p.full_name || '').toLowerCase().includes(term) || String(c.contract_number).includes(term);
  });

  if (countEl) {
    countEl.textContent = `${rows.length} contrato${rows.length === 1 ? '' : 's'}${term ? ' encontrado' + (rows.length === 1 ? '' : 's') : ''}`;
  }

  listEl.innerHTML = rows.length ? `
    <table class="data-table table-scroll">
      <thead><tr>
        <th>Contrato</th><th>Cliente</th><th>Aporte</th><th>Dívida atual</th><th>Juros (%)</th><th>Pago total</th><th>Status</th><th></th>
      </tr></thead>
      <tbody>
        ${rows.map((c) => {
          const cycleInfo = outstandingByContract['cycle_' + c.id];
          const outstanding = cycleInfo ? cycleInfo.v : (outstandingByContract[c.id] || 0);
          const paid = (paymentsByContract[c.id] || { total: 0 }).total;
          return `
          <tr class="contract-row" data-id="${c.id}" style="cursor:pointer">
            <td data-label="Contrato">#${c.contract_number}</td>
            <td data-label="Cliente"><div class="flex items-center gap-8">${avatarHtml((c.clients.profiles || {}).full_name, 26)}<span>${escapeHtml((c.clients.profiles || {}).full_name || '—')}</span></div></td>
            <td data-label="Aporte" class="mono mobile-hide">${formatMoney(c.principal_amount)}</td>
            <td data-label="Dívida atual" class="mono">${formatMoney(outstanding)}</td>
            <td data-label="Juros" class="mobile-hide">${formatNumber(c.interest_rate, 2)}%</td>
            <td data-label="Pago" class="mono mobile-hide">${formatMoney(paid)}</td>
            <td data-label="Status" class="mobile-hide">${statusBadge(c.status, { em_aberto: 'Em aberto', atrasado: 'Atrasado', quitado: 'Quitado', perda: 'Perda' }[c.status])}</td>
            <td data-label=""><button class="icon-btn view-contract-btn" data-id="${c.id}" aria-label="Abrir contrato ${c.contract_number}">${Icons.chevronRight}</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>` : `<div class="empty-state">${Icons.contract}<p>${term ? 'Nenhum contrato encontrado para essa busca.' : `Nenhum contrato ${contratosTab === 'aberto' ? 'em aberto' : 'finalizado'}.`}</p></div>`;

  listEl.querySelectorAll('.contract-row, .view-contract-btn').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); router.navigate('#/gerente/contratos/' + (el.dataset.id)); };
  });
}

registerRoute('gerente/contratos', { role: 'gerente', screenId: 'gerente-contratos', title: 'Contratos', render: renderGerenteContratosLista });

// ---------------------------------------------------------------------------
// Detalhe do contrato
// ---------------------------------------------------------------------------

async function renderGerenteContratoDetalhe(params) {
  const root = document.getElementById('screen-gerente-contratos');
  root.innerHTML = `<div class="text-soft">Carregando contrato...</div>`;

  const contractId = params.id;
  const [{ data: contract }, { data: installments }, { data: cycles }, { data: payments }] = await Promise.all([
    supa.from('loan_contracts').select('*, clients!loan_contracts_client_id_fkey(profile_id, credit_limit, profiles!clients_profile_id_fkey(full_name, cpf, phone))').eq('id', contractId).maybeSingle(),
    supa.from('installments').select('*').eq('contract_id', contractId).order('sequence_number'),
    supa.from('renewal_cycles').select('*').eq('contract_id', contractId).order('cycle_number'),
    supa.from('payments').select('*').eq('contract_id', contractId).order('received_at', { ascending: false }),
  ]);

  if (!contract) { root.innerHTML = `<div class="auth-error">Contrato não encontrado.</div>`; return; }

  const p = contract.clients.profiles || {};
  const totalPago = (payments || []).reduce((s, x) => s + Number(x.amount_received), 0);
  const abertas = (installments || []).filter((i) => i.status === 'pendente' || i.status === 'atrasada');
  const pagas = (installments || []).filter((i) => i.status === 'paga');

  const totalInterestReceived = (payments || []).reduce((s, p) => s + Number(p.interest_component), 0);
  const totalEntryFees = (payments || []).reduce((s, p) => s + Number(p.operational_fee_amount), 0);
  const exitFee = Number(contract.operational_fee_amount || 0);
  const netContractProfit = totalInterestReceived - exitFee - totalEntryFees;

  root.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="back-to-list">${Icons.chevronLeft} Voltar para contratos</button>

    <div class="card mt-14">
      <div class="flex justify-between items-center" style="flex-wrap:wrap">
        <div>
          <h3>Contrato #${contract.contract_number} — ${escapeHtml(p.full_name || '')}</h3>
          <div class="text-sm text-soft">CPF ${escapeHtml(p.cpf || '—')} · ${escapeHtml(p.phone || '')} · Contrato firmado em ${formatDate(contract.contract_date)} · ${contract.installments_count}x ${dueTypeLabel(contract.due_type, contract.custom_interval_days)}</div>
        </div>
        <div class="flex items-center gap-8" style="flex-wrap:wrap">
          ${(() => {
            // O status do contrato é derivado das parcelas/ciclos e vive
            // gravado em loan_contracts.status. Aqui ele é reconferido contra
            // o estado efetivo das parcelas já carregadas nesta tela, pela
            // mesma razão que effectiveInstallmentStatus() existe: a coluna
            // pode estar defasada (o cron roda 1x/dia) e, até a migration_050,
            // reagendar uma parcela nem sequer chamava recompute_contract_
            // status() — o cabeçalho ficava "Atrasado" com todas as parcelas
            // pendentes, exatamente a inconsistência que o usuário reportou.
            // Só reavalia entre em_aberto/atrasado; 'quitado' e 'perda' são
            // terminais e continuam vindo do banco.
            let st = contract.status;
            if (st === 'em_aberto' || st === 'atrasado') {
              const abertos = [
                ...(installments || []).map((i) => effectiveInstallmentStatus(i.status, i.due_date)),
                ...(cycles || []).map((c) => effectiveInstallmentStatus(c.status, c.new_due_date)),
              ];
              st = abertos.includes('atrasada') ? 'atrasado' : 'em_aberto';
            }
            return statusBadge(st, { em_aberto: 'Em aberto', atrasado: 'Atrasado', quitado: 'Quitado', perda: 'Perda' }[st]);
          })()}
          <button class="btn btn-outline btn-sm" id="print-extrato-btn" ${planAllows('allow_extrato_pdf') ? '' : 'disabled title="Não disponível no plano atual"'}>${Icons.printer} Extrato</button>
          <button class="btn btn-outline btn-sm" id="edit-contract-btn">${Icons.edit} Editar contrato</button>
          <button class="btn btn-outline btn-sm" id="delete-contract-btn" style="color:var(--bad)">${Icons.trash} Excluir contrato</button>
        </div>
      </div>
      <div class="grid grid-4 kpi-grid-4 mt-14">
        <div class="stat-card"><div class="label">Aporte (dívida-base)</div><div class="value mono">${formatMoney(contract.principal_amount)}</div></div>
        <div class="stat-card"><div class="label">Juros</div><div class="value mono">${formatNumber(contract.interest_rate, 2)}%</div></div>
        <div class="stat-card"><div class="label">Pago total</div><div class="value mono">${formatMoney(totalPago)}</div></div>
        <div class="stat-card"><div class="label">Total desembolsado (contrato + taxa)</div><div class="value mono">${formatMoney(contract.total_disbursed_amount)}</div></div>
      </div>
      <div class="grid grid-2 mt-14">
        <div class="stat-card" style="background:var(--brand-soft)">
          <div class="label">Lucro líquido do contrato (juros − taxa de saída − taxas de entrada)</div>
          <div class="value mono" style="font-size:20px">${formatMoney(netContractProfit)}</div>
          <div class="hint">Juros recebidos ${formatMoney(totalInterestReceived)} − taxa de saída ${formatMoney(exitFee)} − taxas de entrada ${formatMoney(totalEntryFees)}</div>
        </div>
      </div>
      ${contract.observations ? `<p class="text-sm text-soft mt-14">Obs: ${escapeHtml(contract.observations)}</p>` : ''}
    </div>

    <div class="card mt-14">
      <div class="flex justify-between items-center">
        <h3>Parcelas</h3>
        <button class="btn btn-outline btn-sm" id="print-promissorias-btn" ${planAllows('allow_promissoria_pdf') ? '' : 'disabled title="Não disponível no plano atual"'}>${Icons.printer} Nota Promissória</button>
      </div>
      <table class="data-table table-scroll mt-8">
        <thead><tr><th>Nº</th><th>Vencimento</th><th>Capital</th><th>Juros</th><th>Total</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${(installments || []).map((i) => {
            // Parcela já renovada (contrato de parcela única): em vez de
            // mostrar o registro congelado da parcela original, a linha
            // passa a refletir o ELO ATUAL da cadeia de renovação (o ciclo
            // que ainda não foi renovado de novo — sempre existe só um).
            // Isso substitui a antiga tabela "Ciclos de renovação" (removida
            // por ser redundante com "Pagamentos recebidos" — cada
            // renovação já vira uma linha lá) e devolve o botão "Receber"
            // pra cá, no mesmo lugar de sempre, como se fosse a 1ª parcela.
            const currentCycle = i.status === 'renovada' ? (cycles || []).find((c) => c.status !== 'renovada') : null;
            if (currentCycle) {
              const st = effectiveInstallmentStatus(currentCycle.status, currentCycle.new_due_date);
              const capital = Number(contract.principal_amount);
              const total = cycleRemaining(currentCycle);
              const juros = total - capital;
              return `
              <tr>
                <td data-label="Nº">${i.sequence_number}</td>
                <td data-label="Vencimento">${formatDate(currentCycle.new_due_date)}</td>
                <td data-label="Capital" class="mono">${formatMoney(capital)}</td>
                <td data-label="Juros" class="mono">${formatMoney(juros)}</td>
                <td data-label="Total"><div><div class="mono">${formatMoney(total)}</div>${st === 'perda' ? `<div class="text-sm" style="color:var(--bad)">Perda reconhecida: ${formatMoney(currentCycle.principal_lost)}</div>` : ''}</div></td>
                <td data-label="Status">${statusBadge(st, { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada', renovada: 'Renovada', perda: 'Perda' }[st])}</td>
                <td data-label="">
                  <div class="flex gap-8">
                    ${(currentCycle.status === 'pendente' || currentCycle.status === 'atrasada') ? `
                      <button class="btn btn-accent btn-sm receive-cycle-btn" data-id="${currentCycle.id}">Receber</button>
                    ` : ''}
                    <button class="icon-btn edit-cycle-btn" data-id="${currentCycle.id}" title="Editar/adiar renovação" aria-label="Editar ou adiar a renovação ${currentCycle.cycle_number}">${Icons.edit}</button>
                    ${(currentCycle.status === 'pendente' || currentCycle.status === 'atrasada' || currentCycle.status === 'perda') ? `
                      <button class="icon-btn cycle-loss-btn" data-status="${currentCycle.status}" data-id="${currentCycle.id}" data-amount="${capital}" data-label="Renovação ${currentCycle.cycle_number}" title="${currentCycle.status === 'perda' ? 'Reverter perda' : 'Marcar como perda'}" aria-label="${currentCycle.status === 'perda' ? 'Reverter perda' : 'Marcar como perda'} da renovação ${currentCycle.cycle_number}" style="color:var(--bad)">${Icons.alertTriangle}</button>
                    ` : ''}
                  </div>
                </td>
              </tr>
            `;
            }
            const st = effectiveInstallmentStatus(i.status, i.due_date);
            const isPartial = st !== 'paga' && (i.principal_paid_partial > 0 || i.interest_paid_partial > 0);
            return `
            <tr>
              <td data-label="Nº">${i.sequence_number}</td>
              <td data-label="Vencimento">${formatDate(i.due_date)}</td>
              <td data-label="Capital" class="mono">${formatMoney(i.principal_share)}</td>
              <td data-label="Juros" class="mono">${formatMoney(i.interest_share)}</td>
              <td data-label="Total"><div><div class="mono">${formatMoney(i.amount_due)}</div>${isPartial ? `<div class="text-sm text-soft">Pago parcial: ${formatMoney(Number(i.principal_paid_partial) + Number(i.interest_paid_partial))} · resta ${formatMoney(i.amount_due - i.principal_paid_partial - i.interest_paid_partial)}</div>` : ''}${st === 'perda' ? `<div class="text-sm" style="color:var(--bad)">Perda reconhecida: ${formatMoney(i.principal_lost)}</div>` : ''}</div></td>
              <td data-label="Status">${statusBadge(st, { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada', renovada: 'Renovada', cancelada: 'Cancelada', perda: 'Perda' }[st])}</td>
              <td data-label="">
                <div class="flex gap-8">
                  ${(i.status === 'pendente' || i.status === 'atrasada') ? `
                    <button class="btn btn-accent btn-sm receive-inst-btn" data-id="${i.id}">Receber</button>
                  ` : ''}
                  <button class="icon-btn edit-inst-btn" data-id="${i.id}" title="Editar/reagendar parcela">${Icons.edit}</button>
                </div>
              </td>
            </tr>
          `; }).join('')}
        </tbody>
      </table>
    </div>

    <div class="card mt-14">
      <h3>Pagamentos recebidos</h3>
      ${(payments || []).length ? `
      <table class="data-table table-scroll mt-8">
        <thead><tr><th>Data</th><th>Vencimento</th><th>Tipo</th><th>Valor</th><th>Taxa de entrada</th><th>Lucro líquido</th><th></th></tr></thead>
        <tbody>
          ${payments.map((pay) => {
            // Vencimento do pagamento: derivado do registro relacionado
            // (parcela ou ciclo), já carregado nesta tela — sem query extra.
            // Pra "renovacao_juros"/"quitacao_final" (ligados a um ciclo),
            // isso é justamente o "Novo vencimento" que a antiga tabela
            // "Ciclos de renovação" mostrava — preservado aqui pra não
            // perder essa informação quando aquela tabela foi removida.
            const dueDate = pay.installment_id
              ? ((installments || []).find((i) => i.id === pay.installment_id) || {}).due_date
              : ((cycles || []).find((c) => c.id === pay.renewal_cycle_id) || {}).new_due_date;
            return `
            <tr>
              <td data-label="Data">${formatDateUTC(pay.received_at)}</td>
              <td data-label="Vencimento">${dueDate ? formatDate(dueDate) : '—'}</td>
              <td data-label="Tipo">${{ quitacao_parcela: 'Quitação', renovacao_juros: 'Renovação (juros)', quitacao_final: 'Quitação final' }[pay.payment_kind]}</td>
              <td data-label="Valor" class="mono">${formatMoney(pay.amount_received)}</td>
              <td data-label="Taxa de entrada" class="mono">${pay.has_operational_fee ? formatMoney(pay.operational_fee_amount) : '—'}</td>
              <td data-label="Lucro líquido" class="mono">${formatMoney(pay.net_profit)}</td>
              <td data-label=""><button class="icon-btn edit-payment-fee-btn" data-id="${pay.id}" title="Editar taxa de entrada">${Icons.edit}</button></td>
            </tr>
          `; }).join('')}
        </tbody>
      </table>` : `<p class="text-sm text-soft mt-8">Nenhum pagamento registrado ainda.</p>`}
    </div>
  `;

  document.getElementById('back-to-list').onclick = () => router.navigate('#/gerente/contratos');

  document.getElementById('print-extrato-btn').onclick = async () => {
    const { data: clientData } = await supa.from('clients').select('score').eq('profile_id', contract.client_id).maybeSingle();
    await gerarExtratoPDF({
      contract, installments: installments || [], cycles: cycles || [], clientProfile: p,
      score: clientData ? clientData.score : null,
      companyName: (App.settings && App.settings.company_name) || 'Siges Serviços Financeiros',
    });
  };

  document.getElementById('print-promissorias-btn').onclick = () => {
    gerarNotasPromissoriasPDF({
      contract, installments: installments || [], clientProfile: p,
      companyName: (App.settings && App.settings.company_name) || 'Siges Serviços Financeiros',
      companyCity: (App.settings && App.settings.company_city) || '',
    });
  };

  document.getElementById('edit-contract-btn').onclick = () => openEditContratoModal(contract, () => renderGerenteContratoDetalhe(params));
  document.getElementById('delete-contract-btn').onclick = () => openDeleteContratoConfirm(contract);

  root.querySelectorAll('.receive-inst-btn').forEach((btn) => {
    btn.onclick = () => openReceberModal({ sourceType: 'installment', id: btn.dataset.id, contract }, () => renderGerenteContratoDetalhe(params));
  });
  root.querySelectorAll('.edit-inst-btn').forEach((btn) => {
    btn.onclick = () => {
      const inst = (installments || []).find((i) => i.id === btn.dataset.id);
      openEditInstallmentModal(inst, contract, () => renderGerenteContratoDetalhe(params));
    };
  });
  root.querySelectorAll('.receive-cycle-btn').forEach((btn) => {
    btn.onclick = () => openReceberModal({ sourceType: 'renewal_cycle', id: btn.dataset.id, contract }, () => renderGerenteContratoDetalhe(params));
  });
  // Editar/adiar ciclo de renovação (migration_049, 2026-08-24). Até aqui só a
  // PARCELA podia ser reagendada — chegando o dia do vencimento de uma
  // renovação, o administrador só tinha três saídas: renovar de novo (exige o
  // cliente pagar juros), quitar (exige o valor cheio) ou deixar vencer. Não
  // havia como simplesmente adiar, que é a negociação mais comum do dia a dia.
  root.querySelectorAll('.edit-cycle-btn').forEach((btn) => {
    btn.onclick = () => {
      const cyc = (cycles || []).find((c) => c.id === btn.dataset.id);
      openEditCycleModal(cyc, contract, () => renderGerenteContratoDetalhe(params));
    };
  });
  // O botão "Marcar como perda" saiu da linha da tabela (poluía o visual,
  // 2026-07-30). Pra parcela normal ele vive dentro do modal de "Editar/
  // reagendar parcela" (ver openEditInstallmentModal); pro ciclo continua como
  // ícone próprio na linha, mas desde 2026-08-24 com ícone de ALERTA, não mais
  // a caneta — antes as duas ações (editar e marcar perda) dividiam o mesmo
  // Icons.edit, e no celular, onde não há tooltip, clicar no lugar óbvio para
  // reagendar abria uma confirmação de perda.
  root.querySelectorAll('.cycle-loss-btn').forEach((btn) => {
    btn.onclick = () => openMarkOrRevertLossModal({
      isCycle: true, isLoss: btn.dataset.status === 'perda',
      id: btn.dataset.id, amount: btn.dataset.amount, label: btn.dataset.label,
      contract, onDone: () => renderGerenteContratoDetalhe(params),
    });
  });
  root.querySelectorAll('.edit-payment-fee-btn').forEach((btn) => {
    btn.onclick = () => {
      const pay = (payments || []).find((x) => x.id === btn.dataset.id);
      openEditPaymentFeeModal(pay, () => renderGerenteContratoDetalhe(params));
    };
  });
}

function openEditContratoModal(contract, onDone) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>Editar contrato #${contract.contract_number}</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="ec-feedback"></div>
        <p class="text-sm text-soft">O valor emprestado e o número de parcelas não podem ser alterados aqui (isso exigiria recalcular todas as parcelas já geradas) — para isso, edite as parcelas individualmente ou exclua e crie um novo contrato.</p>
        <div class="field mt-14"><label>Juros (%) do período contratado</label><input type="number" min="0" step="0.01" id="ec-rate" value="${contract.interest_rate}"></div>
        <div class="toggle-row mt-8"><label class="switch"><input type="checkbox" id="ec-fee-toggle" ${contract.has_operational_fee ? 'checked' : ''}><span class="track"></span></label><span>Aplicar taxa operacional de saída?</span></div>
        <div id="ec-fee-fields" class="mt-8 ${contract.has_operational_fee ? '' : 'hidden'}">
          <div class="field"><label>Valor da taxa de saída (R$)</label><input type="text" id="ec-fee-amount"></div>
        </div>
        <div class="toggle-row mt-14"><label class="switch"><input type="checkbox" id="ec-renewal" ${contract.allows_renewal ? 'checked' : ''}><span class="track"></span></label><span>Permite renovação</span></div>
        <div class="field-row mt-14">
          <div class="field"><label>Multa por atraso (%)</label><input type="number" min="0" step="0.01" id="ec-late-fee" value="${contract.late_fee_percent}"></div>
          <div class="field"><label>Juros por atraso (% ao dia)</label><input type="number" min="0" step="0.01" id="ec-late-interest" value="${contract.late_interest_percent}"></div>
        </div>
        <span class="help">Juros compostos diariamente sobre o saldo em atraso (ex: 2% ao dia) + multa fixa uma vez — ajustável em cada recebimento.</span>
        <div class="field"><label>Observações</label><textarea id="ec-observations">${escapeHtml(contract.observations || '')}</textarea></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-primary" id="save-modal">Salvar alterações</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);
  const close = () => overlay.remove();
  // UX-02 (auditoria 2026-08-23): prende o foco dentro do modal, fecha com
  // Escape e devolve o foco a quem abriu. Antes, com o modal aberto, o Tab
  // passeava pela página ATRÁS dele e o Escape não fazia nada.
  wireModal(overlay, close);
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;

  const feeToggle = document.getElementById('ec-fee-toggle');
  const feeInput = document.getElementById('ec-fee-amount');
  setMoneyValue(feeInput, contract.operational_fee_amount);
  attachMoneyMask(feeInput);
  feeToggle.onchange = () => document.getElementById('ec-fee-fields').classList.toggle('hidden', !feeToggle.checked);

  document.getElementById('save-modal').onclick = async () => {
    const btn = document.getElementById('save-modal');
    btn.disabled = true;
    const { error } = await supa.rpc('update_contract', {
      p_contract_id: contract.id,
      p_interest_rate: Number(document.getElementById('ec-rate').value || 0),
      p_has_operational_fee: feeToggle.checked,
      p_operational_fee_amount: feeToggle.checked ? getMoneyValue(feeInput) : 0,
      p_allows_renewal: document.getElementById('ec-renewal').checked,
      p_late_fee_percent: Number(document.getElementById('ec-late-fee').value || 0),
      p_late_interest_percent: Number(document.getElementById('ec-late-interest').value || 0),
      p_observations: document.getElementById('ec-observations').value.trim() || null,
    });
    if (error) {
      document.getElementById('ec-feedback').innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`;
      btn.disabled = false;
      return;
    }
    logAudit('contrato_editado', `Contrato #${contract.contract_number} editado`, { contract_id: contract.id });
    close();
    showToast('Contrato atualizado.');
    if (typeof onDone === 'function') onDone();
  };
}

function openDeleteContratoConfirm(contract) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:460px">
      <div class="modal-head"><h3 style="color:var(--bad)">Excluir contrato</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <p class="text-sm">Tem certeza que deseja excluir o contrato <strong>#${contract.contract_number}</strong> permanentemente? Isso apaga todas as parcelas, pagamentos e ciclos de renovação ligados a ele. Essa ação não pode ser desfeita.</p>
        <div id="dc-feedback" class="mt-8"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-danger" id="confirm-delete">Excluir permanentemente</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);
  const close = () => overlay.remove();
  // UX-02 (auditoria 2026-08-23): prende o foco dentro do modal, fecha com
  // Escape e devolve o foco a quem abriu. Antes, com o modal aberto, o Tab
  // passeava pela página ATRÁS dele e o Escape não fazia nada.
  wireModal(overlay, close);
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;
  document.getElementById('confirm-delete').onclick = async () => {
    const btn = document.getElementById('confirm-delete');
    btn.disabled = true;
    const { error } = await supa.rpc('delete_contract', { p_contract_id: contract.id });
    if (error) {
      document.getElementById('dc-feedback').innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`;
      btn.disabled = false;
      return;
    }
    logAudit('contrato_excluido', `Contrato #${contract.contract_number} excluído`, { contract_id: contract.id });
    close();
    showToast('Contrato excluído.');
    router.navigate('#/gerente/contratos');
  };
}

function openEditInstallmentModal(installment, contract, onDone) {
  // Parcela "acionável" pra perda: só pendente/atrasada (pode marcar) ou já
  // perda (pode reverter) — paga/renovada/cancelada não tem essa opção.
  const canLossAction = ['pendente', 'atrasada', 'perda'].includes(installment.status);
  const lossAmount = Math.max(0, Number(installment.principal_share) - Number(installment.principal_paid_partial || 0));
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h3>Editar/reagendar parcela ${installment.sequence_number}</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="ei-feedback"></div>
        <div class="field"><label>Nova data de vencimento</label><input type="date" id="ei-due-date" value="${installment.due_date}"></div>
        <div class="field-row">
          <div class="field"><label>Capital (R$)</label><input type="text" id="ei-principal"></div>
          <div class="field"><label>Juros (R$)</label><input type="text" id="ei-interest"></div>
        </div>
        ${installment.status === 'renovada' ? `
        <p class="text-sm mt-8" style="color:var(--warn)">Esta parcela já foi renovada (rolou para um novo ciclo) — a edição aqui é só uma correção de registro histórico, não recalcula o ciclo já criado.</p>
        ` : ''}
        ${(Number(installment.principal_paid_partial) > 0 || Number(installment.interest_paid_partial) > 0) ? `
        <p class="text-sm mt-8" style="color:var(--bad)">${installment.status === 'paga' ? 'Esta parcela já foi paga' : 'Esta parcela já recebeu pagamento parcial'}: ${formatMoney(Number(installment.principal_paid_partial) + Number(installment.interest_paid_partial))}. Capital e juros não podem ficar abaixo do que já foi pago.</p>
        ` : ''}
        <p class="text-sm text-soft">Novo total da parcela: <strong class="mono" id="ei-total-preview">${formatMoney(installment.amount_due)}</strong></p>
      </div>
      <div class="modal-foot" style="justify-content:space-between">
        ${canLossAction ? `<button class="btn btn-outline btn-sm" id="ei-loss-btn" style="color:var(--bad)">${installment.status === 'perda' ? 'Reverter perda' : 'Marcar como perda'}</button>` : '<span></span>'}
        <div class="flex gap-10">
          <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
          <button class="btn btn-primary" id="save-modal">Salvar</button>
        </div>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);
  const close = () => overlay.remove();
  // UX-02 (auditoria 2026-08-23): prende o foco dentro do modal, fecha com
  // Escape e devolve o foco a quem abriu. Antes, com o modal aberto, o Tab
  // passeava pela página ATRÁS dele e o Escape não fazia nada.
  wireModal(overlay, close);
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;

  const lossBtn = document.getElementById('ei-loss-btn');
  if (lossBtn) {
    lossBtn.onclick = () => {
      close();
      openMarkOrRevertLossModal({
        isCycle: false, isLoss: installment.status === 'perda',
        id: installment.id, amount: lossAmount, label: `Parcela ${installment.sequence_number}`,
        contract, onDone,
      });
    };
  }

  const principalInput = document.getElementById('ei-principal');
  const interestInput = document.getElementById('ei-interest');
  setMoneyValue(principalInput, installment.principal_share);
  setMoneyValue(interestInput, installment.interest_share);
  attachMoneyMask(principalInput);
  attachMoneyMask(interestInput);
  const updatePreview = () => {
    document.getElementById('ei-total-preview').textContent = formatMoney(getMoneyValue(principalInput) + getMoneyValue(interestInput));
  };
  principalInput.oninput = updatePreview;
  interestInput.oninput = updatePreview;

  document.getElementById('save-modal').onclick = async () => {
    const btn = document.getElementById('save-modal');
    btn.disabled = true;
    const { error } = await supa.rpc('update_installment_schedule', {
      p_installment_id: installment.id,
      p_due_date: document.getElementById('ei-due-date').value,
      p_principal_share: getMoneyValue(principalInput),
      p_interest_share: getMoneyValue(interestInput),
    });
    if (error) {
      const msg = (error.message || '').includes('AMOUNT_BELOW_ALREADY_PAID')
        ? 'Capital ou juros não podem ficar abaixo do valor já pago parcialmente nesta parcela.'
        : (error.message || '').includes('PRINCIPAL_MISMATCH')
        ? 'O novo capital desta parcela faz a soma do capital de todas as parcelas do contrato divergir demais do valor contratado. Confira o valor antes de salvar.'
        : error.message;
      document.getElementById('ei-feedback').innerHTML = `<div class="auth-error">${escapeHtml(msg)}</div>`;
      btn.disabled = false;
      return;
    }
    logAudit('parcela_editada', `Parcela ${installment.sequence_number} reagendada/editada`, { installment_id: installment.id });
    close();
    showToast('Parcela atualizada.');
    if (typeof onDone === 'function') onDone();
  };
}

// Editar/adiar um ciclo de renovação (migration_049, 2026-08-24).
//
// Espelho de openEditInstallmentModal, criado para fechar a assimetria que
// existia desde sempre: só a PARCELA podia ser reagendada. Quando chegava o
// vencimento de uma renovação, o administrador tinha três saídas — renovar de
// novo (exige o cliente pagar juros), quitar (exige o valor cheio) ou deixar
// vencer e acumular encargo. Adiar, que é a negociação mais comum, não existia.
//
// Deixar o valor como veio = adiamento puro (cortesia). Mexer no valor =
// acréscimo negociado pelos dias extras. O sistema não impõe regra: quem
// decide é o administrador, caso a caso (decisão do usuário, 2026-08-24).
function openEditCycleModal(cycle, contract, onDone) {
  if (!cycle) { showToast('Não foi possível carregar esta renovação.'); return; }

  // O modal edita o valor BRUTO da dívida do ciclo, então aqui é
  // full_debt_amount mesmo, não o remanescente. Mas se já houve pagamento
  // parcial o admin precisa ver isso: sem o aviso, ele editaria o total sem
  // saber que parte já entrou (e o banco recusaria com AMOUNT_BELOW_ALREADY_PAID).
  const capital = Math.min(Number(contract.principal_amount || 0), Number(cycle.full_debt_amount || 0));
  const jurosAtual = Number(cycle.full_debt_amount || 0) - capital;
  const jaPago = Number(cycle.principal_paid_partial || 0) + Number(cycle.interest_paid_partial || 0);
  const isTerminal = ['paga', 'renovada', 'perda'].includes(cycle.status);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head">
        <h3>Editar/adiar renovação ${cycle.cycle_number}</h3>
        <button class="icon-btn" id="close-modal" aria-label="Fechar">${Icons.x}</button>
      </div>
      <div class="modal-body">
        <div id="ec-feedback"></div>
        <div class="field">
          <label for="ec-due-date">Novo vencimento</label>
          <input type="date" id="ec-due-date" value="${cycle.new_due_date}">
        </div>
        <div class="field">
          <label for="ec-full-debt">Valor total da dívida (R$)</label>
          <input type="text" id="ec-full-debt">
          <span class="help">Deixe como está para apenas adiar sem cobrar nada a mais. Altere se negociou um acréscimo pelos dias extras.</span>
        </div>
        <div class="text-sm text-soft mt-8">
          Composição atual: <span class="mono">${formatMoney(capital)}</span> de capital
          + <span class="mono">${formatMoney(jurosAtual)}</span> de juros acumulados.
        </div>
        ${jaPago > 0 ? `<p class="text-sm mt-8" style="color:var(--warn)">Já foi recebido <strong>${formatMoney(jaPago)}</strong> desta renovação em pagamento(s) parcial(is) — restam ${formatMoney(cycleRemaining(cycle))}. O novo total não pode ficar abaixo do que já entrou.</p>` : ''}
        <div id="ec-diff" class="mt-8"></div>
        ${isTerminal ? `
          <p class="text-sm mt-8" style="color:var(--warn)">Esta renovação está como <strong>${{ paga: 'paga', renovada: 'renovada', perda: 'perda' }[cycle.status]}</strong> — a edição aqui é correção de registro histórico e não muda esse status nem o valor já contabilizado.</p>
        ` : ''}
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-primary" id="save-modal">Salvar</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);
  const close = () => overlay.remove();
  wireModal(overlay, close);
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;

  const debtInput = document.getElementById('ec-full-debt');
  const dateInput = document.getElementById('ec-due-date');
  setMoneyValue(debtInput, cycle.full_debt_amount);
  attachMoneyMask(debtInput);

  // Mostra em tempo real o que a edição significa — sem isso o administrador
  // só descobre que adiou 40 dias (ou que digitou um valor errado) depois de
  // salvar.
  const updateDiff = () => {
    const novoTotal = getMoneyValue(debtInput);
    const novaData = dateInput.value;
    const partes = [];

    if (novaData && novaData !== cycle.new_due_date) {
      const dias = daysBetween(cycle.new_due_date, novaData);
      partes.push(dias > 0
        ? `<span style="color:var(--accent)">Adiando ${dias} dia(s)</span>`
        : `<span style="color:var(--warn)">Antecipando ${Math.abs(dias)} dia(s)</span>`);
    }
    if (novaData && novaData < todayISO()) {
      partes.push('<span style="color:var(--bad)">a data escolhida já passou — a renovação continuará em atraso</span>');
    }

    const diff = Math.round((novoTotal - Number(cycle.full_debt_amount || 0)) * 100) / 100;
    if (Math.abs(diff) >= 0.01) {
      partes.push(diff > 0
        ? `<span style="color:var(--warn)">acréscimo de ${formatMoney(diff)} na dívida</span>`
        : `<span style="color:var(--good)">abatimento de ${formatMoney(Math.abs(diff))} na dívida</span>`);
    }
    if (novoTotal > 0 && novoTotal < capital) {
      partes.push(`<span style="color:var(--bad)">o total não pode ficar abaixo do capital de ${formatMoney(capital)}</span>`);
    }

    document.getElementById('ec-diff').innerHTML = partes.length
      ? `<p class="text-sm">${partes.join(' · ')}</p>`
      : '<p class="text-sm text-soft">Nenhuma alteração.</p>';
  };
  debtInput.oninput = updateDiff;
  dateInput.onchange = updateDiff;
  updateDiff();

  document.getElementById('save-modal').onclick = async () => {
    const btn = document.getElementById('save-modal');
    const feedback = document.getElementById('ec-feedback');
    feedback.innerHTML = '';
    btn.disabled = true;

    const novaData = dateInput.value;
    const novoTotal = getMoneyValue(debtInput);
    if (!novaData) {
      feedback.innerHTML = '<div class="auth-error">Informe o novo vencimento.</div>';
      btn.disabled = false;
      return;
    }

    const { error } = await supa.rpc('update_cycle_schedule', {
      p_cycle_id: cycle.id,
      p_new_due_date: novaData,
      p_full_debt_amount: novoTotal,
    });
    if (error) {
      const raw = error.message || '';
      const msg = isMissingRpcError(error)
        ? 'Falta aplicar a migration_049 no banco. Rode supabase/migration_049.sql no SQL Editor do Supabase.'
        : raw.includes('AMOUNT_BELOW_ALREADY_PAID')
        ? `O valor total não pode ficar abaixo do que já foi recebido nesta renovação (${formatMoney(jaPago)}).`
        : raw.includes('AMOUNT_BELOW_PRINCIPAL')
        ? `O valor total não pode ficar abaixo do capital do contrato (${formatMoney(capital)}) — senão a quitação entraria como prejuízo nos relatórios.`
        : raw.includes('INVALID_AMOUNT')
        ? 'Informe um valor total maior que zero.'
        : raw.includes('INVALID_DATE')
        ? 'Informe o novo vencimento.'
        : raw.includes('NOT_FOUND')
        ? 'Não encontramos esta renovação. Atualize a tela e tente de novo.'
        : raw;
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(msg)}</div>`;
      btn.disabled = false;
      return;
    }

    const dias = novaData !== cycle.new_due_date ? daysBetween(cycle.new_due_date, novaData) : 0;
    logAudit(
      'renovacao_reagendada',
      `Renovação ${cycle.cycle_number} do contrato #${contract.contract_number} reagendada de ${formatDate(cycle.new_due_date)} para ${formatDate(novaData)}` +
        (Math.abs(novoTotal - Number(cycle.full_debt_amount || 0)) >= 0.01
          ? ` (valor: ${formatMoney(cycle.full_debt_amount)} → ${formatMoney(novoTotal)})`
          : ''),
      { cycle_id: cycle.id, contract_id: contract.id, dias }
    );
    close();
    showToast(dias > 0 ? `Renovação adiada em ${dias} dia(s).` : 'Renovação atualizada.');
    if (typeof onDone === 'function') onDone();
  };
}

// Taxa de entrada fica gravada no PAGAMENTO (payments.operational_fee_amount),
// não na parcela — por isso é um modal separado, editando o registro do
// pagamento já recebido, não a parcela em si. Corrigir esse valor recalcula
// `net_profit` automaticamente (coluna gerada), então relatórios/lucro
// líquido já enxergam o ajuste sem precisar tocar em mais nenhum lugar.
function openEditPaymentFeeModal(payment, onDone) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h3>Editar taxa de entrada</h3><button class="icon-btn" id="epf-close">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="epf-feedback"></div>
        <p class="text-sm text-soft">Pagamento de ${formatMoney(payment.amount_received)} recebido em ${formatDateUTC(payment.received_at)}.</p>
        <div class="toggle-row mt-14">
          <label class="switch"><input type="checkbox" id="epf-toggle" ${payment.has_operational_fee ? 'checked' : ''}><span class="track"></span></label>
          <span>Cobrar taxa operacional de entrada neste pagamento?</span>
        </div>
        <div class="field mt-14 ${payment.has_operational_fee ? '' : 'hidden'}" id="epf-amount-field">
          <label>Valor da taxa de entrada (R$)</label>
          <input type="text" id="epf-amount">
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="epf-cancel">Cancelar</button>
        <button class="btn btn-primary" id="epf-save">Salvar</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);
  const close = () => overlay.remove();
  // UX-02 (auditoria 2026-08-23): prende o foco dentro do modal, fecha com
  // Escape e devolve o foco a quem abriu. Antes, com o modal aberto, o Tab
  // passeava pela página ATRÁS dele e o Escape não fazia nada.
  wireModal(overlay, close);
  overlay.querySelector('#epf-close').onclick = close;
  overlay.querySelector('#epf-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const amountInput = overlay.querySelector('#epf-amount');
  setMoneyValue(amountInput, payment.operational_fee_amount);
  attachMoneyMask(amountInput);
  const toggle = overlay.querySelector('#epf-toggle');
  toggle.onchange = () => overlay.querySelector('#epf-amount-field').classList.toggle('hidden', !toggle.checked);

  overlay.querySelector('#epf-save').onclick = async () => {
    const btn = overlay.querySelector('#epf-save');
    btn.disabled = true;
    const hasFee = toggle.checked;
    const amount = hasFee ? getMoneyValue(amountInput) : 0;
    const { error } = await supa.rpc('update_payment_fee', {
      p_payment_id: payment.id,
      p_has_operational_fee: hasFee,
      p_operational_fee_amount: amount,
    });
    if (error) {
      overlay.querySelector('#epf-feedback').innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`;
      btn.disabled = false;
      return;
    }
    logAudit('pagamento_editado', `Taxa de entrada ajustada para ${formatMoney(amount)} no pagamento de ${formatMoney(payment.amount_received)}`, { payment_id: payment.id });
    close();
    showToast('Taxa de entrada atualizada.');
    if (typeof onDone === 'function') onDone();
  };
}

// Modal genérico de confirmação pra marcar/reverter perda numa parcela ou
// ciclo específico — mesmas 4 RPCs (mark/revert × installment/cycle) usam
// esse único modal, só trocando título/mensagem/RPC/auditoria.
function openLossActionModal({ title, message, confirmLabel, rpcName, rpcParam, auditAction, auditMessage, contractId, successMessage, onDone }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:460px">
      <div class="modal-head"><h3 style="color:var(--bad)">${title}</h3><button class="icon-btn" id="lm-close">${Icons.x}</button></div>
      <div class="modal-body">
        <p class="text-sm">${message}</p>
        <div id="lm-feedback" class="mt-8"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="lm-cancel">Cancelar</button>
        <button class="btn btn-danger" id="lm-confirm">${confirmLabel}</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);
  const close = () => overlay.remove();
  // UX-02 (auditoria 2026-08-23): prende o foco dentro do modal, fecha com
  // Escape e devolve o foco a quem abriu. Antes, com o modal aberto, o Tab
  // passeava pela página ATRÁS dele e o Escape não fazia nada.
  wireModal(overlay, close);
  overlay.querySelector('#lm-close').onclick = close;
  overlay.querySelector('#lm-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#lm-confirm').onclick = async () => {
    const btn = overlay.querySelector('#lm-confirm');
    btn.disabled = true;
    const { error } = await supa.rpc(rpcName, rpcParam);
    if (error) {
      overlay.querySelector('#lm-feedback').innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`;
      btn.disabled = false;
      return;
    }
    logAudit(auditAction, auditMessage, { contract_id: contractId });
    close();
    showToast(successMessage);
    if (typeof onDone === 'function') onDone();
  };
}

// Monta a mensagem/RPC certa (marcar vs reverter, parcela vs ciclo) e delega
// pro modal de confirmação genérico acima — usado tanto pelo ícone de perda
// do ciclo de renovação quanto pelo botão dentro do modal de editar parcela.
function openMarkOrRevertLossModal({ isCycle, isLoss, id, amount, label, contract, onDone }) {
  if (isLoss) {
    openLossActionModal({
      title: 'Reverter perda',
      message: `Confirma reverter a perda de "<strong>${escapeHtml(label)}</strong>" do contrato #${contract.contract_number}? Ela volta a aparecer no Cobrar normalmente. O abatimento já contabilizado no lucro do mês em que a perda foi reconhecida não é alterado retroativamente.`,
      confirmLabel: 'Reverter perda',
      rpcName: isCycle ? 'revert_cycle_loss' : 'revert_installment_loss',
      rpcParam: isCycle ? { p_cycle_id: id } : { p_installment_id: id },
      auditAction: 'perda_revertida',
      auditMessage: `Perda revertida em ${label} do contrato #${contract.contract_number}`,
      contractId: contract.id,
      successMessage: 'Perda revertida.',
      onDone,
    });
  } else {
    openLossActionModal({
      title: 'Marcar como perda',
      message: `Confirma marcar "<strong>${escapeHtml(label)}</strong>" do contrato #${contract.contract_number} como perda? <strong>${formatMoney(Number(amount))}</strong> de capital não recuperado será abatido do lucro líquido do mês. Se o cliente pagar depois, use "Reverter perda" pra corrigir.`,
      confirmLabel: 'Marcar como perda',
      rpcName: isCycle ? 'mark_cycle_loss' : 'mark_installment_loss',
      rpcParam: isCycle ? { p_cycle_id: id } : { p_installment_id: id },
      auditAction: 'perda_manual',
      auditMessage: `${label} do contrato #${contract.contract_number} marcada como perda (${formatMoney(Number(amount))})`,
      contractId: contract.id,
      successMessage: 'Marcado como perda.',
      onDone,
    });
  }
}

registerRoute('gerente/contratos/:id', { role: 'gerente', screenId: 'gerente-contratos', title: 'Detalhe do Contrato', render: renderGerenteContratoDetalhe });
