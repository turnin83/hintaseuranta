# Hintaseuranta

Hintaseuranta suomalaisiin (ja muihin) verkkokauppoihin kotitalouden käyttöön. Push-ilmoitus puhelimeen,
kun hyvä ostoikkuna aukeaa. Mobile-first PWA (Vite + Preact), backend Supabase
(Postgres + RLS, Auth, Edge Functions, pg_cron).

```
 pg_cron (15 min tick) ──► invoke_fetch_prices() ──► Edge Function fetch-prices
                                                         │  hae erääntyneet linkit (per kauppa peräkkäin, viiveellä)
                                                         │  JSON-LD → adapteri → havainnot
                                                         │  hälytyssäännöt → alert_events
                                                         └► Web Push (VAPID) ──► service worker ──► #/item/<id>
 PWA ──► Supabase REST (RLS) · preview-product · push-test · fetch-prices (käsin)
```

## Sisältö

| Polku | Mitä |
|---|---|
| `supabase/migrations/` | skeema + RLS, näkymät (`v_series`, `v_wish_summary`), ajastus |
| `supabase/functions/fetch-prices` | hinnanhaku, säännöt, push |
| `supabase/functions/preview-product` | URL → nimi, hinta, EAN, kaupan tila (lisäysnäkymä) |
| `supabase/functions/push-test` | "Testaa ilmoitus" |
| `supabase/functions/find-offers` | "Etsi muista kaupoista": hinta.fi-haku EAN-koodilla tai nimellä |
| `supabase/functions/probe` | diagnostiikka Supabasen omasta verkosta |
| `supabase/functions/_shared/` | parseri (JSON-LD + adapterit), robots.txt, säännöt, push |
| `web/` | PWA |
| `tests/` | parseri tallennetuilla HTML-fixtureilla, säännöt keinotekoisella historialla |

## Kaupat

Kauppoja ei ole kovakoodattu. Kun liität minkä tahansa tuotesivun, `preview-product` rekisteröi domainin
`shops`-tauluun ja kertoo, toimiiko haku:

- **Suoraan (JSON-LD)**: useimmat kaupat (testattu: Verkkokauppa.com, Power, Veikon Kone).
- **Adapteri**: vain kun JSON-LD ei riitä. Nyt: `verkkokauppa.com` (kampanjan vertailuhinta),
  `hintaopas.fi` (kauppakohtaiset tarjoukset Next.js-datasta). Lisää uusi `_shared/adapters.ts`:n `ADAPTERS`-rekisteriin + fixture-testi.
- **Etsi muista kaupoista** (toiveasian detalji): hakee hinta.fi:stä saman tuotteen EAN-koodilla
  (tai nimellä, jolloin valitaan oikea osuma) ja näyttää kaupat, joita ei vielä seurata. Valitut kaupat
  tallentuvat yhdellä hinta.fi-linkillä. hintaopas.fi:n haku on robots.txt:ssä kielletty, joten sitä ei käytetä.
- **Vertailusivu**: jos kauppa estää botit (esim. **Gigantti**: Vercel Security Checkpoint, 429), lisää
  tuote `hintaopas.fi`- tai `hinta.fi`-linkillä ja valitse listasta tallennettavat kaupat (esim. vain Gigantti).

Haku on kohtelias: rehellinen User-Agent, robots.txt noudatetaan, saman kaupan pyynnöt peräkkäin
(`shops.min_delay_ms`, oletus 2 s), virhe yhdessä linkissä ei kaada ajoa.

## Käyttöönotto

Tarvitset: Node 22.18+ (tai 24), Supabase-projektin (`euqjaihhebvlbaghaeil`), GitHub-repon, Cloudflare-tilin.
Supabase CLI ajetaan `npx supabase`, Deno `npx deno` (erillistä asennusta ei tarvita).

### 1. VAPID-avaimet

```sh
npm run vapid
```

Tulostaa `VAPID_KEYS_JSON` (yksityinen, Supabase-secretiksi) ja `VITE_VAPID_PUBLIC_KEY` (julkinen, webille).
Luo avaimet **kerran**: jos vaihdat ne, kaikkien laitteiden pitää sallia ilmoitukset uudelleen.

### 2. Supabase: tietokanta ja funktiot

```sh
npx supabase login
npx supabase link --project-ref euqjaihhebvlbaghaeil
npx supabase db push
```

Luo `supabase/.env.production` (gitignoroitu):

```
CRON_SECRET=<pitkä satunnainen merkkijono, esim. openssl rand -hex 32>
VAPID_SUBJECT=mailto:sinun@osoite.fi
VAPID_KEYS_JSON={"publicKey":{...},"privateKey":{...}}
```

```sh
npx supabase secrets set --env-file supabase/.env.production
npx supabase functions deploy fetch-prices preview-product push-test probe
```

(`SUPABASE_URL` ja `SUPABASE_SERVICE_ROLE_KEY` ovat funktioissa automaattisesti. Service role ei koskaan päädy webiin.)

### 3. Supabase: ajastuksen secretit (SQL Editor)

Ajastus on migraatiossa valmiina (`fetch-prices-tick`, 15 min välein). Se tarvitsee kaksi Vault-secretiä:

```sql
select vault.create_secret('https://euqjaihhebvlbaghaeil.supabase.co', 'project_url');
select vault.create_secret('<sama arvo kuin CRON_SECRET>', 'cron_secret');
```

Tarkistus: `select * from cron.job;` ja myöhemmin `select * from cron.job_run_details order by start_time desc limit 5;`
sekä `select * from net._http_response order by created desc limit 5;`.

### 4. Supabase: käyttäjät ja kirjautuminen

Kirjautuminen on sähköposti + salasana. Käyttäjät luodaan käsin, eikä sähköpostia lähetetä koskaan
(ei SMTP:tä, ei sähköpostipohjia). Tämä toimii samoin Safarissa ja kotinäytölle asennetussa iOS-PWA:ssa.

Dashboard → Authentication:

1. **Sign In / Providers**: Email päällä. Kytke **Allow new users to sign up** pois, jolloin vain
   luomasi käyttäjät pääsevät sisään. *Confirm email* voi olla pois.
2. **Users → Add user → Create new user**: sähköposti + salasana, ruksi **Auto Confirm User**.
   Toista jokaiselle perheenjäsenelle.
3. **URL Configuration**: Site URL = Cloudflare Pages -osoite (esim. `https://hintaseuranta.pages.dev`).

**Jaettu kotitalous**: jokainen luotu käyttäjä liittyy automaattisesti samaan kotitalouteen
(`household_members`, tietokantatriggeri). Kaikki jäsenet näkevät ja muokkaavat samaa toivelistaa,
linkkejä, hintahistoriaa ja hälytyksiä, ja hakutiheys on yhteinen. Henkilökohtaisia ovat luettu/lukematon-tila
(`alert_reads`) ja push-tilaukset: hälytys lähtee kaikkien jäsenten kaikille laitteille.

Salasanan vaihto: Users → käyttäjä → *Reset password* vaatii sähköpostin, joten helpointa on
poistaa käyttäjä ja luoda uudelleen (data säilyy, koska se kuuluu kotitaloudelle), tai vaihtaa salasana
SQL:llä: `update auth.users set encrypted_password = crypt('uusi', gen_salt('bf')) where email = '...';`

### 5. Web paikallisesti

```sh
cd web
cp .env.example .env.local   # täytä VITE_SUPABASE_ANON_KEY (Project Settings → API Keys) ja VITE_VAPID_PUBLIC_KEY
npm install
npm run dev
```

### 6. Cloudflare Pages

Workers & Pages → Create → Pages → Connect to Git → valitse repo:

| Asetus | Arvo |
|---|---|
| Root directory | `web` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Environment variables | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_VAPID_PUBLIC_KEY`, `NODE_VERSION=22` |

`web/public/_redirects` ohjaa `/share` (Web Share Target) sovellukseen, `_headers` estää service workerin välimuistituksen.
Jokainen push `main`-haaraan julkaisee uuden version.

### 7. Keepalive (GitHub Actions)

Repo → Settings → Secrets → Actions: `SUPABASE_URL` ja `SUPABASE_ANON_KEY`. Workflow
`.github/workflows/keepalive.yml` tekee päivittäin yhden REST-kutsun (ks. ilmaistason rajat alla).

### 8. Puhelin

1. Avaa Pages-osoite. **iPhone**: Safari → Jaa → *Lisää Koti-valikkoon*, avaa kotinäytöltä.
   **Android**: Chrome → *Asenna sovellus*.
2. Kirjaudu sähköpostilla ja salasanalla.
3. Asetukset → **Salli ilmoitukset** → **Testaa ilmoitus**.
4. Lisää tuotteita: liitä linkki tai jaa se kaupan sivulta Hinnat-sovellukseen (Android; iOS ei tue Web Share Targetia).

## Tarjoukset nyt

Välilehti listaa tuotteet, joiden paras saatavilla oleva hinta on vähintään 5 / 10 / 20 % alle
30 päivän mediaanin, alittaa tavoitehinnan tai on kaikkien aikojen alin (vähintään 6 havaintoa).
Järjestys: suurin alennus ensin, tavoitteen alitus ja alin koskaan nostavat. Vertailu tehdään omaan
historiaan, ei kaupan ilmoittamaan "ennen"-hintaan.

## Black Friday -viikko

Asetukset → Hakutiheys → **Tunnin välein**. Cron-lauseketta ei tarvitse muuttaa: 15 minuutin tick
hakee vain erääntyneet linkit (`user_settings.fetch_interval_minutes`). Palauta BF:n jälkeen 2×/pv.

Tarkista viikkoa ennen: Asetukset → *Viimeisimmät haut* ja *Kaupat* (virheet, estot).

## Supabase ilmaistason rajat

| Raja | Arvo | Vaikutus |
|---|---|---|
| Edge Function wall clock | 150 s | `fetch-prices` lopettaa uusien hakujen aloittamisen 110 s kohdalla. Loput linkit jäävät erääntyneiksi ja haetaan seuraavalla tickillä. |
| Edge Function CPU | 2 s / pyyntö | Verkko-odotus ei kuluta. JSON-LD-parsinta on regex-pohjainen (ei DOM:ia), jotta isot sivut (VK ~1 Mt) mahtuvat. |
| Kutsuja | 500 000 / kk | Tick 15 min välein ≈ 3 000/kk, ja kutsu tehdään vain kun jokin linkki on erääntynyt. |
| Tietokanta | 500 Mt | Havainto ~100 t: 100 linkkiä × 24/pv × vuosi ≈ 90 Mt. `cleanup-logs` siivoaa cron/pg_net-lokit. |
| **Pausetus** | ~7 pv käyttämättömyys | ⚠️ Suurin riski: pausetettu projekti ei aja cronia. pg_cronin sisäinen ajo ei välttämättä riitä aktiivisuudeksi → keepalive-workflow + oma käyttö. |

Jos jokin kauppa estää myös Supabasen datakeskus-IP:t (Cloudflare-kaupat voivat toimia kotiverkosta mutta
eivät pilvestä), aja `probe`-funktio (tai käytä vertailusivua). Varapolkuna voi ajaa haun GitHub Actionsissa.

## Hälytyssäännöt (per toiveasia, muokattavissa)

| Sääntö | Oletus |
|---|---|
| Alittaa tavoitehinnan | päällä (tavoitehinta asetettava) |
| Kaikkien aikojen alin | vähintään 6 havaintoa |
| Alle 30 pv mediaanin | ≥ 10 % |
| Pudotus edellisestä havainnosta | ≥ 5 % |
| Palaa varastoon | päällä |
| Epäilyttävä tarjous | kauppa ilmoittaa vertailuhinnan, mutta oma historia (≥ 7 pv) näyttää saman tai alemman hinnan 30 pv sisällä. Vain listaan, ei pushia. |
| Cooldown | sama sääntö samalle linkille/kaupalle uudelleen vain, jos hinta laskee edelleen tai 24 h kulunut |

Hintahälytykset eivät laukea, kun tuote on loppu (hinta voi olla näennäinen).

## Kehitys

```sh
npm test                  # parseri + säännöt (Node, tallennetut fixturet)
npm run check:functions   # Deno-tyyppitarkistus Edge Functioneille
npm run probe -- <url>    # diagnostiikka paikallisesti: robots, status, JSON-LD, bottiesto
node scripts/find-local.ts <EAN tai hakusanat>   # "Etsi muista kaupoista" paikallisesti
npm run build             # web
```
