// Keep the deadline active through response-body reads. A timeout never means a write failed.
// No automatic retry: financial controllers must reuse their existing request ID.
import { financialJsonText } from './financial-json.js';
export function createTimedFetch(
  request = (...args) => globalThis.fetch(...args),
  timeoutMs = 20000,
) {
  return async (input, options = {}) => {
    const upstream = options.signal ?? (typeof input === 'object' ? input.signal : null);
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = upstream ? AbortSignal.any([upstream, deadline]) : deadline;
    const response = await request(input, {
      ...options,
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
    if (response?.ok && response.headers?.get('content-type')?.includes('application/json')) {
      const url = typeof input === 'string' || input instanceof URL ? input : input.url;
      const pathname = new URL(url, globalThis.location?.href).pathname;
      if (
        /^\/rest\/v1\/rpc\/(?:dm_get_balance|dm_get_overview|dm_list_debts|dm_private_write|dm_private_legacy)$/.test(
          pathname,
        )
      ) {
        const body = financialJsonText(await response.text());
        const headers = new Headers(response.headers);
        headers.delete('Content-Length');
        headers.delete('Content-Encoding');
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    }
    return response;
  };
}
