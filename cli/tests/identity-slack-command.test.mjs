import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const identity = JSON.parse(await readFile(new URL("../../tests/fixtures/slack_identity.json", import.meta.url), "utf8"));
function run(args) {
  return new Promise((resolve) => execFile(process.execPath, [cli, ...args],
    { env: { ...process.env, NODE_USE_ENV_PROXY: "0" }, timeout: 15000 },
    (error, stdout, stderr) => resolve({ error, stdout, stderr })));
}

test("identity CLI can enable Slack on create and disable it on update", async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...identity, slack_enabled: body.slack_enabled }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const globals = ["--api-key", "synthetic-test-key", "--base-url", `http://127.0.0.1:${server.address().port}`, "--json", "identity"];
  try {
    const created = await run([...globals, "create", "support-agent", "--slack-enabled"]);
    assert.equal(created.error, null, created.stderr);
    assert.equal(JSON.parse(created.stdout).slackEnabled, true);
    assert.equal(requests.at(-1).body.slack_enabled, true);
    const disabled = await run([...globals, "update", "support-agent", "--slack-enabled", "false"]);
    assert.equal(disabled.error, null, disabled.stderr);
    assert.match(disabled.stdout, /Updated identity/);
    assert.deepEqual(requests.at(-1), { method: "PATCH", url: "/api/v1/identities/support-agent", body: { slack_enabled: false } });
    const count = requests.length;
    const invalid = await run([...globals, "update", "support-agent", "--slack-enabled", "null"]);
    assert.ok(invalid.error);
    assert.match(invalid.stderr, /slack-enabled must be/);
    assert.equal(requests.length, count);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
