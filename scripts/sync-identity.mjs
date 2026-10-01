import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import identity from "../brand/identity.json" with { type: "json" };
if (!/^[\p{L}\p{N}][\p{L}\p{N} -]{0,63}$/u.test(identity.name) || !/^[a-z][a-z0-9-]{1,63}$/.test(identity.slug)) throw new Error("Use a plain product name and a lowercase package slug.");
const packageFile = JSON.parse(readFileSync("package.json", "utf8")), previous = packageFile.build.productName;
packageFile.name = identity.slug; packageFile.build.productName = identity.name; packageFile.build.appId = identity.appId;
writeFileSync("package.json", JSON.stringify(packageFile, null, 2) + "\n");
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
lock.name = identity.slug; lock.packages[""].name = identity.slug;
writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
if (previous !== identity.name) {
  // Public display names can change without rewriting storage paths, OAuth registrations or export formats.
  const files = ["README.md", "CONTRIBUTING.md", "SECURITY.md", ...readdirSync("docs").filter((file) => file.endsWith(".md")).map((file) => "docs/" + file)];
  for (const file of files) writeFileSync(file, readFileSync(file, "utf8").replaceAll(previous, identity.name));
}
await import("./brand-assets.mjs");
