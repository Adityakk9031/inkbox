import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Inkbox,
  IdempotencyKeyReusedError,
  type SlackWebhookPayload,
  type SlackWebhookEventType,
} from "../src/index.js";
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../tests/fixtures/slack.json", import.meta.url),
    "utf8",
  ),
);
const C = fixture.connection.id;
const I = fixture.connection.identity_id;
const payloads: SlackWebhookPayload[] = JSON.parse(
  readFileSync(
    new URL(
      "../../../tests/fixtures/slack_webhook_events.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const events: SlackWebhookEventType[] = [
  "slack.dm_received",
  "slack.group_dm_received",
  "slack.channel_message_received",
  "slack.mention_received",
  "slack.thread_reply_received",
  "slack.message_updated",
  "slack.message_deleted",
  "slack.reaction_added",
  "slack.reaction_removed",
  "slack.member_joined",
  "slack.member_left",
  "slack.channel_updated",
  "slack.file_shared",
  "slack.file_changed",
  "slack.file_deleted",
  "slack.pin_added",
  "slack.pin_removed",
  "slack.connection_changed",
  "slack.message_sent",
  "slack.message_send_failed",
  "slack.message_send_unknown",
  "slack.interaction",
  "slack.session_stopped",
];
const client = () =>
  new Inkbox({ apiKey: "synthetic-test-key", baseUrl: "https://example.com" });
afterEach(() => vi.unstubAllGlobals());
function mock() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", fetch);
  const reply = (data: unknown, status = 200) =>
    fetch.mockResolvedValueOnce(
      new Response(data instanceof Uint8Array ? data : JSON.stringify(data), {
        status,
      }),
    );
  return { fetch, reply };
}
it("maps every Slack operation to exact wire requests and returns raw bytes", async () => {
  const c = client();
  const { fetch, reply } = mock();
  async function check(
    data: unknown,
    call: () => Promise<unknown>,
    method: string,
    path: string,
    body?: unknown,
    query: Record<string, string> = {},
  ) {
    reply(data);
    const result = await call();
    const [input, init] = fetch.mock.calls.at(-1)!;
    const url = new URL(String(input));
    expect(url.pathname).toBe("/api/v1/slack" + path);
    expect(init?.method).toBe(method);
    expect(Object.fromEntries(url.searchParams)).toEqual(query);
    if (body !== undefined)
      expect(JSON.parse(String(init?.body))).toEqual(body);
    return result;
  }
  expect(
    await check(
      { connections: [fixture.connection], installation_available: false },
      () => c.slack.listConnections(I),
      "GET",
      "/connections",
      undefined,
      { identity_id: I },
    ),
  ).toMatchObject({ installationAvailable: false });
  expect(
    await check(
      fixture.invitation,
      () => c.slack.createInvitation(I, { expiresInSeconds: 300 }),
      "POST",
      "/invitations",
      { identity_id: I, expires_in_seconds: 300 },
    ),
  ).toMatchObject({ invitationUrl: fixture.invitation.invitation_url });
  await check(
    [{ ...fixture.invitation, invitation_url: null }],
    () => c.slack.listInvitations(I),
    "GET",
    "/invitations",
    undefined,
    { identity_id: I },
  );
  await check(
    fixture.invitation,
    () => c.slack.revokeInvitation(fixture.invitation.id),
    "POST",
    `/invitations/${fixture.invitation.id}/revoke`,
  );
  await check(
    fixture.connection,
    () => c.slack.disconnect(C),
    "POST",
    `/connections/${C}/disconnect`,
  );
  expect(
    await check(
      { conversations: [{ id: "CEXAMPLE" }], next_cursor: "next" },
      () => c.slack.listConversations(C, { limit: 2, cursor: "cur" }),
      "GET",
      `/connections/${C}/conversations`,
      undefined,
      { limit: "2", cursor: "cur" },
    ),
  ).toMatchObject({ nextCursor: "next" });
  await check(
    { id: "DEXAMPLE" },
    () => c.slack.openConversation(C, ["UALICE", "UBOB"]),
    "POST",
    `/connections/${C}/conversations`,
    { user_ids: ["UALICE", "UBOB"] },
  );
  await check(
    { id: "CEXAMPLE" },
    () => c.slack.getConversation(C, "CEXAMPLE"),
    "GET",
    `/connections/${C}/conversations/CEXAMPLE`,
  );
  expect(
    await check(
      {
        messages: [{ ts: "1780000000.000001" }],
        next_cursor: null,
        has_more: false,
      },
      () =>
        c.slack.listMessages(C, "CEXAMPLE", { threadTs: "1780000000.000001" }),
      "GET",
      `/connections/${C}/conversations/CEXAMPLE/messages`,
      undefined,
      { limit: "15", thread_ts: "1780000000.000001" },
    ),
  ).toMatchObject({ nextCursor: null });
  expect(
    await check(
      fixture.action,
      () =>
        c.slack.sendMessage(C, {
          conversationId: "CEXAMPLE",
          text: "Hello",
          idempotencyKey: "operation:1",
          threadTs: "1780000000.000001",
        }),
      "POST",
      `/connections/${C}/messages`,
      {
        conversation_id: "CEXAMPLE",
        text: "Hello",
        thread_ts: "1780000000.000001",
      },
    ),
  ).toMatchObject({ status: "unknown" });
  expect(
    new Headers(fetch.mock.calls.at(-1)![1]?.headers).get("Idempotency-Key"),
  ).toBe("operation:1");
  await check(
    fixture.action,
    () => c.slack.getAction(C, fixture.action.id),
    "GET",
    `/connections/${C}/actions/${fixture.action.id}`,
  );
  await check(
    fixture.file,
    () => c.slack.getFile(C, "FEXAMPLE"),
    "GET",
    `/connections/${C}/files/FEXAMPLE`,
  );
  expect(
    await check(
      new Uint8Array([0, 255, 128, 1]),
      () => c.slack.downloadFile(C, "FEXAMPLE"),
      "GET",
      `/connections/${C}/files/FEXAMPLE/content`,
    ),
  ).toEqual(new Uint8Array([0, 255, 128, 1]));
  expect(fetch).toHaveBeenCalledTimes(13);
});
it.each([409, 429, 503])(
  "does not retry rejected or ambiguous send (%s)",
  async (status) => {
    const { fetch, reply } = mock();
    reply({ detail: "Unable to send" }, status);
    await expect(
      client().slack.sendMessage(C, {
        conversationId: "CEXAMPLE",
        text: "Hello",
        idempotencyKey: "operation:1",
      }),
    ).rejects.toMatchObject({ statusCode: status });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
it.each(events.slice(0, 5))("uses ordinary event selection for %s", async (eventType) => {
  const { fetch, reply } = mock();
  const subs = client().webhooks.subscriptions;
  reply({ ...fixture.subscription, event_types: [eventType] });
  const row = await subs.create({
    url: "https://example.com/hook", agentIdentityId: I, eventTypes: [eventType],
  });
  expect(row).not.toHaveProperty("slackFilter");
  expect(row.eventTypes).toEqual([eventType]);
  expect(fetch.mock.calls.at(-1)![1]?.method).toBe("POST");
  expect(new URL(String(fetch.mock.calls.at(-1)![0])).pathname).toBe("/api/v1/webhooks/subscriptions");
  expect(JSON.parse(String(fetch.mock.calls.at(-1)![1]?.body))).toEqual({
    url: "https://example.com/hook", agent_identity_id: I, event_types: [eventType],
  });
  reply(fixture.subscription);
  await subs.update(row.id, { eventTypes: [eventType] });
  expect(fetch.mock.calls.at(-1)![1]?.method).toBe("PATCH");
  expect(JSON.parse(String(fetch.mock.calls.at(-1)![1]?.body))).toEqual({ event_types: [eventType] });
});
it.each([null, {}, { messageKinds: ["mention"] }])("rejects removed filter options without sending: %j", async (slackFilter) => {
  const { fetch } = mock();
  const subs = client().webhooks.subscriptions;
  const legacy = { url: "https://example.com/hook", agentIdentityId: I,
    eventTypes: ["slack.mention_received"], slackFilter };
  await expect(subs.create(legacy)).rejects.toThrow("filters have been removed");
  await expect(subs.update(fixture.subscription.id, legacy)).rejects.toThrow("filters have been removed");
  const legacyWire = { ...legacy, slack_filter: slackFilter };
  delete (legacyWire as { slackFilter?: unknown }).slackFilter;
  await expect(subs.create(legacyWire)).rejects.toThrow("filters have been removed");
  await expect(subs.update(fixture.subscription.id, legacyWire)).rejects.toThrow("filters have been removed");
  expect(fetch).not.toHaveBeenCalled();
});
it("exports the exact 23 event types", () => {
  expect(events).toHaveLength(23);
  expect(events).toEqual(payloads.map((p) => p.event_type));
});
it("rejects absent/invalid keys and numeric timestamps before sending", async () => {
  const { fetch } = mock();
  const c = client();
  for (const key of [undefined, "", "bad key", "x".repeat(129)])
    await expect(
      c.slack.sendMessage(C, {
        conversationId: "CEXAMPLE",
        text: "Hi",
        idempotencyKey: key as string,
      }),
    ).rejects.toThrow("idempotencyKey");
  await expect(
    c.slack.listMessages(C, "CEXAMPLE", { threadTs: 1.5 as unknown as string }),
  ).rejects.toThrow("string");
  expect(fetch).not.toHaveBeenCalled();
});

it("accepts explicit null for optional Slack thread and cursor fields", async () => {
  const { fetch, reply } = mock();
  const c = client();
  reply(fixture.action);
  await c.slack.sendMessage(C, {
    conversationId: "CEXAMPLE",
    text: "Hello",
    idempotencyKey: "operation:1",
    threadTs: null,
  });
  expect(
    JSON.parse(String(fetch.mock.calls.at(-1)![1]?.body)).thread_ts,
  ).toBeNull();
  reply({ messages: [], next_cursor: null });
  await c.slack.listMessages(C, "CEXAMPLE", { threadTs: null, cursor: null });
  const url = new URL(String(fetch.mock.calls.at(-1)![0]));
  expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "15" });
});


it.each([["slack.mention_received"], ["slack.mention_received", "message.received"]])(
  "keeps Slack context and mixed events compatible with identity scope: %j",
  async (...eventTypes) => {
    const { fetch, reply } = mock();
    const subs = client().webhooks.subscriptions;
    const contextConfig = { email: { mode: "count" as const, count: 1 } };
    reply({ ...fixture.subscription, event_types: eventTypes });
    const row = await subs.create({
      url: "https://example.com/hook", agentIdentityId: I, eventTypes, contextConfig,
    });
    expect(JSON.parse(String(fetch.mock.calls.at(-1)![1]?.body))).toEqual({
      url: "https://example.com/hook", agent_identity_id: I, event_types: eventTypes,
      context_config: contextConfig,
    });
    for (const [options, wire] of [
      [{}, {}],
      [{ contextConfig: null }, { context_config: null }],
      [{ authToken: "synthetic-token" }, { auth_token: "synthetic-token" }],
    ] as const) {
      reply(fixture.subscription);
      await subs.update(row.id, { scope: "identity", eventTypes, ...options });
      const [url, init] = fetch.mock.calls.at(-1)!;
      expect(new URL(String(url)).searchParams.get("scope")).toBe("identity");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ event_types: eventTypes, ...wire });
    }
    expect(fetch).toHaveBeenCalledTimes(4);
  },
);

it.each(["send", "reaction"])(
  "preserves the typed conflict without repeating a Slack %s write",
  async (operation) => {
    const c = client();
    const { fetch, reply } = mock();
    reply({ detail: {
      error: "idempotency_key_reused",
      message: "This key was already used for another request.",
    } }, 409);
    const request = operation === "send"
      ? c.slack.sendMessage(C, {
          conversationId: "CEXAMPLE", text: "Hello", idempotencyKey: "used-key",
        })
      : c.slack.addReaction(C, "CEXAMPLE", "1780000000.000001", "eyes", {
          idempotencyKey: "used-key",
        });
    await expect(request).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
