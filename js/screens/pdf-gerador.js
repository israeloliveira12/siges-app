/* ============================================================================
   Geração de PDF (nota promissória + extrato) — jsPDF via CDN, sem instalação
   ============================================================================ */

const MESES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Remove acentos/caracteres especiais para uso em nome de arquivo
function slugifyFilePart(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

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

// Monta as linhas do extrato — parcela(s) normal(is) quando o contrato nunca
// foi renovado (multi-parcela sempre cai aqui, já que renovação só existe pra
// parcela única), ou a cadeia completa (parcela + ciclos, relabeled por
// posição) quando já houve 1+ renovação — mesmo critério já usado em
// cliente-emprestimos.js/cliente-indicacoes.js, pra não divergir do que o
// cliente já vê na tela.
function buildExtratoRows(installments, cycles) {
  if (!cycles || !cycles.length) {
    return installments.map((i) => ({
      label: String(i.sequence_number),
      vencimento: i.due_date,
      dataPgto: i.paid_at,
      valor: Number(i.amount_due),
      status: { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada', renovada: 'Renovada', cancelada: 'Cancelada' }[i.status] || i.status,
    }));
  }
  const installment = installments[0];
  const rows = [];
  if (installment.status === 'renovada') {
    const nextCyc = cycles.find((c) => c.id === installment.renewed_into_cycle_id);
    rows.push({
      label: 'Renovação 1', vencimento: installment.due_date,
      dataPgto: nextCyc ? nextCyc.created_at : null,
      valor: nextCyc ? Number(nextCyc.interest_only_amount) : Number(installment.amount_due),
      status: 'Renovada',
    });
  } else {
    rows.push({
      label: String(installment.sequence_number), vencimento: installment.due_date,
      dataPgto: installment.paid_at, valor: Number(installment.amount_due),
      status: { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada' }[installment.status] || installment.status,
    });
  }
  cycles.slice().sort((a, b) => a.cycle_number - b.cycle_number).forEach((c) => {
    if (c.status === 'renovada') {
      const nextCyc = cycles.find((other) => other.previous_cycle_id === c.id);
      rows.push({
        label: 'Renovação ' + (c.cycle_number + 1), vencimento: c.new_due_date,
        dataPgto: nextCyc ? nextCyc.created_at : null,
        valor: nextCyc ? Number(nextCyc.interest_only_amount) : Number(c.full_debt_amount),
        status: 'Renovada',
      });
    } else {
      rows.push({
        label: '1', vencimento: c.new_due_date,
        dataPgto: c.paid_at, valor: Number(c.full_debt_amount),
        status: { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada' }[c.status] || c.status,
      });
    }
  });
  return rows;
}

async function gerarExtratoPDF({ contract, installments, cycles, clientProfile, score, companyName }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const NAVY = [11, 65, 107];
  const INK_SOFT = [91, 102, 99];
  const LINE = [220, 226, 223];
  // Logo sem fundo, direto sobre a página branca (mantém contraste do S navy —
  // colocá-la sobre uma faixa colorida a fazia sumir).
  const logoDataUrl = await loadImageDataUrl('icons/logo-mark.png');

  // Cabeçalho — minimalista: logo pequena + nome da empresa, sem faixa de cor
  if (logoDataUrl) {
    try { doc.addImage(logoDataUrl, 'PNG', 20, 14, 12, 12); } catch (e) { /* segue sem logo se o formato falhar */ }
  }
  doc.setTextColor(...NAVY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(companyName, 36, 20);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...INK_SOFT);
  doc.setFontSize(8.5);
  doc.text(`Extrato do Contrato #${contract.contract_number} · Emitido em ${formatDate(todayISO())}`, 36, 25.5);

  if (score != null) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...NAVY);
    doc.setFontSize(16);
    doc.text(String(score), 190, 18, { align: 'right' });
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...INK_SOFT);
    doc.text('SCORE DO CLIENTE', 190, 22.5, { align: 'right' });
  }

  doc.setDrawColor(...LINE);
  doc.setLineWidth(0.3);
  doc.line(20, 32, 190, 32);

  // Dados do cliente — texto simples, sem caixa preenchida
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...INK_SOFT);
  doc.text('CLIENTE', 20, 40);
  doc.text('CPF', 130, 40);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(20, 33, 43);
  doc.text(clientProfile.full_name || '—', 20, 46);
  doc.text(clientProfile.cpf || '—', 130, 46);

  doc.setDrawColor(...LINE);
  doc.line(20, 52, 190, 52);

  const rows = buildExtratoRows(installments, cycles);
  const hasChain = cycles && cycles.length > 0;

  // Resumo — três colunas de texto simples, sem blocos coloridas. Contrato
  // nunca renovado (ou multi-parcela, que nunca tem ciclos) usa o resumo de
  // sempre; contrato de parcela única já renovado usa um resumo baseado na
  // cadeia inteira (dívida original, total já pago somando todas as
  // renovações, e a situação atual), já que "parcelas restantes" não faz
  // sentido pra um contrato que só tem 1 parcela na vida.
  let summary;
  if (hasChain) {
    const lastRow = rows[rows.length - 1];
    const isQuitado = lastRow.status === 'Paga';
    const totalPago = rows.reduce((s, r, idx) => (idx < rows.length - 1 ? s + r.valor : s + (isQuitado ? r.valor : 0)), 0);
    const saldoAberto = isQuitado ? 0 : lastRow.valor;
    summary = [
      { label: 'DÍVIDA ORIGINAL', value: formatMoney(installments[0].amount_due) },
      { label: 'TOTAL JÁ PAGO', value: formatMoney(totalPago) },
      { label: isQuitado ? 'SITUAÇÃO' : 'SALDO EM ABERTO', value: isQuitado ? 'Quitado' : formatMoney(saldoAberto) },
    ];
  } else {
    const paid = installments.filter((i) => i.status === 'paga');
    const remaining = installments.filter((i) => i.status !== 'paga');
    const totalDue = installments.reduce((s, i) => s + Number(i.amount_due), 0);
    const totalPaid = paid.reduce((s, i) => s + Number(i.amount_due), 0);
    summary = [
      { label: 'DÍVIDA TOTAL', value: formatMoney(totalDue) },
      { label: 'VALOR PAGO', value: formatMoney(totalPaid) },
      { label: 'PARCELAS RESTANTES', value: `${remaining.length} de ${installments.length}` },
    ];
  }
  const colW = 170 / 3;
  summary.forEach((c, i) => {
    const x = 20 + i * colW;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...INK_SOFT);
    doc.text(c.label, x, 60);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...NAVY);
    doc.text(c.value, x, 67);
  });

  doc.setDrawColor(...LINE);
  doc.line(20, 73, 190, 73);

  // Tabela de parcelas — cabeçalho com sublinha fina, sem preenchimento
  let y = 84;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...INK_SOFT);
  const cols = [20, 40, 76, 112, 143, 176];
  ['Parcela', 'Vencimento', 'Data pgto', 'Valor', 'Status', ''].forEach((h, i) => doc.text(h, cols[i], y));
  doc.setDrawColor(...NAVY);
  doc.setLineWidth(0.4);
  doc.line(20, y + 2.5, 190, y + 2.5);
  y += 10;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(20, 33, 43);
  rows.forEach((r) => {
    if (y > 270) {
      doc.addPage();
      y = 24;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(...INK_SOFT);
      ['Parcela', 'Vencimento', 'Data pgto', 'Valor', 'Status', ''].forEach((h, i) => doc.text(h, cols[i], y));
      doc.setDrawColor(...NAVY);
      doc.line(20, y + 2.5, 190, y + 2.5);
      y += 10;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(20, 33, 43);
    }
    doc.text(r.label, cols[0], y);
    doc.text(formatDate(r.vencimento), cols[1], y);
    doc.text(r.dataPgto ? formatDateUTC(r.dataPgto) : '—', cols[2], y);
    doc.text(formatMoney(r.valor), cols[3], y);
    doc.text(r.status, cols[4], y);
    doc.setDrawColor(240, 242, 240);
    doc.setLineWidth(0.2);
    doc.line(20, y + 2.5, 190, y + 2.5);
    y += 8;
  });

  addExtratoFooter(doc, companyName);
  const nomeArquivo = slugifyFilePart(clientProfile && clientProfile.full_name);
  doc.save(`extrato_${nomeArquivo ? nomeArquivo + '_' : ''}contrato_${contract.contract_number}.pdf`);
}
