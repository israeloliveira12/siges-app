/* ============================================================================
   GET /api/cron-daily-check — roda 1x/dia (Vercel Cron, ver vercel.json).
   1. Chama refresh_overdue_status() no banco.
   2. Notifica clientes: parcela vence amanhã, vence hoje, ou está atrasada
      (atrasada dispara TODO dia enquanto continuar em atraso).
   3. Evita notificação duplicada no mesmo dia checando notifications_log.
   ============================================================================ */

import { supabaseAdminFetch } from './_lib/supabaseAdmin.js';
import { sendEmailViaResend } from './_lib/email.js';
import { sendEmptyPush } from './_lib/webpush.js';

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function addDaysISO(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function money(v) { return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }

const EVENT_TITLES = {
  vence_amanha: 'Parcela vence amanhã',
  vence_hoje: 'Parcela vence hoje',
  atrasada: 'Parcela em atraso',
};

async function alreadyNotifiedToday(recipientId, event, relatedField, relatedId) {
  const startOfDay = todayISO() + 'T00:00:00Z';
  const query = `/rest/v1/notifications_log?recipient_id=eq.${recipientId}&event=eq.${event}&${relatedField}=eq.${relatedId}&sent_at=gte.${startOfDay}&select=id&limit=1`;
  const res = await supabaseAdminFetch(query, { method: 'GET' });
  return res.ok && Array.isArray(res.data) && res.data.length > 0;
}

async function notifyClient({ clientId, event, title, body, contractId, installmentId }) {
  const dedupField = installmentId ? 'related_installment_id' : 'related_contract_id';
  const dedupId = installmentId || contractId;
  if (await alreadyNotifiedToday(clientId, event, dedupField, dedupId)) return false;

  await supabaseAdminFetch('/rest/v1/notifications_log', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      recipient_id: clientId, event, channel: 'in_app', title, body,
      related_contract_id: contractId || null, related_installment_id: installmentId || null,
    }),
  });

  const clientRes = await supabaseAdminFetch(`/rest/v1/profiles?id=eq.${clientId}&select=email`, { method: 'GET' });
  const email = clientRes.ok && clientRes.data[0] && clientRes.data[0].email;

  const tasks = [];
  if (email) {
    tasks.push((async () => {
      const result = await sendEmailViaResend({
        to: email, subject: title + ' — SIGES',
        html: `<div style="font-family:Arial,sans-serif"><h2 style="color:#0B416B">${title}</h2><p>${body}</p><p style="color:#5B6B74;font-size:12px">Siges Serviços Financeiros</p></div>`,
      });
      // Grava o resultado (mesmo em falha) — dá pra diagnosticar problemas de
      // entrega (ex: domínio do Resend não verificado) direto na tabela.
      await supabaseAdminFetch('/rest/v1/notifications_log', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          recipient_id: clientId, event, channel: 'email', title, body,
          related_contract_id: contractId || null, related_installment_id: installmentId || null,
          delivery_status: result.ok ? 'sent' : 'failed',
          provider_response: result.ok ? result.data : { error: result.error, ...result.data },
        }),
      });
    })());
  }
  const subsRes = await supabaseAdminFetch(`/rest/v1/push_subscriptions?profile_id=eq.${clientId}&select=*`, { method: 'GET' });
  const subs = subsRes.ok ? subsRes.data : [];
  for (const sub of subs) {
    tasks.push(sendEmptyPush(sub).catch(() => null));
  }
  await Promise.allSettled(tasks);
  return true;
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) { res.status(401).json({ error: 'Não autorizado' }); return; }

  await supabaseAdminFetch('/rest/v1/rpc/refresh_overdue_status', { method: 'POST', body: JSON.stringify({}) });

  const today = todayISO();
  const tomorrow = addDaysISO(today, 1);
  let notified = 0;

  // Parcelas: vence amanhã / vence hoje / atrasada
  const instRes = await supabaseAdminFetch(
    `/rest/v1/installments?status=in.(pendente,atrasada)&select=id,contract_id,due_date,amount_due,status,loan_contracts!installments_contract_id_fkey(client_id,contract_number)`,
    { method: 'GET' }
  );
  for (const inst of (instRes.ok ? instRes.data : [])) {
    const contract = inst.loan_contracts;
    if (!contract) continue;
    let event = null;
    if (inst.status === 'atrasada') event = 'atrasada';
    else if (inst.due_date === today) event = 'vence_hoje';
    else if (inst.due_date === tomorrow) event = 'vence_amanha';
    if (!event) continue;

    const body = `Contrato #${contract.contract_number}, parcela de ${money(inst.amount_due)}, vencimento ${inst.due_date.split('-').reverse().join('/')}.`;
    const sent = await notifyClient({
      clientId: contract.client_id, event, title: EVENT_TITLES[event], body,
      contractId: inst.contract_id, installmentId: inst.id,
    });
    if (sent) notified++;
  }

  // Ciclos de renovação: mesmas regras, usando new_due_date
  const cycRes = await supabaseAdminFetch(
    `/rest/v1/renewal_cycles?status=in.(pendente,atrasada)&select=id,contract_id,new_due_date,full_debt_amount,status,loan_contracts!renewal_cycles_contract_id_fkey(client_id,contract_number)`,
    { method: 'GET' }
  );
  for (const cyc of (cycRes.ok ? cycRes.data : [])) {
    const contract = cyc.loan_contracts;
    if (!contract) continue;
    let event = null;
    if (cyc.status === 'atrasada') event = 'atrasada';
    else if (cyc.new_due_date === today) event = 'vence_hoje';
    else if (cyc.new_due_date === tomorrow) event = 'vence_amanha';
    if (!event) continue;

    const body = `Contrato #${contract.contract_number} (renovação), valor de ${money(cyc.full_debt_amount)}, vencimento ${cyc.new_due_date.split('-').reverse().join('/')}.`;
    const sent = await notifyClient({
      clientId: contract.client_id, event, title: EVENT_TITLES[event], body,
      contractId: cyc.contract_id, installmentId: null,
    });
    if (sent) notified++;
  }

  res.status(200).json({ ok: true, notified });
}
