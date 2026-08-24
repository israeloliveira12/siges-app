// Wrapper fino — a lógica real vive em api/cron-daily-check.js e nunca é duplicada aqui.
//
// `config.schedule` é a convenção atual (2024+) do Netlify Scheduled
// Functions — mesmo cron "0 10 * * *" já usado em vercel.json. NÃO testado
// contra uma conta Netlify real (sem acesso nesta sessão) — antes de ativar
// de verdade, confirme esse formato na documentação do Netlify na hora da
// migração, já que plataformas mudam essa sintaxe com alguma frequência.
//
// `injectCronSecret` (auditoria 2026-08-23): o agendador do Netlify invoca a
// função INTERNAMENTE e não manda o header Authorization que a Vercel Cron
// injeta a partir de CRON_SECRET. Sem isso, o handler — que desde a auditoria
// falha fechado quando o segredo não confere — recusaria toda execução
// agendada com 401. O adaptador só injeta quando `x-nf-event: schedule` está
// presente, marca que só a invocação interna do Netlify carrega.
import vercelHandler from '../../api/cron-daily-check.js';
import { adaptVercelHandler } from './_adapter.mjs';

export const handler = adaptVercelHandler(vercelHandler, { injectCronSecret: true });
export const config = { schedule: '0 10 * * *' };
