/* ============================================================================
   Plataforma SaaS — Backup Geral (fase final da transformação em SaaS).
   Exclusivo do Administrador Master — cobre dados ADMINISTRATIVOS da
   plataforma inteira (empresas, planos, trilha de auditoria de todas as
   empresas). Deliberadamente NÃO inclui clientes/contratos/parcelas/
   pagamentos de nenhuma empresa — esses dados continuam privados de cada
   empresa (inclusive a sua), cobertos pelo backup normal dela em
   Configurações → Backup e exportação (js/screens/backup-export.js, que já
   funciona corretamente pra qualquer tenant via RLS, sem mudança nenhuma
   necessária aqui). Bulk-exportar PII de clientes de OUTRAS empresas seria
   uma invasão de privacidade desproporcional ao papel de Administrador
   Master — decisão de escopo consciente, não uma limitação técnica.
   ============================================================================ */

async function collectPlatformBackupData() {
  const [{ data: tenants }, { data: plans }, { data: auditLog }] = await Promise.all([
    supa.from('tenants').select('id, name, active, plan_id, referrals_enabled, owner_profile_id, created_at'),
    supa.from('plans').select('*'),
    supa.from('audit_log').select('*').order('created_at', { ascending: false }),
  ]);
  return {
    generated_at: new Date().toISOString(),
    empresas: tenants || [],
    planos: plans || [],
    auditoria: auditLog || [],
  };
}

async function runPlatformBackupJSON() {
  const data = await collectPlatformBackupData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  downloadBlob(`siges-plataforma-backup-${todayISO()}.json`, blob);
  showToast('Backup geral (.json) gerado com sucesso.');
}

const PLATFORM_SQL_TABLE_MAP = { empresas: 'tenants', planos: 'plans', auditoria: 'audit_log' };
const PLATFORM_SQL_TABLE_PK = { tenants: 'id', plans: 'id', audit_log: 'id' };

function buildPlatformSqlDump(data) {
  const lines = [];
  lines.push('-- ============================================================================');
  lines.push('-- Backup GERAL da plataforma SIGES (SQL) — gerado em ' + data.generated_at);
  lines.push('-- Cobre só dados ADMINISTRATIVOS da plataforma (empresas, planos, auditoria de');
  lines.push('-- todas as empresas) — NÃO inclui clientes/contratos/parcelas/pagamentos de');
  lines.push('-- nenhuma empresa, que continuam privados de cada uma (backup próprio dela em');
  lines.push('-- Configurações → Backup e exportação).');
  lines.push('-- ============================================================================');
  lines.push('');
  lines.push('begin;');
  lines.push('');

  Object.keys(PLATFORM_SQL_TABLE_MAP).forEach((key) => {
    const table = PLATFORM_SQL_TABLE_MAP[key];
    const pk = PLATFORM_SQL_TABLE_PK[table];
    const rows = data[key] || [];
    lines.push(`-- ---- ${table} (${rows.length} linha${rows.length === 1 ? '' : 's'}) ----`);
    if (rows.length) {
      const columns = Object.keys(rows[0]);
      rows.forEach((row) => {
        const values = columns.map((c) => sqlLiteral(row[c]));
        lines.push(`insert into ${table} (${columns.join(', ')}) values (${values.join(', ')}) on conflict (${pk}) do nothing;`);
      });
    }
    lines.push('');
  });

  lines.push('commit;');
  return lines.join('\n');
}

async function runPlatformBackupSQL() {
  const data = await collectPlatformBackupData();
  const sql = buildPlatformSqlDump(data);
  const blob = new Blob([sql], { type: 'application/sql' });
  downloadBlob(`siges-plataforma-backup-${todayISO()}.sql`, blob);
  showToast('Backup geral (.sql) gerado com sucesso.');
}

async function renderPlataformaBackup() {
  const root = document.getElementById('screen-plataforma-backup');
  root.innerHTML = `
    <div class="card">
      <h3>Backup geral da plataforma</h3>
      <p class="text-sm text-soft mt-8">Cobre os dados <strong>administrativos da plataforma inteira</strong>: lista de empresas, planos configurados e a trilha de auditoria de todas as empresas. <strong>Não inclui</strong> clientes, contratos, parcelas ou pagamentos de nenhuma empresa — cada empresa (inclusive a sua) continua com o backup próprio dela, privado, em Configurações → Backup e exportação.</p>
      <div id="pb-feedback" class="mt-14"></div>
      <div class="flex gap-8 mt-14" style="flex-wrap:wrap">
        <button class="btn btn-primary" id="pb-json-btn">${Icons.printer} Baixar backup geral (.json)</button>
        <button class="btn btn-outline" id="pb-sql-btn">${Icons.printer} Baixar backup geral (.sql)</button>
      </div>
    </div>

    <div class="card mt-14">
      <h3>Backup do seu próprio negócio</h3>
      <p class="text-sm text-soft mt-8">Seus dados de empréstimos (clientes, contratos, parcelas, pagamentos) continuam com o backup de sempre, em <strong>Configurações → Backup e exportação</strong> — vá até lá pra baixar agora ou configurar o backup automático.</p>
    </div>
  `;

  const feedback = document.getElementById('pb-feedback');
  document.getElementById('pb-json-btn').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    feedback.innerHTML = '';
    try { await runPlatformBackupJSON(); } catch (err) { feedback.innerHTML = `<div class="auth-error">${escapeHtml(err.message || String(err))}</div>`; }
    btn.disabled = false;
  };
  document.getElementById('pb-sql-btn').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    feedback.innerHTML = '';
    try { await runPlatformBackupSQL(); } catch (err) { feedback.innerHTML = `<div class="auth-error">${escapeHtml(err.message || String(err))}</div>`; }
    btn.disabled = false;
  };
}

registerRoute('plataforma/backup', { role: 'plataforma', screenId: 'plataforma-backup', title: 'Backup Geral', render: renderPlataformaBackup });
