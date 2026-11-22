import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidateMismatch,
  features,
  findDuplicates,
  gtin,
  linkMismatches,
  productUrlKey,
} from "../web/src/lib/same-product.ts";

let n = 0;
const link = (model_name: string | null, ean: string | null = null, url = `https://shop${++n}.fi/p/${n}`) => ({
  id: `l${n}`, url, ean, model_name,
});

test("gtin: check digit, leading zeros and shop codes", () => {
  assert.equal(gtin("4548736178298"), "04548736178298");
  assert.equal(gtin("810037291261"), gtin("0810037291261")); // UPC-12 and EAN-13 of the same product
  assert.equal(gtin("470855322"), null); // a shop's own code, not a GTIN
  assert.equal(gtin("4548736178299"), null); // wrong check digit
  assert.equal(gtin("0000000000000"), null);
  assert.equal(gtin(null), null);
});

test("features: sizes, capacities, volumes, packs and colours from titles", () => {
  assert.deepEqual([...features('SONY 65" BRAVIA 7 II RGB QFHD TV K65XR75M2PB').inch], ["65"]);
  assert.deepEqual([...features("Bravia 7 MK2 75 tuumainen True RGB Google TV").inch], ["75"]);
  assert.deepEqual([...features("TCL C8L 75C8L").inch], []); // model codes are not read
  assert.deepEqual([...features("Kingston NV3 PCIe 4.0 NVMe 1 Tt M.2 SSD").storage], ["1000"]);
  assert.deepEqual([...features("Kingston NV3 M.2 2280 PCIe 4.0 NVMe 500GB").storage], ["500"]);
  assert.deepEqual([...features("Philips 5000-sarja NA547/07 7.2 l").volume], ["7200"]);
  assert.deepEqual([...features("Uni Posca Marker 8 kpl PC-5M").pack], ["8"]);
  assert.deepEqual([...features("Oral-B iO 3 Duo -sähköhammasharja, 2 kpl, Matte Black/Ice Blue").colour].sort(), ["musta", "sininen"]);
  assert.deepEqual([...features("NutriBullet Ultra 0,9 l tummanharmaa-musta").colour].sort(), ["harmaa", "musta"]);
  assert.deepEqual([...features("Samsung Galaxy kuulokkeet Bluetooth").colour], []); // "Blue" only as a word
  assert.deepEqual([...features("Ryzen 5 7500X3D 4.0 GHz 96 MB L3").storage], []);
});

test("a 65-inch page in a 75-inch item is flagged, with its EAN", () => {
  const ls = [
    link("Bravia 7 MK2 75 tuumainen True RGB Google TV", "4548736178298"),
    link('Sony 75" BRAVIA 7 II True RGB LED 4K Google TV K75XR75M2PB (2026)', "4548736178298"),
    link('SONY 65" BRAVIA 7 II RGB QFHD TV K65XR75M2PB', "4548736178335"),
    link('Sony 75" Bravia 7 II – 4K True RGB Google TV', "4548736178298"),
  ];
  const m = linkMismatches('Sony 75" BRAVIA 7 II True RGB LED 4K Google TV K75XR75M2PB (2026)', ls);
  assert.deepEqual([...m.keys()], [ls[2].id]);
  assert.deepEqual(m.get(ls[2].id), [
    "eri EAN 4548736178335 (muilla 4548736178298)",
    "65″, tuotteella 75″",
  ]);
});

test("EAN: the minority is flagged, a 1 vs 1 tie is not", () => {
  // Kärcher RCW 2 Extra+: Proshop's page is the plain RCW 2.
  const k = [link("Kärcher RCW 2 Extra+", "4066529224453"), link("Kärcher RCW 2", "4066529208149"), link("RCW 2 Extra+", "4066529224453")];
  assert.deepEqual([...linkMismatches("Karcher RCW 2 Extra+ ikkunanpesurobotti", k).keys()], [k[1].id]);
  // Two shops share the other code: still the minority (Google TV Streamer, 6 vs 2).
  const g = [
    ...["0810037291261", "810037291261", "0810037291261", "0810037291261"].map((e) => link("Google TV Streamer (4K)", e)),
    link("Google TV Streamer (4K)", "0810037291292"),
    link("GOOGLE TV STREAMER 4K MEDIATOISTIN", "0810037291292"),
  ];
  assert.deepEqual([...linkMismatches("Google TV Streamer (4K)", g).keys()], [g[4].id, g[5].id]);
  // 1 vs 1: no side to pick.
  const t = [link("NutriBullet Ultra", "8006447002159"), link("NutriBullet Ultra", "8006447002166")];
  assert.equal(linkMismatches("NutriBullet Ultra Blender", t).size, 0);
  // Shop codes that are not GTINs are ignored.
  const d = [link("Ryzen 5 7500F", "4251538815826"), link("Ryzen 5 7500F", "470855322"), link("Ryzen 5 7500F", "4251538815826")];
  assert.equal(linkMismatches("AMD Ryzen 5 7500F", d).size, 0);
});

test("colour: the item's name decides; without it the links' majority does", () => {
  const ls = [link("be quiet! PURE BASE 501 Airflow Black - Musta"), link("Be Quiet! Pure Base 501 AirFlow - White"), link("Be-Quiet PURE BASE 501 Airflow")];
  const m = linkMismatches("be quiet! PURE BASE 501 Airflow Black - Kotelot - Miditower - Musta", ls);
  assert.deepEqual([...m.entries()], [[ls[1].id, ["valkoinen, tuotteella musta"]]]);
  // Name without colour: four white pages, one black.
  const f = [
    ...["Meshify 3 Valkoinen", "Meshify 3 White RGB TG", "Meshify 3 White RGB", "Meshify 3 White RGB - Valkoinen"].map((t) => link(t)),
    link("Meshify 3 Black"),
    link("Fractal Design Meshify 3 Solid"),
  ];
  const fm = linkMismatches("Fractal Design Meshify 3", f);
  assert.deepEqual([...fm.entries()], [[f[4].id, ["musta, muilla valkoinen"]]]);
  // Overlapping colours are the same product (black/blue vs blue/black).
  const o = [link("Oral-B iO 3 Duo, Matte Black/Ice Blue"), link("iO Series 3s Duo -sähköhammasharja, sininen / musta")];
  assert.equal(linkMismatches("Oral-B iO Series 3 Duo - Matt Black/Ice Blue", o).size, 0);
});

test("capacity: a 1 TB page in a 500 GB item", () => {
  const ls = [link("Kingston NV3 500 Gt M.2"), link("Kingston NV3 M.2 2280 PCIe 4.0 NVMe 1TB"), link("Kingston NV3 SSD - 500GB")];
  assert.deepEqual(linkMismatches("Kingston Technology NV3", ls).get(ls[1].id), ["1 TB, muilla 500 GB"]);
});

test("a new page for an existing item: one link is enough to warn", () => {
  const ls = [link('Sony 75" BRAVIA 7 II', "4548736178298")];
  assert.deepEqual(candidateMismatch("Sony Bravia 7 II", ls, { ean: "4548736178335", name: 'SONY 65" BRAVIA 7 II' }), [
    "eri EAN 4548736178335 (tuotteella 4548736178298)",
    "65″, muilla 75″",
  ]);
  assert.deepEqual(candidateMismatch("Sony Bravia 7 II", ls, { ean: "4548736178298", name: "Sony Bravia 7 II 75 tuumainen" }), []);
});

test("productUrlKey: www, trailing slash and tracking parameters do not matter", () => {
  assert.equal(
    productUrlKey("https://www.maxgaming.fi/fi/termostaatit/tapo-t315/?campaign_id=1&adgroup_id=2&utm_source=x"),
    productUrlKey("https://maxgaming.fi/fi/termostaatit/tapo-t315"),
  );
  assert.notEqual(productUrlKey("https://hintaopas.fi/product.php?p=1"), productUrlKey("https://hintaopas.fi/product.php?p=2"));
});

test("duplicates: a shared page, the same EAN or the same name; older item first", () => {
  const items = [
    { id: "a", name: "AMD Ryzen 5 7500X3D", created_at: "2026-10-19" },
    { id: "b", name: 'Sony 75" BRAVIA 7 II True RGB LED 4K Google TV K75XR75M2PB (2026)', created_at: "2026-10-01" },
    { id: "c", name: "AMD Ryzen 5 7500X3D 4.0 GHz Socket AM5 Laatikko", created_at: "2026-11-21" },
    { id: "d", name: 'Sony 75" Bravia 7 II – 4K True RGB Google TV', created_at: "2026-11-02" },
    { id: "e", name: "Kingston NV3 1TB", created_at: "2026-11-22" },
    { id: "f", name: "Kingston NV3 500GB", created_at: "2026-10-17" },
  ];
  const links: Record<string, ReturnType<typeof link>[]> = {
    a: [link("x", "0730143318167", "https://www.hintaopas.fi/product.php?p=15769114"), link("x", "0730143318167")],
    c: [link("x", null, "https://hintaopas.fi/product.php?p=15769114")],
    b: [
      link("x", "4548736178298", "https://www.verkkokauppa.com/fi/product/1050949/Sony"),
      link("x", "4548736178298"),
      link("65", "4548736178335"), // a wrong page does not make b a duplicate of a 65" item
    ],
    d: [link("x", "4548736178298", "https://www.verkkokauppa.com/fi/product/1050949/Sony/")],
    e: [link("x", "0740617344790")],
    f: [link("x", "0740617344806")],
  };
  const pairs = findDuplicates(items, (id) => links[id] ?? []);
  assert.deepEqual(pairs.map((p) => [p.older.id, p.newer.id, p.why]), [
    ["a", "c", ["sama linkki: hintaopas.fi"]],
    ["b", "d", ["sama linkki: verkkokauppa.com", "sama EAN 4548736178298"]],
  ]);
});
