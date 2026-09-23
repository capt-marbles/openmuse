import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store, directory: string, token: string;
let app: Awaited<ReturnType<typeof createApp>>["app"];
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-local-threads-"));
  db = await createStore();
  ({ app } = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  }));
  const session = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  token = (await session.json()).token;
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("without Intelligence the workspace reports local conversations", async () => {
  const body = await (await app.request("/api/workspace", { headers: headers() })).json();
  assert.equal(body.runtime.richThreads, false);
});

test("without Intelligence the main thread never contacts CopilotKit", async (t) => {
  const calls = t.mock.method(CopilotKitIntelligence.prototype, "getOrCreateThread", async () => {
    throw new Error("Intelligence must not be called");
  });
  const first = await (await app.request("/api/main-thread", { headers: headers() })).json();
  const reopened = await (await app.request("/api/main-thread", { headers: headers() })).json();
  assert.equal(first.existing, false);
  assert.equal(reopened.threadId, first.threadId);
  assert.equal(calls.mock.callCount(), 0);
});

test("without Intelligence the local conversation store round-trips messages", async () => {
  const messages = [{ id: "m1", role: "user", content: "Hello" }];
  const saved = await app.request("/api/conversation", {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ messages }),
  });
  assert.ok(saved.ok);
  const loaded = await (await app.request("/api/conversation", { headers: headers() })).json();
  assert.deepEqual(loaded.messages, messages);
});
