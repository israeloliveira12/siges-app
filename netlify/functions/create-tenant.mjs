// Wrapper fino — a lógica real vive em api/create-tenant.js e nunca é duplicada aqui.
import vercelHandler from '../../api/create-tenant.js';
import { adaptVercelHandler } from './_adapter.mjs';

export const handler = adaptVercelHandler(vercelHandler);
