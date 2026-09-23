import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createApp } from "../apps/server/src/app.ts";
import { type Bot, parseBots } from "../apps/server/src/bots.ts";
import { createStore } from "../apps/server/src/db.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { modelFixture } from "./helpers/model.ts";

test("bots.json defines bots, keeps secrets in the environment and validates delegation", () => {
  assert.deepEqual(
    parseBots(undefined, {}, "sample").map((bot) => [bot.id, bot.name]),
    [["default", "OpenMuse"]],
  );
  const bots = parseBots(
    {
      bots: [
        { id: "default", name: "Chief of Staff", delegates: ["airtable"] },
        {
          id: "airtable",
          name: "Airtable Bot",
          tools: [],
          mcpServers: [
            {
              name: "airtable",
              url: "https://mcp.example/mcp",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bots.json placeholder
              headers: { Authorization: "Bearer ${AIRTABLE_TOKEN}" },
              readOnlyTools: ["list_records"],
            },
          ],
        },
      ],
    },
    { AIRTABLE_TOKEN: "pat-secret" },
    "model",
  );
  assert.deepEqual(
    bots.map((bot) => [bot.id, bot.name, bot.delegates]),
    [
      ["default", "Chief of Staff", ["airtable"]],
      ["airtable", "Airtable Bot", []],
    ],
  );
  assert.equal(bots[1].mcpServers[0].headers.Authorization, "Bearer pat-secret");
  const invalid: [unknown, RegExp][] = [
    [{ bots: [{ id: "x", name: "X", delegates: ["missing"] }] }, /unknown bot missing/],
    [{ bots: [{ id: "x", name: "X", delegates: ["x"] }] }, /cannot delegate to itself/],
    [
      {
        bots: [
          { id: "x", name: "X" },
          { id: "x", name: "Y" },
        ],
      },
      /Duplicate bot id x/,
    ],
    [
      { bots: [{ id: "x", name: "X", tools: ["web"], remote: { url: "https://r.example" } }] },
      /Remote bots/,
    ],
    [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bots.json placeholder
      { bots: [{ id: "x", name: "X", instructions: "${UNSET_TOKEN}" }] },
      /unset variable UNSET_TOKEN/,
    ],
  ];
  for (const [raw, message] of invalid) assert.throws(() => parseBots(raw, {}, "sample"), message);
  const agui = parseBots(undefined, {}, "agui")[0];
  assert.equal(agui.remote?.url, "", "an AG-UI default without a URL stays unconfigured");
});

async function airtableStub(t: TestContext) {
  const created: unknown[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const mcp = new McpServer({ name: "airtable-stub", version: "1.0.0" });
    mcp.registerTool(
      "list_records",
      { description: "List records in a table", inputSchema: { table: z.string() } },
      async () => ({ content: [{ type: "text", text: "No records named Acme" }] }),
    );
    mcp.registerTool(
      "create_record",
      {
        description: "Create a record",
        inputSchema: { table: z.string(), fields: z.record(z.string(), z.string()) },
      },
      async (args) => {
        created.push(args);
        return { content: [{ type: "text", text: "Created rec123" }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, created };
}

async function botApp(t: TestContext, bots: Bot[]) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-bots-"));
  const db = await createStore();
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    bots,
  });
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { server, db };
}
const call = (name: string, args: object) => ({ name, arguments: args });

test("the Chief of Staff delegates to the Airtable bot, whose write waits for review", async (t) => {
  const airtable = await airtableStub(t);
  const bodies: Record<string, string[]> = { chief: [], airtable: [] };
  await modelFixture(t, (_index, body) => {
    if (body.includes("You are Airtable Bot")) {
      bodies.airtable.push(body);
      if (body.includes("approvalResult"))
        return call("finish_task", { summary: "Created Acme as rec123" });
      if (body.includes("waiting_approval")) return undefined;
      if (body.includes("No records named Acme"))
        return call("airtable__create_record", { table: "Leads", fields: { Name: "Acme" } });
      return call("airtable__list_records", { table: "Leads" });
    }
    bodies.chief.push(body);
    if (body.includes("Results from delegated work"))
      return call("finish_task", { summary: "Acme is logged in Airtable (rec123)." });
    if (body.includes('\\"assigned\\":true')) return undefined;
    return call("delegate_task", { bot: "airtable", brief: "Add Acme to the Leads table" });
  });
  const bots = parseBots(
    {
      bots: [
        { id: "default", name: "Chief of Staff", delegates: ["airtable"] },
        {
          id: "airtable",
          name: "Airtable Bot",
          description: "Reads and updates the CRM base",
          tools: [],
          mcpServers: [{ name: "airtable", url: airtable.url, readOnlyTools: ["list_records"] }],
        },
      ],
    },
    {},
    "model",
  );
  const { server, db } = await botApp(t, bots);
  const parent = await server.agent.createTask("owner", { prompt: "Log the new lead Acme" });

  await server.agent.worker.tick();
  let chief = await server.agent.getTask("owner", parent.id);
  assert.equal(chief.status, "waiting_delegate", chief.error ?? chief.question);
  assert.ok(bodies.chief[0].includes('"name":"delegate_task"'));
  const [child] = await server.agent.children("owner", parent.id);
  assert.equal(child.botId, "airtable");
  assert.equal(child.depth, 1);

  await server.agent.worker.tick();
  let bot = await server.agent.getTask("owner", child.id);
  assert.equal(bot.status, "waiting_approval", bot.error ?? bot.question);
  assert.ok(bodies.airtable[0].includes('"name":"airtable__create_record"'));
  assert.ok(!bodies.airtable[0].includes('"name":"prepare_email"'), "tools: [] removes built-ins");
  assert.ok(!bodies.airtable[0].includes('"name":"delegate_task"'));
  assert.deepEqual(airtable.created, [], "nothing is written before review");
  const proposal = await db.get<ActionProposal>("owner", "actions", bot.actionId as string);
  assert.equal(proposal?.kind, "mcp.call");
  assert.equal(proposal?.title, "airtable: create_record");

  const approved = await server.actions.decide("owner", proposal.id, proposal.hash, "approve");
  assert.equal(approved.status, "succeeded", approved.error);
  assert.deepEqual(airtable.created, [{ table: "Leads", fields: { Name: "Acme" } }]);

  await server.agent.worker.tick();
  bot = await server.agent.getTask("owner", child.id);
  assert.equal(bot.status, "succeeded", bot.error ?? bot.question);
  chief = await server.agent.getTask("owner", parent.id);
  assert.equal(chief.status, "queued", "the parent resumes once its delegate finishes");

  await server.agent.worker.tick();
  chief = await server.agent.getTask("owner", parent.id);
  assert.equal(chief.status, "succeeded", chief.error ?? chief.question);
  assert.equal(chief.result, "Acme is logged in Airtable (rec123).");
  assert.match(bodies.chief.at(-1) ?? "", /Created Acme as rec123/);
});

test("delegation refuses loops, and cancelling stops assigned work and releases the parent", async (t) => {
  const bodies: string[] = [];
  await modelFixture(t, (_index, body) => {
    if (body.includes("You are Helper")) {
      bodies.push(body);
      if (body.includes("would loop")) return undefined;
      return call("delegate_task", { bot: "default", brief: "Hand it back" });
    }
    if (body.includes('\\"assigned\\":true')) return undefined;
    if (body.includes("Results from delegated work")) return undefined;
    return call("delegate_task", { bot: "helper", brief: "Look into it" });
  });
  const bots = parseBots(
    {
      bots: [
        { id: "default", name: "Lead", delegates: ["helper"] },
        { id: "helper", name: "Helper", delegates: ["default"] },
      ],
    },
    {},
    "model",
  );
  const { server } = await botApp(t, bots);
  const parent = await server.agent.createTask("owner", { prompt: "Investigate" });
  await server.agent.worker.tick();
  const [child] = await server.agent.children("owner", parent.id);
  await server.agent.worker.tick();
  assert.match(bodies.at(-1) ?? "", /would loop/);
  assert.equal((await server.agent.children("owner", child.id)).length, 0);

  const second = await server.agent.createTask("owner", { prompt: "Investigate again" });
  await server.agent.worker.tick();
  assert.equal((await server.agent.getTask("owner", second.id)).status, "waiting_delegate");
  const [secondChild] = await server.agent.children("owner", second.id);
  await server.agent.control("owner", second.id, "cancel");
  assert.equal((await server.agent.getTask("owner", secondChild.id)).status, "cancelled");

  const third = await server.agent.createTask("owner", { prompt: "Investigate once more" });
  await server.agent.worker.tick();
  const [thirdChild] = await server.agent.children("owner", third.id);
  await server.agent.control("owner", thirdChild.id, "cancel");
  const released = await server.agent.getTask("owner", third.id);
  assert.equal(released.status, "queued", "a stopped delegate lets the parent continue");
  const delegations = released.state.delegations as AgentTask["state"][];
  assert.equal((delegations[0] as { status: string }).status, "cancelled");
});
