// Failure-mode list for magic-link sign-in, written before the code. Each case is a way a link
// could be forged, replayed, or used to learn who has an account. These tests call the real handler.
//  1. A link is made: the mail holds one link, the store holds only its hash, never the token.
//  2. A link is verified: it sets a session cookie with HttpOnly, Secure, and SameSite=Lax.
//  3. The session user is present: /me answers with a person, and the user row has the verified email.
//  4. A link works once: a second click, and two clicks at once, give one session.
//  5. A link ends at 15 minutes: one second before works, at the limit is refused.
//  6. A token that is unknown, malformed, or edited is refused. A row with a bad expiry is refused.
//  7. No enumeration: a known and an unknown address get the same status and body, and a mail
//     that fails to send gives the same answer. A bad address is the only 400.
//  8. Rate limits: per address, per IP (another address does not help), and for everyone.
//  9. returnTo that leaves the site becomes `/`. 10. It is off (404) with no mail or no config.
// 11. Opening the link (GET, HEAD, a scanner) must not use the token up. Only a POST with our own
//     Origin does, so a page on another site cannot sign a person into the attacker's account.
// 12. A bad mail setting in the Worker env turns this off and does not break other routes.
import { describe, expect, test, vi } from "vitest";
import { createMemoryMail, createMemoryStore } from "./adapters/memory.js";
import { sha256Hex } from "./credentials.js";
import type { Mail } from "./ports.js";
import { createApp, mailFromEnv, type WorkerConfig } from "./worker.js";
import { deletePerson } from "./gdpr.js";

let t = 1_000_000_000;

function setup(extra: Partial<WorkerConfig> = {}, mailOverride?: Mail) {
  const store = createMemoryStore();
  const memoryMail = createMemoryMail();
  const mail = mailOverride ?? memoryMail;
  const app = createApp({ store, mail, now: () => t, config: { magicLink: { publicUrl: "https://app.test", appName: "Docs" }, unsafeTestMint: false, ...extra } });
  const ask = (email: unknown, ip = "1.1.1.1", returnTo?: string) =>
    app.request("/api/v1/auth/magic", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ email, ...(returnTo ? { returnTo } : {}) }) });
  const tokenFrom = (index = -1) => {
    const text = memoryMail.outbox().at(index)!.text;
    return /token=([A-Za-z0-9_-]+)/.exec(text)![1]!;
  };
  const open = (token: string, method = "GET") => app.request(`/api/v1/auth/magic/verify?token=${token}`, { method });
  const verify = (token: string, origin: string | false = "https://app.test") =>
    app.request("/api/v1/auth/magic/verify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) }, body: new URLSearchParams({ token }) });
  const me = (cookie: string) => app.request("/api/v1/me", { headers: { cookie } });
  return { store, memoryMail, app, ask, tokenFrom, open, verify, me };
}

describe("magic-link sign-in", () => {
  test("a link is made, and the store holds only its hash", async () => {
    const { ask, memoryMail, tokenFrom, store } = setup();
    const res = await ask("Ana@Example.test");
    expect(res.status).toBe(202);
    expect(memoryMail.outbox()).toHaveLength(1);
    const mail = memoryMail.outbox()[0]!;
    expect(mail.to).toBe("ana@example.test");
    expect(mail.text).toContain("https://app.test/api/v1/auth/magic/verify?token=");
    const token = tokenFrom();
    expect(await store.get("magic_links", token)).toBeNull();
    const row = await store.get("magic_links", await sha256Hex(token));
    expect(row?.expiresAt).toBe(t + 900_000);
  });

  test("a link is verified: the cookie is set with its flags, and the session user is present", async () => {
    const { ask, tokenFrom, verify, me, store } = setup();
    await ask("ana@example.test", "1.1.1.1", "/docs/1");
    const res = await verify(tokenFrom());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/docs/1");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^session=aid_/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const who = await me(cookie.split(";")[0]!);
    expect(who.status).toBe(200);
    const body = (await who.json()) as { principalId: string; kind: string };
    expect(body.kind).toBe("human");
    expect((await store.get("users", body.principalId))?.emailVerified).toBe(true);
  });

  test("the same address signs in as the same person each time", async () => {
    const { ask, tokenFrom, verify, me } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      await ask("ana@example.test");
      const cookie = (await verify(tokenFrom())).headers.get("set-cookie")!.split(";")[0]!;
      ids.push(((await (await me(cookie)).json()) as { principalId: string }).principalId);
    }
    expect(ids[0]).toBe(ids[1]);
  });

  test("a link works once, even when two clicks arrive together", async () => {
    const { ask, tokenFrom, verify } = setup();
    await ask("ana@example.test");
    const token = tokenFrom();
    const results = await Promise.all([verify(token), verify(token)]);
    expect(results.map((r) => r.status).sort()).toEqual([303, 400]);
    expect((await verify(token)).status).toBe(400);
  });

  test("opening the link does not use it up, and a POST needs our Origin", async () => {
    const { ask, tokenFrom, open, verify } = setup();
    await ask("ana@example.test");
    const token = tokenFrom();
    for (const method of ["GET", "HEAD", "GET"]) {
      const res = await open(token, method);
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
      // A browser sends `Origin: null` from a `no-referrer` page, so the page must keep our Origin.
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await (await open(token)).text()).toContain(`name="token" value="${token}"`);
    for (const origin of [false as const, "https://evil.test", "null"]) {
      const res = await verify(token, origin);
      expect(res.status).toBe(403);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect((await verify(token)).status).toBe(303);
  });

  test("an erase removes a pending link, and the press has its own budget", async () => {
    const { ask, tokenFrom, verify, me, store } = setup({ rateLimits: { magicVerify: { limit: 2, windowMs: 600_000 } } });
    await ask("ana@example.test");
    const first = tokenFrom();
    const cookie = (await verify(first)).headers.get("set-cookie")!.split(";")[0]!;
    const id = ((await (await me(cookie)).json()) as { principalId: string }).principalId;
    await ask("ana@example.test", "2.2.2.2");
    const pending = tokenFrom();
    await deletePerson(store, id);
    expect((await store.query("magic_links", { limit: 10 })).items).toHaveLength(0);
    expect((await verify(pending)).status).toBe(400);
    expect((await verify(pending)).status).toBe(429);
  });

  test("a bad mail setting in the env turns this off and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = { DB: {} as never, REGION: "eu", PUBLIC_URL: "https://app.test", MAIL_FROM: "login@app.test", MAIL_HTTP_URL: "https://mail.test/send" };
    expect(await mailFromEnv(base)).toBeDefined();
    expect(await mailFromEnv({ ...base, MAIL_HTTP_URL: "http://mail.test/send" })).toBeUndefined();
    expect(await mailFromEnv({ ...base, MAIL_FROM: "not-an-address" })).toBeUndefined();
    expect(await mailFromEnv({ ...base, REGION: "mars" })).toBeUndefined();
    expect(await mailFromEnv({ ...base, PUBLIC_URL: "app.test" })).toBeUndefined();
    expect(await mailFromEnv({ ...base, PUBLIC_URL: "http://app.test" })).toBeUndefined();
    expect(await mailFromEnv({ ...base, MAIL_HTTP_URL: undefined, SEND_EMAIL: { send: async () => undefined } })).toBeUndefined();
    expect(await mailFromEnv({ ...base, MAIL_FROM: undefined })).toBeUndefined();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("app.test");
    warn.mockRestore();
  });

  test("an address with a trailing dot is refused", async () => {
    const { ask } = setup();
    expect((await ask("ana@example.test.")).status).toBe(400);
  });

  test("a link ends at 15 minutes", async () => {
    const { ask, tokenFrom, verify } = setup();
    await ask("ana@example.test");
    const old = tokenFrom();
    await ask("bob@example.test", "2.2.2.2");
    const fresh = tokenFrom();
    t += 899_999;
    expect((await verify(fresh)).status).toBe(303);
    t += 1;
    const res = await verify(old);
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("an unknown, malformed, or edited token is refused, and so is a row with a bad expiry", async () => {
    const { ask, tokenFrom, verify, store } = setup();
    await ask("ana@example.test");
    const token = tokenFrom();
    for (const bad of ["", "short", "x".repeat(43), `${token}x`, `${token.slice(0, -1)}A`, "a b", "../x"]) {
      const res = await verify(bad);
      expect(res.status).toBe(400);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    const hash = await sha256Hex(token);
    const row = (await store.get("magic_links", hash))!;
    for (const expiresAt of ["9999999999999", Number.NaN, null, undefined]) {
      await store.put("magic_links", hash, { ...row, expiresAt } as never);
      expect((await verify(token)).status).toBe(400);
    }
  });

  test("an unknown and a known address get the same answer, and a failed send looks the same", async () => {
    const { ask, verify, tokenFrom } = setup();
    await ask("known@example.test");
    await verify(tokenFrom());
    const known = await ask("known@example.test", "3.3.3.3");
    const unknown = await ask("nobody@example.test", "4.4.4.4");
    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
    const failing = setup({}, { region: "unknown", send: async () => { throw new Error("mailbox refused"); } });
    const res = await failing.ask("ana@example.test");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect((await failing.ask("not-an-address")).status).toBe(400);
    expect((await failing.ask(42)).status).toBe(400);
  });

  test("a request over the budget for an address, an IP, or everyone is a 429 and sends nothing", async () => {
    const byEmail = setup();
    for (let i = 0; i < 3; i++) expect((await byEmail.ask("ana@example.test", `9.9.9.${i}`)).status).toBe(202);
    const blocked = await byEmail.ask("ana@example.test", "9.9.9.9");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect(byEmail.memoryMail.outbox()).toHaveLength(3);
    // Another case differs only in case: it is the same address.
    expect((await byEmail.ask("ANA@example.test", "9.9.9.8")).status).toBe(429);

    const byIp = setup();
    for (let i = 0; i < 10; i++) expect((await byIp.ask(`u${i}@example.test`, "5.5.5.5")).status).toBe(202);
    expect((await byIp.ask("other@example.test", "5.5.5.5")).status).toBe(429);
    expect((await byIp.ask("other@example.test", "6.6.6.6")).status).toBe(202);

    const all = setup({ rateLimits: { magicAll: { limit: 2, windowMs: 900_000 } } });
    expect((await all.ask("a@example.test", "7.0.0.1")).status).toBe(202);
    expect((await all.ask("b@example.test", "7.0.0.2")).status).toBe(202);
    expect((await all.ask("c@example.test", "7.0.0.3")).status).toBe(429);
  });

  test("a returnTo that leaves the site becomes /", async () => {
    const { ask, tokenFrom, verify } = setup();
    for (const [i, to] of ["https://evil.test/", "//evil.test", "/\\evil.test"].entries()) {
      await ask("ana@example.test", `8.8.${i}.1`, to);
      expect((await verify(tokenFrom())).headers.get("location")).toBe("/");
    }
  });

  test("expired rows are removed when a new link is made", async () => {
    const { ask, store } = setup();
    await ask("ana@example.test");
    t += 900_001;
    await ask("bob@example.test", "2.2.2.2");
    expect((await store.query("magic_links", { limit: 10 })).items).toHaveLength(1);
  });

  test("a cookie write from the same origin works for a magic-link-only deployment", async () => {
    const { ask, tokenFrom, verify, app } = setup();
    await ask("ana@example.test");
    const cookie = (await verify(tokenFrom())).headers.get("set-cookie")!.split(";")[0]!;
    const out = await app.request("/api/v1/auth/logout", { method: "POST", headers: { cookie, origin: "https://app.test" } });
    expect(out.status).toBe(200);
    expect((await app.request("/api/v1/me", { headers: { cookie } })).status).toBe(401);
  });

  test("it is off with no config or no mail", async () => {
    const off = setup({ magicLink: undefined });
    expect((await off.ask("ana@example.test")).status).toBe(404);
    expect((await off.open("a".repeat(43))).status).toBe(404);
    expect((await off.verify("a".repeat(43))).status).toBe(404);
    const app = createApp({ store: createMemoryStore(), now: () => t, config: { magicLink: { publicUrl: "https://app.test" }, unsafeTestMint: false } });
    const res = await app.request("/api/v1/auth/magic", { method: "POST", body: JSON.stringify({ email: "ana@example.test" }) });
    expect(res.status).toBe(404);
  });
});
