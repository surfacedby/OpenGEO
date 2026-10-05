import { mkdirSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
const dir = resolve(".local");
// The private folder protects the secret on the host. Docker mounts the file itself, and the container's
// unprivileged user must be able to read it whatever the host user's ID, so the file is not owner-only.
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const file = resolve(dir, "encryption-secret");
if (!existsSync(file)) writeFileSync(file, randomBytes(48));
chmodSync(file, 0o644);
console.log(
  "Local encryption secret ready. Set OPENGEO_SECRET_FILE to .local/encryption-secret before starting. Keep the .local folder private. Desktop uses the operating-system credential store.",
);
