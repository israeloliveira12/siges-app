/* ============================================================================
   POST /api/send-push — envia um Web Push "vazio" para todas as inscrições
   de um usuário. Chamada server-to-server (protegida por CRON_SECRET).
   ============================================================================ */

import { sendEmptyPush } from './_lib/webpush.js';
import { supabaseAdminFetch } from './_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido' }); return; }

  const secret = req.headers['x-internal-secret'];
  if (secret !== process.env.CRON_SECRET) { res.status(401).json({ error: 'Não autorizado' }); return; }

  const { profile_id } = req.body || {};
  if (!profile_id) { res.status(400).json({ error: 'profile_id ausente' }); return; }

  const subsRes = await supabaseAdminFetch(`/rest/v1/push_subscriptions?profile_id=eq.${profile_id}&select=*`, { method: 'GET' });
  const subscriptions = subsRes.ok ? subsRes.data : [];

  const results = [];
  for (const sub of subscriptions) {
    try {
      const pushRes = await sendEmptyPush(sub);
      if (pushRes.status === 404 || pushRes.status === 410) {
        await supabaseAdminFetch(`/rest/v1/push_subscriptions?id=eq.${sub.id}`, { method: 'DELETE' });
      }
      results.push({ id: sub.id, status: pushRes.status });
    } catch (e) {
      results.push({ id: sub.id, error: String(e) });
    }
  }

  res.status(200).json({ ok: true, sent: results.length, results });
}
