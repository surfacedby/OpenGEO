export type ValidationField = { path: (string | number)[]; message: string };
export class RequestError extends Error {
  constructor(message: string, readonly fields: ValidationField[] = []) { super(message); this.name = "RequestError"; }
}
let sessionGeneration = 0;
let sessionRefresh: Promise<void> | undefined;
function refreshSession(): Promise<void> {
  if (!sessionRefresh) {
    sessionRefresh = fetch("/api/session", { credentials: "same-origin" }).then(response => {
      if (!response.ok) throw new Error("Local session could not be renewed");
      sessionGeneration++;
    }).finally(() => { sessionRefresh = undefined; });
  }
  return sessionRefresh;
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
  const generation = sessionGeneration;
  const options: RequestInit = {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(repeatable
        ? { "Idempotency-Key": idempotencyKey ?? crypto.randomUUID() }
        : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  try {
    response = await fetch("/api" + path, options);
    // Local authorization runs before handlers, so a refused request has not
    // started work. Other failures retain the caller's explicit retry flow.
    if (response.status === 401 && path !== "/session") {
      if (generation === sessionGeneration) await refreshSession();
      response = await fetch("/api" + path, options);
    }
  } catch { throw new Error(unavailable); }
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
