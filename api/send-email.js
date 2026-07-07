/* ============================================================================
   POST /api/send-email — envia um e-mail avulso via Resend.
   Chamada server-to-server (protegida por CRON_SECRET), nunca do navegador.
   ============================================================================ */

import { sendEmailViaResend } from './_lib/email.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido' }); return; }

  const secret = req.headers['x-internal-secret'];
  if (secret !== process.env.CRON_SECRET) { res.status(401).json({ error: 'Não autorizado' }); return; }

  const { to, subject, html } = req.body || {};
  if (!to || !subject || !html) { res.status(400).json({ error: 'Parâmetros ausentes (to, subject, html)' }); return; }

  const result = await sendEmailViaResend({ to, subject, html });
  if (!result.ok) { res.status(502).json({ error: (result.data && result.data.message) || result.error || 'Falha ao enviar e-mail' }); return; }
  res.status(200).json({ ok: true, id: result.data && result.data.id });
}
