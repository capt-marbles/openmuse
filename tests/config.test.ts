import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../apps/server/src/config.ts";

function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const sample = { WORKSPACE_MODE: "sample", AGENT_BACKEND: "sample" };
const live = {
  WORKSPACE_MODE: "live",
  AGENT_BACKEND: "model",
  OPENMUSE_ACCESS_KEY: "a".repeat(32),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
};

test("every mode starts without an Intelligence key", () => {
  for (const mode of [sample, live]) {
    for (const key of [undefined, "", " \t\n"]) {
      const config = withEnv({ ...mode, CPK_INTELLIGENCE_API_KEY: key }, readConfig);
      assert.equal(config.intelligenceApiKey, undefined);
    }
  }
});

test("a configured Intelligence key is trimmed and kept", () => {
  for (const mode of [sample, live]) {
    const config = withEnv(
      { ...mode, CPK_INTELLIGENCE_API_KEY: " test-project-key-never-sent\n" },
      readConfig,
    );
    assert.equal(config.intelligenceApiKey, "test-project-key-never-sent");
  }
});
