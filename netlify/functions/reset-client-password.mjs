// Wrapper fino — a lógica real vive em api/reset-client-password.js e nunca é duplicada aqui.
import vercelHandler from '../../api/reset-client-password.js';
import { adaptVercelHandler } from './_adapter.mjs';

export const handler = adaptVercelHandler(vercelHandler);
