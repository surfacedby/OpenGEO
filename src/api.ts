export type ValidationField = { path: (string | number)[]; message: string };
export class RequestError extends Error {
  constructor(message: string, readonly fields: ValidationField[] = []) { super(message); this.name = "RequestError"; }
}
let sessionGeneration = 0;
let sessionRefresh: Promise<void> | undefined;
// Keep only the current workspace in memory, never in browser or disk storage.
let workspaceCache: { path: string; etag: string; data: unknown } | undefined;
function refreshSession(): Promise<void> {
  if (!sessionRefresh) {
    sessionRefresh = fetch("/api/session", { credentials: "same-origin", signal: AbortSignal.timeout(15000) }).then(response => {
      if (response.status === 401) throw new RequestError("Your workspace is locked. Open /login in another tab, sign in, then retry. Your unsaved work stays in this tab.");
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
  const asking = /^\/projects\/[^/]+\/asks$/.test(path);
  const repeatable = (["/jobs", "/schedules"].includes(path) || asking) && method === "POST";
  const unavailable = repeatable
    ? path === "/jobs" ? "The workspace did not confirm this run. If it started, it appears as in progress on this page; otherwise retry with the same inputs."
      : asking ? "The workspace did not confirm this ask. If it started, it appears in Ask history; otherwise ask again."
      : "The workspace did not confirm this schedule. Check your schedules or retry with the same settings."
    : "Your local workspace could not be reached. Keep the application running and try again.";
  let response: Response;
  const workspaceRead = method === 'GET' && /^\/projects\/[^/]+\/workspace(?:\?pages=lazy)?$/.test(path);
  const cached = workspaceRead && workspaceCache?.path === path ? workspaceCache : undefined;
  const generation = sessionGeneration;
  const options: RequestInit = {
    method,
    ...(method === "GET" ? { signal: AbortSignal.timeout(15000) } : {}),
    credentials: "same-origin",
    headers: {
      ...(cached ? { 'If-None-Match': cached.etag } : {}),
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
      workspaceCache = undefined;
      delete (options.headers as Record<string, string>)['If-None-Match'];
      if (generation === sessionGeneration) await refreshSession();
      response = await fetch("/api" + path, options);
    }
  } catch (error) { if (error instanceof RequestError) throw error; throw new Error(unavailable); }
  if (response.status === 304 && cached && (options.headers as Record<string, string>)['If-None-Match'] === cached.etag) return cached.data as T;
  let data;
  try { data = await response.json(); } catch { throw new Error(unavailable); }
  if (!response.ok) {
    const fields: ValidationField[] = Array.isArray(data?.fields) ? data.fields.filter((field: any) => Array.isArray(field?.path) && field.path.every((part: unknown) => typeof part === "string" || typeof part === "number") && typeof field.message === "string") : [];
    throw new RequestError(fields.length ? fields.map(field => field.path.join(" ") + ": " + field.message).join(". ") : data?.error ?? "The request could not be completed", fields);
  }
  if (workspaceRead) {
    const etag = response.headers.get('etag');
    workspaceCache = etag ? { path, etag, data } : undefined;
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
