/* ============================================================================
   Geração de PDF (nota promissória + extrato) — jsPDF via CDN, sem instalação
   ============================================================================ */

const MESES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function gerarPromissoriaPDF({ contract, installment, clientProfile, companyName }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const dueDate = new Date(installment.due_date + 'T00:00:00');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('NOTA PROMISSÓRIA', 20, 25);
  doc.setFontSize(11);
  doc.text(`Nº ${contract.contract_number}/${installment.sequence_number}`, 20, 32);

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

  doc.save(`nota-promissoria-contrato-${contract.contract_number}-parcela-${installment.sequence_number}.pdf`);
}

function gerarExtratoPDF({ contract, installments, clientProfile, score, companyName }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(companyName, 20, 20);
  doc.setFontSize(11);
  doc.text(`Extrato do Contrato #${contract.contract_number}`, 20, 28);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Cliente: ${clientProfile.full_name || ''}`, 20, 38);
  doc.text(`CPF: ${clientProfile.cpf || '—'}`, 20, 44);

  if (score != null) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.text(String(score), 175, 22, { align: 'right' });
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text('Score do cliente', 175, 27, { align: 'right' });
  }

  const paid = installments.filter((i) => i.status === 'paga');
  const remaining = installments.filter((i) => i.status !== 'paga');
  const totalDue = installments.reduce((s, i) => s + Number(i.amount_due), 0);
  const totalPaid = paid.reduce((s, i) => s + Number(i.amount_due), 0);

  doc.setFillColor(244, 246, 247);
  doc.rect(20, 52, 170, 20, 'F');
  doc.setFontSize(9);
  doc.text('Dívida total', 25, 59);
  doc.text('Valor pago', 90, 59);
  doc.text('Parcelas restantes', 145, 59);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(formatMoney(totalDue), 25, 67);
  doc.text(formatMoney(totalPaid), 90, 67);
  doc.text(`${remaining.length} de ${installments.length}`, 145, 67);

  let y = 85;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  const cols = [20, 35, 75, 110, 140, 170];
  ['Nº', 'Vencimento', 'Data pgto', 'Valor', 'Status', ''].forEach((h, i) => doc.text(h, cols[i], y));
  doc.line(20, y + 2, 190, y + 2);
  y += 8;

  doc.setFont('helvetica', 'normal');
  installments.forEach((inst) => {
    if (y > 275) { doc.addPage(); y = 20; }
    const statusLabel = { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada', renovada: 'Renovada', cancelada: 'Cancelada' }[inst.status];
    doc.text(String(inst.sequence_number), cols[0], y);
    doc.text(formatDate(inst.due_date), cols[1], y);
    doc.text(inst.paid_at ? formatDate(inst.paid_at) : '—', cols[2], y);
    doc.text(formatMoney(inst.amount_due), cols[3], y);
    doc.text(statusLabel, cols[4], y);
    y += 7;
  });

  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text(`Documento gerado por ${companyName}`, 20, 290);

  doc.save(`extrato-contrato-${contract.contract_number}.pdf`);
}
