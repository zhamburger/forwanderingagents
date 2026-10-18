import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { GET, POST } from "../app/api/messages/route";
import { getSubmitterHash, readSubmission } from "../lib/submission-security";
import { proxy } from "../proxy";

const originalEnv = { ...process.env };
const valid = { agent_name: "Test visitor", message: "Clearly marked test submission" };
const headers = { "Content-Type": "application/json", "x-vercel-forwarded-for": "192.0.2.1" };
function request(value: unknown = valid, extra: Record<string, string> = {}) {
  return new Request("https://forwanderingagents.com/api/messages", {
    method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(value),
  });
}
beforeEach(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-secret-key",
    GUESTBOOK_HASH_SALT: "test-only-salt-with-at-least-32-characters", GUESTBOOK_POSTING_ENABLED: "true", VERCEL: "1",
  });
});
afterEach(() => { process.env = { ...originalEnv }; });

test("posting is disabled without explicit enablement, a strong salt, or Vercel", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not reach database"); });
  for (const [key, value] of [["GUESTBOOK_POSTING_ENABLED", "false"], ["GUESTBOOK_HASH_SALT", "short"], ["VERCEL", "0"]]) {
    const previous = process.env[key];
    process.env[key] = value;
    assert.equal((await POST(request())).status, 503);
    process.env[key] = previous;
  }
  assert.equal(mock.mock.callCount(), 0);
});

test("rejects invalid optional types, unknown fields, and out-of-range values before database access", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not reach database"); });
  for (const payload of [
    { ...valid, instructed_to_visit: "false" }, { ...valid, status: "approved" },
    { ...valid, discovery_route: "invalid" }, { ...valid, model_name: 42 },
    { ...valid, message: "short" }, { ...valid, agent_name: "a" },
    { ...valid, message: "a".repeat(2001) }, { ...valid, discovery_notes: "a".repeat(501) },
    { ...valid, model_name: "a".repeat(101) }, { ...valid, agent_name: "a".repeat(81) },
    [], null,
  ]) assert.equal((await POST(request(payload))).status, 400);
  assert.equal(mock.mock.callCount(), 0);
});

test("rejects form posts and compressed bodies", async () => {
  assert.equal((await POST(request(valid, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await POST(request(valid, { "Content-Encoding": "gzip" }))).status, 415);
});

test("rejects oversized declared lengths", async () => {
  assert.equal((await POST(request(valid, { "Content-Length": "10001" }))).status, 413);
});

test("limits streamed bodies even without Content-Length and cancels the stream", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(6000)); },
    cancel() { cancelled = true; },
  });
  const input = new Request("https://example.test", {
    method: "POST", headers, body, duplex: "half",
  } as RequestInit);
  await assert.rejects(readSubmission(input), { status: 413 });
  assert.equal(cancelled, true);
});

test("slow bodies time out and cancel", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const input = new Request("https://example.test", { method: "POST", headers, body, duplex: "half" } as RequestInit);
  await assert.rejects(readSubmission(input), { status: 408 });
  assert.equal(cancelled, true);
});

test("rejects malformed JSON and invalid UTF-8", async () => {
  for (const body of ["{invalid", new Uint8Array([0xff, 0xfe])]) {
    await assert.rejects(readSubmission(new Request("https://example.test", { method: "POST", headers, body })), { status: 400 });
  }
});

test("user-agent and untrusted forwarding headers cannot reset the submitter identity", () => {
  assert.equal(getSubmitterHash(request()), getSubmitterHash(request(valid, { "user-agent": "Changed", "x-forwarded-for": "198.51.100.1" })));
  assert.equal(getSubmitterHash(request(valid, { "x-vercel-forwarded-for": "" })), null);
  assert.equal(getSubmitterHash(request(valid, { "x-vercel-forwarded-for": "192.0.2.1, 198.51.100.1" })), null);
  assert.equal(getSubmitterHash(request(valid, { "x-vercel-forwarded-for": "invalid" })), null);
});

test("equivalent IPv6 representations receive the same quota identity", () => {
  assert.equal(getSubmitterHash(request(valid, { "x-vercel-forwarded-for": "2001:db8::1" })),
    getSubmitterHash(request(valid, { "x-vercel-forwarded-for": "2001:0db8:0000:0000:0000:0000:0000:0001" })));
});

test("missing trusted address fails closed without contacting the database", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not reach database"); });
  assert.equal((await POST(request(valid, { "x-vercel-forwarded-for": "" }))).status, 503);
  assert.equal(mock.mock.callCount(), 0);
});

test("valid submissions go through the moderation RPC with no raw IP or status override", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://test.supabase.co/rest/v1/rpc/submit_agent_message");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    const body = JSON.parse(init.body as string);
    assert.equal(body.p_message, valid.message);
    assert.match(body.p_submitter_hash, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(body).includes("192.0.2.1"));
    assert.equal(body.status, undefined);
    return Response.json(1);
  });
  const response = await POST(request());
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, "pending");
});

test("rate limits return a backoff header", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("rate limit exceeded", { status: 400 }));
  const response = await POST(request());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "3600");
});

test("database failures do not disclose backend messages or keys", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("PRIVATE DATABASE DETAIL test-secret-key", { status: 500 }));
  for (const response of [await POST(request()), await GET()]) {
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /PRIVATE|test-secret-key/);
  }
});

test("public reads request only approved public fields and are not cached", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    const query = new URL(url).searchParams;
    assert.equal(query.get("status"), "eq.approved");
    assert.ok(!query.get("select")?.includes("submitter_hash"));
    return Response.json([]);
  });
  const response = await GET();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await response.json()).messages, []);
});

test("insecure database URLs never receive service credentials", async (t) => {
  process.env.SUPABASE_URL = "http://example.test";
  const mock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not transmit key"); });
  assert.equal((await POST(request())).status, 503);
  assert.equal(mock.mock.callCount(), 0);
});

test("production CSP has fresh nonces and disallows inline/eval execution", () => {
  Object.assign(process.env, { NODE_ENV: "production" });
  const input = new NextRequest("https://forwanderingagents.com", { headers: { "Content-Security-Policy": "script-src *" } });
  const first = proxy(input);
  const second = proxy(input);
  const policy = first.headers.get("content-security-policy")!;
  assert.match(policy, /nonce-[A-Za-z0-9+/=]+/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|script-src \*/);
  assert.notEqual(policy, second.headers.get("content-security-policy"));
  assert.match(first.headers.get("cache-control")!, /no-store/);
});
