import "./config.ts";
import { HttpAgent } from "@ag-ui/client";
import {
  type AgentsFactory,
  type CopilotKitIntelligence,
  CopilotRuntime,
  createCopilotHonoHandler,
} from "@copilotkit/runtime/v2";
import type { Auth } from "./auth.ts";
import { type Bot, botOf, botsOf } from "./bots.ts";
import type { Config } from "./config.ts";
import { ConversationAgent } from "./engine/conversation.ts";
import type { AgentService } from "./engine/service.ts";
import type { LocalThreadRunner } from "./thread-store.ts";

function botRunnable(config: Config, bot: Bot) {
  if (bot.remote) return Boolean(bot.remote.url);
  return (
    config.agentBackend === "sample" ||
    Boolean(
      config.model &&
        // chatgpt/ models use the ChatGPT sign-in, checked when a request is made.
        (config.model.startsWith("chatgpt/") ||
          process.env.OPENAI_API_KEY ||
          process.env.ANTHROPIC_API_KEY ||
          process.env.GOOGLE_API_KEY),
    )
  );
}
/** Whether the default bot, which the main chat uses, can run. */
export function agentConfigured(config: Config) {
  return botRunnable(config, botOf(config));
}
export function runnableBots(config: Config) {
  return botsOf(config).filter((bot) => botRunnable(config, bot));
}
export function makeRuntime(
  config: Config,
  service: AgentService,
  auth: Auth,
  threads: { intelligence: CopilotKitIntelligence } | { runner: LocalThreadRunner },
) {
  const agents: AgentsFactory = async ({ request }) => {
    const owner = () => auth.owner(request.headers.get("authorization") ?? undefined);
    const entries = await Promise.all(
      runnableBots(config).map(async (bot) =>
        bot.remote
          ? ([
              bot.id,
              new HttpAgent({
                agentId: bot.id,
                url: bot.remote.url,
                headers: bot.remote.token ? { Authorization: `Bearer ${bot.remote.token}` } : {},
              }),
            ] as const)
          : ([bot.id, new ConversationAgent(config, service, await owner(), bot.id)] as const),
      ),
    );
    return Object.fromEntries(entries);
  };
  const runtime =
    "intelligence" in threads
      ? new CopilotRuntime({
          agents,
          intelligence: threads.intelligence,
          identifyUser: async (request) => ({
            id: await auth.owner(request.headers.get("authorization") ?? undefined),
            name: "OpenMuse user",
          }),
          generateThreadNames: false,
        })
      : new CopilotRuntime({ agents, runner: threads.runner });
  return createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit" });
}
