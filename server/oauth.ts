import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Vault } from "./vault.js";
import { Store } from "./storage.js";
import { providerJson } from "./network.js";
import { ProviderError } from "./contracts.js";
import { connectionPage } from "./connection-page.js";
import identity from "../brand/identity.json";
const issuer = "https://auth.openai.com",
  resource = "https://api.openai.com/v1";
type Pending = {
  provider: "chatgpt" | "openrouter";
  verifier: string;
  nonce: string;
  redirect: string;
  clientId: string;
  profileId?: string;
  server?: Server;
  expires: number;
  timer?: ReturnType<typeof setTimeout>;
  epoch: number;
};
export class Connections {
  private pending = new Map<string, Pending>();
  private outcomes = new Map<string, { provider: "chatgpt" | "openrouter"; status: "pending" | "connected" | "identity" | "failed"; expires: number }>();
  private latestAttempts = new Map<string, string>();
  private refreshing = new Map<string, Promise<string>>();
  private signingOut = new Set<string>();
  private epochs = new Map<string, number>();
  private servers = new Set<Server>();
  constructor(
    readonly store: Store,
    readonly vault: Vault,
    readonly returnUrl: () => string | undefined = () => undefined,
    readonly onConnected: () => void = () => {},
  ) {
    const account = vault.get("chatgpt");
    if (account?.profiles?.some((profile: any) => !profile.label)) {
      account.profiles.forEach((profile: any, index: number) => { profile.label ??= "Connection " + (index + 1); });
      vault.set("chatgpt", account);
    }
  }
  profiles() {
    const c = this.vault.get("chatgpt");
    const active = c?.profiles?.find((profile: any) => profile.id === c.active);
    return {
      active: c?.active ?? null,
      welcome: Boolean(active?.access_token && active?.scopes?.includes("chatgpt.tokens.use.direct") && !active.planWelcomeAcknowledged),
      profiles: (c?.profiles ?? []).map((p: any, index: number) => ({
        id: p.id,
        email: p.email ?? "ChatGPT account",
        label: p.label ?? "Connection " + (index + 1),
        sharing:
          p.scopes?.includes("chatgpt.tokens.use.direct") &&
          Boolean(p.access_token),
      })),
    };
  }
  select(id: string) {
    const c = this.vault.get("chatgpt");
    if (!c?.profiles?.some((p: any) => p.id === id))
      throw new Error("Profile not found");
    c.active = id;
    this.vault.set("chatgpt", c);
  }
  async start(
    provider: "chatgpt" | "openrouter",
    profileId?: string,
    headless = false,
  ) {
    this.assertIdle(provider);
    for (const [state, outcome] of this.outcomes) if (outcome.expires < Date.now() || outcome.provider === provider) this.outcomes.delete(state);
    const verifier = randomBytes(32).toString("base64url"),
      state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url");
    const saved = this.vault
      .get("chatgpt")
      ?.profiles?.find((p: any) => p.id === profileId);
    if (profileId && !saved) throw new Error("Profile not found");
    this.latestAttempts.set(provider, state);
    for (const [attempt, previous] of this.pending) {
      if (previous.provider !== provider) continue;
      if (previous.timer) clearTimeout(previous.timer);
      previous.server?.close(() => { if (previous.server) this.servers.delete(previous.server); });
      this.pending.delete(attempt);
    }
    const p: Pending = {
      provider,
      verifier,
      nonce,
      redirect: "",
      clientId: saved?.client_id ?? "dynamic_agent_client",
      profileId,
      expires: Date.now() + 600000,
      epoch: this.epochs.get(profileId ?? "") ?? 0,
    };
    if (provider === "chatgpt" || !headless) {
      const server = createServer(async (req, res) => {
        try {
          const callback = new URL(req.url ?? "/", p.redirect);
          if (
            req.method !== "GET" ||
            req.headers.host !== new URL(p.redirect).host
          )
            throw new Error("Invalid callback host");
          if (
            callback.pathname !== "/auth/callback" ||
            (callback.searchParams.get("state") &&
              callback.searchParams.get("state") !== state)
          )
            throw new Error("Invalid callback");
          if (
            provider === "chatgpt" &&
            callback.searchParams.get("state") !== state
          )
            throw new Error("Invalid callback");
          const result = await this.finish(state, callback.searchParams);
          this.page(res, result?.sharing === false ? "identity" : "connected", provider);
          server.close(() => this.servers.delete(server));
          try { this.onConnected(); } catch { /* Window focus cannot invalidate a completed connection. */ }
        } catch {
          this.page(res, "error", provider);
          if (!this.pending.has(state)) server.close(() => this.servers.delete(server));
        }
      });
      const callbackPort = Number(process.env.OPENGEO_OAUTH_PORT ?? 0);
      if (
        !Number.isInteger(callbackPort) ||
        callbackPort < 0 ||
        callbackPort > 65535
      )
        throw new Error("Invalid local callback port");
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => {
          server.close();
          reject(error);
        };
        server.once("error", failed);
        server.listen(
          callbackPort,
          process.env.OPENGEO_CONTAINER === "1" ? "0.0.0.0" : "127.0.0.1",
          () => {
            server.removeListener("error", failed);
            resolve();
          },
        );
      });
      p.server = server;
      this.servers.add(server);
      p.redirect =
        "http://127.0.0.1:" + (server.address() as any).port + "/auth/callback";
    }
    if (this.latestAttempts.get(provider) !== state) {
      p.server?.close(() => { if (p.server) this.servers.delete(p.server); });
      throw new Error("A newer connection attempt has replaced this one");
    }
    this.pending.set(state, p);
    const timer = p.timer = setTimeout(() => {
      this.pending.delete(state);
      p.server?.close(() => { if (p.server) this.servers.delete(p.server); });
    }, 600000);
    timer.unref();
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(
      provider === "chatgpt"
        ? issuer + "/api/accounts/authorize"
        : "https://openrouter.ai/auth",
    );
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    if (provider === "openrouter") {
      url.searchParams.set("key_label", identity.name);
      if (p.redirect) url.searchParams.set("callback_url", p.redirect);
    } else {
      let host = this.store.setting("chatgptHostId", "");
      if (!host) {
        host = "urn:uuid:" + randomUUID();
        this.store.set("chatgptHostId", host);
      }
      for (const [key, value] of Object.entries({
        client_id: p.clientId,
        ext_agent_host_id: host,
        response_type: "code",
        redirect_uri: p.redirect,
        scope:
          "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        resource,
        nonce,
      }))
        url.searchParams.set(key, value);
      if (p.clientId === "dynamic_agent_client")
        url.searchParams.set("agent_name_hint", identity.name);
      else {
        if (saved?.email) url.searchParams.set("login_hint", saved.email);
        if (saved?.access_token && !saved?.scopes?.includes("chatgpt.tokens.use.direct")) url.searchParams.set("prompt", "consent");
      }
    }
    return { url: url.href, state, headless: !p.redirect };
  }
  status(provider: "chatgpt" | "openrouter", state: string) {
    const pending = this.pending.get(state), outcome = this.outcomes.get(state);
    if (pending?.provider === provider && pending.expires > Date.now()) return { status: "pending" as const };
    if (outcome?.provider === provider && outcome.expires > Date.now()) return { status: outcome.status };
    return { status: "expired" as const };
  }
  async finish(state: string, params: URLSearchParams) {
    const pending = this.pending.get(state);
    if (pending && pending.expires > Date.now()) this.outcomes.set(state, { provider: pending.provider, status: "pending", expires: Date.now() + 600000 });
    try {
      const result = await this.finishAttempt(state, params);
      if (pending) this.outcomes.set(state, { provider: pending.provider, status: result?.sharing === false ? "identity" : "connected", expires: Date.now() + 600000 });
      return result;
    } catch (error) {
      if (pending && !this.pending.has(state)) this.outcomes.set(state, { provider: pending.provider, status: "failed", expires: Date.now() + 600000 });
      throw error;
    }
  }
  private assertIdle(provider: "chatgpt" | "openrouter") {
    if (this.store.jobs().some((job) => job.provider === provider && job.status === "running"))
      throw new ProviderError("busy", "Stop the active workflow before changing this connection.");
  }
  /** A slow exchange must never replace credentials from a newer sign-in. */
  private assertCurrent(provider: "chatgpt" | "openrouter", state: string) {
    if (this.latestAttempts.get(provider) !== state)
      throw new Error("A newer connection attempt has replaced this one");
  }
  private async finishAttempt(state: string, params: URLSearchParams) {
    const p = this.pending.get(state);
    if (!p || p.expires < Date.now())
      throw new Error("Connection attempt expired");
    this.assertCurrent(p.provider, state);
    if (p.provider === "chatgpt" && params.get("state") !== state)
      throw new Error("Invalid callback state");
    if (params.has("error")) {
      this.pending.delete(state);
      if (p.timer) clearTimeout(p.timer);
      throw new Error("Authorization was declined");
    }
    const code = params.get("code");
    if (!code) throw new Error("Authorization code missing");
    this.pending.delete(state);
    if (p.timer) clearTimeout(p.timer);
    this.assertIdle(p.provider);
    if (p.provider === "openrouter") {
      const result = await providerJson(
        "https://openrouter.ai/api/v1/auth/keys",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            code_verifier: p.verifier,
            code_challenge_method: "S256",
          }),
        },
      );
      if (!result.key) throw new Error("Key missing");
      this.assertCurrent("openrouter", state);
      this.assertIdle("openrouter");
      this.vault.set("openrouter", { key: result.key });
      return;
    }
    let clientId = params.get("client_id") ?? p.clientId;
    if (
      clientId === "dynamic_agent_client" ||
      (p.clientId !== "dynamic_agent_client" && clientId !== p.clientId)
    )
      throw new Error("Registration did not return the expected client");
    const saved = this.vault.get("chatgpt") ?? { profiles: [], active: null };
    const id = p.profileId ?? randomUUID();
    const old = saved.profiles.find((x: any) => x.id === id);
    const registration = { ...old, id, client_id: clientId, label: old?.label ?? "Connection " + (saved.profiles.length + (old ? 0 : 1)) };
    saved.profiles = saved.profiles
      .filter((x: any) => x.id !== id)
      .concat(registration);
    this.vault.set("chatgpt", saved);
    const result = await providerJson(issuer + "/api/accounts/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: p.verifier,
        redirect_uri: p.redirect,
        resource,
      }),
    });
    const discovery = await providerJson(
      issuer + "/.well-known/openid-configuration",
    );
    if (
      discovery.issuer !== issuer ||
      new URL(discovery.jwks_uri).origin !== issuer
    )
      throw new Error("Invalid identity discovery");
    const verified = await jwtVerify(
      result.id_token,
      createRemoteJWKSet(new URL(discovery.jwks_uri)),
      { issuer, audience: clientId },
    );
    if (
      verified.payload.nonce !== p.nonce ||
      !verified.payload.sub ||
      (old?.subject && old.subject !== verified.payload.sub)
    )
      throw new Error("Identity did not match this sign-in");
    if (p.profileId && ((this.epochs.get(p.profileId) ?? 0) !== p.epoch || this.signingOut.has(p.profileId)))
      throw new Error("The account was disconnected during sign-in");
    const credentials = validTokens(result);
    const profile = {
      ...registration,
      ...credentials,
      subject: verified.payload.sub,
      email: verified.payload.email ?? "ChatGPT account",
      scopes: String(result.scope ?? "").split(" "),
      expiresAt: credentials.expiresAt,
    };
    const latest = this.vault.get("chatgpt") ?? { profiles: [], active: null };
    latest.profiles = latest.profiles
      .filter((x: any) => x.id !== id)
      .concat(profile);
    latest.active = id;
    this.assertCurrent("chatgpt", state);
    this.assertIdle("chatgpt");
    this.vault.set("chatgpt", latest);
    return { sharing: profile.scopes.includes("chatgpt.tokens.use.direct") };
  }
  private page(response: import("node:http").ServerResponse, state: import("./connection-page.js").ConnectionPageState, provider: "chatgpt" | "openrouter") {
    const nonce = randomBytes(24).toString("base64url");
    response.writeHead(state === "error" ? 400 : 200, {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    response.end(connectionPage(state, provider, this.returnUrl(), nonce));
  }
  async token(): Promise<string> {
    const account = this.vault.get("chatgpt"),
      profile = account?.profiles.find((entry: any) => entry.id === account.active);
    if (!profile?.access_token || !profile.scopes?.includes("chatgpt.tokens.use.direct") || this.signingOut.has(profile.id))
      throw new ProviderError("auth", "Connect ChatGPT and enable ChatGPT plan usage.");
    if (profile.expiresAt > Date.now() + 60000) return profile.access_token;
    if (!profile.refresh_token) throw new ProviderError("auth", "Reconnect ChatGPT.");
    const existing = this.refreshing.get(profile.id);
    if (existing) return existing;
    const operation = (async () => {
      let result;
      try {
        result = await providerJson(issuer + "/api/accounts/oauth/token", {
          method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", client_id: profile.client_id, refresh_token: profile.refresh_token, resource }),
        });
      } catch (error) {
        if (error instanceof ProviderError && ["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"].includes(error.remoteCode ?? "")) {
          this.clearTokens(profile.id);
          throw new ProviderError("auth", "Your ChatGPT connection expired. Reconnect the saved account.");
        }
        throw error;
      }
      const tokens = validTokens(result);
      const latest = this.vault.get("chatgpt"), current = latest?.profiles.find((entry: any) => entry.id === profile.id);
      if (!current || current.refresh_token !== profile.refresh_token)
        throw new ProviderError("auth", "The ChatGPT connection changed. Start the task again.");
      Object.assign(current, tokens, { scopes: result.scope === undefined ? current.scopes : String(result.scope).split(" ") });
      this.vault.set("chatgpt", latest);
      if (this.signingOut.has(profile.id) || latest.active !== profile.id)
        throw new ProviderError("auth", "The active ChatGPT connection changed.");
      if (!current.scopes?.includes("chatgpt.tokens.use.direct"))
        throw new ProviderError("auth", "ChatGPT plan permission is unavailable. Reconnect this account and review its permissions.");
      return current.access_token as string;
    })();
    this.refreshing.set(profile.id, operation);
    try { return await operation; }
    finally { if (this.refreshing.get(profile.id) === operation) this.refreshing.delete(profile.id); }
  }
  private clearTokens(id: string) {
    const latest = this.vault.get("chatgpt"), current = latest?.profiles.find((entry: any) => entry.id === id);
    if (!current) return;
    for (const key of ["access_token", "refresh_token", "id_token", "expiresAt"]) delete current[key];
    this.vault.set("chatgpt", latest);
  }
  acknowledgePlan() {
    const account = this.vault.get("chatgpt"), profile = account?.profiles.find((entry: any) => entry.id === account.active);
    if (!profile?.access_token || !profile.scopes?.includes("chatgpt.tokens.use.direct")) throw new ProviderError("auth", "Enable ChatGPT plan usage first.");
    profile.planWelcomeAcknowledged = true;
    this.vault.set("chatgpt", account);
  }
  /** A rotating refresh must settle before revocation, so sign-out cannot resurrect credentials. */
  async signOut() {
    const id = this.vault.get("chatgpt")?.active;
    if (!id) return { revoked: true };
    this.signingOut.add(id); this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    try {
      await this.refreshing.get(id)?.catch(() => {});
      const account = this.vault.get("chatgpt"), profile = account?.profiles.find((entry: any) => entry.id === id);
      let revoked = !profile?.refresh_token;
      if (profile?.refresh_token) {
        try {
          const discovery = await providerJson(issuer + "/.well-known/openid-configuration");
          if (discovery.issuer !== issuer || new URL(discovery.revocation_endpoint).origin !== issuer) throw new Error("Invalid revocation endpoint");
          for (let attempt = 0; attempt < 2; attempt++) {
            const response = await fetch(discovery.revocation_endpoint, {
              method: "POST", signal: AbortSignal.timeout(15000),
              body: new URLSearchParams({ token: profile.refresh_token, token_type_hint: "refresh_token", client_id: profile.client_id }),
            }).catch(() => null);
            revoked = response?.ok === true;
            if (revoked || (response && response.status < 500)) break;
          }
        } catch { revoked = false; }
      }
      this.clearTokens(id);
      return { revoked };
    } finally { this.signingOut.delete(id); }
  }
  close() {
    for (const pending of this.pending.values()) if (pending.timer) clearTimeout(pending.timer);
    for (const server of this.servers) server.close();
    this.servers.clear(); this.pending.clear(); this.outcomes.clear(); this.latestAttempts.clear();
  }
}

/** Only validated token fields are persisted; provider payloads never become arbitrary vault metadata. */
function validTokens(result: any) {
  if (typeof result.access_token !== "string" || !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0 ||
    (result.token_type !== undefined && String(result.token_type).toLowerCase() !== "bearer") ||
    (result.refresh_token !== undefined && (typeof result.refresh_token !== "string" || !result.refresh_token)))
    throw new ProviderError("invalid_response", "ChatGPT returned unusable credentials. Reconnect the saved account.", true);
  return {
    access_token: result.access_token,
    ...(typeof result.refresh_token === "string" ? { refresh_token: result.refresh_token } : {}),
    ...(typeof result.id_token === "string" ? { id_token: result.id_token } : {}),
    expiresAt: Date.now() + result.expires_in * 1000,
  };
}
