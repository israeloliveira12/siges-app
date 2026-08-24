/* ============================================================================
   Plataforma SaaS — Saúde da Plataforma

   Tela criada na auditoria de 2026-08-23. Motivo: as rotinas automáticas
   falhavam em SILÊNCIO. refresh_overdue_status() estava quebrada havia tempo
   (subconsulta escalar sobre system_settings, que virou uma linha por empresa)
   e nada no sistema dizia isso — api/cron-daily-check.js chamava a RPC com
   `await` solto, sem conferir o resultado. Enquanto isso: parcelas não viravam
   "atrasada" no banco, perdas não eram reconhecidas e os avisos de atraso não
   saíam. A interface mascarava parte disso porque effectiveInstallmentStatus()
   recalcula o atraso na tela, então o sintoma só aparecia nos relatórios.

   Esta tela transforma o silêncio em sinal: cada tarefa do cron registra o
   próprio desfecho em cron_runs (ver record_cron_run em migration_048.sql), e
   o que falhou aparece primeiro, no topo, em vermelho.
   ============================================================================ */

const SAUDE_JOB_LABELS = {
  refresh_overdue_status: {
    label: 'Atualizar atrasos e perdas',
    impacto: 'parcelas não passam a "atrasada", perdas não são reconhecidas e avisos de atraso não saem.',
  },
  avisos_vencimento: {
    label: 'Enviar avisos de vencimento',
    impacto: 'clientes deixam de receber o aviso de parcela vencendo ou vencida.',
  },
  capture_platform_metrics_snapshot: {
    label: 'Capturar métricas do dia',
    impacto: 'a tela Métricas históricas fica com buraco neste dia.',
  },
  refresh_tenant_payment_status: {
    label: 'Marcar assinaturas vencidas',
    impacto: 'cobranças vencidas continuam aparecendo como pendentes.',
  },
};

const SAUDE_ISOLAMENTO_LABELS = {
  contratos_cliente_outra_empresa: 'Contratos cujo cliente é de outra empresa',
  parcelas_contrato_outra_empresa: 'Parcelas com empresa diferente do contrato',
  ciclos_contrato_outra_empresa: 'Ciclos com empresa diferente do contrato',
  pagamentos_contrato_outra_empresa: 'Pagamentos com empresa diferente do contrato',
  notificacoes_fora_da_empresa: 'Notificações enviadas para fora da empresa',
};

function saudeJobLabel(job) {
  return (SAUDE_JOB_LABELS[job] && SAUDE_JOB_LABELS[job].label) || job;
}

// "hoje 07:00", "ontem 07:00", "12/08 07:00" — o dono da plataforma quer saber
// se rodou HOJE, não a data completa.
function saudeWhen(iso) {
  if (!iso) return 'nunca rodou';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const dia = toLocalISO(d);
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (dia === todayISO()) return `hoje ${hora}`;
  if (dia === addDaysISO(todayISO(), -1)) return `ontem ${hora}`;
  return `${formatDate(dia)} ${hora}`;
}

function saudeDuration(ms) {
  if (ms == null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function renderPlataformaSaude() {
  const root = document.getElementById('screen-plataforma-saude');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const { data, error } = await supa.rpc('get_platform_health');
  if (isMissingRpcError(error)) {
    root.innerHTML = missingMigrationHtml('a função get_platform_health');
    return;
  }
  if (error) {
    console.error('Erro ao carregar a saúde da plataforma:', error);
    root.innerHTML = `<div class="card"><p class="auth-error">Não foi possível carregar a saúde da plataforma agora. Recarregue a página ou tente novamente em instantes.</p></div>`;
    return;
  }

  const h = data || {};
  const jobs = Array.isArray(h.jobs) ? h.jobs : [];
  const orfaos = h.orfaos || {};

  // Tarefa em pior estado — é ela que vira o alerta do topo.
  const falhando = jobs
    .filter((j) => j.status === 'falhou')
    .sort((a, b) => Number(b.consecutive_failures || 0) - Number(a.consecutive_failures || 0))[0];

  // Tarefas que o sistema espera existir mas que NUNCA registraram execução —
  // "sem registro" é tão informativo quanto "falhou".
  const jobsConhecidos = Object.keys(SAUDE_JOB_LABELS);
  const registrados = new Set(jobs.map((j) => j.job));
  const semRegistro = jobsConhecidos.filter((j) => !registrados.has(j));

  const totalOrfaos = Object.values(orfaos).reduce((s, v) => s + Number(v || 0), 0);

  const avisosHoje = Number(h.avisos_hoje || 0);
  const avisosMedia = Number(h.avisos_media_7d || 0);
  const emailsFalhos = Number(h.emails_falhos_7d || 0);

  root.innerHTML = `
    ${falhando ? `
      <div class="alert-banner">
        <span class="alert-banner-mark" aria-hidden="true">!</span>
        <div class="alert-banner-body">
          <div class="alert-banner-title">
            ${Number(falhando.consecutive_failures) > 1
              ? `A rotina "${escapeHtml(saudeJobLabel(falhando.job))}" falhou nas últimas ${falhando.consecutive_failures} execuções`
              : `A rotina "${escapeHtml(saudeJobLabel(falhando.job))}" falhou na última execução`}
          </div>
          <div class="alert-banner-detail">
            <code>${escapeHtml(falhando.job)}</code>${falhando.message ? ` — ${escapeHtml(falhando.message)}` : ''}
          </div>
          ${SAUDE_JOB_LABELS[falhando.job] ? `<div class="alert-banner-impact">Enquanto isso: ${escapeHtml(SAUDE_JOB_LABELS[falhando.job].impacto)}</div>` : ''}
        </div>
      </div>` : ''}

    ${semRegistro.length && !falhando ? `
      <div class="warn-banner">
        <span class="warn-banner-mark" aria-hidden="true">!</span>
        <div>
          <strong>Sem registro de execução</strong> para ${semRegistro.map((j) => escapeHtml(saudeJobLabel(j))).join(', ')}.
          Se o cron já rodou depois desta atualização, isso significa que a tarefa não está sendo chamada.
        </div>
      </div>` : ''}

    <div class="grid grid-4 kpi-grid-4 mt-14">
      <div class="card stat-card">
        <div class="label">Empresas ativas</div>
        <div class="value mono">${formatNumber(h.tenants_ativos)}</div>
        ${Number(h.tenants_total) !== Number(h.tenants_ativos) ? `<div class="text-sm text-soft mt-8">${formatNumber(h.tenants_total)} no total</div>` : ''}
      </div>
      <div class="card stat-card">
        <div class="label">Avisos enviados hoje</div>
        <div class="value mono" style="${avisosHoje === 0 && avisosMedia > 0 ? 'color:var(--bad)' : ''}">${formatNumber(avisosHoje)}</div>
        <div class="text-sm text-soft mt-8">média: ${formatNumber(avisosMedia)}</div>
      </div>
      <div class="card stat-card">
        <div class="label">E-mails recusados (7d)</div>
        <div class="value mono" style="${emailsFalhos > 0 ? 'color:var(--warn)' : ''}">${formatNumber(emailsFalhos)}</div>
      </div>
      <div class="card stat-card">
        <div class="label">Inscrições push</div>
        <div class="value mono">${formatNumber(h.push_total)}</div>
      </div>
    </div>

    <div class="card mt-14">
      <h3>Rotinas automáticas</h3>
      <p class="text-sm text-soft">Última execução de cada tarefa do cron diário.</p>
      <div class="health-rows mt-14">
        ${jobsConhecidos.map((jobKey) => {
          const j = jobs.find((x) => x.job === jobKey);
          if (!j) {
            return `
              <div class="health-row">
                <div class="health-ico neutral" aria-hidden="true">–</div>
                <div class="health-row-main">
                  <div class="health-row-title">${escapeHtml(saudeJobLabel(jobKey))}</div>
                  <div class="health-row-meta"><code>${escapeHtml(jobKey)}</code> · sem registro de execução</div>
                </div>
                <span class="badge badge-neutral">sem registro</span>
              </div>`;
          }
          const falhas = Number(j.consecutive_failures || 0);
          const kind = j.status === 'falhou' ? 'bad' : (j.status === 'parcial' ? 'warn' : 'good');
          const mark = j.status === 'falhou' ? '✕' : (j.status === 'parcial' ? '!' : '✓');
          const pill = j.status === 'falhou'
            ? `<span class="badge badge-bad">${falhas > 1 ? `${falhas} falhas seguidas` : 'falhou'}</span>`
            : (j.status === 'parcial'
              ? `<span class="badge badge-warn">${formatNumber(j.remaining)} na fila</span>`
              : `<span class="badge badge-good">ok</span>`);
          const processed = j.processed != null && j.remaining != null
            ? ` · ${formatNumber(j.processed)} de ${formatNumber(Number(j.processed) + Number(j.remaining))} processadas`
            : (j.processed != null ? ` · ${formatNumber(j.processed)} processadas` : '');
          return `
            <div class="health-row ${kind === 'bad' ? 'is-bad' : ''}">
              <div class="health-ico ${kind}" aria-hidden="true">${mark}</div>
              <div class="health-row-main">
                <div class="health-row-title">${escapeHtml(saudeJobLabel(jobKey))}</div>
                <div class="health-row-meta"><code>${escapeHtml(j.job)}</code> · ${escapeHtml(saudeWhen(j.ran_at))}${j.duration_ms != null ? ` · ${escapeHtml(saudeDuration(j.duration_ms))}` : ''}${processed}</div>
                ${j.status === 'falhou' && j.message ? `<div class="health-row-msg">${escapeHtml(j.message)}</div>` : ''}
              </div>
              ${pill}
            </div>`;
        }).join('')}
      </div>
    </div>

    <div class="card mt-14">
      <h3>Verificações de isolamento</h3>
      <p class="text-sm text-soft">Conferência automática de que nenhum dado cruzou de empresa. Todos devem ser zero.</p>
      <div class="health-checks mt-14">
        ${Object.entries(SAUDE_ISOLAMENTO_LABELS).map(([key, label]) => {
          const n = Number(orfaos[key] || 0);
          return `
            <div class="health-check">
              <span class="health-dot ${n > 0 ? 'bad' : 'good'}" aria-hidden="true"></span>
              <span class="health-check-label">${escapeHtml(label)}</span>
              <span class="health-check-value mono" style="${n > 0 ? 'color:var(--bad)' : ''}">${formatNumber(n)}</span>
            </div>`;
        }).join('')}
        <div class="health-check">
          <span class="health-dot ${Number(h.tenants_sem_settings) > 0 ? 'bad' : 'good'}" aria-hidden="true"></span>
          <span class="health-check-label">Empresas sem linha de configuração</span>
          <span class="health-check-value mono" style="${Number(h.tenants_sem_settings) > 0 ? 'color:var(--bad)' : ''}">${formatNumber(h.tenants_sem_settings)}</span>
        </div>
      </div>
      ${totalOrfaos > 0 ? `
        <div class="warn-banner mt-14">
          <span class="warn-banner-mark" aria-hidden="true">!</span>
          <div>
            <strong>${formatNumber(totalOrfaos)} registro(s) com empresa inconsistente.</strong>
            Isso não deveria acontecer com as travas de escrita ativas (migration_048). Se apareceu, provavelmente é dado
            anterior à correção — vale conferir antes de assumir que é uma falha nova.
          </div>
        </div>` : ''}
    </div>

    <div class="flex gap-8 mt-14" style="flex-wrap:wrap">
      <button class="btn btn-outline" id="saude-refresh">Atualizar agora</button>
    </div>
  `;

  document.getElementById('saude-refresh').onclick = () => renderPlataformaSaude();
}

registerRoute('plataforma/saude', {
  role: 'plataforma',
  screenId: 'plataforma-saude',
  title: 'Saúde da Plataforma',
  platformOwnerOnly: true,
  render: renderPlataformaSaude,
});
