import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Config } from "./config.ts";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "Use a lowercase id such as airtable-bot");
export const toolGroups = [
  "workspace",
  "documents",
  "web",
  "computer",
  "email",
  "calendar",
] as const;
export type ToolGroup = (typeof toolGroups)[number];

const mcpServerSchema = z.object({
  name: id,
  url: z.url(),
  transport: z.enum(["http", "sse"]).default("http"),
  headers: z.record(z.string(), z.string()).default({}),
  /** Tools that only read. Every other tool on this server needs a review before it runs. */
  readOnlyTools: z.array(z.string()).default([]),
});
const botSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(60),
    description: z.string().max(300).default(""),
    instructions: z.string().max(8000).default(""),
    /** Built-in tool groups; omitted means all of them. */
    tools: z.array(z.enum(toolGroups)).optional(),
    /** Bots this bot may assign work to. */
    delegates: z.array(id).default([]),
    mcpServers: z.array(mcpServerSchema).default([]),
    /** An external AG-UI agent instead of a built-in bot. */
    remote: z.object({ url: z.url(), token: z.string().optional() }).optional(),
  })
  .refine((bot) => !bot.remote || (!bot.tools && !bot.mcpServers.length && !bot.delegates.length), {
    message: "Remote bots cannot declare tools, MCP servers or delegates",
  });
export type Bot = z.infer<typeof botSchema>;
export type McpServer = Bot["mcpServers"][number];
const fileSchema = z.object({ bots: z.array(botSchema).max(50) });

/** Replaces ${NAME} with the environment value so secrets stay in .env, not bots.json. */
function substitute(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === "string")
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
      const found = env[name];
      if (found === undefined) throw new Error(`bots.json references unset variable ${name}`);
      return found;
    });
  if (Array.isArray(value)) return value.map((item) => substitute(item, env));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substitute(item, env)]),
    );
  return value;
}

/**
 * Bots come from BOTS_FILE (default DATA_DIR/bots.json). The `default` bot runs
 * the main chat; bots.json may redefine it, e.g. as a Chief of Staff. Without
 * the file OpenMuse has only its default bot, following AGENT_BACKEND.
 */
export function parseBots(
  raw: unknown,
  env: Record<string, string | undefined>,
  backend: Config["agentBackend"],
): Bot[] {
  // An AG-UI default without AGENT_URL stays unconfigured rather than failing startup.
  const fallback: Bot = {
    ...botSchema.parse({ id: "default", name: "OpenMuse" }),
    ...(backend === "agui" ? { remote: { url: env.AGENT_URL ?? "", token: env.AGENT_TOKEN } } : {}),
  };
  const bots = raw === undefined ? [] : fileSchema.parse(substitute(raw, env)).bots;
  const byId = new Map<string, Bot>([["default", fallback]]);
  for (const bot of bots) {
    if (byId.has(bot.id) && bot.id !== "default") throw new Error(`Duplicate bot id ${bot.id}`);
    byId.set(bot.id, bot);
  }
  for (const bot of byId.values())
    for (const target of bot.delegates) {
      if (target === bot.id) throw new Error(`Bot ${bot.id} cannot delegate to itself`);
      if (!byId.has(target)) throw new Error(`Bot ${bot.id} delegates to unknown bot ${target}`);
    }
  return [...byId.values()];
}

export function loadBots(
  file: string,
  env: Record<string, string | undefined>,
  backend: Config["agentBackend"],
): Bot[] {
  if (!existsSync(file)) return parseBots(undefined, env, backend);
  try {
    return parseBots(JSON.parse(readFileSync(file, "utf8")), env, backend);
  } catch (error) {
    throw new Error(`Could not load ${file}: ${error instanceof Error ? error.message : error}`);
  }
}

export function botsOf(config: Config): Bot[] {
  return config.bots ?? parseBots(undefined, {}, config.agentBackend);
}
export function botOf(config: Config, botId = "default"): Bot {
  const bot = botsOf(config).find((item) => item.id === botId);
  if (!bot) throw new Error(`Unknown bot ${botId}`);
  return bot;
}
export const hasTool = (bot: Bot, group: ToolGroup) => !bot.tools || bot.tools.includes(group);
