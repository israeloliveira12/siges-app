/* ============================================================================
   Gerente — Auditoria (trilha de ações importantes do sistema)
   Escrita só via RPC log_audit_event() (ver schema.sql); aqui é só leitura.
   ============================================================================ */

const AUDIT_ACTION_LABELS = {
  contrato_criado: 'Contrato criado',
  contrato_editado: 'Contrato editado',
  contrato_excluido: 'Contrato excluído',
  parcela_editada: 'Parcela editada',
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

let auditActorFilter = 'todos';
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
  const [{ data: admins }, { data: logs, error }] = await Promise.all([
    supa.from('profiles').select('id, full_name').eq('role', 'gerente').order('full_name'),
    supa.from('audit_log').select('*').order('created_at', { ascending: false }).limit(fetchLimit),
  ]);

  if (error) { root.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }

  paintAuditoria(root, { admins: admins || [], logs: logs || [] });
}

function paintAuditoria(root, { admins, logs }) {
  const actionsPresent = Array.from(new Set(logs.map((l) => l.action))).sort();

  const filtered = logs.filter((l) => {
    if (auditActorFilter !== 'todos' && l.actor_id !== auditActorFilter) return false;
    if (auditActionFilter !== 'todos' && l.action !== auditActionFilter) return false;
    return true;
  });

  root.innerHTML = `
    <div class="flex justify-between items-center gap-10" style="flex-wrap:wrap">
      <p class="text-sm text-soft">Trilha das ações importantes do sistema — mostrando os ${logs.length} eventos mais recentes.</p>
    </div>

    <div class="card mt-14">
      <div class="flex gap-14" style="flex-wrap:wrap">
        <div class="field" style="min-width:220px;margin-bottom:0">
          <label>Usuário</label>
          <select id="aud-actor">
            <option value="todos">Todos os usuários</option>
            ${admins.map((a) => `<option value="${a.id}" ${auditActorFilter === a.id ? 'selected' : ''}>${escapeHtml(a.full_name || '—')}</option>`).join('')}
          </select>
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
              <td data-label="Descrição">${escapeHtml(l.description)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : `<div class="empty-state">${Icons.audit}<p>Nenhum evento encontrado com esse filtro.</p></div>`}
    </div>
  `;

  document.getElementById('aud-actor').onchange = (e) => { auditActorFilter = e.target.value; paintAuditoria(root, { admins, logs }); };
  document.getElementById('aud-action').onchange = (e) => { auditActionFilter = e.target.value; paintAuditoria(root, { admins, logs }); };
  document.getElementById('aud-page-size').onchange = (e) => {
    auditPageSize = e.target.value === 'todos' ? 'todos' : Number(e.target.value);
    renderGerenteAuditoria();
  };
}

registerRoute('gerente/auditoria', { role: 'gerente', screenId: 'gerente-auditoria', title: 'Auditoria', render: renderGerenteAuditoria });
