// ---------------------------------------------------------------------------
// Session token store.
//
// The token is held in memory only — never localStorage, never a cookie.
// A page refresh requires re-authentication, which is the right tradeoff
// for a wallet-authenticated app: the user reconnects their wallet anyway.
// ---------------------------------------------------------------------------

let token = null;

export function setSessionToken(t) {
  token = t;
}

export function getSessionToken() {
  return token;
}

export function clearSessionToken() {
  token = null;
}

/**
 * A fetch wrapper that injects the session token into every request.
 * Drop-in replacement for the global fetch in gateway.js.
 */
export async function authFetch(url, opts = {}) {
  const token = getSessionToken();
  const headers = { ...(opts.headers || {}) };
  if (token) headers['X-Session-Token'] = token;

  // If this is a /api/pay call, freeze the quote to prevent mutation
  if (url.includes('/api/pay') && opts.body) {
    const body = JSON.parse(opts.body);
    if (body.quote) Object.freeze(body.quote);
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, { ...opts, headers });

  if (res.status === 401) {
    clearSessionToken();
    window.dispatchEvent(new CustomEvent('agentfloat:session-expired'));
  }
  return res;
}