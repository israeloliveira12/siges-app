// Wrapper fino — a lógica real vive em api/delete-client.js e nunca é duplicada aqui.
import vercelHandler from '../../api/delete-client.js';
import { adaptVercelHandler } from './_adapter.mjs';

export const handler = adaptVercelHandler(vercelHandler);
