# Callforus Outbound

Software interno per le campagne di cold email di Callforus: contatti, sequenza di email (prima email + follow-up), coda di invio con Gmail, piano degli invii, risposte, ricerca lead e statistiche anonime di aperture e clic.

È una copia separata di Outbound di Flowline: non condivide con Flowline né il database, né il login, né le credenziali Google, né i testi.

È un solo file, `index.html`, più il database in `supabase/`.

## Cosa serve (tutto di Callforus, nuovo)

| Cosa | A cosa serve |
|---|---|
| Progetto **Supabase** | contatti, lead, statistiche, login |
| Progetto **Google Cloud** con ID client OAuth (tipo Web) | invio e lettura delle risposte con Gmail |
| Chiave **API Anthropic** | scrive le bozze delle email (resta nel browser di chi la inserisce, non nel file) |
| Un posto dove pubblicare `index.html` | vedi «Dove pubblicarlo» |
| Flusso **n8n** + Apify (facoltativo) | solo per la pagina «Ricerca lead» |

## Messa in funzione

1. **Database.** In Supabase apri SQL Editor → New query, incolla `supabase/setup.sql` ed esegui.
2. **Persone.** In Authentication → Users crea un utente per ciascuno (email e password). Poi, nel SQL Editor:
   `insert into public.ob_users (email, nome) values ('nome@dominio.it', 'Nome');`
   Chi non è in `ob_users` vede «Accesso non abilitato» anche con una password giusta.
3. **Configurazione.** In `index.html`, in cima allo script, compila:
   - `APP_DEFAULTS.supabaseUrl` e `supabaseKey` (Project Settings → API; la chiave «publishable» o «anon»)
   - `APP_DEFAULTS.googleClientId`
   - `BRAND`: nome, sito, email e telefono (finiscono nella firma delle email)
4. **Google.** In Google Cloud → Credenziali, nell'ID client OAuth aggiungi tra le «origini JavaScript autorizzate» l'indirizzo da cui aprirai Outbound. Gli accessi richiesti sono Gmail (invio, lettura, impostazioni di base), Fogli e Drive (per l'importazione e il selettore file).
5. **Statistiche (facoltativo).** Pubblica la funzione `supabase/functions/ob-track` con la verifica JWT disattivata (viene chiamata dai programmi di posta) e imposta `OB_FALLBACK_URL` con il sito di Callforus. Aggiungi il dominio del sito in `outbound_link_hosts` (esempio nel SQL), altrimenti i clic sui suoi link non vengono contati.
6. **Primo avvio.** Apri il file, accedi, poi in Impostazioni → «Cadenza & template» compila **Mittente** e **Cosa offriamo**: l'AI presenta Callforus usando solo quel testo e non scrive nulla se i campi sono vuoti. Rivedi anche la sequenza dei follow-up.

L'app parte in **modalità test**: gli invii sono simulati finché non la spegni in Impostazioni.

## Ricerca lead

La pagina scrive una richiesta in `lead_searches`; il database chiama un webhook n8n che cerca (per esempio con Apify su Google Maps) e salva i risultati in `leads`. Quel flusso va creato per Callforus: non è incluso e quello di Flowline non va riusato. Servono due segreti nel Vault di Supabase, `lead_search_webhook_url` e `lead_search_webhook_key` (la chiave arriva nell'header `x-callforus-key`). Finché non ci sono, la pagina avvisa «Webhook n8n non configurato» e il resto di Outbound funziona normalmente.

## Prospect Amazon

Pagina «Prospect Amazon» per il flusso di acquisizione clienti: brand trovati su Amazon.it, qualifica, punteggio gap, analisi della scheda con Claude, video e sequenza LinkedIn → email → telefono → chiusura.

1. **Database.** Esegui una volta `supabase/prospects.sql` nel SQL Editor (dopo `setup.sql`). Crea `prospects`, `fiere_espositori` e la funzione `prospects_add_brands`, con le stesse regole di accesso di Outbound (`ob_users`).
2. **Estensione Chrome** (cartella `extension/`): in Chrome apri `chrome://extensions`, attiva «Modalità sviluppatore», premi «Carica estensione non pacchettizzata» e scegli la cartella `extension`. Clicca l'icona Callforus Prospect e accedi con l'account di Outbound.
   - Pagina dei risultati di amazon.it: «Salva brand» salva i brand del filtro Marca con il link della ricerca filtrata; «Qualifica la coda» apre quelle ricerche con pause di 6-12 secondi e salva stima minima, badge, prezzo, stelle e recensioni.
   - Pagina prodotto: «Invia scheda» salva titolo, punti elenco, immagini, video, A+, Brand Store, stelle e venditore; se Amazon li mostra, anche ragione sociale, partita IVA e indirizzo del venditore.
   - Volumi bassi: Amazon non ama le letture automatiche e può chiedere il captcha. L'estensione si ferma da sola.
3. **Nell'app**: «Soglie e testi» per fasce, punteggio minimo, nome nei messaggi, testi della sequenza e casi studio. «Fiere» per caricare gli elenchi espositori. L'analisi usa la chiave Anthropic già inserita nelle Impostazioni. «Passa l'email a Outbound» crea il contatto con l'email già scritta, pianificata al giorno 5 della sequenza: da lì invio, follow-up e risposte sono quelli di Outbound.

## Fiere

Pagina «Fiere»: dalla lista espositori di una fiera alle email in Outbound.

1. **Database.** Esegui una volta `supabase/fiere.sql` (dopo `prospects.sql`): aggiunge a `fiere_espositori` le colonne dell'analisi.
2. **Importa espositori**: file CSV o Excel (colonne riconosciute: azienda, sito, paese, categoria, email) oppure incolla una riga per azienda.
3. **Analizza**: per ogni azienda Claude usa la ricerca web e la lettura delle pagine (chiave Anthropic delle Impostazioni) per trovare sito, email aziendali (niente PEC, niente indirizzi inventati), descrizione, fatturato con anno e fonte, dipendenti, notorietà del marchio e presenza su Amazon.it. La ricerca web va attivata una volta nella Console Anthropic dall'amministratore dell'organizzazione.
4. **Esiti automatici** (modificabili in «Criteri»): marchio famoso = Scartato; fatturato fuori dalla fascia (predefinita 100.000 € – 5 M€) = Scartato; senza email o senza fatturato = Da verificare; il resto = Idoneo. Ogni esito si può cambiare a mano.
5. **Aggiungi a Outbound**: gli idonei diventano contatti con la descrizione già pronta e finiscono in Pianificazione, da dove generi le email come sempre.

## Dove pubblicarlo

Il file contiene l'indirizzo e la chiave pubblica di Supabase: sono pensati per stare nel browser e i dati sono protetti dal login e dalle regole del database (`ob_users`), ma non c'è motivo di renderli pubblici. Meglio un repository **privato** e un hosting con accesso limitato, oppure aprire il file in locale.

## Cosa è stato tolto rispetto alla Suite di Flowline

Home, Newsletter, Richieste, Contabilità, Calendario, Password, Messaggi, Bacheca e «Online». Il login è ora di Outbound stesso e il browser non conserva i contatti dopo l'uscita.

## File

- `index.html`: l'applicazione
- `supabase/setup.sql`: tabelle, regole di accesso, statistiche
- `supabase/functions/ob-track/index.ts`: conteggio anonimo di aperture e clic
- `supabase/prospects.sql`: tabelle dei Prospect Amazon
- `supabase/fiere.sql`: colonne di analisi degli espositori delle fiere
- `extension/`: estensione Chrome «Callforus Prospect»
