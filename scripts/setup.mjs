import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
const dir = resolve(".local");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = resolve(dir, "encryption-secret");
if (!existsSync(file)) writeFileSync(file, randomBytes(48), { mode: 0o600 });
console.log(
  "Local encryption secret ready. Set OPENGEO_SECRET_FILE to .local/encryption-secret before starting. Keep this file private. Desktop uses the operating-system credential store.",
);
