import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import identity from "../brand/identity.json";

/** One runtime owns job recovery. A second process must not pause its paid work. */
export function lockRuntime(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "runtime.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => {
        if (readFileSync(file, "utf8") === String(process.pid))
          unlinkSync(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(file, "utf8"));
      let live = true;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") live = false;
        }
      }
      if (live)
        throw new Error(identity.name + " is already running for this data directory.");
      unlinkSync(file);
    }
  }
  throw new Error("Could not acquire the " + identity.name + " runtime lock.");
}
