/* ============================================================================
   Geração de PDF (nota promissória + extrato) — jsPDF via CDN, sem instalação
   ============================================================================ */

const MESES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Desenha uma nota promissória na página ATUAL do doc (não cria/salva nada) —
// usada para montar um único PDF com várias páginas, uma por parcela.
function drawPromissoriaPage(doc, { contract, installment, clientProfile, companyName }) {
  const dueDate = new Date(installment.due_date + 'T00:00:00');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('NOTA PROMISSÓRIA', 20, 25);
  doc.setFontSize(11);
  doc.text(`Contrato nº: ${contract.contract_number}`, 20, 32);
  doc.text(`Parcela: ${installment.sequence_number} de ${contract.installments_count}`, 20, 38);

  doc.setFontSize(11);
  doc.text(`Vencimento: ${formatDate(installment.due_date)}`, 140, 25);
  doc.setFontSize(14);
  doc.text(formatMoney(installment.amount_due), 140, 32);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  const texto = `Ao(s) ${dueDate.getDate()} dia(s) do mês de ${MESES_PT[dueDate.getMonth()]} do ano de ${dueDate.getFullYear()} pagarei por esta única via de NOTA PROMISSÓRIA a ${companyName}, a quantia de ${formatMoney(installment.amount_due)} (${valueByExtenso(installment.amount_due)}), correspondente à ${installment.sequence_number}/${contract.installments_count} parcela do contrato nº ${contract.contract_number}, com vencimento em ${formatDate(installment.due_date)}.`;
  const lines = doc.splitTextToSize(texto, 170);
  doc.text(lines, 20, 55);

  const afterTextY = 55 + lines.length * 6 + 20;
  doc.setFont('helvetica', 'bold');
  doc.text('Emitente:', 20, afterTextY);
  doc.setFont('helvetica', 'normal');
  doc.text(clientProfile.full_name || '', 45, afterTextY);
  doc.setFont('helvetica', 'bold');
  doc.text('CPF:', 20, afterTextY + 8);
  doc.setFont('helvetica', 'normal');
  doc.text(clientProfile.cpf || '—', 45, afterTextY + 8);

  doc.line(20, afterTextY + 35, 120, afterTextY + 35);
  doc.setFontSize(9);
  doc.text('Assinatura', 20, afterTextY + 40);
}

// Gera UM único PDF com todas as notas promissórias do contrato, uma parcela
// por página (em vez de um arquivo separado para cada parcela).
function gerarNotasPromissoriasPDF({ contract, installments, clientProfile, companyName }) {
  if (!installments || !installments.length) { showToast('Este contrato não tem parcelas.'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });

  installments.forEach((installment, idx) => {
    if (idx > 0) doc.addPage();
    drawPromissoriaPage(doc, { contract, installment, clientProfile, companyName });
  });

  doc.save(`notas-promissorias-contrato-${contract.contract_number}.pdf`);
}

async function loadImageDataUrl(path) {
  try {
    const res = await fetch(path);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    return null; // segue sem logo se por algum motivo não conseguir carregar
  }
}

function addExtratoFooter(doc, companyName) {
  const pageCount = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setDrawColor(220, 226, 223);
    doc.line(20, 283, 190, 283);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(`Documento gerado por ${companyName}`, 20, 289);
    doc.text(`Página ${p} de ${pageCount}`, 190, 289, { align: 'right' });
    doc.setTextColor(0);
  }
}

async function gerarExtratoPDF({ contract, installments, clientProfile, score, companyName }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const NAVY = [11, 65, 107];
  const TEAL = [30, 154, 149];
  const logoDataUrl = await loadImageDataUrl('icons/logo-mark.png');

  // Cabeçalho: logo + nome da empresa + faixa navy
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, 210, 34, 'F');
  if (logoDataUrl) {
    try { doc.addImage(logoDataUrl, 'PNG', 16, 7, 20, 20); } catch (e) { /* segue sem logo se o formato falhar */ }
  }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(companyName, 42, 16);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Extrato do Contrato #${contract.contract_number}`, 42, 23);
  doc.setFontSize(8);
  doc.text(`Emitido em ${formatDate(todayISO())}`, 42, 29);

  if (score != null) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.text(String(score), 190, 16, { align: 'right' });
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    doc.text('SCORE DO CLIENTE', 190, 21, { align: 'right' });
  }
  doc.setTextColor(0, 0, 0);

  // Dados do cliente
  doc.setFillColor(244, 246, 247);
  doc.rect(20, 42, 170, 16, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('CLIENTE', 25, 48);
  doc.text('CPF', 130, 48);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.text(clientProfile.full_name || '—', 25, 54);
  doc.text(clientProfile.cpf || '—', 130, 54);

  const paid = installments.filter((i) => i.status === 'paga');
  const remaining = installments.filter((i) => i.status !== 'paga');
  const totalDue = installments.reduce((s, i) => s + Number(i.amount_due), 0);
  const totalPaid = paid.reduce((s, i) => s + Number(i.amount_due), 0);

  // Cards de resumo
  const cardY = 64, cardW = 54, cardH = 22, gap = 4;
  const cards = [
    { label: 'DÍVIDA TOTAL', value: formatMoney(totalDue), color: NAVY },
    { label: 'VALOR PAGO', value: formatMoney(totalPaid), color: TEAL },
    { label: 'PARCELAS RESTANTES', value: `${remaining.length} de ${installments.length}`, color: NAVY },
  ];
  cards.forEach((c, i) => {
    const x = 20 + i * (cardW + gap);
    doc.setDrawColor(220, 226, 223);
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(x, cardY, cardW, cardH, 2, 2, 'FD');
    doc.setFillColor(...c.color);
    doc.rect(x, cardY, 2, cardH, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(90, 100, 96);
    doc.text(c.label, x + 6, cardY + 8);
    doc.setFontSize(12);
    doc.setTextColor(...c.color);
    doc.text(c.value, x + 6, cardY + 16);
  });
  doc.setTextColor(0, 0, 0);

  // Tabela de parcelas
  let y = 100;
  doc.setFillColor(...NAVY);
  doc.rect(20, y - 6, 170, 8, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(255, 255, 255);
  const cols = [24, 42, 78, 114, 145, 178];
  ['Nº', 'Vencimento', 'Data pgto', 'Valor', 'Status', ''].forEach((h, i) => doc.text(h, cols[i], y));
  doc.setTextColor(0, 0, 0);
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  installments.forEach((inst, idx) => {
    if (y > 270) {
      doc.addPage();
      y = 24;
      doc.setFillColor(...NAVY);
      doc.rect(20, y - 6, 170, 8, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(255, 255, 255);
      ['Nº', 'Vencimento', 'Data pgto', 'Valor', 'Status', ''].forEach((h, i) => doc.text(h, cols[i], y));
      doc.setTextColor(0, 0, 0);
      doc.setFont('helvetica', 'normal');
      y += 8;
    }
    if (idx % 2 === 0) { doc.setFillColor(248, 249, 247); doc.rect(20, y - 5, 170, 7, 'F'); }
    const statusLabel = { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada', renovada: 'Renovada', cancelada: 'Cancelada' }[inst.status];
    doc.text(String(inst.sequence_number), cols[0], y);
    doc.text(formatDate(inst.due_date), cols[1], y);
    doc.text(inst.paid_at ? formatDate(inst.paid_at) : '—', cols[2], y);
    doc.text(formatMoney(inst.amount_due), cols[3], y);
    doc.text(statusLabel, cols[4], y);
    y += 7;
  });

  addExtratoFooter(doc, companyName);
  doc.save(`extrato-contrato-${contract.contract_number}.pdf`);
}
