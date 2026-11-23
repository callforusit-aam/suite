/* Callforus Prospect — pannello su amazon.it
   - pagina dei risultati di ricerca: salva i brand del filtro Marca e qualifica quelli in coda
   - pagina prodotto: invia i dati della scheda (e del venditore) al prospect del brand */
(() => {
  if (window.__cfpLoaded) return;
  window.__cfpLoaded = true;

  const path = location.pathname;
  const isSearch = path === '/s' || path.startsWith('/s/');
  const asinM = path.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  if (!isSearch && !asinM) return;

  /* ---------- utilità ---------- */
  const send = msg => new Promise((res, rej) => {
    try {
      chrome.runtime.sendMessage(msg, r => {
        if (chrome.runtime.lastError) return rej(new Error('Estensione ricaricata: aggiorna la pagina.'));
        r && r.ok ? res(r.data) : rej(new Error((r && r.error) || 'Errore'));
      });
    } catch (e) { rej(new Error('Estensione ricaricata: aggiorna la pagina.')); }
  });
  const db = (method, p, body, prefer) => send({ type: 'rest', method, path: p, body, prefer });
  const pausa = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const brandKey = s => clean(s).toLowerCase();
  const num = s => Number(String(s).replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '')) || 0;
  const numK = s => Math.round(num(s) * (/k|mila/i.test(s) ? 1000 : 1));
  const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const euro = n => (Math.round(n) || 0).toLocaleString('it-IT') + ' €';
  const BADGE_RE = /(\d[\d.]*)\s*(mila|k)?\s*\+?\s*(?:acquistat|vendut)\w*\s+nel(?:l['’])?\s*(?:mese scorso|ultimo mese)/i;
  const isCaptcha = html => /\/errors\/validateCaptcha|api-services-support@amazon\.com/i.test(html);

  /* ---------- pannello ---------- */
  const root = document.createElement('div');
  root.id = 'cfp-panel';
  root.innerHTML = `
    <div class="cfp-h">
      <span class="cfp-logo">C</span><b>Callforus</b>&nbsp;Prospect
      <span class="cfp-sp"></span>
      <button class="cfp-ic" id="cfp-min" title="Riduci">–</button>
    </div>
    <div class="cfp-b" id="cfp-body">
      <div class="cfp-user" id="cfp-user">Verifico l'accesso…</div>
      <div id="cfp-main"></div>
      <div class="cfp-log" id="cfp-log" aria-live="polite"></div>
    </div>`;
  document.body.appendChild(root);
  const $ = id => root.querySelector('#' + id);
  const minimized = sessionStorage.getItem('cfp_min') === '1';
  if (minimized) root.classList.add('cfp-closed');
  $('cfp-min').onclick = () => {
    root.classList.toggle('cfp-closed');
    sessionStorage.setItem('cfp_min', root.classList.contains('cfp-closed') ? '1' : '0');
  };
  const log = (t, kind) => {
    const el = $('cfp-log');
    const p = document.createElement('div');
    p.className = 'cfp-line' + (kind ? ' cfp-' + kind : '');
    p.textContent = t;
    el.prepend(p);
    while (el.children.length > 40) el.lastChild.remove();
  };

  let me = { logged: false };
  async function refreshUser() {
    try { me = await send({ type: 'status' }); } catch (e) { me = { logged: false, error: e.message }; }
    const u = $('cfp-user');
    if (!me.logged) u.innerHTML = 'Non hai fatto l\'accesso: clicca l\'icona <b>Callforus Prospect</b> in alto a destra in Chrome.';
    else if (!me.allowed) u.innerHTML = `<b>${esc(me.email)}</b> non è abilitato in Outbound.${me.error ? ' ' + esc(me.error) : ''}`;
    else u.innerHTML = `Collegato come <b>${esc(me.email)}</b>`;
    root.querySelectorAll('[data-need-login]').forEach(b => { b.disabled = !(me.logged && me.allowed) || b.dataset.busy === '1' || b.dataset.empty === '1'; });
  }
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.cfp_session) refreshUser(); });

  /* =========================================================
     PAGINA DI RICERCA
     ========================================================= */
  function keyword() { return clean(new URLSearchParams(location.search).get('k') || ''); }

  function extractBrands() {
    const box = document.querySelector('#brandsRefinements');
    if (!box) return { box: null, brands: [], more: null };
    const seen = new Set(), brands = [];
    box.querySelectorAll('li').forEach(li => {
      const a = li.querySelector('a[href]');
      if (!a) return;
      let u;
      try { u = new URL(a.getAttribute('href'), location.origin); } catch (e) { return; }
      if (!u.searchParams.get('rh')) return;
      const label = li.querySelector('.a-size-base.a-color-base') || a;
      const name = clean(label.textContent);
      if (!name || name.length > 120 || /^vedi (altro|meno|tutto|tutti)/i.test(name)) return;
      const k = brandKey(name);
      if (seen.has(k)) return;
      seen.add(k);
      // se il brand è già spuntato, il link toglie il filtro: non è il link giusto
      const checked = li.querySelector('input[type="checkbox"]:checked, [aria-checked="true"]');
      ['qid', 'ref', 'dib', 'dib_tag', 'rnid', 'sprefix', 'crid', 'content-id', 'pd_rd_r'].forEach(p => u.searchParams.delete(p));
      brands.push({ brand: name, url: checked ? null : u.toString() });
    });
    const more = [...box.querySelectorAll('a, span[role="button"], .a-expander-prompt')]
      .find(e => /^vedi altro$/i.test(clean(e.textContent)) && e.offsetParent !== null) || null;
    return { box, brands, more };
  }

  function parseResults(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cards = [...doc.querySelectorAll('[data-component-type="s-search-result"]')]
      .filter(c => !/Sponsorizzat/i.test(c.textContent));
    const prezzi = [], stelle = [];
    let recensioni = 0, acquisti = 0, conBadge = 0, stima = 0;
    for (const c of cards) {
      const testo = clean(c.textContent);
      const p = c.querySelector('.a-price .a-offscreen');
      const prezzo = p ? num(p.textContent) : 0;
      if (prezzo) prezzi.push(prezzo);
      const st = testo.match(/(\d[,.]\d) su 5 stelle/);
      if (st) stelle.push(num(st[1]));
      const rec = [...c.querySelectorAll('a[href*="customerReviews"]')].map(x => clean(x.textContent))
        .find(t => /^\(?[\d.,]+\s*(k|mila)?\)?$/i.test(t));
      if (rec) recensioni += numK(rec);
      const m = testo.match(BADGE_RE);
      if (m) {
        const q = num(m[1]) * (m[2] ? 1000 : 1);
        acquisti += q; conBadge++; stima += q * prezzo;
      }
    }
    const media = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const pm = media(prezzi), sm = media(stelle);
    return {
      prodotti: cards.length,
      prezzo_medio: pm == null ? null : Math.round(pm * 100) / 100,
      stelle: sm == null ? null : Math.round(sm * 10) / 10,
      recensioni, con_badge: conBadge, acquisti_mese: acquisti,
      stima_min_mese: Math.round(stima),
    };
  }

  let stopFlag = false, running = false;

  function renderSearch() {
    const { box, brands, more } = extractBrands();
    const kw = keyword();
    $('cfp-main').innerHTML = `
      <div class="cfp-sec">
        <div class="cfp-t">1 · Brand di questa ricerca</div>
        <div class="cfp-p">Keyword: <b>${esc(kw || '—')}</b></div>
        <div class="cfp-p">${box ? `Nel filtro Marca: <b>${brands.length}</b> brand` : 'Filtro Marca non trovato in questa pagina.'}</div>
        ${more ? '<button class="cfp-btn cfp-ghost" id="cfp-more">Espandi «Vedi altro»</button>' : ''}
        <button class="cfp-btn" id="cfp-save" data-need-login data-empty="${brands.length ? '0' : '1'}" disabled>Salva ${brands.length} brand</button>
      </div>
      <div class="cfp-sec">
        <div class="cfp-t">2 · Qualifica</div>
        <div class="cfp-p" id="cfp-queue">In coda: …</div>
        <button class="cfp-btn" id="cfp-qual" data-need-login>${running ? 'Ferma' : 'Qualifica la coda'}</button>
        <div class="cfp-p cfp-mute">Lascia questa scheda aperta e in primo piano: ogni brand richiede 6-12 secondi.</div>
      </div>`;
    if (more) $('cfp-more').onclick = () => { more.click(); setTimeout(renderSearch, 1200); };
    $('cfp-save').onclick = saveBrands;
    $('cfp-qual').onclick = () => (running ? (stopFlag = true, log('Mi fermo dopo il brand in corso…')) : qualify());
    refreshUser();
    refreshQueue();
  }

  async function refreshQueue() {
    const el = $('cfp-queue');
    if (!el) return;
    try {
      const rows = await db('GET', 'prospects?select=id&qualificato_il=is.null&url=not.is.null&limit=1000');
      el.innerHTML = `In coda: <b>${rows.length}</b> brand da qualificare`;
    } catch (e) { el.textContent = 'In coda: —'; }
  }

  async function saveBrands() {
    const { brands } = extractBrands();
    if (!brands.length) return;
    const b = $('cfp-save');
    b.disabled = true; b.dataset.busy = '1'; b.textContent = 'Salvo…';
    try {
      const r = await db('POST', 'rpc/prospects_add_brands', { p_keyword: keyword(), p_items: brands });
      log(`Salvati: ${r.nuovi} nuovi, ${r.gia_presenti} già presenti (keyword aggiunta).`, 'ok');
      const noUrl = brands.filter(x => !x.url).length;
      if (noUrl) log(`${noUrl} brand spuntati nel filtro sono stati salvati senza link: toglili dal filtro e salva di nuovo per poterli qualificare.`, 'warn');
    } catch (e) { log('Salvataggio non riuscito: ' + e.message, 'err'); }
    b.dataset.busy = '0'; b.textContent = `Salva ${brands.length} brand`; b.disabled = false;
    refreshQueue();
  }

  async function qualify() {
    if (running) return;
    running = true; stopFlag = false;
    const btn = $('cfp-qual');
    btn.textContent = 'Ferma';
    try {
      const st = await send({ type: 'settings:get' });
      const max = Math.max(1, Math.min(100, +st.maxPerSessione || 30));
      const pMin = Math.max(3, +st.pausaMinSec || 6), pMax = Math.max(pMin, +st.pausaMaxSec || 12);
      const rows = await db('GET', `prospects?select=id,brand,url&qualificato_il=is.null&url=not.is.null&order=created_at.asc&limit=${max}`);
      if (!rows.length) { log('Niente da qualificare: salva prima qualche brand.', 'warn'); return; }
      log(`Qualifico ${rows.length} brand…`);
      let badgeVisti = 0;
      for (let i = 0; i < rows.length; i++) {
        if (stopFlag) { log('Fermato.', 'warn'); break; }
        const p = rows[i];
        let url;
        try { url = new URL(p.url); } catch (e) { continue; }
        if (url.hostname !== location.hostname) { log(`${p.brand}: link non di ${location.hostname}, salto.`, 'warn'); continue; }
        const r = await fetch(url.toString(), { credentials: 'include' });
        const html = await r.text();
        if (isCaptcha(html)) { log('Amazon chiede il captcha: mi fermo. Risolvilo in una scheda normale e riprendi più tardi.', 'err'); break; }
        const m = parseResults(html);
        badgeVisti += m.con_badge;
        await db('PATCH', `prospects?id=eq.${p.id}`, Object.assign(m, { qualificato_il: new Date().toISOString() }), 'return=minimal');
        log(`${i + 1}/${rows.length} ${p.brand}: ${m.prodotti} prodotti, ${m.con_badge} con badge, stima minima ${euro(m.stima_min_mese)}/mese`, 'ok');
        if (i === 4 && badgeVisti === 0) log('Nei primi 5 brand nessun badge «acquistati nel mese scorso»: se Amazon ha cambiato il testo, va aggiornato il riconoscimento.', 'warn');
        if (i < rows.length - 1) await pausa((pMin + Math.random() * (pMax - pMin)) * 1000);
      }
    } catch (e) { log('Qualifica interrotta: ' + e.message, 'err'); }
    finally {
      running = false; stopFlag = false;
      const b = $('cfp-qual'); if (b) b.textContent = 'Qualifica la coda';
      refreshQueue();
    }
  }

  /* =========================================================
     PAGINA PRODOTTO
     ========================================================= */
  function readBrandFromByline() {
    const a = document.querySelector('#bylineInfo');
    if (!a) return '';
    let t = clean(a.textContent);
    t = t.replace(/^visita lo store di\s+/i, '').replace(/^marca:\s*/i, '').replace(/^brand:\s*/i, '');
    return t;
  }

  function readProduct() {
    const q = s => document.querySelector(s);
    const txt = s => clean(q(s)?.textContent);
    const asin = asinM[1].toUpperCase();
    const bullets = [...document.querySelectorAll('#feature-bullets li .a-list-item, #feature-bullets li')]
      .map(e => clean(e.textContent)).filter(Boolean);
    const uniqBullets = [...new Set(bullets)].slice(0, 10);
    const thumbs = document.querySelectorAll('#altImages li.imageThumbnail, #altImages li.item:not(.videoThumbnail):not(.videoBlockIngress)');
    const altText = clean(q('#altImages')?.textContent).toLowerCase();
    const hasVideo = !!q('#altImages li.videoThumbnail, #altImages li.videoBlockIngress, #altImages [class*="video"]') || /\bvideo\b/.test(altText);
    const aplus = !!q('#aplus .aplus-module, #aplus_feature_div .aplus-module, #aplus .celwidget, #aplusBrandStory_feature_div .aplus-module');
    const byline = q('#bylineInfo');
    const brandStore = !!(byline && /\/stores\//.test(byline.getAttribute('href') || ''));
    const stelleT = q('#acrPopover')?.getAttribute('title') || txt('#acrPopover');
    const st = (stelleT || '').match(/(\d[,.]\d)/);
    const recT = txt('#acrCustomerReviewText');
    const prezzo = txt('#corePrice_feature_div .a-offscreen') || txt('#corePriceDisplay_desktop_feature_div .a-offscreen') || txt('.a-price .a-offscreen');
    const sellerA = q('#sellerProfileTriggerId') || q('#merchantInfoFeature_feature_div a[href*="seller="]') || q('a[href*="/sp?"][href*="seller="]');
    let sellerId = null;
    if (sellerA) { try { sellerId = new URL(sellerA.getAttribute('href'), location.origin).searchParams.get('seller'); } catch (e) { } }
    const venditore = clean(sellerA?.textContent) || txt('#merchantInfoFeature_feature_div .offer-display-feature-text') || '';
    const speditoDa = txt('#fulfillerInfoFeature_feature_div .offer-display-feature-text');
    const badge = txt('#social-proofing-faceout-title-tk_bought');
    const det = clean(q('#detailBulletsWrapper_feature_div, #prodDetails, #detailBullets_feature_div')?.textContent);
    const bsr = (det.match(/n\.\s?[\d.]+\s+in\s+[^(]+/i) || [''])[0].trim().slice(0, 160);
    return {
      asin, url: location.origin + '/dp/' + asin,
      titolo: txt('#productTitle').slice(0, 400),
      punti_elenco: uniqBullets.map(b => b.slice(0, 500)),
      descrizione: txt('#productDescription').slice(0, 2500),
      immagini: thumbs.length,
      video: hasVideo,
      aplus,
      brand_store: brandStore,
      stelle: st ? num(st[1]) : null,
      recensioni: recT ? numK(recT) : null,
      prezzo: prezzo ? num(prezzo) : null,
      venditore, venditore_id: sellerId, spedito_da: speditoDa,
      badge_acquisti: badge,
      bsr,
      letta_il: new Date().toISOString(),
    };
  }

  async function readSeller(sellerId) {
    const r = await fetch(`/sp?seller=${encodeURIComponent(sellerId)}`, { credentials: 'include' });
    const html = await r.text();
    if (isCaptcha(html)) throw new Error('captcha');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = {};
    doc.querySelectorAll('.a-text-bold').forEach(b => {
      const label = clean(b.textContent).toLowerCase();
      const val = clean(b.nextElementSibling?.textContent);
      if (/nome dell.azienda|ragione sociale|nome legale/.test(label) && val) out.ragione_sociale = val;
      else if (/partita iva|numero di partita iva|vat/.test(label) && val) out.piva = val;
      else if (/indirizzo dell.azienda|indirizzo commerciale|indirizzo/.test(label)) {
        const row = b.closest('.a-row') || b.parentElement;
        const parts = [];
        let n = row ? row.nextElementSibling : null;
        while (n && /indent-left/.test(n.className || '') && parts.length < 6) { parts.push(clean(n.textContent)); n = n.nextElementSibling; }
        if (!parts.length && val) parts.push(val);
        if (parts.length) out.indirizzo = parts.join(', ');
      }
    });
    return out;
  }

  function renderProduct() {
    const brand = readBrandFromByline();
    $('cfp-main').innerHTML = `
      <div class="cfp-sec">
        <div class="cfp-t">4 · Scheda per l'analisi</div>
        <div class="cfp-p">Brand: <b>${esc(brand || 'non trovato')}</b></div>
        <label class="cfp-p cfp-lbl">Brand nel database
          <input id="cfp-brand" value="${esc(brand)}" placeholder="Nome del brand">
        </label>
        <button class="cfp-btn" id="cfp-send" data-need-login>Invia scheda a Callforus</button>
        <div class="cfp-p cfp-mute">Salva titolo, punti elenco, immagini, A+, video, stelle, venditore e, se Amazon li mostra, ragione sociale e partita IVA del venditore. L'analisi con Claude la fai poi nell'app.</div>
      </div>`;
    $('cfp-send').onclick = sendProduct;
    refreshUser();
  }

  async function sendProduct() {
    const brand = clean($('cfp-brand').value);
    if (!brand) { log('Scrivi il nome del brand.', 'warn'); return; }
    const b = $('cfp-send');
    b.disabled = true; b.dataset.busy = '1'; b.textContent = 'Invio…';
    try {
      const scheda = readProduct();
      let seller = {};
      if (scheda.venditore_id) {
        try { seller = await readSeller(scheda.venditore_id); } catch (e) { log('Dati del venditore non letti: ' + e.message, 'warn'); }
      }
      if (seller.ragione_sociale) scheda.venditore_ragione_sociale = seller.ragione_sociale;
      const key = encodeURIComponent(brandKey(brand));
      let rows = await db('GET', `prospects?select=id,ragione_sociale,piva,sede&marketplace=eq.amazon.it&brand_key=eq.${key}`);
      if (!rows.length) {
        await db('POST', 'rpc/prospects_add_brands', { p_keyword: '', p_items: [{ brand }] });
        rows = await db('GET', `prospects?select=id,ragione_sociale,piva,sede&marketplace=eq.amazon.it&brand_key=eq.${key}`);
        log(`«${brand}» non era tra i prospect: l'ho aggiunto.`, 'warn');
      }
      const p = rows[0];
      const patch = { scheda };
      if (!p.ragione_sociale && seller.ragione_sociale) patch.ragione_sociale = seller.ragione_sociale;
      if (!p.piva && seller.piva) patch.piva = seller.piva;
      if (!p.sede && seller.indirizzo) patch.sede = seller.indirizzo;
      await db('PATCH', `prospects?id=eq.${p.id}`, patch, 'return=minimal');
      const extra = [patch.ragione_sociale && 'ragione sociale', patch.piva && 'P.IVA', patch.sede && 'indirizzo'].filter(Boolean);
      log(`Scheda di ${scheda.asin} salvata su «${brand}»${extra.length ? ' con ' + extra.join(', ') : ''}.`, 'ok');
    } catch (e) { log('Invio non riuscito: ' + e.message, 'err'); }
    b.dataset.busy = '0'; b.textContent = 'Invia scheda a Callforus'; b.disabled = false;
    refreshUser();
  }

  /* ---------- avvio ---------- */
  if (isSearch) {
    renderSearch();
    // Amazon aggiorna i risultati senza ricaricare: ridisegno quando cambia il filtro Marca
    let t = null, lastSig = '';
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (running) return;
        const sig = location.search + '|' + extractBrands().brands.length;
        if (sig !== lastSig) { lastSig = sig; renderSearch(); }
      }, 800);
    }).observe(document.body, { childList: true, subtree: true });
  } else {
    renderProduct();
  }
})();
