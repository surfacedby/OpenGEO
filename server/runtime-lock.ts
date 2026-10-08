import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import identity from "../brand/identity.json";

/** A native exclusive lock protects job recovery and is released by the OS after a crash. */
export function lockRuntime(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let lock: Database.Database | undefined;
  try {
    lock = new Database(join(directory, "runtime-lock.sqlite"), { timeout: 0 });
    lock.exec("BEGIN EXCLUSIVE");
    return () => { if (lock?.open) lock.close(); };
  } catch (error) {
    if (lock?.open) lock.close();
    if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes((error as { code?: string }).code ?? ""))
      throw new Error(identity.name + " is already running for this data directory.");
    throw error;
  }
}
