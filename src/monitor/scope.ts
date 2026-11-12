/**
 * Which turn is running. The request handler runs each turn inside `turnScope`, so
 * code deep in the call stack — MSAL's token refresh, the image upload, the chat
 * socket's egress check — can be tied back to the turn that caused it without
 * threading an id through every signature.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export const turnScope = new AsyncLocalStorage<string>();
