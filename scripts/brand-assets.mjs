import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import opentype from "opentype.js";
mkdirSync("assets", { recursive: true });
writeFileSync("assets/Inter-OFL.txt", readFileSync("node_modules/@fontsource/inter/LICENSE"));
const identity = JSON.parse(readFileSync("brand/identity.json", "utf8"));
const escape = (value) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const symbol = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-labelledby="title"><title id="title">' + escape(identity.name) + '</title><path fill="' + identity.primary + '" fill-rule="evenodd" d="' + identity.symbolPath + '"/></svg>';
writeFileSync("public/logo.svg", symbol);
writeFileSync("assets/identity.json", JSON.stringify(identity, null, 2) + "\n");
for (const [name, color] of [
  ["symbol", identity.primary],
  ["symbol-ink", identity.ink],
  ["symbol-white", "#ffffff"],
])
  writeFileSync("assets/" + name + ".svg", symbol.replace(identity.primary, color));
// The bundled open font supplies outlined letters; release SVGs contain no font dependency.
const font = opentype.loadSync(
  resolve("node_modules/@fontsource/inter/files/inter-latin-500-normal.woff"),
);
const outlined = font.getPath(identity.name, 80, 47, 44, { letterSpacing: -0.018 }), word = outlined.toPathData(3), width = Math.ceil(outlined.getBoundingBox().x2 + 8);
const base = /<path[^>]+\/>/.exec(symbol)[0];
for (const [name, color, ink] of [
  ["wordmark", identity.primary, identity.ink],
  ["wordmark-ink", identity.ink, identity.ink],
  ["wordmark-white", "#ffffff", "#ffffff"],
])
  writeFileSync(
    "assets/" + name + ".svg",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' 64" role="img" aria-labelledby="title"><title id="title">' + escape(identity.name) + '</title>' +
      base.replace(identity.primary, color) +
      '<path fill="' +
      ink +
      '" d="' +
      word +
      '"/></svg>',
  );
await sharp(Buffer.from(readFileSync("assets/wordmark.svg", "utf8")))
  .resize(width * 3, 192)
  .extend({ top: 80, bottom: 80, left: 80, right: 80, background: "#ffffff" })
  .flatten({ background: "#ffffff" })
  .png()
  .toFile("assets/wordmark-preview.png");
for (const size of [16, 24, 32, 64, 128, 256, 512, 1024])
  await sharp(Buffer.from(symbol))
    .resize(size, size)
    .png()
    .toFile("assets/icon-" + size + ".png");
const icon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" rx="18" fill="#ffffff"/><g transform="translate(8 8)">' +
  base +
  "</g></svg>";
writeFileSync("assets/app-icon.svg", icon);
await sharp(Buffer.from(icon)).resize(1024).png().toFile("assets/app-icon.png");
const images = await Promise.all(
  [16, 32, 48, 64, 128, 256].map((s) =>
    sharp(Buffer.from(icon)).resize(s).png().toBuffer(),
  ),
);
const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((b, i) => {
  const size = [16, 32, 48, 64, 128, 256][i],
    start = 6 + i * 16;
  header[start] = size === 256 ? 0 : size;
  header[start + 1] = header[start];
  header.writeUInt16LE(1, start + 4);
  header.writeUInt16LE(32, start + 6);
  header.writeUInt32LE(b.length, start + 8);
  header.writeUInt32LE(offset, start + 12);
  offset += b.length;
});
writeFileSync("assets/app-icon.ico", Buffer.concat([header, ...images]));
console.log("Original brand assets generated.");
