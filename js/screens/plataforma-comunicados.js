/* ============================================================================
   Plataforma SaaS — Comunicados. Aviso in-app do Administrador Master pros
   administradores (gerentes) de uma empresa específica ou de todas —
   reaproveita o sino de notificações já existente (channel='in_app'), sem
   e-mail/push (é comunicação da plataforma, não evento financeiro).
   ============================================================================ */

let comunicadosTenantsCache = [];
let comunicadosHistoricoCache = [];

async function renderPlataformaComunicados() {
  const root = document.getElementById('screen-plataforma-comunicados');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const [{ data: tenants, error }, { data: historico, error: error2 }] = await Promise.all([
    supa.rpc('list_tenants_with_stats'),
    supa.rpc('list_platform_broadcasts'),
  ]);
  if (error || error2) { root.innerHTML = `<div class="auth-error">${escapeHtml((error || error2).message)}</div>`; return; }
  comunicadosTenantsCache = tenants || [];
  comunicadosHistoricoCache = historico || [];

  paintPlataformaComunicados(root);
}

function paintPlataformaComunicados(root) {
  root.innerHTML = `
    <div class="card" style="max-width:560px">
      <h3>Novo comunicado</h3>
      <p class="text-sm text-soft">Aparece no sino de notificações dos administradores (gerentes) das empresas escolhidas — não é enviado por e-mail nem WhatsApp.</p>
      <div id="cm-feedback" class="mt-14"></div>
      <div class="field mt-8">
        <label>Destinatário</label>
        <select id="cm-tenant">
          <option value="">Todas as empresas</option>
          ${comunicadosTenantsCache.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Título</label><input type="text" id="cm-title" placeholder="Ex: Manutenção programada"></div>
      <div class="field"><label>Mensagem</label><textarea id="cm-body" rows="3" placeholder="Ex: O sistema ficará indisponível das 2h às 3h de domingo pra manutenção."></textarea></div>
      <button class="btn btn-primary mt-8" id="cm-send">${Icons.bell} Enviar comunicado</button>
    </div>

    <h3 class="mt-20">Últimos comunicados enviados</h3>
    <div class="mt-14">
      ${comunicadosHistoricoCache.map((c) => `
        <div class="extrato-row">
          <div style="min-width:0;flex:1 1 auto">
            <div class="name">${escapeHtml(c.title)}</div>
            <div class="meta">${escapeHtml(c.tenant_scope)} · ${c.recipient_count} destinatário${Number(c.recipient_count) === 1 ? '' : 's'} · ${formatDateTime(c.sent_at)}</div>
            <div class="text-sm text-soft mt-8">${escapeHtml(c.body)}</div>
          </div>
        </div>
      `).join('')}
      ${!comunicadosHistoricoCache.length ? '<p class="text-sm text-soft">Nenhum comunicado enviado ainda.</p>' : ''}
    </div>
  `;

  document.getElementById('cm-send').onclick = async (e) => {
    const feedback = document.getElementById('cm-feedback');
    feedback.innerHTML = '';
    const title = document.getElementById('cm-title').value.trim();
    const body = document.getElementById('cm-body').value.trim();
    if (!title || !body) { feedback.innerHTML = '<div class="auth-error">Preencha título e mensagem.</div>'; return; }

    const tenantId = document.getElementById('cm-tenant').value || null;
    const tenantName = tenantId ? (comunicadosTenantsCache.find((t) => t.id === tenantId) || {}).name : 'todas as empresas';
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const { data: count, error } = await supa.rpc('broadcast_platform_message', { p_title: title, p_body: body, p_tenant_id: tenantId });
      if (error) throw error;
      logAudit('comunicado_enviado', `Comunicado "${title}" enviado para ${tenantName}`, { tenant_id: tenantId, recipient_count: count });
      showToast(`Enviado para ${count} administrador${Number(count) === 1 ? '' : 'es'}.`);
      renderPlataformaComunicados();
    } catch (err) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(err.message || String(err))}</div>`;
      btn.disabled = false;
    }
  };
}

registerRoute('plataforma/comunicados', { role: 'plataforma', screenId: 'plataforma-comunicados', title: 'Comunicados', render: renderPlataformaComunicados });
