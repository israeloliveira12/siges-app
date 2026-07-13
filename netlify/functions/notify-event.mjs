// Wrapper fino — a lógica real vive em api/notify-event.js e nunca é duplicada aqui.
import vercelHandler from '../../api/notify-event.js';
import { adaptVercelHandler } from './_adapter.mjs';

export const handler = adaptVercelHandler(vercelHandler);
