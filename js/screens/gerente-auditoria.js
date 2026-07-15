/* ============================================================================
   Gerente — Auditoria (trilha de ações importantes do sistema)
   Escrita só via RPC log_audit_event() (ver schema.sql); aqui é só leitura.
   ============================================================================ */

const AUDIT_ACTION_LABELS = {
  contrato_criado: 'Contrato criado',
  contrato_editado: 'Contrato editado',
  contrato_excluido: 'Contrato excluído',
  parcela_editada: 'Parcela editada',
  pagamento_editado: 'Pagamento editado',
  pagamento_recebido: 'Pagamento recebido',
  renovacao_registrada: 'Renovação registrada',
  cliente_criado: 'Cliente criado',
  cliente_editado: 'Cliente editado',
  cliente_excluido: 'Cliente excluído',
  cliente_aprovado: 'Cadastro aprovado',
  cliente_rejeitado: 'Cadastro rejeitado',
  senha_redefinida: 'Senha redefinida',
  gerente_criado: 'Gerente criado',
  gerente_editado: 'Gerente editado',
  login_sucesso: 'Login realizado',
  login_falho: 'Login falhou',
  erro_sistema: 'Erro do sistema',
};

function auditActionLabel(action) {
  return AUDIT_ACTION_LABELS[action] || action;
}

function auditActionBadgeColor(action) {
  if (action === 'erro_sistema' || action === 'login_falho' || action.includes('excluido') || action === 'cliente_rejeitado') return 'var(--bad)';
  if (action.includes('criado') || action === 'cliente_aprovado' || action === 'pagamento_recebido' || action === 'renovacao_registrada' || action === 'login_sucesso') return 'var(--good)';
  return 'var(--ink-soft)';
}

let auditActorSearch = '';
let auditActionFilter = 'todos';
// Quantidade de eventos buscados do banco — não só escondidos no cliente,
// pra tela não ficar lenta conforme o histórico crescer. 'todos' ainda usa
// um teto (2000) pra nunca puxar a tabela inteira sem limite nenhum.
let auditPageSize = 20;
const AUDIT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

async function renderGerenteAuditoria() {
  const root = document.getElementById('screen-gerente-auditoria');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const fetchLimit = auditPageSize === 'todos' ? 2000 : auditPageSize;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

  // Sumário sempre calculado com queries próprias (contagem no servidor),
  // independente do filtro/paginação da tabela abaixo — senão "última hora"
  // ficaria errado sempre que auditPageSize fosse menor que o volume real.
  const [
    { data: logs, error },
    { count: lastHourCount, error: e1 },
    { count: loginsHojeCount, error: e2 },
    { count: falhasHojeCount, error: e3 },
  ] = await Promise.all([
    supa.from('audit_log').select('*').order('created_at', { ascending: false }).limit(fetchLimit),
    supa.from('audit_log').select('id', { count: 'exact', head: true }).gte('created_at', oneHourAgo),
    supa.from('audit_log').select('id', { count: 'exact', head: true }).eq('action', 'login_sucesso').gte('created_at', todayStart.toISOString()),
    supa.from('audit_log').select('id', { count: 'exact', head: true }).eq('action', 'login_falho').gte('created_at', todayStart.toISOString()),
  ]);

  if (error || e1 || e2 || e3) { root.innerHTML = `<div class="auth-error">${escapeHtml((error || e1 || e2 || e3).message)}</div>`; return; }

  paintAuditoria(root, {
    logs: logs || [],
    summary: { lastHourCount: lastHourCount || 0, loginsHojeCount: loginsHojeCount || 0, falhasHojeCount: falhasHojeCount || 0 },
  });
}

function paintAuditoria(root, { logs, summary }) {
  const actionsPresent = Array.from(new Set(logs.map((l) => l.action))).sort();
  // Derivado dos próprios logs (não uma query fixa em profiles role=gerente)
  // — o filtro precisa listar QUALQUER ator que já gerou um evento, cliente
  // ou gerente (ex: login_sucesso/login_falho de cliente, cliente_criado
  // etc.), não só administradores. Antes disso, clientes nunca apareciam
  // nessa lista mesmo tendo ações registradas.
  const actorsPresent = Array.from(
    new Map(logs.filter((l) => l.actor_id).map((l) => [l.actor_id, l.actor_name || 'Anônimo'])).entries()
  ).sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));

  const term = auditActorSearch.trim().toLowerCase();
  const filtered = logs.filter((l) => {
    if (term && !(l.actor_name || 'anônimo').toLowerCase().includes(term)) return false;
    if (auditActionFilter !== 'todos' && l.action !== auditActionFilter) return false;
    return true;
  });

  const oldActorInput = document.getElementById('aud-actor');
  const hadFocus = document.activeElement === oldActorInput;
  const selStart = hadFocus ? oldActorInput.selectionStart : null;

  root.innerHTML = `
    <div class="flex justify-between items-center gap-10" style="flex-wrap:wrap">
      <p class="text-sm text-soft">Trilha das ações importantes do sistema — mostrando os ${logs.length} eventos mais recentes.</p>
    </div>

    <div class="grid grid-3 mt-14">
      <div class="card stat-card"><div class="label">Ações na última hora</div><div class="value mono">${summary.lastHourCount}</div></div>
      <div class="card stat-card"><div class="label">Logins hoje</div><div class="value mono">${summary.loginsHojeCount}</div></div>
      <div class="card stat-card"><div class="label">Falhas de login hoje</div><div class="value mono" style="${summary.falhasHojeCount > 0 ? 'color:var(--bad)' : ''}">${summary.falhasHojeCount}</div></div>
    </div>

    <div class="card mt-14">
      <div class="flex gap-14" style="flex-wrap:wrap">
        <div class="field" style="min-width:220px;margin-bottom:0">
          <label>Usuário</label>
          <input type="text" id="aud-actor" list="aud-actor-options" placeholder="Buscar por nome..." value="${escapeHtml(auditActorSearch)}">
          <datalist id="aud-actor-options">
            ${actorsPresent.map(([, name]) => `<option value="${escapeHtml(name)}">`).join('')}
          </datalist>
        </div>
        <div class="field" style="min-width:220px;margin-bottom:0">
          <label>Ação</label>
          <select id="aud-action">
            <option value="todos">Todas as ações</option>
            ${actionsPresent.map((a) => `<option value="${a}" ${auditActionFilter === a ? 'selected' : ''}>${escapeHtml(auditActionLabel(a))}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="min-width:160px;margin-bottom:0">
          <label>Exibir</label>
          <select id="aud-page-size">
            ${AUDIT_PAGE_SIZE_OPTIONS.map((n) => `<option value="${n}" ${auditPageSize === n ? 'selected' : ''}>Exibir ${n}</option>`).join('')}
            <option value="todos" ${auditPageSize === 'todos' ? 'selected' : ''}>Exibir tudo</option>
          </select>
        </div>
      </div>
    </div>

    <div class="card mt-14" style="padding:0;overflow:hidden">
      ${filtered.length ? `
      <table class="data-table table-scroll">
        <thead><tr><th>Data/Hora</th><th>Usuário</th><th>Ação</th><th>Descrição</th></tr></thead>
        <tbody>
          ${filtered.map((l) => `
            <tr>
              <td data-label="Data/Hora" class="mono text-sm">${formatDateTime(l.created_at)}</td>
              <td data-label="Usuário"><div>${escapeHtml(l.actor_name || 'Anônimo')}</div>${l.actor_role ? `<div class="text-sm text-soft">${l.actor_role === 'gerente' ? 'Administrador' : 'Cliente'}</div>` : ''}</td>
              <td data-label="Ação"><span style="color:${auditActionBadgeColor(l.action)};font-weight:600">${escapeHtml(auditActionLabel(l.action))}</span></td>
              <td data-label="Descrição" class="wrap-text">${escapeHtml(l.description)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : `<div class="empty-state">${Icons.audit}<p>Nenhum evento encontrado com esse filtro.</p></div>`}
    </div>
  `;

  const newActorInput = document.getElementById('aud-actor');
  if (hadFocus) { newActorInput.focus(); newActorInput.setSelectionRange(selStart, selStart); }
  newActorInput.oninput = debounce((e) => { auditActorSearch = e.target.value; paintAuditoria(root, { logs, summary }); }, 200);
  document.getElementById('aud-action').onchange = (e) => { auditActionFilter = e.target.value; paintAuditoria(root, { logs, summary }); };
  document.getElementById('aud-page-size').onchange = (e) => {
    auditPageSize = e.target.value === 'todos' ? 'todos' : Number(e.target.value);
    renderGerenteAuditoria();
  };
}

registerRoute('gerente/auditoria', { role: 'gerente', screenId: 'gerente-auditoria', title: 'Auditoria', render: renderGerenteAuditoria });
