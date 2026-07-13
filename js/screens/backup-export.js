/* ============================================================================
   Backup automático/manual e exportação de dados (JSON / XLSX / CSV / PDF)
   ============================================================================ */

const BACKUP_TABLE_LABELS = {
  clientes: 'Clientes',
  contratos: 'Contratos',
  parcelas: 'Parcelas',
  ciclos_renovacao: 'Ciclos de renovação',
  pagamentos: 'Pagamentos',
  solicitacoes: 'Solicitações',
};

async function collectAllSystemData() {
  const [
    { data: clients }, { data: contracts }, { data: installments },
    { data: cycles }, { data: payments }, { data: requests },
  ] = await Promise.all([
    supa.from('clients').select('*, profiles!clients_profile_id_fkey(full_name, email, cpf, phone, active)'),
    supa.from('loan_contracts').select('*'),
    supa.from('installments').select('*'),
    supa.from('renewal_cycles').select('*'),
    supa.from('payments').select('*'),
    supa.from('loan_requests').select('*'),
  ]);
  return {
    generated_at: new Date().toISOString(),
    clientes: clients || [],
    contratos: contracts || [],
    parcelas: installments || [],
    ciclos_renovacao: cycles || [],
    pagamentos: payments || [],
    solicitacoes: requests || [],
  };
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function runBackupJSON(silent, preloadedData) {
  const data = preloadedData || await collectAllSystemData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  downloadBlob(`siges-backup-${todayISO()}.json`, blob);
  if (!silent) showToast('Backup .json gerado com sucesso.');
}

// ---------------------------------------------------------------------------
// Backup em .sql — mesmo escopo de dados do .json (as mesmas 6 tabelas),
// só que como INSERTs prontos pra colar no SQL Editor do Supabase (a mesma
// ferramenta já usada toda semana pras migrations), sem precisar de um
// script de importação customizado na hora do aperto.
// ---------------------------------------------------------------------------

const SQL_TABLE_MAP = {
  clientes: 'clients',
  contratos: 'loan_contracts',
  parcelas: 'installments',
  ciclos_renovacao: 'renewal_cycles',
  pagamentos: 'payments',
  solicitacoes: 'loan_requests',
};

// Ordem já é FK-safe (cliente antes de contrato, contrato antes de parcela...
// mesma ordem de SQL_TABLE_MAP/BACKUP_TABLE_LABELS). Chave primária de cada
// tabela, usada no ON CONFLICT DO NOTHING (torna o dump seguro de rodar mais
// de uma vez sem duplicar linha).
const SQL_TABLE_PK = {
  clients: 'profile_id',
  loan_contracts: 'id',
  installments: 'id',
  renewal_cycles: 'id',
  payments: 'id',
  loan_requests: 'id',
};

function sqlEscapeString(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'object') return sqlEscapeString(JSON.stringify(v));
  return sqlEscapeString(v);
}

function buildSqlDump(data) {
  const lines = [];
  lines.push('-- ============================================================================');
  lines.push('-- Backup SIGES (SQL) — gerado em ' + data.generated_at);
  lines.push('-- Cole este arquivo inteiro no SQL Editor do Supabase (o mesmo lugar onde você');
  lines.push('-- roda as migrations) para restaurar os dados destas 6 tabelas.');
  lines.push('--');
  lines.push('-- ATENCAO — pré-requisito antes de rodar este dump:');
  lines.push('-- as contas de autenticação (auth.users / profiles) de cada cliente precisam');
  lines.push('-- já existir no banco de destino com os MESMOS IDs (profile_id abaixo). O');
  lines.push('-- Supabase Auth guarda senha como hash irreversível — nenhum backup feito pelo');
  lines.push('-- navegador tem acesso a ela nem à service_role key, então recriar as contas é');
  lines.push('-- sempre um passo separado (mesma técnica já usada na importação em massa de');
  lines.push('-- 2026-07-11: inserir em auth.users com senha temporária via crypt(), deixar o');
  lines.push('-- trigger handle_new_user() criar profiles/clients, e depois resetar a senha de');
  lines.push('-- cada cliente pela tela "Redefinir senha"). Sem isso, os INSERTs em "clients"');
  lines.push('-- abaixo vão falhar por violação de chave estrangeira.');
  lines.push('-- ============================================================================');
  lines.push('');
  lines.push('begin;');
  lines.push('');

  Object.keys(SQL_TABLE_MAP).forEach((key) => {
    const table = SQL_TABLE_MAP[key];
    const pk = SQL_TABLE_PK[table];
    const rows = data[key] || [];
    lines.push(`-- ---- ${table} (${rows.length} linha${rows.length === 1 ? '' : 's'}) ----`);
    if (rows.length) {
      const columns = Object.keys(rows[0]).filter((c) => c !== 'profiles');
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

async function runBackupSQL(silent, preloadedData) {
  const data = preloadedData || await collectAllSystemData();
  const sql = buildSqlDump(data);
  const blob = new Blob([sql], { type: 'application/sql' });
  downloadBlob(`siges-backup-${todayISO()}.sql`, blob);
  if (!silent) showToast('Backup .sql gerado com sucesso.');
}

function flattenRowForSheet(row) {
  const out = {};
  Object.keys(row).forEach((k) => {
    const v = row[k];
    out[k] = (v && typeof v === 'object') ? JSON.stringify(v) : v;
  });
  return out;
}

async function runExportXLSX() {
  if (typeof XLSX === 'undefined') { showToast('Biblioteca de planilhas não carregou — tente recarregar a página.'); return; }
  const data = await collectAllSystemData();
  const wb = XLSX.utils.book_new();
  Object.keys(BACKUP_TABLE_LABELS).forEach((key) => {
    const rows = (data[key] || []).map(flattenRowForSheet);
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ aviso: 'Sem dados' }]);
    XLSX.utils.book_append_sheet(wb, ws, BACKUP_TABLE_LABELS[key].slice(0, 31));
  });
  XLSX.writeFile(wb, `siges-export-${todayISO()}.xlsx`);
}

function rowsToCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escapeCell = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => escapeCell(r[h])).join(','))].join('\r\n');
}

async function runExportCSV(tableKey) {
  const data = await collectAllSystemData();
  const rows = (data[tableKey] || []).map(flattenRowForSheet);
  if (!rows.length) { showToast('Não há dados nessa tabela para exportar.'); return; }
  const csv = rowsToCsv(rows);
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(`siges-${tableKey}-${todayISO()}.csv`, blob);
}

async function runExportPDF() {
  const data = await collectAllSystemData();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const NAVY = [11, 65, 107];
  const INK_SOFT = [91, 102, 99];
  const LINE = [220, 226, 223];
  const companyName = (App.settings && App.settings.company_name) || 'Siges Serviços Financeiros';
  const logoDataUrl = await loadImageDataUrl('icons/logo-mark.png');

  function drawHeader(title) {
    if (logoDataUrl) { try { doc.addImage(logoDataUrl, 'PNG', 20, 14, 12, 12); } catch (e) { /* segue sem logo */ } }
    doc.setTextColor(...NAVY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(companyName, 36, 20);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...INK_SOFT);
    doc.setFontSize(8.5);
    doc.text(`${title} · Emitido em ${formatDate(todayISO())}`, 36, 25.5);
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.3);
    doc.line(20, 32, 190, 32);
  }

  function drawTableSection(sectionTitle, columns, rows, startY) {
    let y = startY;
    if (y > 250) { doc.addPage(); drawHeader('Exportação de Dados'); y = 40; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...NAVY);
    doc.text(sectionTitle, 20, y);
    y += 7;
    const colWidth = 170 / columns.length;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...INK_SOFT);
    columns.forEach((c, i) => doc.text(c.label, 20 + i * colWidth, y));
    doc.setDrawColor(...NAVY);
    doc.setLineWidth(0.3);
    doc.line(20, y + 2, 190, y + 2);
    y += 7;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(20, 33, 43);
    if (!rows.length) {
      doc.setTextColor(...INK_SOFT);
      doc.text('Sem registros.', 20, y);
      y += 8;
    }
    rows.forEach((row) => {
      if (y > 275) {
        doc.addPage();
        drawHeader('Exportação de Dados');
        y = 40;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.setTextColor(...INK_SOFT);
        columns.forEach((c, i) => doc.text(c.label, 20 + i * colWidth, y));
        doc.setDrawColor(...NAVY);
        doc.line(20, y + 2, 190, y + 2);
        y += 7;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(20, 33, 43);
      }
      columns.forEach((c, i) => {
        const text = String(c.value(row) ?? '—').slice(0, 28);
        doc.text(text, 20 + i * colWidth, y);
      });
      doc.setDrawColor(240, 242, 240);
      doc.setLineWidth(0.2);
      doc.line(20, y + 2, 190, y + 2);
      y += 6;
    });
    return y + 8;
  }

  function addFooters() {
    const pageCount = doc.internal.getNumberOfPages();
    for (let p = 1; p <= pageCount; p++) {
      doc.setPage(p);
      doc.setDrawColor(...LINE);
      doc.line(20, 283, 190, 283);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text(`Documento gerado por ${companyName}`, 20, 289);
      doc.text(`Página ${p} de ${pageCount}`, 190, 289, { align: 'right' });
      doc.setTextColor(0);
    }
  }

  function checkPageBreak(y, needed) {
    if (y + needed > 278) { doc.addPage(); drawHeader('Exportação de Dados'); return 40; }
    return y;
  }

  function drawClientHeader(client, y) {
    y = checkPageBreak(y, 15);
    const p = client.profiles || {};
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...NAVY);
    doc.text(p.full_name || '—', 20, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...INK_SOFT);
    doc.text(`CPF ${p.cpf || '—'} · Score ${client.score ?? '—'} · Limite ${formatMoney(client.credit_limit)} · ${client.approval_status || ''}`, 20, y + 5);
    doc.setDrawColor(...NAVY);
    doc.setLineWidth(0.4);
    doc.line(20, y + 8, 190, y + 8);
    return y + 13;
  }

  function drawContractSubheader(contract, y) {
    y = checkPageBreak(y, 10);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(20, 33, 43);
    doc.text(`Contrato #${contract.contract_number} — ${formatMoney(contract.principal_amount)} — ${contract.status} — criado em ${formatDate(contract.contract_date)}`, 24, y);
    return y + 6;
  }

  function drawOpenInstallments(rows, y) {
    if (!rows.length) {
      y = checkPageBreak(y, 7);
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(7.5);
      doc.setTextColor(...INK_SOFT);
      doc.text('Nenhuma parcela em aberto.', 28, y);
      return y + 8;
    }
    const cols = [{ label: 'Nº', w: 12, get: (r) => String(r.sequence_number) },
      { label: 'Vencimento', w: 26, get: (r) => formatDate(r.due_date) },
      { label: 'Valor', w: 26, get: (r) => formatMoney(r.amount_due) },
      { label: 'Status', w: 26, get: (r) => r.status }];
    y = checkPageBreak(y, 10);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(...INK_SOFT);
    let x = 28;
    cols.forEach((c) => { doc.text(c.label, x, y); x += c.w; });
    y += 4.5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(20, 33, 43);
    rows.forEach((r) => {
      y = checkPageBreak(y, 6);
      x = 28;
      cols.forEach((c) => { doc.text(c.get(r), x, y); x += c.w; });
      y += 5;
    });
    return y + 4;
  }

  drawHeader('Exportação de Dados');
  let y = 40;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...NAVY);
  y = checkPageBreak(y, 10);
  doc.text('Clientes, contratos e parcelas em aberto', 20, y);
  y += 9;

  const contractsByClient = {};
  (data.contratos || []).forEach((c) => { (contractsByClient[c.client_id] = contractsByClient[c.client_id] || []).push(c); });
  const openInstallmentsByContract = {};
  (data.parcelas || []).forEach((i) => {
    if (i.status !== 'pendente' && i.status !== 'atrasada') return;
    (openInstallmentsByContract[i.contract_id] = openInstallmentsByContract[i.contract_id] || []).push(i);
  });
  const clientsSorted = [...(data.clientes || [])].sort((a, b) =>
    ((a.profiles || {}).full_name || '').localeCompare((b.profiles || {}).full_name || '', 'pt-BR'));

  if (!clientsSorted.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...INK_SOFT);
    doc.text('Nenhum cliente cadastrado.', 20, y);
    y += 8;
  }

  clientsSorted.forEach((client) => {
    y = drawClientHeader(client, y);
    const contracts = (contractsByClient[client.profile_id] || []).sort((a, b) => (a.contract_number || 0) - (b.contract_number || 0));
    if (!contracts.length) {
      y = checkPageBreak(y, 7);
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8);
      doc.setTextColor(...INK_SOFT);
      doc.text('Nenhum contrato.', 24, y);
      y += 8;
    } else {
      contracts.forEach((contract) => {
        y = drawContractSubheader(contract, y);
        const openInst = (openInstallmentsByContract[contract.id] || []).sort((a, b) => a.sequence_number - b.sequence_number);
        y = drawOpenInstallments(openInst, y);
      });
    }
    y += 4;
  });

  y = drawTableSection('Pagamentos', [
    { label: 'Data', value: (r) => formatDateUTC(r.received_at) },
    { label: 'Tipo', value: (r) => r.payment_kind },
    { label: 'Valor', value: (r) => formatMoney(r.amount_received) },
    { label: 'Lucro líquido', value: (r) => formatMoney(r.net_profit) },
  ], data.pagamentos, y);

  addFooters();
  doc.save(`siges-export-${todayISO()}.pdf`);
}

// ---------------------------------------------------------------------------
// Backup automático — dispara no máximo 1x por período configurado, ao abrir
// o sistema (verificado via localStorage, é por navegador/dispositivo).
// ---------------------------------------------------------------------------

function backupFrequencyToDays(freq, customDays) {
  switch (freq) {
    case 'semanal': return 7;
    case 'quinzenal': return 15;
    case 'mensal': return 30;
    case 'personalizado': return Math.max(1, Number(customDays) || 1);
    default: return 1; // diario
  }
}

function shouldAutoBackupNow() {
  if (!App.settings || !App.settings.backup_auto_enabled) return false;
  const last = localStorage.getItem('siges_last_auto_backup');
  if (!last) return true;
  const diffDays = Math.round((new Date(todayISO()) - new Date(last)) / 86400000);
  return diffDays >= backupFrequencyToDays(App.settings.backup_frequency, App.settings.backup_custom_days);
}

async function maybeRunAutoBackup() {
  try {
    if (!isGerente() || !shouldAutoBackupNow()) return;
    const data = await collectAllSystemData();
    await runBackupJSON(true, data);
    // Pequeno intervalo entre os dois downloads — disparar dois arquivos no
    // mesmíssimo instante às vezes faz o navegador tratar o segundo como
    // pop-up/spam e bloquear silenciosamente.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await runBackupSQL(true, data);
    localStorage.setItem('siges_last_auto_backup', todayISO());
  } catch (e) { /* falha silenciosa — tenta de novo no próximo acesso */ }
}
