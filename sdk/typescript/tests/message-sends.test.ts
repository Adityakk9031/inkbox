import { describe, expect, it, vi } from "vitest";
import { InkboxAPIError, InkboxConnectionError, HttpTransport } from "../src/_http.js";
import { MessageSendsResource, postMessage } from "../src/message_sends.js";
import type { MailboxesResource } from "../src/mail/resources/mailboxes.js";

describe("message request identity", () => {
  it("retries a timed-out request with the same key", async () => {
    vi.useFakeTimers();
    try {
      const post = vi.fn().mockRejectedValueOnce(new DOMException("timeout", "AbortError")).mockResolvedValue({ id: "original" });
      const pending = postMessage({ post } as unknown as HttpTransport, "/messages", {}, "same");
      await vi.runAllTimersAsync();
      expect(await pending).toEqual({ id: "original" });
      expect(post.mock.calls[0]).toEqual(post.mock.calls[1]);
    } finally { vi.useRealTimers(); }
  });
  it("reuses its generated key after a lost response", async () => {
    vi.useFakeTimers();
    try {
      const post = vi.fn().mockRejectedValueOnce(new InkboxConnectionError("lost", null)).mockResolvedValue({ id: "original" });
      const pending = postMessage({ post } as unknown as HttpTransport, "/messages", { text: "hello" });
      await vi.runAllTimersAsync();
      expect(await pending).toEqual({ id: "original" });
      expect(post.mock.calls[0]).toEqual(post.mock.calls[1]);
      expect(post.mock.calls[0][2].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(post.mock.calls[0][2].headers.Prefer).toBe("idempotency-replay");
    } finally { vi.useRealTimers(); }
  });

  it("does not retry permanent errors or replace the original key", async () => {
    const error = new InkboxAPIError(422, { error: "invalid_input" });
    const post = vi.fn().mockRejectedValue(error);
    await expect(postMessage({ post } as unknown as HttpTransport, "/messages", {}, "same")).rejects.toMatchObject({ idempotencyKey: "same" });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("makes a separate call a new message", async () => {
    const post = vi.fn().mockResolvedValue({ id: "result" });
    const transport = { post } as unknown as HttpTransport;
    await postMessage(transport, "/messages", { text: "hello" });
    await postMessage(transport, "/messages", { text: "hello" });
    expect(post.mock.calls[0][2].headers["Idempotency-Key"]).not.toBe(post.mock.calls[1][2].headers["Idempotency-Key"]);
  });

  it("does not retry before a long Retry-After delay", async () => {
    const error = new InkboxAPIError(429, { error: "rate_limited" });
    Object.assign(error, { retryAfterSeconds: 60 });
    const post = vi.fn().mockRejectedValue(error);
    await expect(postMessage({ post } as unknown as HttpTransport, "/messages", {}, "original"))
      .rejects.toBe(error);
    expect(post).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ idempotencyKey: "original" });
  });

  it("looks up the original ID without submitting a message", async () => {
    const get = vi.fn().mockResolvedValue({ message_id: "original" });
    const transport = { get, post: vi.fn() } as unknown as HttpTransport;
    const resource = new MessageSendsResource(transport, {} as MailboxesResource);
    expect(await resource.lookup({ senderKind: "phone_number", senderId: "sender", operation: "text.send", idempotencyKey: "same" })).toBe("original");
    expect(get.mock.calls[0][2]).toEqual({ headers: { "Idempotency-Key": "same" } });
    expect(transport.post).not.toHaveBeenCalled();
  });
});
