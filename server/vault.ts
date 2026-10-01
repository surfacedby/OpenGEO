import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "./contracts.js";
export type SecretProtector = {
  encrypt: (plain: string) => Buffer;
  decrypt: (sealed: Buffer) => string;
};
export class Vault {
  private values: Record<string, any> = {};
  private protector: SecretProtector;
  private file: string;
  constructor(directory: string, protector?: SecretProtector) {
    this.file = join(directory, "credentials.sealed");
    if (protector) this.protector = protector;
    else {
      const keyFile = process.env.OPENGEO_SECRET_FILE;
      if (!keyFile)
        throw new Error(
          "Set OPENGEO_SECRET_FILE to a file containing at least 32 random bytes. Desktop uses the operating-system credential store.",
        );
      const input = readFileSync(keyFile);
      if (input.length < 32)
        throw new Error("Encryption secret must contain at least 32 bytes");
      const key = createHash("sha256").update(input).digest();
      this.protector = {
        encrypt: (text) => {
          const iv = randomBytes(12),
            c = createCipheriv("aes-256-gcm", key, iv);
          const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
          return Buffer.concat([iv, c.getAuthTag(), body]);
        },
        decrypt: (sealed) => {
          const d = createDecipheriv(
            "aes-256-gcm",
            key,
            sealed.subarray(0, 12),
          );
          d.setAuthTag(sealed.subarray(12, 28));
          return Buffer.concat([
            d.update(sealed.subarray(28)),
            d.final(),
          ]).toString("utf8");
        },
      };
    }
    if (existsSync(this.file))
      this.values = JSON.parse(this.protector.decrypt(readFileSync(this.file)));
  }
  get<T = any>(provider: Provider): T | undefined {
    return structuredClone(this.values[provider]);
  }
  set(provider: Provider, value: unknown) {
    this.save({ ...this.values, [provider]: structuredClone(value) });
  }
  remove(provider: Provider) {
    const next = { ...this.values };
    delete next[provider];
    this.save(next);
  }
  private save(next: Record<string, any>) {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, this.protector.encrypt(JSON.stringify(next)), {
      mode: 0o600,
    });
    renameSync(tmp, this.file);
    this.values = next;
  }
  status() {
    return Object.fromEntries(
      ["chatgpt", "openrouter", "dataforseo", "console"].map((p) => [
        p,
        p === "chatgpt"
          ? Boolean(
              this.values[p]?.profiles?.find(
                (profile: any) => profile.id === this.values[p]?.active,
              )?.access_token && this.values[p]?.profiles?.find((profile: any) => profile.id === this.values[p]?.active)?.scopes?.includes("chatgpt.tokens.use.direct"),
            )
          : Boolean(this.values[p]),
      ]),
    );
  }
}
