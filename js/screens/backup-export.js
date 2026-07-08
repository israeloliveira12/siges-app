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

async function runBackupJSON(silent) {
  const data = await collectAllSystemData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  downloadBlob(`siges-backup-${todayISO()}.json`, blob);
  if (!silent) showToast('Backup gerado com sucesso.');
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

  drawHeader('Exportação de Dados');
  let y = 40;

  y = drawTableSection('Clientes', [
    { label: 'Nome', value: (r) => (r.profiles || {}).full_name },
    { label: 'CPF', value: (r) => (r.profiles || {}).cpf },
    { label: 'Score', value: (r) => r.score },
    { label: 'Limite', value: (r) => formatMoney(r.credit_limit) },
    { label: 'Status', value: (r) => r.approval_status },
  ], data.clientes, y);

  y = drawTableSection('Contratos', [
    { label: 'Nº', value: (r) => r.contract_number },
    { label: 'Valor', value: (r) => formatMoney(r.principal_amount) },
    { label: 'Parcelas', value: (r) => r.installments_count },
    { label: 'Status', value: (r) => r.status },
    { label: 'Criado em', value: (r) => formatDate(r.contract_date) },
  ], data.contratos, y);

  y = drawTableSection('Parcelas', [
    { label: 'Nº', value: (r) => r.sequence_number },
    { label: 'Vencimento', value: (r) => formatDate(r.due_date) },
    { label: 'Valor', value: (r) => formatMoney(r.amount_due) },
    { label: 'Status', value: (r) => r.status },
  ], data.parcelas, y);

  y = drawTableSection('Pagamentos', [
    { label: 'Data', value: (r) => formatDate(r.received_at) },
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
    await runBackupJSON(true);
    localStorage.setItem('siges_last_auto_backup', todayISO());
  } catch (e) { /* falha silenciosa — tenta de novo no próximo acesso */ }
}
