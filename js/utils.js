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
  return toLocalISO(new Date());
}

// Serializa um Date lendo o calendário LOCAL, nunca via toISOString() (que
// converte pra UTC). OPS-09: a versão anterior montava a data em horário local
// e depois chamava toISOString() — no Brasil (UTC-3) isso funciona por acaso,
// porque a meia-noite local vira 03:00 UTC do MESMO dia; em qualquer fuso a
// leste de Greenwich a meia-noite local vira 22:00/23:00 UTC do dia ANTERIOR e
// toda data calculada saía um dia atrás. Um administrador acessando de fora do
// país via vencimentos errados.
function toLocalISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function addDaysISO(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return toLocalISO(d);
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
  return toLocalISO(d);
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
    // UX-08 (auditoria 2026-08-23), corrigido de novo em seguida (regressão
    // real reportada pelo usuário, 2026-08-24): a primeira versão desta
    // função ancorava a posição do cursor pela quantidade de DÍGITOS ANTES
    // DELE. Isso quebrava a digitação normal — a mais comum de todas: com o
    // campo vazio, digitar "1" a máscara mostra "0,01" (o zero é só
    // preenchimento decorativo, nunca foi digitado). Ao digitar o segundo
    // dígito, a lógica antiga contava aquele zero decorativo como se fosse um
    // dígito real já digitado, calculava a posição errada, e o dígito novo
    // entrava ANTES da vírgula em vez de depois — reformatando o número
    // inteiro errado (ex: tentar digitar "12" produzia "2,01" em vez de
    // "0,12"). Reproduzido e confirmado em js/utils.js:attachMoneyMask por
    // simulação determinística antes desta correção.
    //
    // A correção: ancorar pela quantidade de dígitos DEPOIS do cursor, não
    // antes. Os zeros de preenchimento SEMPRE nascem no início da string,
    // nunca no fim — então contar "quantos dígitos restam depois de onde
    // estou" ignora esse zero decorativo automaticamente, tanto na digitação
    // normal (0 dígitos depois do cursor = cursor no fim, comportamento de
    // caixa registradora) quanto ao editar no meio de um valor já digitado
    // (preserva quantos dígitos ficam à direita do cursor, que é o motivo
    // original do UX-08).
    const selStart = input.selectionStart;
    const digitsAfterCaret = selStart == null
      ? 0
      : input.value.slice(selStart).replace(/\D/g, '').length;

    let digits = input.value.replace(/\D/g, '');
    if (!digits) { input.value = ''; return; }
    digits = digits.replace(/^0+(?=\d)/, '');
    while (digits.length < 3) digits = '0' + digits;
    const cents = digits.slice(-2);
    const intPart = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const formatted = intPart + ',' + cents;
    input.value = formatted;

    if (selStart == null || document.activeElement !== input) return;

    // Posição = logo antes do dígito a partir do qual restam exatamente
    // `digitsAfterCaret` dígitos até o fim. Se não sobrar nenhum dígito
    // depois do cursor (o caso normal de digitação sequencial), o cursor vai
    // pro fim do campo.
    const digitIdx = [];
    for (let i = 0; i < formatted.length; i++) {
      if (/\d/.test(formatted[i])) digitIdx.push(i);
    }
    const keepAfter = Math.min(digitsAfterCaret, digitIdx.length);
    const pos = keepAfter === 0 ? formatted.length : digitIdx[digitIdx.length - keepAfter];
    input.setSelectionRange(pos, pos);
  });
}

// ---------------------------------------------------------------------------
// CPF — validação de dígito verificador (SEC-13)
// ---------------------------------------------------------------------------
// Antes o sistema só conferia o COMPRIMENTO (11 dígitos) no cadastro público,
// no cadastro pelo administrador e na conclusão de cadastro via Google. Então
// "000.000.000-00" era aceito como CPF válido. Para um sistema que usa CPF
// como identificador de login (email_for_cpf) e âncora de identidade em nota
// promissória, isso é uma lacuna relevante.
function isValidCpf(value) {
  const cpf = String(value || '').replace(/\D/g, '');
  if (cpf.length !== 11) return false;
  // Sequências repetidas (111.111.111-11 etc.) passam no cálculo dos dígitos
  // mas nunca são CPFs reais — a Receita não emite nenhum deles.
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const digito = (base, pesoInicial) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i);
    const resto = (soma * 10) % 11;
    return resto === 10 || resto === 11 ? 0 : resto;
  };

  if (digito(cpf.slice(0, 9), 10) !== Number(cpf[9])) return false;
  if (digito(cpf.slice(0, 10), 11) !== Number(cpf[10])) return false;
  return true;
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
// UX-07 (auditoria 2026-08-23): a versão anterior fazia root.innerHTML = ...,
// sobrescrevendo o container inteiro. Uma segunda ação apagava o aviso
// anterior — inclusive um "Desfazer" que ainda estava disponível e que a
// pessoa talvez estivesse indo clicar. Agora cada aviso é um nó próprio, com
// o próprio temporizador, e eles se empilham.
function showToast(message, opts = {}) {
  const root = document.getElementById('toast-root');
  if (!root) return;

  const el = document.createElement('div');
  el.className = 'toast';
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);

  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.add('leaving');
    // Espera a transição de saída; se o motion estiver reduzido, o CSS zera a
    // duração e isso vira praticamente imediato.
    setTimeout(() => el.remove(), 200);
  };

  if (opts.onUndo) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Desfazer';
    btn.onclick = () => { clearTimeout(timer); dismiss(); opts.onUndo(); };
    el.appendChild(btn);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Fechar aviso');
  close.textContent = '×';
  close.onclick = () => { clearTimeout(timer); dismiss(); };
  el.appendChild(close);

  // Mais de 3 avisos ao mesmo tempo viram ruído — o mais antigo sai.
  while (root.children.length >= 3) root.firstElementChild.remove();
  root.appendChild(el);

  const timer = setTimeout(dismiss, opts.duration || 4500);
}

// ---------------------------------------------------------------------------
// Acessibilidade de modal (UX-01, UX-02)
// ---------------------------------------------------------------------------
// Todo modal do sistema é montado como `<div class="modal-overlay">` com
// innerHTML e anexado ao DOM. Nenhum deles tinha role/aria-modal, prisão de
// foco ou Escape: com o modal aberto o Tab passeava pela página ATRÁS dele, o
// Escape não fechava, e ao fechar o foco não voltava pra onde estava. Havia 3
// referências a `keydown` no projeto inteiro.
//
// Chame depois de anexar o overlay:
//   const release = wireModal(overlay, close);
// e chame release() dentro do seu close() (ou deixe o próprio wireModal cuidar,
// já que ele remove os ouvintes quando o overlay sai do DOM).
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function wireModal(overlay, onClose, opts = {}) {
  if (!overlay) return () => {};
  const previouslyFocused = document.activeElement;

  const dialog = overlay.querySelector('.modal') || overlay;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const heading = dialog.querySelector('h1, h2, h3');
  if (heading) {
    if (!heading.id) heading.id = 'modal-title-' + Math.random().toString(36).slice(2, 9);
    dialog.setAttribute('aria-labelledby', heading.id);
  } else if (opts.label) {
    dialog.setAttribute('aria-label', opts.label);
  }

  const focusables = () => Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter((el) => el.offsetParent !== null || el === document.activeElement);

  // Foco inicial: o primeiro campo de verdade, não o "X" de fechar — quem abre
  // um modal de recebimento quer digitar o valor, não fechar.
  const first = dialog.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])')
    || focusables().find((el) => !el.classList.contains('icon-btn'))
    || focusables()[0];
  if (first) setTimeout(() => first.focus(), 0);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (typeof onClose === 'function') onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) return;
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };

  overlay.addEventListener('keydown', onKeyDown);

  // Enquanto o modal existe, o resto da página não é lido por leitor de tela.
  const shell = document.querySelector('.app-shell');
  if (shell) shell.setAttribute('aria-hidden', 'true');

  const release = () => {
    overlay.removeEventListener('keydown', onKeyDown);
    if (shell && !document.querySelector('.modal-overlay')) shell.removeAttribute('aria-hidden');
    if (previouslyFocused && typeof previouslyFocused.focus === 'function' && document.body.contains(previouslyFocused)) {
      previouslyFocused.focus();
    }
  };

  // Rede de segurança: se o overlay for removido por outro caminho (ex:
  // overlay.remove() direto), o release acontece do mesmo jeito.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(overlay)) {
      observer.disconnect();
      release();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return () => { observer.disconnect(); release(); };
}

// ---------------------------------------------------------------------------
// Senha (SEC-14)
// ---------------------------------------------------------------------------
// O mínimo era 6 caracteres, sem medidor, sem confirmação e sem verificação
// contra vazamentos — nem no cadastro, nem na redefinição (onde um erro de
// digitação tranca a conta, já que o campo era único).
const PASSWORD_MIN_LENGTH = 8;

// Senhas óbvias que aparecem no topo de qualquer lista de vazamento. Não
// substitui uma checagem real contra base de senhas comprometidas (isso é uma
// configuração do painel do Supabase — ver observação no fim da auditoria),
// mas barra o caso mais comum sem depender de rede.
const COMMON_PASSWORDS = [
  '12345678', '123456789', '1234567890', 'senha123', 'password', 'password1',
  'qwerty123', 'abc12345', '11111111', '00000000', 'iloveyou', 'admin123',
  'siges123', 'brasil123', '123mudar', 'mudar123',
];

function passwordProblem(pwd) {
  const p = String(pwd || '');
  if (p.length < PASSWORD_MIN_LENGTH) return `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  if (!/[a-zA-Z]/.test(p) || !/\d/.test(p)) return 'A senha precisa misturar letras e números.';
  if (COMMON_PASSWORDS.includes(p.toLowerCase())) return 'Essa senha é fácil demais de adivinhar. Escolha outra.';
  if (/^(.)\1+$/.test(p)) return 'Essa senha é fácil demais de adivinhar. Escolha outra.';
  return null;
}

// 0 a 3 — alimenta a barrinha de força abaixo do campo.
function passwordStrength(pwd) {
  const p = String(pwd || '');
  if (p.length < PASSWORD_MIN_LENGTH) return 0;
  let score = 1;
  if (p.length >= 12) score++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p)) score++;
  if (/[^a-zA-Z0-9]/.test(p)) score = Math.min(3, score + 1);
  return Math.min(3, score);
}

const STRENGTH_LABELS = ['Muito fraca', 'Fraca', 'Boa', 'Forte'];

// Liga o medidor a um campo de senha. `meterId` é o id de um <div> vazio
// colocado logo abaixo do campo.
function wirePasswordStrength(inputId, meterId) {
  const input = document.getElementById(inputId);
  const meter = document.getElementById(meterId);
  if (!input || !meter) return;
  const paint = () => {
    const v = input.value;
    if (!v) { meter.innerHTML = ''; return; }
    const s = passwordStrength(v);
    meter.innerHTML = `
      <div class="pw-meter" aria-hidden="true">
        ${[0, 1, 2].map((i) => `<span class="${i < s ? 'on s' + s : ''}"></span>`).join('')}
      </div>
      <span class="pw-meter-label s${s}">${STRENGTH_LABELS[s]}</span>`;
  };
  input.addEventListener('input', paint);
  paint();
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
    // FIN-02 (auditoria 2026-08-23): em português "cem" só existe sozinho —
    // com qualquer resto vira "cento". A versão anterior usava centenas[1]
    // ('cem') nos dois casos, então R$ 150,00 saía como "cem e cinquenta
    // reais" e R$ 199,00 como "cem e noventa e nove reais". Isso ia impresso
    // na NOTA PROMISSÓRIA (pdf-gerador.js), e pela Lei Uniforme de Genebra
    // (art. 6º, Decreto 57.663/66) o valor POR EXTENSO prevalece sobre o
    // numérico quando os dois divergem — ou seja, era um argumento pronto
    // para o devedor contestar o título. Atinge toda faixa 100–199,
    // 1.100–1.199, 2.100–2.199 e assim por diante.
    const centena = c === 1 ? 'cento' : centenas[c];
    return centena + (r ? ' e ' + ate999(r) : '');
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
    // Convenção do português: as classes (milhão / mil / resto) são separadas
    // por vírgula, e só o ÚLTIMO par leva "e" — "um milhão, duzentos e trinta
    // e quatro mil, quinhentos e sessenta e sete". O join(' e ') anterior
    // produzia uma corrente de "e" que ninguém escreve num título de crédito.
    if (partes.length <= 1) return partes[0] || '';
    // Exceção clássica: quando o resto é < 100 ou múltiplo de 100, liga-se com
    // "e" em vez de vírgula ("mil e cem", "dois mil e trinta").
    const last = partes.pop();
    const ligaComE = resto > 0 && (resto < 100 || resto % 100 === 0);
    return partes.join(', ') + (ligaComE ? ' e ' : ', ') + last;
  }

  const inteiro = Math.floor(Math.abs(value));
  const centavos = Math.round((Math.abs(value) - inteiro) * 100);
  let texto = inteiroPorExtenso(inteiro) + (inteiro === 1 ? ' real' : ' reais');
  if (centavos > 0) texto += ' e ' + inteiroPorExtenso(centavos) + (centavos === 1 ? ' centavo' : ' centavos');
  return texto;
}

// Quando o frontend novo chega ao ar ANTES de a migration_048 ser aplicada no
// Supabase, as RPCs de agregação ainda não existem e o Postgres responde
// 42883 (undefined_function). Sem este tratamento a tela mostrava só "não foi
// possível carregar", que não diz a ninguém o que fazer — e o que fazer é uma
// coisa só e bem específica.
function isMissingRpcError(err) {
  if (!err) return false;
  const code = err.code || '';
  const msg = (err.message || '') + ' ' + (err.hint || '');
  return code === '42883' || /does not exist|Could not find the function/i.test(msg);
}

function missingMigrationHtml(quais) {
  return `<div class="card">
    <div class="warn-banner">
      <span class="warn-banner-mark" aria-hidden="true">!</span>
      <div>
        <strong>Falta aplicar a migration_048 no banco.</strong>
        Esta tela usa ${escapeHtml(quais)}, que ainda não existe no Supabase — o código novo já está no ar, o banco não.
        Rode <code>supabase/migration_048.sql</code> no SQL Editor do Supabase e recarregue esta página.
      </div>
    </div>
  </div>`;
}
