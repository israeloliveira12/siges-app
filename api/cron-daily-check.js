/* ============================================================================
   GET /api/cron-daily-check — roda 1x/dia (Vercel Cron, ver vercel.json).

   Reescrito na auditoria de 2026-08-23 (achados OPS-01, OPS-02, SEC-10).
   O que mudou e por quê:

   - SEC-10: o segredo do cron falhava ABERTO. `authHeader !== 'Bearer ' +
     process.env.CRON_SECRET` com a variável ausente comparava contra a string
     literal "Bearer undefined" — quem adivinhasse isso entrava. Agora recusa
     tudo quando a variável não está configurada.

   - OPS-01: as chamadas de RPC eram `await` solto, sem conferir o resultado.
     refresh_overdue_status() estava quebrada havia tempo (subconsulta escalar
     sobre system_settings, que virou uma linha por empresa) e ninguém sabia,
     porque a falha não aparecia em lugar nenhum. Agora cada tarefa registra o
     próprio desfecho em cron_runs, que alimenta a tela "Saúde da Plataforma".

   - OPS-02: a busca de parcelas não tinha `limit` (então o PostgREST cortava
     em 1.000 para a plataforma INTEIRA) e cada parcela disparava ~5 chamadas
     HTTP em série — mil parcelas eram cinco mil idas e voltas, uma de cada
     vez, e a função estourava o tempo no meio. Agora uma única RPC devolve a
     fila do dia já montada e deduplicada, e o despacho é paralelo com
     concorrência limitada.
   ============================================================================ */

import { supabaseAdminFetch } from './_lib/supabaseAdmin.js';
import { sendEmailViaResend, renderEmailHtml } from './_lib/email.js';
import { sendPush } from './_lib/webpush.js';

// Teto de itens despachados por execução. Com CONCURRENCY=8 e ~4 chamadas por
// item, cabe folgado no limite de tempo da função; o que sobrar é reportado
// como "na fila" e sai na execução seguinte.
const BATCH_LIMIT = 400;
const CONCURRENCY = 8;

const EVENT_TITLES = {
  vence_amanha: 'Parcela vence amanhã',
  vence_hoje: 'Parcela vence hoje',
  atrasada: 'Parcela em atraso',
};

const EMAIL_SUBJECTS = {
  vence_amanha: 'Parcela vence amanhã — SIGES',
  vence_hoje: 'Parcela vence hoje — SIGES',
  atrasada: 'Parcela em atraso — SIGES',
};

function money(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function dateBR(iso) {
  return String(iso || '').split('-').reverse().join('/');
}

async function recordRun(job, status, extra = {}) {
  await supabaseAdminFetch('/rest/v1/rpc/record_cron_run', {
    method: 'POST',
    body: JSON.stringify({
      p_job: job,
      p_status: status,
      p_message: extra.message || null,
      p_duration_ms: extra.durationMs != null ? Math.round(extra.durationMs) : null,
      p_processed: extra.processed != null ? extra.processed : null,
      p_remaining: extra.remaining != null ? extra.remaining : null,
    }),
  });
}

// Roda uma RPC sem parâmetros e registra o desfecho. Devolve true se deu certo.
async function runJob(job, rpcName) {
  const started = Date.now();
  const res = await supabaseAdminFetch(`/rest/v1/rpc/${rpcName}`, { method: 'POST', body: JSON.stringify({}) });
  const durationMs = Date.now() - started;
  if (res.ok) {
    await recordRun(job, 'ok', { durationMs });
    return true;
  }
  const message = (res.data && (res.data.message || res.data.hint || res.data.details)) || `HTTP ${res.status}`;
  await recordRun(job, 'falhou', { durationMs, message });
  return false;
}

// Despacha um item da fila: grava o in_app, manda e-mail e push.
async function dispatchOne(item, companyByTenant) {
  const isInstallment = item.kind === 'installment';
  const title = EVENT_TITLES[item.event] || 'SIGES';
  const body = isInstallment
    ? `Contrato #${item.contract_number}, parcela de ${money(item.amount)}, vencimento ${dateBR(item.due_date)}.`
    : `Contrato #${item.contract_number} (renovação), valor de ${money(item.amount)}, vencimento ${dateBR(item.due_date)}.`;

  // O in_app entra primeiro: é ele que a próxima execução usa para deduplicar.
  const logRes = await supabaseAdminFetch('/rest/v1/notifications_log', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      recipient_id: item.client_id,
      event: item.event,
      channel: 'in_app',
      title,
      body,
      related_contract_id: item.contract_id,
      related_installment_id: isInstallment ? item.ref_id : null,
    }),
  });
  if (!logRes.ok) return false;

  const companyName = companyByTenant.get(item.client_id) || null;

  await Promise.allSettled([
    (async () => {
      if (!item.client_email) return;
      const result = await sendEmailViaResend({
        to: item.client_email,
        subject: EMAIL_SUBJECTS[item.event] || 'SIGES',
        html: renderEmailHtml({ title, body, companyName }),
      });
      await supabaseAdminFetch('/rest/v1/notifications_log', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          recipient_id: item.client_id, event: item.event, channel: 'email', title, body,
          related_contract_id: item.contract_id,
          related_installment_id: isInstallment ? item.ref_id : null,
          delivery_status: result.ok ? 'sent' : 'failed',
          provider_response: result.ok ? result.data : { error: result.error, ...result.data },
        }),
      });
    })(),
    (async () => {
      const subsRes = await supabaseAdminFetch(`/rest/v1/push_subscriptions?profile_id=eq.${item.client_id}&select=*`, { method: 'GET' });
      for (const sub of (subsRes.ok ? subsRes.data : [])) {
        try {
          const r = await sendPush(sub, { title, body, url: './#/cliente/emprestimos' });
          if (r.status === 404 || r.status === 410) {
            await supabaseAdminFetch(`/rest/v1/push_subscriptions?id=eq.${sub.id}`, { method: 'DELETE' });
          }
        } catch (e) { /* uma inscrição morta não derruba as outras */ }
      }
    })(),
  ]);

  return true;
}

// Pool simples de trabalhadores — mantém no máximo CONCURRENCY despachos em
// voo ao mesmo tempo, sem depender de biblioteca externa.
async function runPool(items, worker, concurrency) {
  let index = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      try { if (await worker(items[i])) done++; } catch (e) { /* item isolado */ }
    }
  });
  await Promise.all(runners);
  return done;
}

export default async function handler(req, res) {
  // SEC-10: falha fechada. Sem CRON_SECRET configurado, ninguém entra.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) { res.status(500).json({ error: 'CRON_SECRET não configurado' }); return; }
  if ((req.headers.authorization || '') !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: 'Não autorizado' });
    return;
  }

  const summary = {};

  // 1. Manutenção de status. Se refresh_overdue_status falhar, a fila de
  // avisos abaixo fica incompleta (depende dos status recalculados), mas o
  // resto ainda roda — e agora a falha fica registrada.
  summary.refresh_overdue_status = await runJob('refresh_overdue_status', 'refresh_overdue_status');
  summary.capture_platform_metrics_snapshot = await runJob('capture_platform_metrics_snapshot', 'capture_platform_metrics_snapshot');
  summary.refresh_tenant_payment_status = await runJob('refresh_tenant_payment_status', 'refresh_tenant_payment_status');

  // 2. Avisos de vencimento — uma RPC devolve a fila inteira já deduplicada.
  const started = Date.now();
  const queueRes = await supabaseAdminFetch('/rest/v1/rpc/pending_due_notifications', {
    method: 'POST',
    body: JSON.stringify({ p_limit: BATCH_LIMIT }),
    timeoutMs: 20000,
  });

  if (!queueRes.ok) {
    const message = (queueRes.data && (queueRes.data.message || queueRes.data.hint)) || `HTTP ${queueRes.status}`;
    await recordRun('avisos_vencimento', 'falhou', { durationMs: Date.now() - started, message });
    res.status(200).json({ ok: false, ...summary, notified: 0, error: message });
    return;
  }

  const queue = Array.isArray(queueRes.data) ? queueRes.data : [];

  // Nome da empresa por tenant, resolvido de uma vez só (o rodapé do e-mail
  // usa isso) — evita uma consulta por destinatário.
  const companyByTenant = new Map();
  if (queue.length) {
    const clientIds = [...new Set(queue.map((q) => q.client_id))];
    const profRes = await supabaseAdminFetch(
      `/rest/v1/profiles?id=in.(${clientIds.join(',')})&select=id,tenant_id`, { method: 'GET' }
    );
    const settingsRes = await supabaseAdminFetch('/rest/v1/system_settings?select=tenant_id,company_name', { method: 'GET' });
    const nameByTenant = new Map((settingsRes.ok ? settingsRes.data : []).map((s) => [s.tenant_id, s.company_name]));
    for (const p of (profRes.ok ? profRes.data : [])) {
      companyByTenant.set(p.id, nameByTenant.get(p.tenant_id) || null);
    }
  }

  const notified = await runPool(queue, (item) => dispatchOne(item, companyByTenant), CONCURRENCY);
  const durationMs = Date.now() - started;

  // Quantos sobraram para a próxima execução.
  const remainingRes = await supabaseAdminFetch('/rest/v1/rpc/pending_due_notifications_count', {
    method: 'POST', body: JSON.stringify({}),
  });
  const remaining = remainingRes.ok && typeof remainingRes.data === 'number' ? remainingRes.data : null;

  await recordRun('avisos_vencimento', remaining ? 'parcial' : 'ok', {
    durationMs,
    processed: notified,
    remaining,
    message: remaining ? `${remaining} ainda na fila para a próxima execução` : null,
  });

  res.status(200).json({ ok: true, ...summary, notified, remaining });
}
