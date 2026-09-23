import { createOpenAI } from "@ai-sdk/openai";
import { decryptSecret, encryptSecret } from "../../../packages/integrations/src/vault.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

// The public client and endpoints used by the Codex CLI's ChatGPT sign-in.
// OpenAI permits this subscription sign-in in external tools; the request shape
// follows the Codex CLI (openai/codex codex-api ResponsesApiRequest).
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE = "https://auth.openai.com";
const VERIFICATION_URL = `${AUTH_BASE}/codex/device`;
const DEVICE_CALLBACK_URL = `${AUTH_BASE}/deviceauth/callback`;
export const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEVICE_TIMEOUT_MS = 15 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const OWNER = "system";
const HEADERS = { originator: "openmuse", "User-Agent": "openmuse" };

interface Tokens {
  access: string;
  refresh: string;
  expires: number;
}
export interface ChatGPTStatus {
  connected: boolean;
  account?: { email?: string; plan?: string };
  pending?: { userCode: string; verificationUrl: string; expiresAt: string };
  error?: string;
}

/** Reads the claims OpenAI puts in the access token; the token is not verified here. */
export function tokenClaims(access: string) {
  try {
    const payload = JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString("utf8"));
    const auth = payload["https://api.openai.com/auth"] ?? {};
    const profile = payload["https://api.openai.com/profile"] ?? {};
    return {
      accountId: typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined,
      plan: typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
      email: typeof profile.email === "string" ? profile.email : undefined,
      expires: typeof payload.exp === "number" ? payload.exp * 1000 : undefined,
    };
  } catch {
    return {};
  }
}

async function post(path: string, body: Record<string, string>, form = false) {
  const response = await fetch(`${AUTH_BASE}${path}`, {
    method: "POST",
    headers: {
      ...HEADERS,
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
    },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, ok: response.ok, json, text: text.slice(0, 500) };
}

function tokensFrom(json: Record<string, unknown>, previousRefresh?: string): Tokens {
  const access = typeof json.access_token === "string" ? json.access_token : "";
  const refresh = typeof json.refresh_token === "string" ? json.refresh_token : previousRefresh;
  if (!access || !refresh) throw new Error("OpenAI did not return sign-in tokens");
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in * 1000 : undefined;
  return {
    access,
    refresh,
    expires: expiresIn ? Date.now() + expiresIn : (tokenClaims(access).expires ?? Date.now()),
  };
}

/**
 * ChatGPT subscription sign-in for the whole deployment, using OpenAI's device
 * code flow so it works from any browser, including against a headless server.
 * Tokens are encrypted with TOKEN_ENCRYPTION_KEY.
 */
export class ChatGPTAuth {
  private pending?: ChatGPTStatus["pending"] & { cancel: AbortController };
  private lastError?: string;
  private refreshing?: Promise<Tokens>;

  constructor(
    private readonly db: Store,
    private readonly config: Config,
  ) {}

  private key() {
    if (!this.config.encryptionKey)
      throw new AppError("Set TOKEN_ENCRYPTION_KEY before signing in with ChatGPT", 409);
    return this.config.encryptionKey;
  }
  private async load(): Promise<Tokens | undefined> {
    const stored = await this.db.get<{ secret: string }>(OWNER, "credentials", "chatgpt");
    return stored ? (JSON.parse(decryptSecret(stored.secret, this.key())) as Tokens) : undefined;
  }
  private async save(tokens: Tokens) {
    await this.db.put(OWNER, "credentials", {
      id: "chatgpt",
      secret: encryptSecret(JSON.stringify(tokens), this.key()),
    });
  }

  async status(): Promise<ChatGPTStatus> {
    const tokens = this.config.encryptionKey ? await this.load().catch(() => undefined) : undefined;
    const claims = tokens ? tokenClaims(tokens.access) : undefined;
    return {
      connected: Boolean(tokens),
      ...(claims ? { account: { email: claims.email, plan: claims.plan } } : {}),
      ...(this.pending
        ? {
            pending: {
              userCode: this.pending.userCode,
              verificationUrl: this.pending.verificationUrl,
              expiresAt: this.pending.expiresAt,
            },
          }
        : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /** Starts a device sign-in; finishes in the background once the user approves the code. */
  async startLogin(): Promise<ChatGPTStatus> {
    this.key();
    this.pending?.cancel.abort();
    this.lastError = undefined;
    const requested = await post("/api/accounts/deviceauth/usercode", { client_id: CLIENT_ID });
    if (!requested.ok)
      throw new AppError(`ChatGPT sign-in could not start (HTTP ${requested.status})`, 502);
    const deviceAuthId = String(requested.json.device_auth_id ?? "");
    const userCode = String(requested.json.user_code ?? requested.json.usercode ?? "");
    if (!deviceAuthId || !userCode) throw new AppError("ChatGPT sign-in returned no code", 502);
    const interval = Math.max(1, Number(requested.json.interval) || 5) * 1000;
    const cancel = new AbortController();
    const pending = {
      userCode,
      verificationUrl: VERIFICATION_URL,
      expiresAt: new Date(Date.now() + DEVICE_TIMEOUT_MS).toISOString(),
      cancel,
    };
    this.pending = pending;
    void this.completeLogin(deviceAuthId, userCode, interval, cancel.signal)
      .catch((error) => {
        if (!cancel.signal.aborted)
          this.lastError = error instanceof Error ? error.message : "ChatGPT sign-in failed";
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    return this.status();
  }

  private async completeLogin(
    deviceAuthId: string,
    userCode: string,
    interval: number,
    signal: AbortSignal,
  ) {
    const deadline = Date.now() + DEVICE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      if (signal.aborted) return;
      const polled = await post("/api/accounts/deviceauth/token", {
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }).catch(() => undefined);
      if (!polled || polled.status === 403 || polled.status === 404) continue;
      if (!polled.ok) throw new Error(`ChatGPT sign-in failed (HTTP ${polled.status})`);
      const exchanged = await post(
        "/oauth/token",
        {
          grant_type: "authorization_code",
          code: String(polled.json.authorization_code ?? ""),
          redirect_uri: DEVICE_CALLBACK_URL,
          client_id: CLIENT_ID,
          code_verifier: String(polled.json.code_verifier ?? ""),
        },
        true,
      );
      if (!exchanged.ok) throw new Error(`ChatGPT sign-in failed (HTTP ${exchanged.status})`);
      if (!signal.aborted) await this.save(tokensFrom(exchanged.json));
      return;
    }
    throw new Error("The ChatGPT sign-in code expired. Start again.");
  }

  cancelLogin() {
    this.pending?.cancel.abort();
    this.pending = undefined;
  }

  async disconnect() {
    this.cancelLogin();
    await this.db.remove(OWNER, "credentials", "chatgpt");
  }

  /** A current access token, refreshed shortly before expiry; one refresh at a time. */
  async accessToken(): Promise<{ access: string; accountId?: string }> {
    let tokens = await this.load();
    if (!tokens) throw new AppError("Sign in with ChatGPT in Apps to use chatgpt/ models", 409);
    if (tokens.expires - Date.now() < REFRESH_MARGIN_MS) {
      const current = tokens;
      this.refreshing ??= (async () => {
        const refreshed = await post(
          "/oauth/token",
          { grant_type: "refresh_token", refresh_token: current.refresh, client_id: CLIENT_ID },
          true,
        );
        if (!refreshed.ok) {
          // Another process may have rotated the refresh token first; use its result.
          const stored = await this.load();
          if (stored && stored.refresh !== current.refresh && stored.expires > Date.now())
            return stored;
          throw new AppError(
            `ChatGPT sign-in expired (HTTP ${refreshed.status}). Sign in again in Apps.`,
            401,
          );
        }
        const next = tokensFrom(refreshed.json, current.refresh);
        await this.save(next);
        return next;
      })().finally(() => {
        this.refreshing = undefined;
      });
      tokens = await this.refreshing;
    }
    return { access: tokens.access, accountId: tokenClaims(tokens.access).accountId };
  }
}

/** Reshapes an AI SDK Responses request into what the Codex backend accepts. */
export function codexRequestBody(body: Record<string, unknown>) {
  const next: Record<string, unknown> = { ...body, store: false, stream: true };
  // The Codex CLI never sends these; the subscription backend rejects them.
  for (const field of ["max_output_tokens", "temperature", "top_p", "metadata", "user"])
    delete next[field];
  const include = new Set(Array.isArray(next.include) ? (next.include as string[]) : []);
  include.add("reasoning.encrypted_content");
  next.include = [...include];
  // Codex sends the system prompt as instructions rather than as an input message.
  if (!next.instructions && Array.isArray(next.input)) {
    const input = [...(next.input as Record<string, unknown>[])];
    const texts: string[] = [];
    while (input[0] && (input[0].role === "system" || input[0].role === "developer")) {
      const content = input.shift()?.content;
      texts.push(
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part) => (part as { text?: string }).text ?? "").join("")
            : "",
      );
    }
    if (texts.length) {
      next.instructions = texts.join("\n\n");
      next.input = input;
    }
  }
  return next;
}

export function chatgptFetch(auth: ChatGPTAuth): typeof fetch {
  return async (url, init) => {
    const { access, accountId } = await auth.accessToken();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${access}`);
    if (accountId) headers.set("ChatGPT-Account-ID", accountId);
    for (const [name, value] of Object.entries(HEADERS)) headers.set(name, value);
    let body = init?.body;
    if (typeof body === "string" && body.startsWith("{"))
      body = JSON.stringify(codexRequestBody(JSON.parse(body)));
    const response = await fetch(url, { ...init, headers, body });
    if (response.status === 429) {
      const text = await response.text();
      throw new Error(
        `ChatGPT usage limit reached. ${text.slice(0, 300) || "Try again after your limit resets."}`,
      );
    }
    return response;
  };
}

/** A chatgpt/<model> spec becomes a Responses model on the subscription backend. */
export function chatgptModel(auth: ChatGPTAuth, modelId: string) {
  return createOpenAI({
    baseURL: CHATGPT_BASE_URL,
    apiKey: "chatgpt-oauth",
    fetch: chatgptFetch(auth),
  }).responses(modelId);
}

export const chatgptProviderOptions = {
  openai: { store: false, include: ["reasoning.encrypted_content"] },
};

/** The model and provider options for MODEL; chatgpt/<id> uses the ChatGPT sign-in. */
export function modelSettings(config: Config, auth?: ChatGPTAuth) {
  const spec = config.model ?? "openai/unconfigured";
  if (!spec.startsWith("chatgpt/")) return { model: spec };
  if (!auth) throw new Error("ChatGPT sign-in is unavailable in this process");
  return {
    model: chatgptModel(auth, spec.slice("chatgpt/".length)),
    providerOptions: chatgptProviderOptions,
  };
}
