// Wrapper fino — a lógica real vive em api/cron-daily-check.js e nunca é duplicada aqui.
//
// `config.schedule` é a convenção atual (2024+) do Netlify Scheduled
// Functions — mesmo cron "0 10 * * *" já usado em vercel.json. NÃO testado
// contra uma conta Netlify real (sem acesso nesta sessão) — antes de ativar
// de verdade, confirme esse formato na documentação do Netlify na hora da
// migração, já que plataformas mudam essa sintaxe com alguma frequência.
import vercelHandler from '../../api/cron-daily-check.js';
import { adaptVercelHandler } from './_adapter.mjs';

export const handler = adaptVercelHandler(vercelHandler);
export const config = { schedule: '0 10 * * *' };
