// Wrapper fino — a lógica real vive em api/delete-tenant.js e nunca é duplicada aqui.
import vercelHandler from '../../api/delete-tenant.js';
import { adaptVercelHandler } from './_adapter.mjs';

export const handler = adaptVercelHandler(vercelHandler);
