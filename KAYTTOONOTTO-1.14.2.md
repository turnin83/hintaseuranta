# Käyttöönotto: hinta.fi-tauko (v1.14.2)

Tarvitset Node.js:n (vähintään 22.18) ja tämän repon koneellesi. Komennot ajetaan repon juuressa.

## 1. Hae uusin koodi

```sh
git checkout main
git pull origin main
```

Tarkista, että migraatio on mukana:

```sh
ls supabase/migrations/20261110120000_host_cooldowns.sql
```

## 2. Kirjaudu ja linkitä projekti

Nämä tarvitaan vain, jos et ole tehnyt niitä aiemmin tällä koneella.

```sh
npx supabase login
npx supabase link --project-ref euqjaihhebvlbaghaeil
```

`login` avaa selaimen. `link` kysyy tietokannan salasanaa (Supabase-paneeli → Project Settings → Database).

## 3. Aja migraatio

```sh
npx supabase db push
```

Komento näyttää ajettavat migraatiot ja kysyy vahvistusta. Listassa pitäisi olla vain
`20261110120000_host_cooldowns.sql`. Vastaa `Y`.

Jos listassa on muitakin tiedostoja, ne ovat jääneet aiemmin ajamatta. Niiden ajaminen on yleensä oikein,
mutta tarkista lista ennen vahvistusta.

**Vaihtoehto ilman CLI:tä:** Supabase-paneeli → SQL Editor → liitä tiedoston
`supabase/migrations/20261110120000_host_cooldowns.sql` sisältö → Run. Tällöin CLI ei tiedä migraation
ajetuksi, ja seuraava `db push` yrittää ajaa sen uudelleen ja epäonnistuu (taulu on jo olemassa). Merkitse se
siksi ajetuksi:

```sh
npx supabase migration repair --status applied 20261110120000
```

## 4. Julkaise funktiot

```sh
npx supabase functions deploy fetch-prices find-offers preview-product
```

Jokaisesta funktiosta pitäisi tulla ilmoitus `Deployed Function`.

## 5. Tarkista

Aja Supabase-paneelin SQL Editorissa:

```sql
-- Taulu on olemassa (tyhjä, kunnes hinta.fi estää seuraavan kerran)
select * from public.host_cooldowns;

-- hinta.fi:n sivujen väli on nyt 10 s
select domain, min_delay_ms from public.shops where domain = 'hinta.fi';
```

Sovelluksessa: kokeile *Etsi muista kaupoista* jollakin tuotteella.
- Jos hinta.fi vastaa, tulokset näkyvät normaalisti.
- Jos hinta.fi on yhä estänyt palvelimen, näet viestin "hinta.fi on rajoittanut hakuja tilapäisesti … Haut
  jatkuvat automaattisesti klo … jälkeen". Silloin tauko on alkanut, eikä sovellus kysy hinta.fi:ltä mitään
  ennen sitä.

Jos tauko pitää jostain syystä lopettaa käsin:

```sql
delete from public.host_cooldowns where domain = 'hinta.fi';
```

## Web-sovellus

Versionumero näkyy sovelluksessa versiona 1.14.2, kun Cloudflare Pages on kääntänyt mainin. Web-puolella ei
ole muita muutoksia: uudet virheviestit tulevat funktioista.
