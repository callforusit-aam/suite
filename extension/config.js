/* Configurazione dell'estensione Callforus Prospect.
   Sono gli stessi valori di APP_DEFAULTS in index.html: indirizzo e chiave pubblica
   del progetto Supabase di Callforus. I dati restano protetti dal login e da ob_users. */
const CFP_CONFIG = {
  supabaseUrl: 'https://mxkasinotmqqqdcpidrn.supabase.co',
  supabaseKey: 'sb_publishable__pMjCkStlmcyrthmp_x0Cw_AjP4ven1',
  appUrl: 'https://callforusit-aam.github.io/suite/',
  // valori predefiniti, modificabili dal pannello dell'estensione
  maxPerSessione: 30,
  pausaMinSec: 6,
  pausaMaxSec: 12,
};
if (typeof self !== 'undefined') self.CFP_CONFIG = CFP_CONFIG;
