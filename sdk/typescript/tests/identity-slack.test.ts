import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { Inkbox } from "../src/index.js";

const identity = JSON.parse(readFileSync(new URL("../../../tests/fixtures/slack_identity.json", import.meta.url), "utf8"));
afterEach(() => vi.unstubAllGlobals());
function wire() {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) =>
    new Response(JSON.stringify({ ...identity, slack_enabled: init?.body ? JSON.parse(String(init.body)).slack_enabled : undefined })),
  );
  vi.stubGlobal("fetch", fetch);
  return { client: new Inkbox({ apiKey: "synthetic-test-key", baseUrl: "https://example.com" }), fetch };
}
it("preserves Slack defaults, true, false, and omitted updates", async () => {
  const { client, fetch } = wire();
  const defaultIdentity = await client.createIdentity("support-agent");
  expect(defaultIdentity.slackEnabled).toBe(false);
  expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).not.toHaveProperty("slack_enabled");
  const enabled = await client.createIdentity("support-agent", { slackEnabled: true });
  expect(enabled.slackEnabled).toBe(true);
  await enabled.update({ slackEnabled: false });
  expect(enabled.slackEnabled).toBe(false);
  expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe("PATCH");
  expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).toEqual({ slack_enabled: false });
  await enabled.update({ displayName: "Support" });
  expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).not.toHaveProperty("slack_enabled");
});
it.each([null, "true", 1])("rejects invalid Slack enablement before dispatch: %j", async (value) => {
  const { client, fetch } = wire();
  // Exercise callers without TypeScript validation.
  const slackEnabled = value as unknown as boolean;
  await expect(client.createIdentity("support-agent", { slackEnabled })).rejects.toThrow("slackEnabled must be a boolean");
  expect(fetch).not.toHaveBeenCalled();
  const selected = await client.getIdentity("support-agent");
  await expect(selected.update({ slackEnabled })).rejects.toThrow("slackEnabled must be a boolean");
  expect(fetch).toHaveBeenCalledTimes(1);
});
