const send = msg => new Promise((res, rej) => chrome.runtime.sendMessage(msg, r => {
  if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
  r && r.ok ? res(r.data) : rej(new Error((r && r.error) || 'Errore'));
}));
const $ = id => document.getElementById(id);

async function show() {
  const st = await send({ type: 'status' }).catch(() => ({ logged: false }));
  $('login').hidden = !!st.logged;
  $('in').hidden = !st.logged;
  if (!st.logged) { setTimeout(() => $('em').focus(), 30); return; }
  $('who').textContent = st.email;
  $('allowed').textContent = st.allowed ? 'Accesso abilitato: il pannello compare su amazon.it.' : 'Questo account non è abilitato in Outbound (tabella ob_users).';
  const cfg = await send({ type: 'config' });
  $('app').href = cfg.appUrl;
  const s = await send({ type: 'settings:get' });
  $('max').value = s.maxPerSessione; $('pmin').value = s.pausaMinSec; $('pmax').value = s.pausaMaxSec;
}

$('f').addEventListener('submit', async e => {
  e.preventDefault();
  $('msg').textContent = ''; $('go').disabled = true; $('go').textContent = 'Accesso…';
  try { await send({ type: 'login', email: $('em').value, password: $('pw').value }); await show(); }
  catch (err) { $('msg').textContent = err.message; }
  $('go').disabled = false; $('go').textContent = 'Accedi';
});
$('out').addEventListener('click', async () => { await send({ type: 'logout' }); show(); });
['max', 'pmin', 'pmax'].forEach(id => $(id).addEventListener('change', async () => {
  const max = Math.max(1, Math.min(100, +$('max').value || 30));
  const pmin = Math.max(3, Math.min(60, +$('pmin').value || 6));
  const pmax = Math.max(pmin, Math.min(120, +$('pmax').value || 12));
  $('max').value = max; $('pmin').value = pmin; $('pmax').value = pmax;
  await send({ type: 'settings:set', value: { maxPerSessione: max, pausaMinSec: pmin, pausaMaxSec: pmax } });
}));
show();
