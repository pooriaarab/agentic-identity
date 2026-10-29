// The Mail contract runs against two adapters. The HTTP adapter calls a real Worker served by
// miniflare, which keeps what it received. The Cloudflare adapter hands raw MIME to a binding,
// and the harness parses it back, so the contract checks the bytes that would leave.
// Failure list, written before the code:
//  1. An address, subject, or body that could add a header must not reach the API or the binding.
//  2. A non-2xx reply must throw an error that holds the status, and no address or body.
//  3. A plain http URL, a redirect, and a bad sender must be refused.
//  4. A subject with non-ASCII text must survive the MIME round trip, at every length.
//  5. The token must go in the Authorization header, and nowhere else.
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MailMessage } from "../ports.js";
import { runMailContract } from "../testing.js";
import { MailError, buildMime, createCloudflareMail, createHttpMail } from "./mail.js";

const SCRIPT = `
const boxes = new Map();
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const [, box, action] = url.pathname.split("/");
    if (action === "outbox") return Response.json(boxes.get(box) ?? []);
    if (request.headers.get("authorization") !== "Bearer t0k3n") return new Response("no", { status: 401 });
    const body = await request.json();
    if (body.to === "fail@example.test") return new Response("ana@example.test " + body.text, { status: 502 });
    const list = boxes.get(box) ?? [];
    list.push({ ...body, auth: true });
    boxes.set(box, list);
    return Response.json({ id: "m-" + list.length + "-" + box.slice(0, 8) });
  },
};`;

let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: SCRIPT });
});
afterAll(() => mf.dispose());

const viaMiniflare = ((input: RequestInfo | URL, init?: RequestInit) => mf.dispatchFetch(input as string, init as never)) as unknown as typeof fetch;

describe("HTTP mail", () => {
  runMailContract(async (options) => {
    const box = crypto.randomUUID();
    const mail = createHttpMail({ ...options, url: `https://mail.example.test/${box}/send`, fetch: viaMiniflare, from: "noreply@example.test", token: () => "t0k3n" });
    const delivered = async () => {
      const list = (await (await mf.dispatchFetch(`https://mail.example.test/${box}/outbox`)).json()) as (MailMessage & { from: string; auth: boolean })[];
      expect(list.every((m) => m.from === "noreply@example.test" && m.auth)).toBe(true);
      return list.map(({ to, subject, text, html }) => ({ to, subject, text, ...(html === undefined ? {} : { html }) }));
    };
    return { mail, delivered };
  });

  const make = (extra: object = {}) => createHttpMail({ url: "https://mail.example.test/b/send", fetch: viaMiniflare, from: "noreply@example.test", token: "t0k3n", ...extra });
  const message: MailMessage = { to: "ana@example.test", subject: "Invite", text: "Open the link." };

  it("uses the id the API returns", async () => {
    expect((await make().send(message)).id).toMatch(/^m-1-b$/);
  });

  it("throws the status and nothing from the message or the reply on a refusal", async () => {
    const error = await make().send({ ...message, to: "fail@example.test", text: "secret body" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailError);
    expect((error as MailError).httpStatus).toBe(502);
    expect(String((error as Error).message) + JSON.stringify(error)).not.toMatch(/example\.test|secret body/);
    await expect(make({ token: "wrong" }).send(message)).rejects.toMatchObject({ httpStatus: 401 });
  });

  it("refuses a plain http URL, a bad sender, and a bad timeout", () => {
    expect(() => make({ url: "http://mail.example.test/b/send" })).toThrow("https");
    for (const from of ["", "no-at", "a@b.test\r\nBcc: x@example.test", "Ana <a@b.test>"]) expect(() => make({ from })).toThrow("sender");
    expect(() => make({ timeoutMs: 0 })).toThrow(RangeError);
  });

  it("turns a redirect into an error, and does not follow it", async () => {
    const seen: RequestInit[] = [];
    const redirecting = (async (_url: URL, init: RequestInit) => (seen.push(init), new Response(null, { status: 302, headers: { location: "https://evil.example.test/" } }))) as unknown as typeof fetch;
    await expect(make({ fetch: redirecting }).send(message)).rejects.toMatchObject({ httpStatus: 302 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.redirect).toBe("manual");
  });

  it("works with the redirect mode that workerd accepts, and never reaches the second host", async () => {
    const hosts: string[] = [];
    const edge = new Miniflare({
      modules: true,
      script: `export default { async fetch(request, env) {
        const r = await fetch("https://mail.example.test/send", { method: "POST", headers: { authorization: "Bearer t0k3n" }, body: "{}", redirect: "manual" });
        return Response.json({ status: r.status });
      } }`,
      outboundService: (request: Request) => {
        hosts.push(new URL(request.url).host);
        return new Response(null, { status: 302, headers: { location: "https://evil.example.test/" } });
      },
    });
    try {
      expect(await (await edge.dispatchFetch("https://app.example.test/")).json()).toEqual({ status: 302 });
      expect(hosts).toEqual(["mail.example.test"]);
    } finally {
      await edge.dispose();
    }
  });

  it("refuses a bad token with a fixed message that does not quote it", async () => {
    for (const token of ["", "a b", "tok\r\nX: y", 5 as unknown as string]) {
      const error = await make({ token: () => token }).send(message).catch((e: unknown) => e as Error);
      expect((error as Error).message).toBe("invalid mail token");
    }
  });

  it("refuses a body builder that returns nothing", async () => {
    await expect(make({ body: () => undefined }).send(message)).rejects.toThrow("returned nothing");
  });

  it("lets the caller shape the body for another API", async () => {
    const seen: unknown[] = [];
    const spy = (async (_url: URL, init: RequestInit) => (seen.push(JSON.parse(init.body as string)), Response.json({ id: "x" }))) as unknown as typeof fetch;
    await make({ fetch: spy, body: (m: MailMessage, from: string) => ({ sender: from, recipients: [m.to] }) }).send(message);
    expect(seen).toEqual([{ sender: "noreply@example.test", recipients: ["ana@example.test"] }]);
  });
});

/** Reads back the MIME that `buildMime` writes. */
function parseMime(raw: string): MailMessage {
  const [headText, ...rest] = raw.split("\r\n\r\n");
  const unfolded = headText!.replace(/\r\n /g, " ");
  const header = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(unfolded)?.[1] ?? "";
  const words = (value: string) => value.replace(/=\?UTF-8\?B\?([^?]*)\?=\s?/g, (_m, b64: string) => Buffer.from(b64, "base64").toString("utf8"));
  const decode = (body: string) => Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
  const multipart = /boundary="([^"]+)"/.exec(unfolded);
  const out: MailMessage = { to: header("To"), subject: words(header("Subject")), text: "" };
  if (!multipart) return { ...out, text: decode(rest.join("\r\n\r\n")) };
  const parts = rest.join("\r\n\r\n").split(`--${multipart[1]}`).slice(1, -1);
  const bodies = parts.map((p) => decode(p.split("\r\n\r\n").slice(1).join("\r\n\r\n")));
  return { ...out, text: bodies[0]!, html: bodies[1]! };
}

describe("Cloudflare mail", () => {
  class FakeEmailMessage {
    constructor(readonly from: string, readonly to: string, readonly raw: string) {}
  }
  const setup = (options: object = {}) => {
    const sent: FakeEmailMessage[] = [];
    const binding = { send: async (m: unknown) => void sent.push(m as FakeEmailMessage) };
    const mail = createCloudflareMail(binding, { from: "noreply@example.test", EmailMessage: FakeEmailMessage, ...options });
    return { mail, sent };
  };

  runMailContract((options) => {
    const { mail, sent } = setup(options);
    return { mail, delivered: () => sent.map((m) => parseMime(m.raw)) };
  });

  it("sets the envelope, and keeps the subject and bodies whole for any text", async () => {
    const { mail, sent } = setup();
    const subjects = ["=?UTF-8?B?SGk=?=", "Plain", "Café ☕", "é".repeat(200), "🔑".repeat(50), "a".repeat(200)];
    for (const subject of subjects) await mail.send({ to: "ana@example.test", subject, text: "Zażółć\r\ngęślą\n" + "x".repeat(500), html: "<p>日本語</p>" });
    expect(sent.every((m) => m.from === "noreply@example.test" && m.to === "ana@example.test")).toBe(true);
    expect(sent.map((m) => parseMime(m.raw).subject)).toEqual(subjects);
    expect(parseMime(sent[0]!.raw)).toMatchObject({ text: "Zażółć\r\ngęślą\n" + "x".repeat(500), html: "<p>日本語</p>" });
    for (const m of sent) expect(Math.max(...m.raw.split("\r\n").map((l) => l.length))).toBeLessThanOrEqual(998);
  });

  it("refuses a bad sender and a header injection through the sender", () => {
    for (const from of ["", "x", "a@b.test\r\nBcc: x@example.test"]) expect(() => setup({ from })).toThrow("sender");
  });

  it("adds exactly the headers it means to", () => {
    const raw = buildMime({ to: "ana@example.test", subject: "Hi", text: "x" }, "noreply@example.test", "id1", 0);
    expect(raw).toContain("Date: Thu, 01 Jan 1970 00:00:00 GMT");
    expect(raw.split("\r\n\r\n")[0]!.split("\r\n").map((h) => h.split(":")[0])).toEqual(["From", "To", "Subject", "Date", "Message-ID", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"]);
  });
});
