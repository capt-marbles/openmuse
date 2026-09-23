import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { ChatGPTAuth, codexRequestBody, tokenClaims } from "../apps/server/src/chatgpt.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { modelFixture } from "./helpers/model.ts";

const encryptionKey = randomBytes(32).toString("base64");
const jwt = (claims: object) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const accessToken = (expiresInSeconds: number, account = "acct-1") =>
  jwt({
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "pro" },
    "https://api.openai.com/profile": { email: "owner@example.com" },
  });
const baseConfig = (dataDir: string): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir,
  agentBackend: "model",
  model: "chatgpt/gpt-fixture",
  encryptionKey,
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: [],
});

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;
/** Routes fetch calls for OpenAI hosts to a handler; everything else is passed through. */
function interceptFetch(t: TestContext, handler: Handler) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const handled = await handler(url, init);
    return handled ?? original(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
}

test("requests are reshaped like the Codex CLI's", () => {
  const body = codexRequestBody({
    model: "gpt-fixture",
    input: [
      { role: "developer", content: "You are OpenMuse." },
      { role: "system", content: [{ type: "input_text", text: "Be brief." }] },
      { role: "user", content: [{ type: "input_text", text: "Hi" }] },
    ],
    max_output_tokens: 1000,
    temperature: 0.2,
    top_p: 1,
    include: ["file_search_call.results"],
    tools: [],
  });
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  for (const field of ["max_output_tokens", "temperature", "top_p"]) assert.ok(!(field in body));
  assert.deepEqual(body.include, ["file_search_call.results", "reasoning.encrypted_content"]);
  assert.equal(body.instructions, "You are OpenMuse.\n\nBe brief.");
  assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }]);
  assert.deepEqual(tokenClaims(accessToken(60)), {
    accountId: "acct-1",
    plan: "pro",
    email: "owner@example.com",
    expires: tokenClaims(accessToken(60)).expires,
  });
});

test("device sign-in stores encrypted tokens once the code is approved", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const auth = new ChatGPTAuth(db, baseConfig("/tmp"));
  let polls = 0;
  const calls: string[] = [];
  const access = accessToken(3600);
  interceptFetch(t, (url, init) => {
    if (url.host !== "auth.openai.com") return undefined;
    calls.push(url.pathname);
    if (url.pathname === "/api/accounts/deviceauth/usercode") {
      assert.equal(JSON.parse(String(init?.body)).client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
      return Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: 1 });
    }
    if (url.pathname === "/api/accounts/deviceauth/token")
      return ++polls === 1
        ? new Response("pending", { status: 403 })
        : Response.json({ authorization_code: "code-1", code_verifier: "verifier-1" });
    if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code_verifier"), "verifier-1");
      assert.equal(form.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
      return Response.json({ access_token: access, refresh_token: "refresh-1", expires_in: 3600 });
    }
    return new Response("unexpected", { status: 500 });
  });

  const started = await auth.startLogin();
  assert.equal(started.pending?.userCode, "ABCD-1234");
  assert.equal(started.pending?.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(started.connected, false);
  let status = started;
  for (let i = 0; i < 40 && !status.connected; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = await auth.status();
  }
  assert.equal(status.connected, true, status.error);
  assert.deepEqual(status.account, { email: "owner@example.com", plan: "pro" });
  assert.equal(status.pending, undefined);
  assert.deepEqual(calls, [
    "/api/accounts/deviceauth/usercode",
    "/api/accounts/deviceauth/token",
    "/api/accounts/deviceauth/token",
    "/oauth/token",
  ]);
  const stored = await db.get<{ secret: string }>("system", "credentials", "chatgpt");
  assert.ok(stored && !stored.secret.includes("refresh-1"), "tokens are encrypted at rest");
  assert.deepEqual(await auth.accessToken(), { access, accountId: "acct-1" });

  await auth.disconnect();
  assert.equal((await auth.status()).connected, false);
  await assert.rejects(auth.accessToken(), /Sign in with ChatGPT/);
});

test("expiring tokens refresh once, and a token rotated by another process is reused", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const auth = new ChatGPTAuth(db, baseConfig("/tmp"));
  const other = new ChatGPTAuth(db, baseConfig("/tmp"));
  const fresh = accessToken(3600, "acct-2");
  let refreshes = 0;
  interceptFetch(t, (url, init) => {
    if (url.host !== "auth.openai.com") return undefined;
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("grant_type"), "refresh_token");
    refreshes++;
    return Response.json({ access_token: fresh, refresh_token: "refresh-2", expires_in: 3600 });
  });
  // Seed an expiring credential through the public refresh path's storage.
  await (auth as unknown as { save(tokens: object): Promise<void> }).save({
    access: accessToken(30),
    refresh: "refresh-1",
    expires: Date.now() + 30_000,
  });
  const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
  assert.equal(refreshes, 1);
  assert.equal(a.access, fresh);
  assert.equal(b.accountId, "acct-2");

  // Another process rotated the token first: this one's refresh is rejected as reused.
  await (auth as unknown as { save(tokens: object): Promise<void> }).save({
    access: accessToken(30),
    refresh: "refresh-3",
    expires: Date.now() + 30_000,
  });
  globalThis.fetch = (async () => {
    await (other as unknown as { save(tokens: object): Promise<void> }).save({
      access: fresh,
      refresh: "refresh-4",
      expires: Date.now() + 3_600_000,
    });
    return Response.json({ error: "refresh_token_reused" }, { status: 400 });
  }) as typeof fetch;
  assert.equal((await auth.accessToken()).access, fresh);
});

test("a chatgpt/ model runs OpenMuse tasks on the subscription backend", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-chatgpt-"));
  const db = await createStore();
  const bodies: Record<string, unknown>[] = [];
  const headers: Headers[] = [];
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "finish_task", arguments: { summary: "Planned on ChatGPT." } }
      : undefined,
  );
  const fixtureBase = process.env.OPENAI_BASE_URL as string;
  interceptFetch(t, (url, init) => {
    if (url.host !== "chatgpt.com") return undefined;
    assert.equal(url.pathname, "/backend-api/codex/responses");
    headers.push(new Headers(init?.headers));
    bodies.push(JSON.parse(String(init?.body)));
    return fetch(`${fixtureBase}/responses`, init);
  });
  const server = await createApp(db, baseConfig(directory));
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  await (server.chatgpt as unknown as { save(tokens: object): Promise<void> }).save({
    access: accessToken(3600),
    refresh: "refresh-1",
    expires: Date.now() + 3_600_000,
  });

  const task = await server.agent.createTask("owner", { prompt: "Plan my week" });
  await server.agent.worker.tick();
  const done = await server.agent.getTask("owner", task.id);
  assert.equal(done.status, "succeeded", done.error ?? done.question);
  assert.equal(done.result, "Planned on ChatGPT.");
  assert.ok(requests.length >= 1);
  assert.match(headers[0].get("authorization") ?? "", /^Bearer e30\./);
  assert.equal(headers[0].get("chatgpt-account-id"), "acct-1");
  assert.equal(headers[0].get("originator"), "openmuse");
  const first = bodies[0];
  assert.equal(first.model, "gpt-fixture");
  assert.equal(first.store, false);
  assert.equal(first.stream, true);
  assert.ok(!("max_output_tokens" in first) && !("temperature" in first));
  assert.match(String(first.instructions), /executing a delegated task/);
  assert.ok(
    (first.input as { role?: string }[]).every((item) => item.role !== "system"),
    "the system prompt moved to instructions",
  );
  assert.ok(JSON.stringify(first.tools).includes("finish_task"));
  for (const body of bodies)
    assert.ok(!JSON.stringify(body.input).includes("item_reference"), "no stored-item references");
});

test("the ChatGPT API reports status and requires a session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-chatgpt-api-"));
  const db = await createStore();
  const server = await createApp(db, baseConfig(directory));
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal((await server.app.request("/api/chatgpt")).status, 401);
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const { token } = await session.json();
  const status = await server.app.request("/api/chatgpt", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.deepEqual(await status.json(), { connected: false });
  const workspace = await (
    await server.app.request("/api/workspace", { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  assert.equal(workspace.runtime.model, "chatgpt/gpt-fixture");
  assert.equal(workspace.runtime.configured, true);
});
