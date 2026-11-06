// ob-track — statistiche anonime delle email di Callforus Outbound.
//   GET /ob-track/o?s=<step>&n=<codice>&t=<invio>          → immagine 1×1, conta un'apertura
//   GET /ob-track/c?s=<step>&n=<codice>&t=<invio>&u=<link> → conta un clic e porta al link
// <codice> è casuale per ogni email e non è salvato con il contatto: si contano email aperte, non chi le ha aperte.
// Il redirect porta solo ai domini in outbound_link_hosts (niente redirect verso siti a caso).
// Deploy con verify_jwt = false: viene chiamata dai programmi di posta, senza login.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (ch) => ch.charCodeAt(0));
const NONCE = /^[a-z0-9]{8,40}$/;
// filtri antispam aziendali, anteprime e script: aprono e cliccano da soli, li teniamo fuori dai numeri
const BOT_UA = /bot|crawl|spider|preview|scan|proofpoint|mimecast|barracuda|bitdefender|forcepoint|python|curl|wget|go-http|headless|monitor|zgrab/i;
// Dove rimandare chi clicca un link non ammesso. Impostalo con: supabase secrets set OB_FALLBACK_URL=https://tuo-sito.it/
const FALLBACK = Deno.env.get('OB_FALLBACK_URL') || '';
const noStore = { 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache', Expires: '0' };

let hosts: string[] = [];
let hostsAt = 0;
async function allowedHosts() {
  if (Date.now() - hostsAt > 5 * 60 * 1000) {
    const { data } = await sb.from('outbound_link_hosts').select('host');
    hosts = (data || []).map((r: { host: string }) => r.host.toLowerCase());
    hostsAt = Date.now();
  }
  return hosts;
}
async function isAllowed(target: string) {
  try {
    const u = new URL(target);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase();
    return (await allowedHosts()).some((a) => h === a || h.endsWith('.' + a));
  } catch {
    return false;
  }
}
function isBot(req: Request, sentAt: number) {
  const ua = req.headers.get('user-agent') || '';
  const age = sentAt > 0 ? Date.now() / 1000 - sentAt : Infinity;
  return req.method === 'HEAD' || BOT_UA.test(ua) || (age >= 0 && age < 20); // nessuna persona apre in meno di 20 secondi
}
async function record(row: Record<string, unknown>) {
  const { error } = await sb.from('outbound_events').insert(row);
  if (error) console.error('ob-track insert', error.message);
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const kind = u.pathname.split('/').filter(Boolean).pop();
  const step = Number(u.searchParams.get('s'));
  const n = (u.searchParams.get('n') || '').toLowerCase();
  const t = Number(u.searchParams.get('t') || 0);
  const valid = Number.isInteger(step) && step >= 0 && step <= 20 && NONCE.test(n);

  if (kind === 'c') {
    const target = u.searchParams.get('u') || '';
    let dest = FALLBACK;
    if (target.length <= 2000 && (await isAllowed(target))) {
      dest = target;
      if (valid) await record({ type: 'click', step, nonce: n, url: target, bot: isBot(req, t) });
    }
    if (!dest) return new Response(null, { status: 204, headers: noStore });
    return new Response(null, { status: 302, headers: { Location: dest, 'Referrer-Policy': 'no-referrer', ...noStore } });
  }

  if (kind === 'o' && valid) await record({ type: 'open', step, nonce: n, bot: isBot(req, t) });
  return new Response(req.method === 'HEAD' ? null : GIF, { headers: { 'Content-Type': 'image/gif', ...noStore } });
});
