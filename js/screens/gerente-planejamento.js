/* ============================================================================
   Gerente — Planejamento estratégico
   Caixa atual + dívidas mensais nomeadas (12 meses) → dívida total x
   faturamento projetado (caixa + recebíveis em aberto) → lucro bruto/líquido.
   Cálculo é um retrato único ("se eu parar de emprestar hoje, quanto sobra"),
   não uma projeção mês a mês — daí taxas de entrada/saída serem aplicadas UMA
   vez sobre o valor agregado, e não parcela a parcela.
   ============================================================================ */

const mesesPtPlanejamento = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

// Meses expandidos no acordeão de "Dívidas planejadas" — mantido fora do
// paint pra sobreviver a repaints (senão fechava tudo de novo a cada clique).
let plExpandedMonths = new Set();

function planningMonthKeys() {
  const today = todayISO();
  const keys = [];
  for (let m = 0; m < 12; m++) {
    const d = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 + m, 1);
    keys.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01');
  }
  return keys;
}

function planningMonthLabel(monthISO) {
  const [y, m] = monthISO.split('-');
  return mesesPtPlanejamento[Number(m) - 1] + '/' + y;
}

async function renderGerentePlanejamento() {
  const root = document.getElementById('screen-gerente-planejamento');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const [{ data: settings }, { data: debts }, { data: pendingInst }, { data: pendingCycles }] = await Promise.all([
    supa.from('system_settings').select('*').maybeSingle(),
    supa.from('planning_debts').select('*').order('month').order('created_at'),
    supa.from('installments').select('amount_due').in('status', ['pendente', 'atrasada']),
    supa.from('renewal_cycles').select('full_debt_amount').in('status', ['pendente', 'atrasada']),
  ]);
  App.settings = settings;

  const monthKeys = planningMonthKeys();
  const debtsList = debts || [];

  paintPlanejamento(root, { settings, debtsList, pendingInst: pendingInst || [], pendingCycles: pendingCycles || [], monthKeys });
}

function calcPlanejamento({ settings, debtsList, pendingInst, pendingCycles }) {
  const sum = (rows, field) => (rows || []).reduce((s, r) => s + Number(r[field] || 0), 0);

  const dividaBase = sum(debtsList, 'amount');
  const exitPct = Number((settings && settings.default_exit_fee_percent) || 0);
  const exitFixed = Number((settings && settings.default_exit_fee_fixed) || 0);
  const taxaSaida = dividaBase > 0 ? (dividaBase * exitPct / 100 + exitFixed) : 0;
  const dividaTotal = dividaBase + taxaSaida;

  const caixaAtual = Number((settings && settings.planning_current_cash) || 0);
  const recebiveis = sum(pendingInst, 'amount_due') + sum(pendingCycles, 'full_debt_amount');
  const faturamentoBase = caixaAtual + recebiveis;
  const entryPct = Number((settings && settings.default_entry_fee_percent) || 0);
  const entryFixed = Number((settings && settings.default_entry_fee_fixed) || 0);
  // O valor FIXO da taxa de entrada é cobrado por recebimento (uma parcela
  // ou ciclo de cada vez), então na agregação ele precisa ser multiplicado
  // pela quantidade de parcelas/ciclos em aberto — só a % incide sobre o
  // faturamento total de uma vez.
  const qtdRecebiveis = (pendingInst || []).length + (pendingCycles || []).length;
  const taxaEntrada = faturamentoBase > 0 ? (faturamentoBase * entryPct / 100 + entryFixed * qtdRecebiveis) : 0;
  const faturamentoFinal = faturamentoBase - taxaEntrada;

  const lucroBruto = faturamentoFinal - dividaTotal;
  // LTV agora é uma MULTIPLICAÇÃO direta sobre o lucro bruto (decisão do
  // usuário, 2026-07-10): informar 80% de LTV significa "meu lucro líquido é
  // 80% do bruto", não mais "descontar 80% do bruto". Antes era
  // lucroBruto - (lucroBruto*LTV/100); agora é lucroBruto*LTV/100 direto.
  const ltvPercent = Number((settings && settings.planning_ltv_percent) || 0);
  const lucroLiquido = lucroBruto * ltvPercent / 100;

  return {
    dividaBase, exitPct, exitFixed, taxaSaida, dividaTotal,
    caixaAtual, recebiveis, faturamentoBase, entryPct, entryFixed, qtdRecebiveis, taxaEntrada, faturamentoFinal,
    lucroBruto, ltvPercent, lucroLiquido,
  };
}

function paintPlanejamento(root, state) {
  const { settings, debtsList, monthKeys } = state;
  const calc = calcPlanejamento(state);

  const debtsByMonth = {};
  debtsList.forEach((d) => {
    const key = String(d.month).slice(0, 10);
    (debtsByMonth[key] = debtsByMonth[key] || []).push(d);
  });
  const monthsWithDebts = monthKeys.filter((k) => debtsByMonth[k] && debtsByMonth[k].length);

  root.innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <h3>Caixa disponível hoje</h3>
        <p class="text-sm text-soft mt-8">Quanto a empresa tem em caixa neste momento (informado manualmente).</p>
        <div class="field mt-14">
          <label>Caixa atual (R$)</label>
          <input type="text" id="pl-caixa">
        </div>
        <button class="btn btn-primary btn-sm" id="pl-save-caixa">Salvar</button>
      </div>
      <div class="card">
        <h3>LTV aplicado</h3>
        <p class="text-sm text-soft mt-8">Percentual do lucro bruto que vira lucro líquido projetado (ex: 80% significa que 80% do lucro bruto é considerado líquido).</p>
        <div class="field mt-14">
          <label>LTV (%)</label>
          <input type="number" min="0" max="100" step="0.01" id="pl-ltv" value="${Number((settings && settings.planning_ltv_percent) || 0)}">
        </div>
        <button class="btn btn-primary btn-sm" id="pl-save-ltv">Salvar</button>
      </div>
    </div>

    <div class="card mt-14" style="border-color:var(--brand)">
      <h3>Resumo do planejamento</h3>
      <div class="grid grid-2 mt-14" style="gap:24px">
        <div>
          <div class="form-section-title" style="margin-top:0">Dívida</div>
          <div class="flex justify-between text-sm" style="padding:6px 0"><span class="text-soft">Dívida base (soma das dívidas)</span><span class="mono">${formatMoney(calc.dividaBase)}</span></div>
          <div class="flex justify-between text-sm" style="padding:6px 0"><span class="text-soft">(+) Taxa de saída (${formatNumber(calc.exitPct, 2)}% + ${formatMoney(calc.exitFixed)})</span><span class="mono">${formatMoney(calc.taxaSaida)}</span></div>
          <div class="flex justify-between" style="padding:8px 0;border-top:1px solid var(--line);font-weight:700"><span>Dívida Total</span><span class="mono">${formatMoney(calc.dividaTotal)}</span></div>
        </div>
        <div>
          <div class="form-section-title" style="margin-top:0">Faturamento</div>
          <div class="flex justify-between text-sm" style="padding:6px 0"><span class="text-soft">Caixa atual</span><span class="mono">${formatMoney(calc.caixaAtual)}</span></div>
          <div class="flex justify-between text-sm" style="padding:6px 0"><span class="text-soft">(+) Recebíveis em aberto (parcelas + ciclos)</span><span class="mono">${formatMoney(calc.recebiveis)}</span></div>
          <div class="flex justify-between text-sm" style="padding:6px 0;border-top:1px solid var(--line)"><span class="text-soft">= Faturamento base</span><span class="mono">${formatMoney(calc.faturamentoBase)}</span></div>
          <div class="flex justify-between text-sm" style="padding:6px 0"><span class="text-soft">(−) Taxa de entrada (${formatNumber(calc.entryPct, 2)}% + ${formatMoney(calc.entryFixed)} × ${calc.qtdRecebiveis} parcela${calc.qtdRecebiveis === 1 ? '' : 's'})</span><span class="mono">${formatMoney(calc.taxaEntrada)}</span></div>
          <div class="flex justify-between" style="padding:8px 0;border-top:1px solid var(--line);font-weight:700"><span>Faturamento Final</span><span class="mono">${formatMoney(calc.faturamentoFinal)}</span></div>
        </div>
      </div>

      <div class="grid grid-2 mt-20" style="gap:14px">
        <div class="stat-card" style="background:var(--bg)">
          <div class="label">Lucro Bruto (Faturamento Final − Dívida Total)</div>
          <div class="value mono" style="font-size:22px;color:${calc.lucroBruto >= 0 ? 'var(--good)' : 'var(--bad)'}">${formatMoney(calc.lucroBruto)}</div>
        </div>
        <div class="stat-card" style="background:var(--brand-soft)">
          <div class="label">Lucro Líquido (Bruto × LTV ${formatNumber(calc.ltvPercent, 2)}%)</div>
          <div class="value mono" style="font-size:22px;color:${calc.lucroLiquido >= 0 ? 'var(--good)' : 'var(--bad)'}">${formatMoney(calc.lucroLiquido)}</div>
          <div class="hint">${formatMoney(calc.lucroBruto)} × ${formatNumber(calc.ltvPercent, 2)}%</div>
        </div>
      </div>
    </div>

    <div class="card mt-14">
      <div class="flex justify-between items-center" style="flex-wrap:wrap;gap:10px">
        <div>
          <h3>Dívidas planejadas — próximos 12 meses</h3>
          <p class="text-sm text-soft mt-8">Lançamentos manuais de dívidas futuras (uma ou várias por mês). A soma vira a Dívida base do resumo acima.</p>
        </div>
        <button class="btn btn-primary btn-sm" id="pl-add-debt">${Icons.plus} Nova dívida</button>
      </div>
      ${!monthsWithDebts.length ? `<p class="text-soft text-sm mt-14">Nenhuma dívida lançada ainda.</p>` : `
      <div class="mt-14">
        <div class="flex justify-between text-sm text-soft" style="padding:0 2px 6px;border-bottom:1px solid var(--line)"><span>Mês</span><span>Total</span></div>
        ${monthsWithDebts.map((key) => {
          const rows = debtsByMonth[key];
          const subtotal = rows.reduce((s, d) => s + Number(d.amount || 0), 0);
          const expanded = plExpandedMonths.has(key);
          return `
          <div class="pl-month-block" style="border-bottom:1px solid var(--line)">
            <button type="button" class="pl-month-header flex justify-between items-center" data-month="${key}" style="width:100%;background:none;border:none;padding:10px 2px;cursor:pointer;text-align:left">
              <span class="flex items-center gap-8">
                <span style="display:inline-flex;transition:transform .15s;transform:rotate(${expanded ? '90deg' : '0deg'})">${Icons.chevronRight}</span>
                <strong style="font-size:13.5px">${planningMonthLabel(key)}</strong>
                <span class="text-sm text-soft">(${rows.length} dívida${rows.length === 1 ? '' : 's'})</span>
              </span>
              <span class="text-sm mono" style="font-weight:700">${formatMoney(subtotal)}</span>
            </button>
            <div class="${expanded ? '' : 'hidden'}" style="padding:0 2px 12px 30px">
              <table class="data-table table-scroll">
                <thead><tr><th>Nome</th><th>Valor</th><th></th></tr></thead>
                <tbody>
                  ${rows.map((d) => `
                    <tr>
                      <td data-label="Nome">${escapeHtml(d.name)}</td>
                      <td data-label="Valor" class="mono">${formatMoney(d.amount)}</td>
                      <td>
                        <div class="flex items-center gap-6">
                          <button class="icon-btn edit-debt-btn" data-id="${d.id}" title="Editar">${Icons.edit}</button>
                          <button class="icon-btn del-debt-btn" data-id="${d.id}" title="Excluir">${Icons.trash}</button>
                        </div>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>`;
        }).join('')}
      </div>`}
    </div>
  `;

  const caixaInput = document.getElementById('pl-caixa');
  setMoneyValue(caixaInput, calc.caixaAtual);
  attachMoneyMask(caixaInput);

  document.getElementById('pl-save-caixa').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const value = getMoneyValue(caixaInput);
    const { error } = await supa.from('system_settings').update({ planning_current_cash: value }).eq('id', true);
    if (error) { btn.disabled = false; showToast('Erro ao salvar: ' + error.message); return; }
    App.settings = { ...App.settings, planning_current_cash: value };
    showToast('Caixa atualizado.');
    renderGerentePlanejamento();
  };

  document.getElementById('pl-save-ltv').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const value = Number(document.getElementById('pl-ltv').value || 0);
    const { error } = await supa.from('system_settings').update({ planning_ltv_percent: value }).eq('id', true);
    if (error) { btn.disabled = false; showToast('Erro ao salvar: ' + error.message); return; }
    App.settings = { ...App.settings, planning_ltv_percent: value };
    showToast('LTV atualizado.');
    renderGerentePlanejamento();
  };

  document.getElementById('pl-add-debt').onclick = () => openDebtModal(monthKeys);

  root.querySelectorAll('.pl-month-header').forEach((btn) => {
    btn.onclick = () => {
      const key = btn.dataset.month;
      if (plExpandedMonths.has(key)) plExpandedMonths.delete(key); else plExpandedMonths.add(key);
      paintPlanejamento(root, state);
    };
  });

  root.querySelectorAll('.edit-debt-btn').forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); openDebtModal(monthKeys, debtsList.find((d) => d.id === btn.dataset.id)); };
  });

  root.querySelectorAll('.del-debt-btn').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('Excluir esta dívida planejada?')) return;
      btn.disabled = true;
      const { error } = await supa.from('planning_debts').delete().eq('id', btn.dataset.id);
      if (error) { btn.disabled = false; showToast('Erro ao excluir: ' + error.message); return; }
      renderGerentePlanejamento();
    };
  });
}

function openDebtModal(monthKeys, existingDebt) {
  const isEdit = !!existingDebt;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h3>${isEdit ? 'Editar dívida planejada' : 'Nova dívida planejada'}</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="debt-feedback"></div>
        <div class="field">
          <label>Mês</label>
          <select id="debt-month">
            ${monthKeys.map((k) => `<option value="${k}" ${isEdit && String(existingDebt.month).slice(0, 10) === k ? 'selected' : ''}>${planningMonthLabel(k)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Nome da dívida</label><input type="text" id="debt-name" placeholder="Ex: Aluguel, fornecedor, empréstimo bancário" value="${isEdit ? escapeHtml(existingDebt.name) : ''}"></div>
        <div class="field"><label>Valor (R$)</label><input type="text" id="debt-amount"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-primary" id="confirm-debt">${isEdit ? 'Salvar' : 'Adicionar'}</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);
  const amountInput = document.getElementById('debt-amount');
  attachMoneyMask(amountInput);
  if (isEdit) setMoneyValue(amountInput, existingDebt.amount);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;
  document.getElementById('confirm-debt').onclick = async (e) => {
    const btn = e.currentTarget;
    const name = document.getElementById('debt-name').value.trim();
    const amount = getMoneyValue(amountInput);
    const month = document.getElementById('debt-month').value;
    const feedback = document.getElementById('debt-feedback');
    if (!name) { feedback.innerHTML = `<div class="auth-error">Informe o nome da dívida.</div>`; return; }
    if (!amount || amount <= 0) { feedback.innerHTML = `<div class="auth-error">Informe um valor válido.</div>`; return; }
    btn.disabled = true;
    const { error } = isEdit
      ? await supa.from('planning_debts').update({ month, name, amount }).eq('id', existingDebt.id)
      : await supa.from('planning_debts').insert({ month, name, amount, created_by: App.session.user.id });
    if (error) { btn.disabled = false; feedback.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
    close();
    showToast(isEdit ? 'Dívida atualizada.' : 'Dívida adicionada.');
    renderGerentePlanejamento();
  };
}

registerRoute('gerente/planejamento', { role: 'gerente', primaryOnly: true, screenId: 'gerente-planejamento', title: 'Planejamento', render: renderGerentePlanejamento });
