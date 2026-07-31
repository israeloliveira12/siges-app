/* ============================================================================
   Gerente — Lançamentos Futuros (parcelas/renovações que ainda vão vencer)
   Extraído de Relatórios (2026-07-29, pedido do usuário) pra virar menu
   próprio, logo abaixo de Cobrar — mesmo conteúdo/lógica de antes, só que
   como tela independente em vez de uma aba dentro de Relatórios.
   ============================================================================ */

let futurosDataLimite = '';
let futurosTipo = 'todos'; // 'todos' | 'parcela' | 'renovacao'
let futurosSearch = '';

async function renderGerenteLancamentos() {
  const root = document.getElementById('screen-gerente-lancamentos');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const [{ data: installments, error: fe1 }, { data: cycles, error: fe2 }] = await Promise.all([
    supa.from('installments').select('*, loan_contracts!installments_contract_id_fkey(contract_number, client_id, clients!loan_contracts_client_id_fkey(profiles!clients_profile_id_fkey(full_name)))').in('status', ['pendente', 'atrasada']),
    supa.from('renewal_cycles').select('*, loan_contracts!renewal_cycles_contract_id_fkey(contract_number, client_id, clients!loan_contracts_client_id_fkey(profiles!clients_profile_id_fkey(full_name)))').in('status', ['pendente', 'atrasada']),
  ]);
  if (fe1 || fe2) {
    console.error('Erro ao carregar lançamentos futuros:', fe1 || fe2);
    root.innerHTML = `<p class="auth-error">Não foi possível carregar os lançamentos futuros agora. Recarregue a página ou tente novamente em instantes.</p>`;
    return;
  }
  paintLancamentosFuturos(root, installments || [], cycles || []);
}

// Repintura pura (sem refetch) — os 3 filtros (data limite, tipo, busca) só
// mudam o que já está em memória, mesmo padrão de paintCobrar/paintGerenteScore.
function paintLancamentosFuturos(root, installments, cycles) {
  const today = todayISO();

  let items = [
    ...installments.map((i) => ({
      tipo: 'parcela',
      data: i.due_date,
      // Saldo remanescente (não o valor cheio) — parcela com pagamento
      // parcial já recebido não deve contar o total original como "previsto".
      valor: Number(i.amount_due) - Number(i.principal_paid_partial || 0) - Number(i.interest_paid_partial || 0),
      descricao: ((i.loan_contracts || {}).clients || {}).profiles ? ((i.loan_contracts.clients.profiles.full_name) + ' · Parcela #' + i.sequence_number) : 'Parcela #' + i.sequence_number,
      contractNumber: (i.loan_contracts || {}).contract_number, contractId: i.contract_id,
    })),
    ...cycles.map((c) => ({
      tipo: 'renovacao', data: c.new_due_date, valor: Number(c.full_debt_amount),
      descricao: ((c.loan_contracts || {}).clients || {}).profiles ? ((c.loan_contracts.clients.profiles.full_name) + ' · Renovação #' + c.cycle_number) : 'Renovação #' + c.cycle_number,
      contractNumber: (c.loan_contracts || {}).contract_number, contractId: c.contract_id,
    })),
  ];

  // Remove atrasados — eles já aparecem no menu Cobrar; "Lançamentos
  // Futuros" deve mostrar só o que ainda vai vencer (hoje em diante).
  // Compara a data direto (não confia só no status, que só é atualizado
  // 1x/dia pelo cron) — mesmo padrão usado no resto do sistema.
  items = items.filter((i) => i.data >= today);

  if (futurosTipo !== 'todos') items = items.filter((i) => i.tipo === futurosTipo);
  if (futurosDataLimite) items = items.filter((i) => i.data <= futurosDataLimite);
  const term = futurosSearch.trim().toLowerCase();
  if (term) items = items.filter((i) => i.descricao.toLowerCase().includes(term) || String(i.contractNumber || '').includes(term));
  items.sort((a, b) => a.data.localeCompare(b.data));

  const previsaoEntradas = items.reduce((s, i) => s + i.valor, 0);

  const diasRestantes = (dataStr) => Math.round((new Date(dataStr) - new Date(today)) / 86400000);

  // Preserva foco/cursor da busca entre repaints (debounced, recria o
  // <input> a cada tecla) — mesmo padrão já usado em Clientes/Contratos.
  const searchElBefore = document.getElementById('futuros-search');
  const hadFocus = !!searchElBefore && document.activeElement === searchElBefore;
  const cursorPos = hadFocus ? searchElBefore.selectionStart : null;

  root.innerHTML = `
    <div class="flex justify-between items-center" style="flex-wrap:wrap;gap:8px">
      <p class="text-sm text-soft">Previsto: <strong class="mono" style="color:var(--ink)">${formatMoney(previsaoEntradas)}</strong> em ${items.length} lançamento${items.length === 1 ? '' : 's'}</p>
    </div>

    <div class="field-row mt-14">
      <div class="field"><label>Data Limite (Opcional)</label><input type="date" id="futuros-data-limite" value="${futurosDataLimite}"></div>
      <div class="field">
        <label>Tipo</label>
        <select id="futuros-tipo">
          <option value="todos" ${futurosTipo === 'todos' ? 'selected' : ''}>Todos</option>
          <option value="parcela" ${futurosTipo === 'parcela' ? 'selected' : ''}>Parcela</option>
          <option value="renovacao" ${futurosTipo === 'renovacao' ? 'selected' : ''}>Renovação</option>
        </select>
      </div>
      <div class="field"><label>Buscar</label><input type="text" id="futuros-search" placeholder="Cliente ou nº contrato" value="${escapeHtml(futurosSearch)}"></div>
    </div>

    <div class="card mt-14" style="padding:0">
      <table class="data-table table-scroll">
        <thead><tr><th>Tipo</th><th>Data</th><th>Dias Restantes</th><th>Descrição</th><th>Valor</th><th>Referência</th></tr></thead>
        <tbody>
          ${items.length ? items.map((i) => {
            const dias = diasRestantes(i.data);
            const diasLabel = dias < 0 ? `${Math.abs(dias)}d atrasado` : dias === 0 ? 'Hoje' : `${dias} dia${dias === 1 ? '' : 's'}`;
            const diasColor = dias < 0 ? 'badge-bad' : dias <= 7 ? 'badge-warn' : 'badge-purple';
            return `
            <tr>
              <td data-label="Tipo"><span class="badge badge-brand">${i.tipo === 'parcela' ? 'Parcela' : 'Renovação'}</span></td>
              <td data-label="Data">${formatDate(i.data)}</td>
              <td data-label="Dias Restantes"><span class="badge ${diasColor}">${diasLabel}</span></td>
              <td data-label="Descrição" class="wrap-text">${escapeHtml(i.descricao)}</td>
              <td data-label="Valor" class="mono">${formatMoney(i.valor)}</td>
              <td data-label="Referência">${i.contractNumber ? `<a href="#/gerente/contratos/${i.contractId}" class="reference-link">Contrato #${i.contractNumber} ${Icons.chevronRight}</a>` : '—'}</td>
            </tr>`;
          }).join('') : `<tr><td colspan="6" class="text-soft">Nenhum lançamento futuro encontrado.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('futuros-data-limite').onchange = (e) => { futurosDataLimite = e.target.value; paintLancamentosFuturos(root, installments, cycles); };
  document.getElementById('futuros-tipo').onchange = (e) => { futurosTipo = e.target.value; paintLancamentosFuturos(root, installments, cycles); };
  const searchEl = document.getElementById('futuros-search');
  searchEl.oninput = debounce((e) => { futurosSearch = e.target.value; paintLancamentosFuturos(root, installments, cycles); }, 250);
  if (hadFocus) { searchEl.focus(); if (cursorPos != null) searchEl.setSelectionRange(cursorPos, cursorPos); }
}

registerRoute('gerente/lancamentos', { role: 'gerente', screenId: 'gerente-lancamentos', title: 'Lançamentos Futuros', render: renderGerenteLancamentos });
