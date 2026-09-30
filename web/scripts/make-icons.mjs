// Renders PWA icons from public/icons/icon.svg: npm run icons
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = new URL("../public/icons/", import.meta.url);
const svg = readFileSync(new URL("icon.svg", dir));

// Maskable: full-bleed background, artwork inside the 80 % safe zone.
const maskable = Buffer.from(
  svg.toString()
    .replace('rx="112"', 'rx="0"')
    .replace("<path", '<g transform="translate(51 51) scale(0.8)"><path')
    .replace("</svg>", "</g></svg>"),
);
// Badge (Android status bar): white glyph on transparent.
const badge = Buffer.from(
  svg.toString()
    .replace(/<rect[^>]*\/>/, "")
    .replaceAll("#4fd18b", "#ffffff"),
);

const jobs = [
  [svg, 192, "icon-192.png"],
  [svg, 512, "icon-512.png"],
  [maskable, 512, "icon-maskable-512.png"],
  [maskable, 180, "apple-touch-icon.png"],
  [badge, 96, "badge-96.png"],
];
for (const [src, size, name] of jobs) {
  await sharp(src, { density: 300 }).resize(size, size).png().toFile(fileURLToPath(new URL(name, dir)));
  console.log("wrote", name);
}
