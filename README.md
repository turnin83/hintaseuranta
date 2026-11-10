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
- **Hakusana lisäysnäkymässä**: kirjoita linkin sijaan esim. "Sage Super Q", valitse tuote hinta.fi:n
  tuloksista ja valitse kaupat kuten vertailusivun linkillä.
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
`.github/workflows/keepalive.yml` tekee tunneittain yhden REST-kutsun (ks. ilmaistason rajat ja
terveysvahti alla). Julkisessa repossa Actions-ajot ovat ilmaisia.

### 8. Puhelin

1. Avaa Pages-osoite. **iPhone**: Safari → Jaa → *Lisää Koti-valikkoon*, avaa kotinäytöltä.
   **Android**: Chrome → *Asenna sovellus*.
2. Kirjaudu sähköpostilla ja salasanalla.
3. Asetukset → **Salli ilmoitukset** → **Testaa ilmoitus**.
4. Lisää tuotteita: liitä linkki tai jaa se kaupan sivulta Hinnat-sovellukseen (Android; iOS ei tue Web Share Targetia).

## Tarjoukset nyt

Välilehti listaa tuotteet, joiden paras saatavilla oleva hinta on vähintään 5 / 10 / 20 % alle
tavallisen hinnan, alittaa tavoitehinnan tai on kaikkien aikojen alin (vähintään 6 havaintoa).
Järjestys: suurin alennus ensin, tavoitteen alitus ja alin koskaan nostavat. Vertailu tehdään omaan
historiaan, ei kaupan ilmoittamaan "ennen"-hintaan.

## Kampanjat (Black Friday ym.)

Asetukset → **Kampanjat**: kampanjan aikana hinnat haetaan tiheämmin (oletus tunnin välein), muulloin
käytetään normaalia hakutiheyttä. Valmiina: Singles Day 10.–11.11., Black Week 20.–30.11. ja Joulualet
26.12.–6.1. Kampanjoita voi lisätä, poistaa ja kytkeä pois. Käynnissä olevasta kampanjasta näkyy pieni merkki
Toivelistan ja Tarjousten yläosassa. Tehokas väli = lyhin kotitalouden asetuksesta ja käynnissä olevista
kampanjoista (`effective_interval_minutes`).

## Hiljaiset tunnit

Asetukset → **Hiljaiset tunnit** (oletus 23–07, Europe/Helsinki): yöllä syntyneitä hälytyksiä ei pushata,
vaan ne merkitään siirretyiksi (`push_deferred`) ja lähetetään aamulla yhtenä koosteena. Hinnat haetaan silti.
Poikkeus: kampanjan aikana *Alle tavoitehinnan* ja *Uusi alin hinta* pushataan heti myös yöllä
(`CAMPAIGN_NIGHT_RULES`), koska tarjoukset alkavat usein keskiyöllä ja rajattu erä voi loppua aamuun mennessä.

## Ostettu ja säästö

Tuotesivu → **Merkitse ostetuksi** (hinta, kauppa, päivä): seuranta ja hälytykset loppuvat (`active = false`),
historia säilyy. Säästö = tuotteen tavallinen hinta ostohetkellä − ostohinta. Toivelistan
lopussa *Ostetut (n) · säästit X €*. *Peru ostos* palauttaa seurannan.

## Ostokset ja roskakori

- **Ostetut säilyvät** pysyvästi (hintoja ei haeta 30 päivän jälkeen). Asetukset → **Ostokset**: säästöt
  yhteensä ja kampanjoittain sekä lista ostetuista. Ostetun voi siivota pois tuotteen sivulta (*Poista ostoksista*).
- *Palautettu / peru ostos* palauttaa tuotteen seurantaan historioineen (esim. tuote palautettiin kauppaan).
- **Roskakori**: *Poista* siirtää tuotteen roskakoriin (`wish_items.deleted_at`), ilmoituksessa on *Kumoa*.
  Asetukset → **Poistetut**: palauta tai poista pysyvästi. Ajastettu `purge-trash` poistaa yli 30 päivää
  roskakorissa olleet lopullisesti. Roskakorissa olevia ei haeta eikä niistä hälytetä.

## Hinta laski ostoksen jälkeen

Ostettua tuotetta haetaan vielä 30 päivää hiljaa. Muita hälytyksiä ei tule, mutta jos paras hinta laskee
selvästi ostohintaa alemmaksi (vähintään 2 % ja 1 €), tulee ilmoitus palautusoikeuden tai hintatakuun
käyttämistä varten (toisto aikaisintaan 72 h välein tai kun hinta laskee lisää).

## Keruun terveysvahti

- **Rikkinäinen linkki**: linkki, joka ei ole antanut hintaa yli vuorokauteen (`product_links.failing_since`),
  tekee yhden hälytyksen *Linkki ei toimi* (toisto aikaisintaan viikon päästä).
- **Keruu pysähtynyt**: Supabase ei voi hälyttää itse, jos projekti on pausella. GitHub Actions
  (`keepalive.yml`, tunneittain) kutsuu `rpc/health` ja epäonnistuu, jos projekti ei vastaa tai onnistunutta
  hakua ei ole ollut 3 tuntiin kampanjan aikana tai 26 tuntiin muulloin. GitHub lähettää epäonnistuneesta
  ajastetusta ajosta sähköpostin. Huom: GitHub käynnistää ajastetut ajot ruuhka-aikaan usein tunteja
  myöhässä, joten tämä on varaverkko. Sama tila näkyy heti Asetukset → *Viimeisimmät haut* -kohdan
  ensimmäisellä rivillä.
- **Iso pudotus luetaan uudelleen**: jos hinta on pudonnut vähintään 30 % edellisestä lukemasta, sivu luetaan
  heti uudestaan (`confirmDrops`). Sama hinta → tallennetaan; tavallinen hinta → tallennetaan se (kertaluontoinen
  lukuvirhe); muuten pudotusta ei tallenneta ja linkki haetaan uudelleen seuraavalla 15 min tickillä
  (enintään 3 kertaa, sitten hinta tallennetaan sellaisenaan).
- **Ristiintarkistus**: kun vertailusivu (hinta.fi, hintaopas.fi) näyttää hinnan kaupalle, jota seurataan myös
  suoraan, se tallennetaan suoran linkin `xcheck`-kenttään (vertailusivun riviä ei tallenneta hintahistoriaan).
  Tuotesivu näyttää huomautuksen, jos hinnat eroavat yli 5 % (ja vähintään 1 €) ja lukemat ovat enintään
  6 tunnin päässä toisistaan. Ei hälytyksiä.

## Arvonlisävero

Hintojen pitää olla verollisia. csx4-alustan kaupoilla (Ykköspalvelu, Pemic) JSON-LD voi kertoa hinnan ilman
veroa, joten hinta luetaan tuotelomakkeen kentästä; jos kenttää ei ole, hintaa ei tallenneta. Alusta tunnistetaan
sivusta, joten uudet saman alustan kaupat toimivat itsestään. `npm run shops:check` ja testit varoittavat, jos
sivulla näkyy myös luettu hinta + 25,5 %.

## Toimituskulut

Sivutietona hintojen alla (*toimitettuna X €* / *ilmainen toimitus*), ei vaikuta vertailuun eikä hälytyksiin.
Lähteet: hintaopas.fi (tarjousrivien toimitustavat), hinta.fi (tarjoustaulukon `data-delivery-fee`) ja
kauppojen schema.org `shippingDetails` (esim. Verkkokauppa.com, Power).

## Vertailuhinta ("epäilyttävä tarjous")

Kaupan ilmoittama "alin hinta 30 pv ennen kampanjaa" luetaan: Verkkokauppa.com (sivun tila), hintaopas.fi
(`originalPrice`) ja Power (julkinen tuote-API `/api/v2/products?ids=`, `minimumPreviousPriceInfo`, vain
kampanjan aikana).

## Hintahistoria ennen seurannan alkua (hintaopas.fi)

Jos tuote lisätään kesken alennuksen, oma tavallinen hinta olisi alennushinta, eikä alennusta huomattaisi.
Siksi hintaopas.fi-linkin tuotesivulta luetaan *Hintahistoria* (markkinan alin hinta noin 3 kk, muutospisteinä;
maksulliset jäsenhinnat pois). Kerran linkkiä kohden historiasta tallennetaan päiväkohtaiset arvot tuotteen
ensimmäistä omaa havaintoa edeltäviltä päiviltä pseudomyyjänä `#history` (`price_observations.history_shop` =
kauppa, jolla alin hinta oli).

- Historia lasketaan mukaan tavalliseen hintaan, alimpaan hintaan, tarjousarvioihin ja
  hälytyksiin. Uusi tuote, jolla on historia, ei aloita hiljaa: jos alennus on jo päällä, siitä tulee hälytys heti.
- Se ei ole kauppa: `v_series` jättää sen pois hintalistasta. Hintakäyrässä se näkyy harmaana viivana.
- *Hinta oli alempi* -varoitukset kertovat päivän ja kaupan; tuotesivun *Alin koskaan* samoin.
- Ostettu-kortti: tavallinen hinta lasketaan ostopäivää edeltäviltä 30 päivältä (muokattavissa, *Laske
  historiasta*), ja jos tuote oli 3 kk aikana halvempi, siitä varoitetaan.
- hinta.fi:n historiaa ei lueta: sen `robots.txt` kieltää historiasivut (`/*/*/historia`) ja `ajax.php`:n.
- Hintaopas-linkin lisäys: hintaoppaan haku on kielletty roboteilta, joten tuotesivun *Hae hintaoppaasta*
  kopioi tuotteen nimen leikepöydälle, avaa hintaopas.fi:n ja siirtää sovelluksen tuotteen lisäysnäkymään.
  Kun käyttäjä palaa kopioituaan tuotesivun osoitteen, lisäysnäkymä lukee leikepöydän ja esikatselee linkin
  (Android kysyy luvan kerran; iOS:ssä *Liitä*-painike).
- Toivelistan tagirivin lopussa on suodatin *Ilman hintaopasta* (näkyy, kun jokin tuote on ilman hintaopas-linkkiä).

## hinta.fi: ehdotus, siirtyneet sivut ja estot

- Kun uusi tuote lisätään kaupan sivulta ja EAN tunnetaan, tuotesivu hakee saman tuotteen hinta.fi:stä
  (find-offers) ja näyttää kortin *Sama tuote hinta.fi:ssä*: seuraamattomat kaupat valmiiksi valittuina, yksi
  napautus lisää ne. Mitään ei näytetä, jos osumaa tai uusia kauppoja ei ole.
- hinta.fi-linkki, joka antaa HTTP 404: tuotesivu hakee tuotteen EAN-koodilla ja ehdottaa *Vaihda linkki*
  (sama linkki, uusi osoite, historia säilyy).
- hinta.fi estää liian tiheästi kysyvän asiakkaan sivulla *Pääsy rajoitettu*, jonka HTTP-tila on 404. Se
  tunnistetaan estoksi (`botcheck.ts`), ei puuttuvaksi tuotteeksi. Estävän kaupan muut linkit jätetään sillä
  kierroksella hakematta, eikä estosta tehdä linkkikohtaisia *Linkki ei toimi* -hälytyksiä (tila näkyy
  Asetuksissa). hinta.fi:n sivujen väli on vähintään 10 s, ja hinta.fi-linkit haetaan enintään 6 tunnin
  välein (myös kampanjoiden aikana).
- hinta.fi:n esto koskee palvelimen osoitetta, ja jokainen haku eston aikana pidentää sitä. Siksi esto
  aloittaa tauon (taulu `host_cooldowns`, `_shared/cooldown.ts`): 6 tuntia, toistuvasta estosta kaksinkertainen,
  enintään 48 tuntia. Tauon aikana hintahaku, *Etsi muista kaupoista* ja tuotehaku eivät ota yhteyttä
  hinta.fi:hin, vaan näyttävät viestin, milloin haut jatkuvat. Linkit jäävät jonoon ja haetaan tauon jälkeen.

## Black Friday -viikko

Black Week -kampanja nostaa hakutiheyden automaattisesti tunnin välein 20.–30.11. (ks. Kampanjat).
Cron-lauseketta ei tarvitse muuttaa: 15 minuutin tick hakee vain erääntyneet linkit.

Tarkista viikkoa ennen: Asetukset → *Viimeisimmät haut* ja *Kaupat* (virheet, estot), sekä
`npm run shops:check` (lukeeko parseri jokaisen kaupan sivun kuten ennen; ks. Kehitys).

## Supabase ilmaistason rajat

| Raja | Arvo | Vaikutus |
|---|---|---|
| Edge Function wall clock | 150 s | `fetch-prices` lopettaa uusien hakujen aloittamisen 110 s kohdalla. Loput linkit jäävät erääntyneiksi ja haetaan seuraavalla tickillä. |
| Edge Function CPU | 2 s / pyyntö | Verkko-odotus ei kuluta. JSON-LD-parsinta on regex-pohjainen (ei DOM:ia), jotta isot sivut (VK ~1 Mt) mahtuvat. |
| Kutsuja | 500 000 / kk | Tick 15 min välein ≈ 3 000/kk, ja kutsu tehdään vain kun jokin linkki on erääntynyt. |
| Tietokanta | 500 Mt | Havainto ~100 t: 100 linkkiä × 24/pv × vuosi ≈ 90 Mt. `cleanup-logs` siivoaa cron/pg_net-lokit. |
| API-rivit | 1000 / kysely (oletus) | Isot tuotteet ylittävät sen. Laskenta ja käyrät koostetaan tietokannassa: `item_price_stats`, `item_chart_points` (vain hinnan muutoskohdat, porrasviivasta ei katoa mitään) ja `v_item_trend`. |
| **Pausetus** | ~7 pv käyttämättömyys | ⚠️ Suurin riski: pausetettu projekti ei aja cronia. pg_cronin sisäinen ajo ei välttämättä riitä aktiivisuudeksi → keepalive-workflow + oma käyttö. |

Jos jokin kauppa estää myös Supabasen datakeskus-IP:t (Cloudflare-kaupat voivat toimia kotiverkosta mutta
eivät pilvestä), aja `probe`-funktio (tai käytä vertailusivua). Varapolkuna voi ajaa haun GitHub Actionsissa.

## Hälytyssäännöt

Säännöt säädetään **Asetukset → Hälytykset** koko kotitaloudelle; tuotteelle voi tehdä poikkeukset
(*Mukauta tälle tuotteelle*, vain erot tallennetaan). Tehokkaat säännöt = oletukset ← kotitalous
(`households.default_rules`) ← tuote (`wish_items.rules`).

**Yksi hälytys per tuote ja haku.** Kaikki yhden haun löydökset kootaan yhdeksi tapahtumaksi
(`alert_events.rules`, `details`): otsikko (tärkein syy ja hinta), kauppa, muut syyt riveinä ja tarvittaessa
varoitus. Esimerkki: *Alle tavoitehinnan: 199 €* · Verkkokauppa.com · Uusi alin hinta (aiempi 209 €) ·
18 % alle tavallisen 243 € · Laski 319 € → 199 €.

**Tuotetaso** (paras nykyinen hinta kaikkien kauppojen yli, tuore ≤ 36 h, ei loppu):

| Sääntö | Milloin |
|---|---|
| Alle tavoitehinnan | kun hinta menee tavoitteen alle; uudelleen vain, jos laskee vielä selvästi tai käy välillä yli |
| Kaikkien aikojen alin | selvästi (≥ 1 € ja ≥ 1 %) alle aiemman alimman, vähintään 6 havaintoa |
| Alle tavallisen hinnan | ≥ 10 % alle tavallisen hinnan; tilasidonnainen kuten tavoite |

Tilasidonnaisuus tallentuu `wish_items.alert_state`-kenttään; ensimmäinen arvio vain kirjaa tilan (ei hälytystä).

**Tavallinen hinta** on pienempi 30 ja 90 päivän mediaaneista (päivän alin saatavilla oleva hinta, mukana
hintaoppaan historia). Kun halvat myyjät poistuvat ja jäljelle jää yksi kallis kauppa, 30 päivän luku nousee,
mutta 90 päivän luku pitää vertailun tolkussa. Sääntö voi vain pienentää alennusprosenttia. Sama laskenta
(`item_price_stats`) palvelee näkymiä, hälytyksiä ja ostoksia, ja *Hinta oli alempi* -varoitus katsoo samat 90 päivää.

**Kauppataso**: hinnanpudotus (≥ 5 % ja ≥ 1 €) ja varastoon palaaminen, oletuksena vain jos kauppa on
sen jälkeen tuotteen halvin. Paluu hintaan, joka kaupalla oli jo viimeisen 7 päivän aikana, ei ole pudotus
(hinnan nosto ennen "alea"). Toisto aikaisintaan 24 h, ellei hinta laske edelleen.

**Ilmoitus puhelimeen** vain merkittävistä: tavoite, uusi alin, varastoon aina; alennus tavallisesta tai
pudotus vasta kun ≥ `push_min_pct` (oletus 20 %, säädettävä). Muut näkyvät vain Hälytykset-listassa.
Jos hinta on ollut 60 päivän sisällä selvästi alempi, alennusta ei pushata ja hälytykseen tulee varoitus.

**Ei hälytyksiä**: vertailusivun nimetön alin hinta (hintaseuranta.fi tai hinta.fi ilman kauppaa),
hiljennetyt kaupat (*Älä hälytä* hintataulukossa, lista Asetuksissa) ja kaupat, joita tuote seuraa jo
suoraan (vertailusivun sama kauppa poistetaan valinnoista automaattisesti, myös eri nimillä).

**Kaupan ennen-hinta** (VK, Power, hintaopas) verrataan omaan 30 päivän alimpaan
(`price_observations.own_low_30d_cents`, vaatii viikon historiaa): *Ei oikea alennus* / *Alennus liioiteltu* /
*täsmää seurantaan*. Näkyy hintataulukossa, tarjouskortissa ja hälytyksessä; harhaanjohtava alennus tai
aiemmin selvästi alempi hinta pudottaa ostosuosituksen "Harkitse"-tasolle (oma tavoitehinta ohittaa).

**Hälytykset-näkymä**: *Lista* tai *Tuotteittain* (muistetaan käyttäjäkohtaisesti), 30 päivää, yli 7 päivää
vanhat merkitään luetuiksi automaattisesti.

## Kehitys

```sh
npm test                  # parseri + säännöt (Node, tallennetut fixturet)
npm run shops:check       # hakee jokaisen kaupan testisivun nyt ja vertaa tallennettuun (tests/fixtures/shops.json)
node scripts/shop-fixtures.ts capture [domain]   # tallentaa kauppojen sivut uudelleen testiaineistoksi
npm run check:functions   # Deno-tyyppitarkistus Edge Functioneille
npm run probe -- <url>    # diagnostiikka paikallisesti: robots, status, JSON-LD, bottiesto
node scripts/find-local.ts <EAN tai hakusanat>   # "Etsi muista kaupoista" paikallisesti
npm run build             # web
```
