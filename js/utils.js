/* ============================================================================
   Funções utilitárias puras (sem dependência de estado)
   ============================================================================ */

const INCOME_BRACKETS = [
  'Até R$ 1.621',
  'De R$ 1.622 até R$ 3.000',
  'De R$ 3.001 até R$ 5.000',
  'Acima de R$ 5.000',
];

function incomeBracketOptionsHtml(selected, includeBlank) {
  const blank = includeBlank ? `<option value="" ${!selected ? 'selected' : ''}>Não informado</option>` : '';
  return blank + INCOME_BRACKETS.map((b) => `<option value="${b}" ${selected === b ? 'selected' : ''}>${b}</option>`).join('');
}

const CLIENT_GROUPS = [
  'Carteira Assinada',
  'Servidor Público',
  'Autônomo',
  'Estudante',
  'Desempregado',
];

function clientGroupOptionsHtml(selected, includeBlank) {
  const blank = includeBlank ? `<option value="" ${!selected ? 'selected' : ''}>Não informado</option>` : '';
  return blank + CLIENT_GROUPS.map((g) => `<option value="${g}" ${selected === g ? 'selected' : ''}>${g}</option>`).join('');
}

// O cron que marca status='atrasada' roda 1x/dia — uma parcela vencida há
// poucas horas ainda pode estar 'pendente' no banco. Isso calcula o status
// "de verdade" no momento, sem esperar o próximo ciclo do cron.
function effectiveInstallmentStatus(status, dueDate) {
  if (status === 'pendente' && dueDate < todayISO()) return 'atrasada';
  return status;
}

function formatMoney(value) {
  const n = Number(value || 0);
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatNumber(value, decimals = 0) {
  return Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatDate(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value + (String(value).length === 10 ? 'T00:00:00' : ''));
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR');
}

function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR') + ' às ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// payments.received_at é timestamptz, mas sempre guarda só uma DATA (meia-
// noite UTC — nenhuma RPC de recebimento grava hora real). Formatar com o
// fuso local (como formatDateTime faz) desloca pro dia anterior em qualquer
// fuso negativo (ex: 00:00 UTC vira 20:00 do dia anterior em UTC-4). Usar
// timeZone:'UTC' recupera a data exatamente como foi selecionada.
function formatDateUTC(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function addDaysISO(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(isoA, isoB) {
  const a = new Date(isoA + 'T00:00:00');
  const b = new Date(isoB + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

// Sugestão de próximo vencimento ao renovar — mesma regra de passo usada em
// renew_installment() no banco (mensal/quinzenal/semanal/personalizado). É só
// o valor inicial do campo (editável pelo gerente antes de confirmar), não
// precisa ser byte-a-byte idêntico ao cálculo de data do Postgres.
function addStepISO(iso, dueType, customDays) {
  const d = new Date(iso + 'T00:00:00');
  if (dueType === 'mensal') d.setMonth(d.getMonth() + 1);
  else if (dueType === 'quinzenal') d.setDate(d.getDate() + 15);
  else if (dueType === 'semanal') d.setDate(d.getDate() + 7);
  else d.setDate(d.getDate() + Math.max(1, Number(customDays) || 30));
  return d.toISOString().slice(0, 10);
}

// Estimativa de encargo de atraso (juros compostos diários sobre o saldo +
// multa fixa) — mesma fórmula já usada no modal de recebimento
// (gerente-contrato-receber.js) e na cobrança via WhatsApp (gerente-cobrar.js).
// É só uma SUGESTÃO exibida ao cliente/gerente antes do vencimento ser
// resolvido; o valor final cobrado continua sendo o que o gerente ajustar na
// hora de receber de verdade.
function estimateLateCharge(baseAmount, dueDateISO, lateInterestPercent, lateFeePercent) {
  const diasAtraso = dueDateISO < todayISO() ? daysBetween(dueDateISO, todayISO()) : 0;
  const jurosAtraso = diasAtraso > 0 ? Math.round(baseAmount * (Math.pow(1 + lateInterestPercent / 100, diasAtraso) - 1) * 100) / 100 : 0;
  const multaAtraso = diasAtraso > 0 ? Math.round(baseAmount * (lateFeePercent / 100) * 100) / 100 : 0;
  return { diasAtraso, jurosAtraso, multaAtraso, total: baseAmount + jurosAtraso + multaAtraso };
}

function debounce(fn, wait) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusBadge(kind, label) {
  const map = {
    pendente: 'badge-warn', em_aberto: 'badge-brand', atrasado: 'badge-bad', atrasada: 'badge-bad',
    quitado: 'badge-good', paga: 'badge-good', perda: 'badge-bad', aprovada: 'badge-good',
    reprovada: 'badge-bad', renovada: 'badge-accent', cancelada: 'badge-neutral',
  };
  const cls = map[kind] || 'badge-neutral';
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function scoreTierBadge(tier) {
  const map = { 'Ouro': 'badge-warn', 'Bom': 'badge-good', 'Atenção': 'badge-warn', 'Alto risco': 'badge-bad' };
  return `<span class="badge ${map[tier] || 'badge-neutral'}">${escapeHtml(tier)}</span>`;
}

// Avatar de iniciais (sem upload de foto) — cor determinística por nome, pra
// não repetir a mesma cor em toda linha de uma lista longa. Paleta restrita
// aos tokens de gráfico já usados no resto do sistema (--chart-*), não uma
// paleta nova.
const AVATAR_PALETTE = ['var(--chart-brand)', 'var(--chart-accent)', 'var(--chart-good)', 'var(--chart-warn)', 'var(--chart-purple)', 'var(--chart-bad)'];

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarColorFor(name) {
  const s = String(name || '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function avatarHtml(name, size) {
  const s = size || 34;
  return `<span class="avatar-circle" style="width:${s}px;height:${s}px;font-size:${Math.round(s * 0.4)}px;background:${avatarColorFor(name)}" title="${escapeHtml(name || '')}">${escapeHtml(initialsOf(name))}</span>`;
}

// HTML de um campo de senha com botão de mostrar/ocultar ("olhinho").
// Uso: `<div class="field"><label>Senha</label>${passwordFieldHtml('f-password')}</div>`
// e chamar wirePasswordToggles() depois de inserir o HTML no DOM.
function passwordFieldHtml(id, extraAttrs = '') {
  return `<div class="password-wrap">
    <input type="password" id="${id}" ${extraAttrs}>
    <button type="button" class="password-toggle-btn" data-target="${id}" tabindex="-1">${Icons.eye}</button>
  </div>`;
}

function wirePasswordToggles(root) {
  (root || document).querySelectorAll('.password-toggle-btn').forEach((btn) => {
    btn.onclick = () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
    };
  });
}

function formatPhoneBR(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 2) return digits.length ? `(${digits}` : '';
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

function attachPhoneMask(input) {
  if (!input) return;
  input.setAttribute('inputmode', 'numeric');
  input.addEventListener('input', () => { input.value = formatPhoneBR(input.value); });
}

// Máscara de valor em reais (aplica separador de milhar "." e decimal ","
// automaticamente enquanto a pessoa digita, como um campo de caixa registradora).
function attachMoneyMask(input) {
  if (!input) return;
  input.setAttribute('inputmode', 'decimal');
  input.addEventListener('input', () => {
    let digits = input.value.replace(/\D/g, '');
    if (!digits) { input.value = ''; return; }
    digits = digits.replace(/^0+(?=\d)/, '');
    while (digits.length < 3) digits = '0' + digits;
    const cents = digits.slice(-2);
    const intPart = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    input.value = intPart + ',' + cents;
  });
}

function getMoneyValue(input) {
  if (!input || !input.value) return 0;
  const raw = input.value.replace(/\./g, '').replace(',', '.');
  return Number(raw) || 0;
}

function setMoneyValue(input, num) {
  if (!input) return;
  const n = Number(num || 0);
  const [intPart, centsPart] = n.toFixed(2).split('.');
  const withDots = intPart.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  input.value = (n < 0 ? '-' : '') + withDots + ',' + centsPart;
}

function formatCpf(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 11);
  return digits
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

function dueTypeLabel(t, customDays) {
  if (t === 'personalizado') return `Personalizado${customDays ? ' (' + customDays + 'd)' : ''}`;
  return { mensal: 'Mensal', quinzenal: 'Quinzenal', semanal: 'Semanal' }[t] || t;
}

// Toast com opção de "Desfazer" (padrão de design da skill) -----------------
let undoTimer = null;
function showToast(message, opts = {}) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  clearTimeout(undoTimer);
  const undoBtn = opts.onUndo ? `<button id="toast-undo-btn">Desfazer</button>` : '';
  root.innerHTML = `<div class="toast"><span>${escapeHtml(message)}</span>${undoBtn}</div>`;
  if (opts.onUndo) {
    document.getElementById('toast-undo-btn').onclick = () => {
      clearTimeout(undoTimer);
      root.innerHTML = '';
      opts.onUndo();
    };
  }
  undoTimer = setTimeout(() => { root.innerHTML = ''; }, opts.duration || 4500);
}

function valueByExtenso(value) {
  // Conversão simples de número para texto (usado na nota promissória em PDF)
  const unidades = ['zero','um','dois','três','quatro','cinco','seis','sete','oito','nove','dez',
    'onze','doze','treze','quatorze','quinze','dezesseis','dezessete','dezoito','dezenove'];
  const dezenas = ['','','vinte','trinta','quarenta','cinquenta','sessenta','setenta','oitenta','noventa'];
  const centenas = ['','cem','duzentos','trezentos','quatrocentos','quinhentos','seiscentos','setecentos','oitocentos','novecentos'];

  function ate999(n) {
    if (n === 0) return '';
    if (n < 20) return unidades[n];
    if (n < 100) {
      const d = Math.floor(n / 10), u = n % 10;
      return dezenas[d] + (u ? ' e ' + unidades[u] : '');
    }
    if (n === 100) return 'cem';
    const c = Math.floor(n / 100), r = n % 100;
    return centenas[c] + (r ? ' e ' + ate999(r) : '');
  }

  function inteiroPorExtenso(n) {
    if (n === 0) return 'zero';
    const milhoes = Math.floor(n / 1000000);
    const milhares = Math.floor((n % 1000000) / 1000);
    const resto = n % 1000;
    const partes = [];
    if (milhoes) partes.push(ate999(milhoes) + (milhoes > 1 ? ' milhões' : ' milhão'));
    if (milhares) partes.push((milhares === 1 ? 'mil' : ate999(milhares) + ' mil'));
    if (resto) partes.push(ate999(resto));
    return partes.join(' e ');
  }

  const inteiro = Math.floor(Math.abs(value));
  const centavos = Math.round((Math.abs(value) - inteiro) * 100);
  let texto = inteiroPorExtenso(inteiro) + (inteiro === 1 ? ' real' : ' reais');
  if (centavos > 0) texto += ' e ' + inteiroPorExtenso(centavos) + (centavos === 1 ? ' centavo' : ' centavos');
  return texto;
}
