# OpenGEO identity

The original **Source bird** symbol pairs an observant bird with a folded source page in its wing. It represents finding useful evidence and acting on it. The compact silhouette, cut-out eye and angled tail remain identifiable without letters or color. It is the product mark; provider identifiers belong only beside their connections.

Primary blue: `#0d6cf2`. Neutral ink: `#0f172a`. Use `symbol.svg` or `wordmark.svg` on white and light neutral backgrounds. Use white variants on dark backgrounds and ink variants for monochrome printing. Do not rotate, stretch, recolor individual parts or add effects.

The outlined Inter Medium wordmark uses slightly tighter spacing. Keep its proportions and the supplied symbol-to-word spacing. SVGs contain no remote fonts, raster images or scripts.

Leave at least 12 units of clear space on the symbol's 64-unit grid and half the symbol width around the wordmark. The minimum symbol size is 16 pixels; the wordmark should be at least 120 pixels wide. Use the symbol alone at favicon sizes. Installer assets use the supplied application icon and ICO.

## Renaming

Edit `brand/identity.json`, then run `node scripts/sync-identity.mjs`. The shared identity supplies the app title, sign-in page, OAuth display hint, desktop window/tray title, package name, installer display name, SVG titles and outlined wordmark. The sync updates public Markdown display names and regenerates distribution assets. Normal builds run it too.

Change `name` and `slug` for a display/package rename. Keep `appId` and `storageName` stable so existing desktop installations keep their database and protected connections. Export format identifiers, configuration environment names and OAuth registrations deliberately remain stable. A filesystem/repository rename is independent of the display name.

The product functionality does not depend on the name. Naming and confusing-similarity clearance remain publication checks. The name has earlier geospatial uses and current GEO project uses. An original drawing does not establish name clearance.

The name research found a [US filing, serial 99278124, reported abandoned on March 30, 2026](https://www.trademarkelite.com/trademark/trademark-detail/99278124/OPENGEO). This secondary record is a research lead, not worldwide clearance. Check current records through the [USPTO](https://www.uspto.gov/trademarks/search) before publication. [Boundless announced its change from OpenGeo in 2013](https://www.prnewswire.com/news-releases/opengeo-is-now-boundless-224065831.html).
