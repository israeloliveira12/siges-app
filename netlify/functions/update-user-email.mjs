// Wrapper fino — a lógica real vive em api/update-user-email.js e nunca é duplicada aqui.
import vercelHandler from '../../api/update-user-email.js';
import { adaptVercelHandler } from './_adapter.mjs';

export const handler = adaptVercelHandler(vercelHandler);
