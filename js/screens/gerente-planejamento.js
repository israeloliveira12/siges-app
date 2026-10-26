/* ============================================================================
   Gerente — Planejamento estratégico
   Caixa atual + dívidas mensais nomeadas (qualquer mês, sem limite) → dívida total x
   faturamento projetado (caixa + recebíveis em aberto) → lucro bruto/líquido.
   Cálculo é um retrato único ("se eu parar de emprestar hoje, quanto sobra"),
   não uma projeção mês a mês — daí taxas de entrada/saída serem aplicadas UMA
   vez sobre o valor agregado, e não parcela a parcela.
   ============================================================================ */

const mesesPtPlanejamento = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

// Meses expandidos no acordeão de "Dívidas planejadas" — mantido fora do
// paint pra sobreviver a repaints (senão fechava tudo de novo a cada clique).
let plExpandedMonths = new Set();

// Primeiro dia do mês corrente ('2026-10-01').
//
// Antes existia planningMonthKeys(), que devolvia só os 12 meses seguintes e
// alimentava tanto o seletor de mês quanto a lista. Esse limite foi removido
// (pedido do usuário, 2026-10-25: lançamentos com prazo maior). O banco nunca
// teve limite — `month` é um date comum —, a janela era só da tela.
//
// EFEITO COLATERAL QUE A JANELA ESCONDIA: o resumo soma TODAS as linhas de
// planning_debts, mas a lista só mostrava as que caíam dentro dos 12 meses.
// Uma dívida de um mês que já passou continuava somando na "Dívida base" sem
// aparecer em lugar nenhum. Agora a lista mostra todo mês que tenha lançamento.
function planningCurrentMonthKey() {
  return todayISO().slice(0, 7) + '-01';
}

const PL_YEAR_MIN = 2000;
const PL_YEAR_MAX = 2200;
const mesesCompletosPlanejamento = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

// Seletor de mês + campo de ano, no lugar da lista fixa de 12 meses. O ano é
// um campo numérico (e não um <select>) para não reintroduzir um teto por outro
// caminho; os limites 2000–2200 existem só para barrar erro de digitação
// (2026 escrito como 202 ou 20260 — o tipo date do banco aceitaria os dois).
function monthYearFieldsHtml(prefix, iso, labels = {}) {
  const [y, m] = String(iso).slice(0, 10).split('-');
  return `
    <div class="field-row">
      <div class="field">
        <label for="${prefix}-m">${labels.month || 'Mês'}</label>
        <select id="${prefix}-m">
          ${mesesCompletosPlanejamento.map((nome, i) => `<option value="${String(i + 1).padStart(2, '0')}" ${Number(m) === i + 1 ? 'selected' : ''}>${nome}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="${prefix}-y">${labels.year || 'Ano'}</label>
        <input type="number" id="${prefix}-y" min="${PL_YEAR_MIN}" max="${PL_YEAR_MAX}" step="1" inputmode="numeric" value="${Number(y)}">
      </div>
    </div>`;
}

// Devolve '2026-10-01' ou null se o ano estiver fora da faixa / vazio.
function readMonthYear(root, prefix) {
  const m = root.querySelector('#' + prefix + '-m').value;
  const y = Number(root.querySelector('#' + prefix + '-y').value);
  if (!Number.isInteger(y) || y < PL_YEAR_MIN || y > PL_YEAR_MAX) return null;
  return `${y}-${m}-01`;
}

function planningMonthLabel(monthISO) {
  const [y, m] = monthISO.split('-');
  return mesesPtPlanejamento[Number(m) - 1] + '/' + y;
}

async function renderGerentePlanejamento() {
  const root = document.getElementById('screen-gerente-planejamento');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const [
    { data: settings, error: e1 }, { data: debts, error: e2 },
    { data: pendingInst, error: e3 }, { data: pendingCycles, error: e4 },
  ] = await Promise.all([
    supa.from('system_settings').select('*').maybeSingle(),
    supa.from('planning_debts').select('*').order('month').order('created_at'),
    supa.from('installments').select('amount_due, principal_paid_partial, interest_paid_partial').in('status', ['pendente', 'atrasada']),
    supa.from('renewal_cycles').select('full_debt_amount, principal_paid_partial, interest_paid_partial').in('status', ['pendente', 'atrasada']),
  ]);
  if (e1 || e2 || e3 || e4) {
    console.error('Erro ao carregar dados de planejamento:', e1 || e2 || e3 || e4);
    root.innerHTML = `<div class="card"><p class="auth-error">Não foi possível carregar os dados de planejamento agora. Recarregue a página ou tente novamente em instantes.</p></div>`;
    return;
  }
  App.settings = settings;

  const debtsList = debts || [];

  paintPlanejamento(root, { settings, debtsList, pendingInst: pendingInst || [], pendingCycles: pendingCycles || [] });
}

function calcPlanejamento({ settings, debtsList, pendingInst, pendingCycles }) {
  const sum = (rows, field) => (rows || []).reduce((s, r) => s + Number(r[field] || 0), 0);

  const dividaBase = sum(debtsList, 'amount');
  const exitPct = Number((settings && settings.default_exit_fee_percent) || 0);
  const exitFixed = Number((settings && settings.default_exit_fee_fixed) || 0);
  const taxaSaida = dividaBase > 0 ? (dividaBase * exitPct / 100 + exitFixed) : 0;
  const dividaTotal = dividaBase + taxaSaida;

  const caixaAtual = Number((settings && settings.planning_current_cash) || 0);
  // Saldo remanescente real das parcelas (valor cheio menos pagamento
  // parcial já recebido) — sem isso, "Recebíveis em aberto" ficava inflado
  // pelo tanto que o cliente já pagou de cada parcela parcialmente quitada.
  const recebiveisInst = (pendingInst || []).reduce((s, i) => s + Number(i.amount_due || 0) - Number(i.principal_paid_partial || 0) - Number(i.interest_paid_partial || 0), 0);
  const recebiveis = recebiveisInst + (pendingCycles || []).reduce((s, c) => s + cycleRemaining(c), 0);
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
  const { settings, debtsList } = state;
  const calc = calcPlanejamento(state);

  const debtsByMonth = {};
  debtsList.forEach((d) => {
    const key = String(d.month).slice(0, 10);
    (debtsByMonth[key] = debtsByMonth[key] || []).push(d);
  });
  // Todo mês que tem lançamento, em ordem cronológica — sem recorte de janela.
  const monthsWithDebts = Object.keys(debtsByMonth).filter((k) => debtsByMonth[k].length).sort();
  const currentMonthKey = planningCurrentMonthKey();

  root.innerHTML = `
    <div class="card" style="border-color:var(--brand)">
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

    <div class="grid grid-2 mt-14">
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

    <div class="card mt-14">
      <div class="flex justify-between items-center" style="flex-wrap:wrap;gap:10px">
        <div>
          <h3>Dívidas planejadas</h3>
          <p class="text-sm text-soft mt-8">Lançamentos manuais de dívidas futuras (uma ou várias por mês, em qualquer mês). A soma vira a Dívida base do resumo acima.</p>
        </div>
        <div class="flex gap-8" style="flex-wrap:wrap">
          <button class="btn btn-outline btn-sm" id="pl-adjust-debts" title="Soma ou subtrai um valor em todos os lançamentos de uma dívida que se repete">${Icons.edit} Reajustar recorrente</button>
          <button class="btn btn-primary btn-sm" id="pl-add-debt">${Icons.plus} Nova dívida</button>
        </div>
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
                ${key < currentMonthKey ? `<span class="text-sm text-soft" title="Este mês já passou, mas o lançamento continua somando na Dívida base. Exclua-o se já foi quitado.">· mês passado</span>` : ''}
              </span>
              <span class="text-sm mono" style="font-weight:700">${formatMoney(subtotal)}</span>
            </button>
            <div class="${expanded ? '' : 'hidden'}" style="padding:0 2px 12px 30px">
              ${rows.map((d) => `
                <div class="extrato-row">
                  <div style="min-width:0;flex:1"><div class="name">${escapeHtml(d.name)}</div></div>
                  <div class="amt-wrap" style="display:flex;align-items:center;gap:10px">
                    <div class="amt">${formatMoney(d.amount)}</div>
                    <button class="icon-btn edit-debt-btn" data-id="${d.id}" title="Editar">${Icons.edit}</button>
                    <button class="icon-btn del-debt-btn" data-id="${d.id}" title="Excluir">${Icons.trash}</button>
                  </div>
                </div>
              `).join('')}
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
    const { error } = await supa.rpc('update_planning_cash', { p_value: value });
    if (error) { btn.disabled = false; showToast('Erro ao salvar: ' + error.message); return; }
    App.settings = { ...App.settings, planning_current_cash: value };
    showToast('Caixa atualizado.');
    renderGerentePlanejamento();
  };

  document.getElementById('pl-save-ltv').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const value = Number(document.getElementById('pl-ltv').value || 0);
    const { error } = await supa.rpc('update_planning_ltv', { p_value: value });
    if (error) { btn.disabled = false; showToast('Erro ao salvar: ' + error.message); return; }
    App.settings = { ...App.settings, planning_ltv_percent: value };
    showToast('LTV atualizado.');
    renderGerentePlanejamento();
  };

  document.getElementById('pl-add-debt').onclick = () => openDebtModal();
  document.getElementById('pl-adjust-debts').onclick = () => openAdjustModal(debtsList);

  root.querySelectorAll('.pl-month-header').forEach((btn) => {
    btn.onclick = () => {
      const key = btn.dataset.month;
      if (plExpandedMonths.has(key)) plExpandedMonths.delete(key); else plExpandedMonths.add(key);
      paintPlanejamento(root, state);
    };
  });

  root.querySelectorAll('.edit-debt-btn').forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); openDebtModal(debtsList.find((d) => d.id === btn.dataset.id)); };
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

function openDebtModal(existingDebt) {
  const isEdit = !!existingDebt;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h3>${isEdit ? 'Editar dívida planejada' : 'Nova dívida planejada'}</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="debt-feedback"></div>
        ${monthYearFieldsHtml('debt-month', isEdit ? String(existingDebt.month).slice(0, 10) : planningCurrentMonthKey())}
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
  // UX-02 (auditoria 2026-08-23): prende o foco dentro do modal, fecha com
  // Escape e devolve o foco a quem abriu. Antes, com o modal aberto, o Tab
  // passeava pela página ATRÁS dele e o Escape não fazia nada.
  wireModal(overlay, close);
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;
  document.getElementById('confirm-debt').onclick = async (e) => {
    const btn = e.currentTarget;
    const name = document.getElementById('debt-name').value.trim();
    const amount = getMoneyValue(amountInput);
    const month = readMonthYear(overlay, 'debt-month');
    const feedback = document.getElementById('debt-feedback');
    if (!month) { feedback.innerHTML = `<div class="auth-error">Informe um ano válido (entre ${PL_YEAR_MIN} e ${PL_YEAR_MAX}).</div>`; return; }
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

/* ----------------------------------------------------------------------------
   Reajuste em lote de uma dívida que se repete (migration_053)

   "Salário" lançado em vários meses, cada um com valor próprio: um aumento de
   R$ 12 soma R$ 12 em CADA lançamento (3.000 -> 3.012, 3.100 -> 3.112...), sem
   igualar os valores. A tela mostra a prévia mês a mês e manda ao banco os IDs
   exatos que a pessoa viu — ver o comentário da migration para o porquê.
---------------------------------------------------------------------------- */

// Mesma ideia de "mesma dívida" do olho humano: ignora caixa e espaço sobrando
// ("Salário", "salário ", "SALÁRIO" são a mesma). Acento continua diferenciando:
// "Salario" e "Salário" aparecem como duas dívidas na lista, e a pessoa decide.
function planningNormName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Agrupa por nome e devolve só quem se repete (2+ lançamentos): reajustar um
// lançamento único é o "Editar" de sempre.
function planningRecurringGroups(debtsList) {
  const map = new Map();
  debtsList.forEach((d) => {
    const key = planningNormName(d.name);
    if (!key) return;
    if (!map.has(key)) map.set(key, { key, label: String(d.name).trim(), rows: [] });
    map.get(key).rows.push(d);
  });
  return [...map.values()]
    .filter((g) => g.rows.length >= 2)
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

// Valor novo, em centavos inteiros, espelhando o arredondamento do banco:
//   add     -> amount + valor
//   percent -> round(amount * (100 + valor) / 100, 2)
// `signed` já vem com o sinal (reduzir = negativo). Pode divergir 1 centavo do
// banco só em meio-centavo exato com percentuais quebrados; o que vale é o
// gravado, e a tela relê tudo depois de salvar.
function planningAdjustedAmount(amount, mode, signed) {
  const cents = Math.round(Number(amount) * 100);
  if (mode === 'add') return (cents + Math.round(signed * 100)) / 100;
  return Math.round(cents * (100 + signed) / 100) / 100;
}

function openAdjustModal(debtsList) {
  const groups = planningRecurringGroups(debtsList);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  if (!groups.length) {
    overlay.innerHTML = `
      <div class="modal" style="max-width:460px">
        <div class="modal-head"><h3>Reajustar dívida recorrente</h3><button class="icon-btn" id="adj-close" aria-label="Fechar">${Icons.x}</button></div>
        <div class="modal-body">
          <p class="text-sm">Nenhuma dívida se repete ainda.</p>
          <p class="text-sm text-soft mt-8">Uma dívida recorrente é a mesma dívida (mesmo nome) lançada em mais de um mês — por exemplo, "Salário" em outubro, novembro e dezembro. Assim que houver uma, ela aparece aqui para você somar ou subtrair um valor em todos os meses de uma vez.</p>
        </div>
        <div class="modal-foot"><button class="btn btn-primary" id="adj-cancel">Entendi</button></div>
      </div>`;
    document.getElementById('app').appendChild(overlay);
    const closeEmpty = () => overlay.remove();
    wireModal(overlay, closeEmpty);
    overlay.querySelector('#adj-close').onclick = closeEmpty;
    overlay.querySelector('#adj-cancel').onclick = closeEmpty;
    return;
  }

  const faixa = (g) => {
    const vals = g.rows.map((d) => Number(d.amount));
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return lo === hi ? formatMoney(lo) : `${formatMoney(lo)} a ${formatMoney(hi)}`;
  };

  overlay.innerHTML = `
    <div class="modal" style="max-width:540px">
      <div class="modal-head"><h3>Reajustar dívida recorrente</h3><button class="icon-btn" id="adj-close" aria-label="Fechar">${Icons.x}</button></div>
      <div class="modal-body">
        <p class="text-sm text-soft">Soma ou subtrai a mesma diferença em todos os lançamentos de uma dívida que se repete. Cada mês mantém o seu valor próprio — só muda a diferença.</p>
        <div id="adj-feedback"></div>

        <div class="field mt-14">
          <label for="adj-name">Dívida</label>
          <select id="adj-name">
            ${groups.map((g) => `<option value="${escapeHtml(g.key)}">${escapeHtml(g.label)} — ${g.rows.length} lançamentos (${faixa(g)})</option>`).join('')}
          </select>
        </div>

        <div class="field-row">
          <div class="field">
            <label for="adj-dir">Ajuste</label>
            <select id="adj-dir"><option value="up">Aumentar</option><option value="down">Diminuir</option></select>
          </div>
          <div class="field">
            <label for="adj-mode">Em</label>
            <select id="adj-mode"><option value="add">Valor fixo (R$)</option><option value="percent">Percentual (%)</option></select>
          </div>
        </div>

        <div class="field" id="adj-amount-wrap"><label for="adj-amount">Valor por lançamento (R$)</label><input type="text" id="adj-amount" placeholder="0,00"></div>
        <div class="field hidden" id="adj-percent-wrap"><label for="adj-percent">Percentual (%)</label><input type="number" id="adj-percent" min="0" step="0.01" inputmode="decimal" placeholder="0"></div>

        ${monthYearFieldsHtml('adj-from', planningCurrentMonthKey(), { month: 'A partir do mês', year: 'Ano' })}

        <div class="form-section-title">Prévia</div>
        <div id="adj-preview" aria-live="polite"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="adj-cancel">Cancelar</button>
        <button class="btn btn-primary" id="adj-confirm" disabled>Aplicar reajuste</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);

  const $ = (id) => overlay.querySelector('#' + id);
  const amountInput = $('adj-amount');
  attachMoneyMask(amountInput);
  const close = () => overlay.remove();
  wireModal(overlay, close);
  $('adj-close').onclick = close;
  $('adj-cancel').onclick = close;

  // Meses que a pessoa DESMARCOU na prévia (por id do lançamento). Guardar o que
  // foi desmarcado — e não o que está marcado — faz todo mês novo que entra na
  // lista (ao mudar "a partir de") nascer marcado, que é o comportamento
  // esperado. Trocar a dívida zera tudo.
  const unchecked = new Set();

  // Lê o formulário inteiro e devolve o estado derivado. Tudo que a prévia e o
  // botão precisam sai daqui, para os dois nunca discordarem.
  const read = () => {
    const group = groups.find((g) => g.key === $('adj-name').value);
    const mode = $('adj-mode').value;
    const dir = $('adj-dir').value;
    const raw = mode === 'add' ? getMoneyValue(amountInput) : Number($('adj-percent').value || 0);
    const magnitude = Number.isFinite(raw) ? Math.abs(raw) : 0;
    const signed = dir === 'down' ? -magnitude : magnitude;
    const from = readMonthYear(overlay, 'adj-from');
    const all = group ? group.rows : [];
    const affected = from ? all.filter((d) => String(d.month).slice(0, 10) >= from).sort((a, b) => String(a.month).localeCompare(String(b.month))) : [];
    // `rows` = tudo que a prévia lista; `sel` = só o que está marcado e SERÁ
    // alterado. Resumo, validação e envio ao banco usam `sel`, nunca `rows`.
    const rows = affected.map((d) => ({ d, novo: planningAdjustedAmount(d.amount, mode, signed), on: !unchecked.has(d.id) }));
    const sel = rows.filter((r) => r.on);
    return { group, mode, dir, signed, magnitude, from, rows, sel, skipped: all.length - affected.length };
  };

  const previewTable = (st) => `
    <div style="max-height:210px;overflow:auto;margin-top:8px;border:1px solid var(--line);border-radius:10px">
      ${st.rows.map((r) => {
        const diff = r.novo - Number(r.d.amount);
        const mes = planningMonthLabel(String(r.d.month).slice(0, 10));
        // Linha desmarcada: fica na lista (a pessoa pode remarcar), mas apagada
        // e sem a seta — nada vai mudar nela.
        return `<label class="flex justify-between items-center text-sm" style="padding:7px 12px;border-bottom:1px solid var(--line);gap:10px;cursor:pointer;${r.on ? '' : 'opacity:.5'}">
          <input type="checkbox" class="adj-row-check" data-id="${r.d.id}" ${r.on ? 'checked' : ''} aria-label="Aplicar em ${mes}" style="flex:none;width:auto;margin:0">
          <span style="min-width:70px;flex:none">${mes}</span>
          <span class="mono text-soft">${formatMoney(r.d.amount)}</span>
          ${r.on ? `<span aria-hidden="true" class="text-soft">→</span>
          <span class="mono" style="font-weight:700;${r.novo <= 0 ? 'color:var(--bad)' : ''}">${formatMoney(r.novo)}</span>
          <span class="mono text-sm" style="min-width:74px;text-align:right;color:${diff >= 0 ? 'var(--good)' : 'var(--bad)'}">${diff >= 0 ? '+' : '−'}${formatMoney(Math.abs(diff))}</span>` : `<span class="text-soft" style="margin-left:auto">não será alterado</span>`}
        </label>`;
      }).join('')}
    </div>`;

  const paintPreview = () => {
    const st = read();
    const box = $('adj-preview');
    const btn = $('adj-confirm');
    const bad = st.sel.some((r) => r.novo <= 0);
    let problem = '';
    if (!st.from) problem = `Informe um ano válido (entre ${PL_YEAR_MIN} e ${PL_YEAR_MAX}).`;
    else if (!st.magnitude) problem = 'Informe o valor do reajuste para ver a prévia.';
    else if (!st.rows.length) problem = 'Nenhum lançamento desta dívida a partir deste mês.';
    else if (!st.sel.length) problem = 'Nenhum mês marcado. Marque ao menos um mês para aplicar o reajuste.';
    else if (bad) problem = 'Este reajuste deixaria algum mês marcado com valor zero ou negativo. Reduza o valor do ajuste ou desmarque esse mês.';

    // Barra de seleção: só faz sentido quando há meses listados.
    const toolbar = st.rows.length > 1 ? `
      <div class="flex justify-between items-center text-sm" style="margin-top:8px">
        <span class="text-soft">${st.sel.length} de ${st.rows.length} meses marcados</span>
        <span class="flex gap-8"><button type="button" class="btn btn-ghost btn-sm" data-adj-all="1">Marcar todos</button><button type="button" class="btn btn-ghost btn-sm" data-adj-all="0">Desmarcar todos</button></span>
      </div>` : '';
    // A tabela aparece sempre que há o que escolher — inclusive no erro, para
    // a pessoa ver QUAL mês estourou ou remarcar depois de desmarcar tudo.
    const showTable = st.from && st.magnitude && st.rows.length;

    if (problem) {
      box.innerHTML = `<p class="text-sm ${bad ? '' : 'text-soft'}" ${bad ? 'style="color:var(--bad)"' : ''}>${escapeHtml(problem)}</p>${showTable ? toolbar + previewTable(st) : ''}`;
      btn.disabled = true;
      return;
    }
    const n = st.sel.length;
    const delta = st.sel.reduce((s, r) => s + (r.novo - Number(r.d.amount)), 0);
    const fora = st.rows.length - n;
    box.innerHTML = `
      <p class="text-sm">${n} lançamento${n === 1 ? '' : 's'} de <strong>${escapeHtml(st.group.label)}</strong> ${n === 1 ? 'será alterado' : 'serão alterados'}
        · diferença total <strong class="mono" style="color:${delta >= 0 ? 'var(--good)' : 'var(--bad)'}">${delta >= 0 ? '+' : '−'}${formatMoney(Math.abs(delta))}</strong>
        ${fora ? `<span class="text-soft">· ${fora} desmarcado${fora === 1 ? '' : 's'}</span>` : ''}
        ${st.skipped ? `<span class="text-soft">· ${st.skipped} anterior${st.skipped === 1 ? '' : 'es'} a este mês não ${st.skipped === 1 ? 'muda' : 'mudam'}</span>` : ''}</p>
      ${toolbar}${previewTable(st)}`;
    btn.disabled = false;
  };

  // Delegação: a prévia é recriada a cada repintura, então os checkboxes não
  // guardam listener próprio.
  $('adj-preview').addEventListener('change', (e) => {
    const cb = e.target.closest && e.target.closest('.adj-row-check');
    if (!cb) return;
    if (cb.checked) unchecked.delete(cb.dataset.id); else unchecked.add(cb.dataset.id);
    paintPreview();
  });
  $('adj-preview').addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-adj-all]');
    if (!b) return;
    const st = read();
    st.rows.forEach((r) => { if (b.dataset.adjAll === '1') unchecked.delete(r.d.id); else unchecked.add(r.d.id); });
    paintPreview();
  });

  // Troca entre valor fixo e percentual: mostra só o campo que vale.
  const syncMode = () => {
    const percent = $('adj-mode').value === 'percent';
    $('adj-amount-wrap').classList.toggle('hidden', percent);
    $('adj-percent-wrap').classList.toggle('hidden', !percent);
    paintPreview();
  };
  $('adj-mode').addEventListener('change', syncMode);
  $('adj-name').addEventListener('change', () => { unchecked.clear(); paintPreview(); });
  ['adj-dir', 'adj-from-m'].forEach((id) => $(id).addEventListener('change', paintPreview));
  ['adj-amount', 'adj-percent', 'adj-from-y'].forEach((id) => $(id).addEventListener('input', paintPreview));
  paintPreview();

  $('adj-confirm').onclick = async (e) => {
    const btn = e.currentTarget;
    const st = read();
    const feedback = $('adj-feedback');
    feedback.innerHTML = '';
    if (!st.sel.length || !st.magnitude || st.sel.some((r) => r.novo <= 0)) { paintPreview(); return; }
    btn.disabled = true;
    const { error } = await supa.rpc('adjust_planning_debts', {
      p_ids: st.sel.map((r) => r.d.id),
      p_mode: st.mode,
      p_value: st.signed,
    });
    if (error) {
      const raw = error.message || String(error);
      const msg = isMissingRpcError(error)
        ? 'Falta aplicar a migration_053 no banco (supabase/migration_053.sql). O código novo já está no ar, o banco ainda não — rode o arquivo no SQL Editor do Supabase e tente de novo.'
        : raw.includes('AMOUNT_BELOW_ZERO') ? 'Este reajuste deixaria algum lançamento com valor zero ou negativo.'
        : raw.includes('NOT_FOUND') ? 'Algum lançamento mudou ou foi excluído desde que você abriu esta tela. Nada foi alterado — feche, recarregue e tente de novo.'
        : raw.includes('FORBIDDEN') ? 'Você não tem permissão para alterar o planejamento.'
        : raw;
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(msg)}</div>`;
      btn.disabled = false;
      return;
    }
    const n = st.sel.length;
    const desc = st.mode === 'add'
      ? `${st.signed >= 0 ? '+' : '−'}${formatMoney(Math.abs(st.signed))} em cada lançamento`
      : `${st.signed >= 0 ? '+' : '−'}${formatNumber(Math.abs(st.signed), 2)}% em cada lançamento`;
    logAudit('planejamento_reajuste', `Dívida planejada "${st.group.label}" reajustada: ${desc} (${n} lançamento${n === 1 ? '' : 's'}, a partir de ${planningMonthLabel(st.from)})`, { nome: st.group.label, lancamentos: n, modo: st.mode, valor: st.signed, a_partir_de: st.from });
    close();
    showToast(`${n} lançamento${n === 1 ? '' : 's'} de "${st.group.label}" reajustado${n === 1 ? '' : 's'}.`);
    renderGerentePlanejamento();
  };
}

registerRoute('gerente/planejamento', { role: 'gerente', primaryOnly: true, platformOwnerOnly: true, screenId: 'gerente-planejamento', title: 'Planejamento', render: renderGerentePlanejamento });
