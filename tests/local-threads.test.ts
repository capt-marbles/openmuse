import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

type App = Awaited<ReturnType<typeof createApp>>["app"];
let db: Store, directory: string, token: string, app: App, config: Config;
let threads: Awaited<ReturnType<typeof createApp>>["threads"];
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function signIn(target: App) {
  const session = await target.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return (await session.json()).token as string;
}
async function runTurn(threadId: string, text: string, target = app) {
  const response = await target.request("/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      threadId,
      runId: randomUUID(),
      messages: [{ id: randomUUID(), role: "user", content: text }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  assert.equal(response.status, 200);
  return response.text();
}
async function listThreads(target = app) {
  const response = await target.request("/api/copilotkit/threads?agentId=default", {
    headers: headers(),
  });
  assert.equal(response.status, 200);
  return (await response.json()).threads as {
    id: string;
    name: string | null;
    archived: boolean;
  }[];
}
async function waitForThread(threadId: string) {
  for (let i = 0; i < 50 && !(await listThreads()).some((t) => t.id === threadId); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-local-threads-"));
  db = await createStore();
  config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  ({ app, threads } = await createApp(db, config));
  token = await signIn(app);
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("without Intelligence the workspace offers side chats from the local store", async () => {
  const body = await (await app.request("/api/workspace", { headers: headers() })).json();
  assert.equal(body.runtime.richThreads, true);
  assert.equal(body.runtime.threadStore, "local");
});

test("the local main thread never contacts CopilotKit and imports the earlier conversation", async (t) => {
  const calls = t.mock.method(CopilotKitIntelligence.prototype, "getOrCreateThread", async () => {
    throw new Error("Intelligence must not be called");
  });
  const legacy = [
    { id: "legacy-1", role: "user", content: "Remember the school trip" },
    { id: "legacy-2", role: "assistant", content: "Noted." },
  ];
  await db.put("local-user", "conversations", { id: "default", messages: legacy });
  const first = await (await app.request("/api/main-thread", { headers: headers() })).json();
  const reopened = await (await app.request("/api/main-thread", { headers: headers() })).json();
  assert.equal(reopened.threadId, first.threadId);
  assert.equal(first.existing, true);
  assert.equal(calls.mock.callCount(), 0);
  const messages = await (
    await app.request(`/api/copilotkit/threads/${first.threadId}/messages`, { headers: headers() })
  ).json();
  assert.deepEqual(
    messages.messages.map((message: { id: string }) => message.id),
    ["legacy-1", "legacy-2"],
  );
  const replay = await app.request("/api/copilotkit/agent/default/connect", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      threadId: first.threadId,
      runId: randomUUID(),
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  assert.match(await replay.text(), /MESSAGES_SNAPSHOT.*Remember the school trip/);
});

test("side chats run through the runtime, list, replay, and survive a restart", async () => {
  const threadId = randomUUID();
  const stream = await runTurn(threadId, "Hello there");
  assert.match(stream, /RUN_FINISHED/);
  assert.doesNotMatch(stream, /RUN_ERROR/);
  await waitForThread(threadId);
  const saved = await (
    await app.request(`/api/copilotkit/threads/${threadId}/messages`, { headers: headers() })
  ).json();
  assert.deepEqual(
    saved.messages.map((message: { role: string }) => message.role),
    ["user", "assistant"],
  );
  const listed = (await listThreads()).find((thread) => thread.id === threadId);
  assert.ok(listed);
  assert.equal(listed.archived, false);

  const replay = await app.request("/api/copilotkit/agent/default/connect", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      threadId,
      runId: randomUUID(),
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  assert.equal(replay.status, 200);
  assert.match(await replay.text(), /Hello there/);

  await threads?.flush();
  const restarted = (await createApp(db, config)).app;
  assert.ok((await listThreads(restarted)).some((thread) => thread.id === threadId));
});

test("rename, archive, restore and delete persist in the local store", async () => {
  const threadId = randomUUID();
  await runTurn(threadId, "A separate topic");
  await waitForThread(threadId);
  const call = (path: string, method: string, body?: unknown) =>
    app.request(`/api/copilotkit/threads/${threadId}${path}`, {
      method,
      headers: headers(),
      body: JSON.stringify({ agentId: "default", ...(body as object) }),
    });
  assert.equal((await call("", "PATCH", { name: "Trip planning" })).status, 200);
  assert.equal((await call("/archive", "POST")).status, 200);
  let saved = (await listThreads()).find((thread) => thread.id === threadId);
  assert.equal(saved?.name, "Trip planning");
  assert.equal(saved?.archived, true);
  assert.equal((await call("", "PATCH", { archived: false })).status, 200);
  await threads?.flush();
  const restarted = (await createApp(db, config)).app;
  saved = (await listThreads(restarted)).find((thread) => thread.id === threadId);
  assert.equal(saved?.name, "Trip planning");
  assert.equal(saved?.archived, false);
  assert.equal((await call("", "DELETE")).status, 204);
  assert.ok(!(await listThreads()).some((thread) => thread.id === threadId));
  assert.equal((await call("", "PATCH", { name: "Gone" })).status, 404);
});

test("runtime info advertises local thread mutations to the client", async () => {
  const info = await (await app.request("/api/copilotkit/info", { headers: headers() })).json();
  assert.equal(info.threadEndpoints.list, true);
  assert.equal(info.threadEndpoints.mutations, true);
});

test("thread routes require a session and a clear request never wipes durable history", async () => {
  assert.equal((await app.request("/api/copilotkit/threads?agentId=default")).status, 401);
  const before = await listThreads();
  assert.ok(before.length > 0);
  await app.request("/api/copilotkit/threads/clear", { method: "POST", headers: headers() });
  assert.deepEqual(
    (await listThreads()).map((thread) => thread.id),
    before.map((thread) => thread.id),
  );
});
