// Wrapper fino — a lógica real vive em api/wipe-all-data.js e nunca é duplicada aqui.
import vercelHandler from '../../api/wipe-all-data.js';
import { adaptVercelHandler } from './_adapter.mjs';

export const handler = adaptVercelHandler(vercelHandler);
