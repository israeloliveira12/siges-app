// Wrapper fino — a lógica real vive em api/create-user.js e nunca é duplicada aqui.
import vercelHandler from '../../api/create-user.js';
import { adaptVercelHandler } from './_adapter.mjs';

export const handler = adaptVercelHandler(vercelHandler);
