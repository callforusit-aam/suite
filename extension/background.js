/* Callforus Prospect — service worker
   Tiene la sessione Supabase (login con lo stesso account di Outbound) e fa da tramite
   per le chiamate al database: il content script su amazon.it non vede mai i token. */
importScripts('config.js');

const C = self.CFP_CONFIG;
const SKEY = 'cfp_session';

async function getSession() {
  const o = await chrome.storage.local.get(SKEY);
  return o[SKEY] || null;
}
async function setSession(s) {
  if (s) await chrome.storage.local.set({ [SKEY]: s });
  else await chrome.storage.local.remove(SKEY);
}

async function authRequest(grant, body) {
  const r = await fetch(`${C.supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: C.supabaseKey },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error_description || j.msg || j.message || ('Errore ' + r.status);
    throw new Error(/invalid login/i.test(msg) ? 'Email o password non corretti.' : msg);
  }
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (j.expires_in || 3600) * 1000,
    email: (j.user && j.user.email) || '',
  };
}

let refreshing = null;
async function getToken() {
  const s = await getSession();
  if (!s) throw new Error('Accedi dall\'icona dell\'estensione.');
  if (Date.now() < s.expires_at - 60000) return s.access_token;
  if (!refreshing) {
    refreshing = authRequest('refresh_token', { refresh_token: s.refresh_token })
      .then(async ns => { await setSession(ns); return ns.access_token; })
      .catch(async e => { await setSession(null); throw new Error('Sessione scaduta: accedi di nuovo dall\'icona dell\'estensione.'); })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function rest(method, path, body, prefer) {
  const token = await getToken();
  const headers = { apikey: C.supabaseKey, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${C.supabaseUrl}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  if (!r.ok) {
    const msg = (data && (data.message || data.hint)) || ('Errore database ' + r.status);
    throw new Error(msg);
  }
  return data;
}

async function status() {
  const s = await getSession();
  if (!s) return { logged: false };
  try {
    const ok = await rest('POST', 'rpc/ob_is_user', {});
    return { logged: true, email: s.email, allowed: ok === true };
  } catch (e) {
    return { logged: !!(await getSession()), email: s.email, allowed: false, error: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg && msg.type) {
      case 'login': {
        const s = await authRequest('password', { email: String(msg.email || '').trim().toLowerCase(), password: msg.password || '' });
        await setSession(s);
        return status();
      }
      case 'logout': await setSession(null); return { logged: false };
      case 'status': return status();
      case 'rest': return rest(msg.method || 'GET', msg.path, msg.body, msg.prefer);
      case 'settings:get': {
        const o = await chrome.storage.local.get('cfp_settings');
        return Object.assign({ maxPerSessione: C.maxPerSessione, pausaMinSec: C.pausaMinSec, pausaMaxSec: C.pausaMaxSec }, o.cfp_settings || {});
      }
      case 'settings:set': await chrome.storage.local.set({ cfp_settings: msg.value || {} }); return true;
      case 'config': return { appUrl: C.appUrl };
      default: throw new Error('Messaggio sconosciuto');
    }
  })().then(data => reply({ ok: true, data }), e => reply({ ok: false, error: e.message || String(e) }));
  return true; // risposta asincrona
});
