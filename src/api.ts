export type ValidationField = { path: (string | number)[]; message: string };
export class RequestError extends Error {
  constructor(message: string, readonly fields: ValidationField[] = []) { super(message); this.name = "RequestError"; }
}
export async function api<T = any>(
  path: string,
  body?: unknown,
  method = body !== undefined ? "POST" : "GET",
  idempotencyKey?: string,
): Promise<T> {
  const repeatable = ["/jobs", "/schedules"].includes(path) && method === "POST";
  const unavailable = repeatable
    ? path === "/jobs" ? "The workspace did not confirm this run. Check Recent activity or retry with the same inputs."
      : "The workspace did not confirm this schedule. Check your schedules or retry with the same settings."
    : "Your local workspace could not be reached. Keep the application running and try again.";
  let response: Response;
  try { response = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(repeatable
        ? { "Idempotency-Key": idempotencyKey ?? crypto.randomUUID() }
        : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }); } catch { throw new Error(unavailable); }
  let data;
  try { data = await response.json(); } catch { throw new Error(unavailable); }
  if (!response.ok) {
    const fields: ValidationField[] = Array.isArray(data?.fields) ? data.fields.filter((field: any) => Array.isArray(field?.path) && field.path.every((part: unknown) => typeof part === "string" || typeof part === "number") && typeof field.message === "string") : [];
    throw new RequestError(fields.length ? fields.map(field => field.path.join(" ") + ": " + field.message).join(". ") : data?.error ?? "The request could not be completed", fields);
  }
  return data;
}
export function download(name: string, text: string, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
