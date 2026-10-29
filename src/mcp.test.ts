// Failure cases for the MCP handler. Each is a way a message could crash the server, leak input, or give rights.
//  1. A line that is not JSON, an array (a batch), a number, or an object with no method: an error reply, no crash.
//  2. A request with a wrong `jsonrpc`, or an id that is not a string or a number: an error reply.
//  3. A notification (no id) never gets a reply, even when its method is unknown.
//  4. An unknown method and an unknown tool: an error code, not a thrown error.
//  5. Arguments that are not an object, an unknown argument, a wrong type, a missing required one, a value
//     outside the choices, and `__proto__`: a tool error the agent can read. Nothing is written.
//  6. A tool that the actor may not use gives a tool error, and it names no email.
//  7. An initialize with an unknown protocol version gets the newest one this server speaks.
import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./adapters/memory.js";
import { COMMANDS, openApp } from "./commands.js";
import { createMcpHandler } from "./mcp.js";

const store = createMemoryStore();
const handle = createMcpHandler({ app: () => openApp(store) });
const call = (name: string, args?: unknown, id: number | string = 1) => handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
const result = async (name: string, args?: unknown) => ((await call(name, args))?.result ?? {}) as ToolResult;

describe("framing", () => {
  test("bad messages get an error reply", async () => {
    for (const bad of [[], 5, "x", null, {}, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: {}, method: "ping" }, { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: 1, method: 5 }]) {
      expect((await handle(bad))?.error?.code, JSON.stringify(bad)).toBe(-32600);
    }
  });

  test("a notification gets no reply, and an unknown method or tool gets an error code", async () => {
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    expect(await handle({ jsonrpc: "2.0", method: "no/such" })).toBeUndefined();
    expect((await handle({ jsonrpc: "2.0", id: 1, method: "no/such" }))?.error?.code).toBe(-32601);
    expect((await call("no_such_tool"))?.error?.code).toBe(-32602);
    expect((await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: 5 } }))?.error?.code).toBe(-32602);
    expect((await handle({ jsonrpc: "2.0", id: 1, method: "tools/call" }))?.error?.code).toBe(-32602);
  });

  test("initialize names the server, and an unknown version gets the newest", async () => {
    const known = (await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }))?.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(known).toMatchObject({ protocolVersion: "2024-11-05", serverInfo: { name: "agentic-identity" } });
    const unknown = (await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }))?.result as { protocolVersion: string };
    expect(unknown.protocolVersion).toBe("2025-06-18");
    expect((await handle({ jsonrpc: "2.0", id: 3, method: "initialize" }))?.result).toBeDefined();
  });

  test("tools/list has one tool for each command, with a schema that fits", async () => {
    const { tools } = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }))?.result as { tools: { name: string; inputSchema: { required: string[]; properties: Record<string, { type: string }> } }[] };
    expect(tools.map((t) => t.name)).toEqual(COMMANDS.map((c) => c.tool));
    const link = tools.find((t) => t.name === "identity_links_create")!;
    expect(link.inputSchema.required).toEqual(["resource", "role"]);
    expect(link.inputSchema.properties.expires_in_ms?.type).toBe("integer");
    expect(link.inputSchema.properties.signed_in_only?.type).toBe("boolean");
  });
});

describe("tool calls", () => {
  test("a call does what the CLI command does", async () => {
    expect(await result("identity_whoami")).toMatchObject({ structuredContent: { principalId: "local", kind: "human" } });
    expect(await result("identity_resources_create", { type: "doc", id: "m1" })).toMatchObject({ structuredContent: { id: "m1" } });
    const link = (await result("identity_links_create", { resource: "m1", role: "viewer", expires_in_ms: 60_000 })).structuredContent as { token: string };
    expect((await result("identity_links_resolve", { resource: "m1", token: link.token })).structuredContent).toEqual({ allowed: true, role: "viewer" });
    const audit = (await result("identity_audit", { resource: "m1" })).structuredContent as { entries: { action: string }[] };
    expect(audit.entries.map((e) => e.action)).toContain("link.create");
  });

  test("bad arguments are a tool error, and nothing is written", async () => {
    const before = (await store.query("resources", {})).items.length;
    const cases: [string, unknown][] = [
      ["identity_resources_create", "not an object"],
      ["identity_resources_create", ["doc"]],
      ["identity_resources_create", {}],
      ["identity_resources_create", { type: 5 }],
      ["identity_resources_create", { type: "doc", extra: 1 }],
      ["identity_resources_create", { type: "doc", __proto__x: 1 }],
      ["identity_resources_create", JSON.parse('{"type":"doc","__proto__":{"x":1}}')],
      ["identity_grants_set", { resource: "m1", kind: "robot", subject: "x", role: "viewer" }],
      ["identity_links_create", { resource: "m1", role: "viewer", expires_in_ms: 1.5 }],
      ["identity_links_create", { resource: "m1", role: "viewer", signed_in_only: "yes" }],
      ["identity_agents_create", { handle: "okay", scopes: "doc:read" }],
    ];
    for (const [name, args] of cases) {
      const r = await result(name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    expect((await store.query("resources", {})).items).toHaveLength(before);
  });

  test("a refused action is a tool error that names no email", async () => {
    await store.put("principals", "eve", { id: "eve", kind: "human", scopes: ["*:admin"] });
    const eve = createMcpHandler({ app: () => openApp(store, { as: "eve" }) });
    const r = (await eve({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "identity_grants_list", arguments: { resource: "m1" } } }))?.result as ToolResult;
    expect(r).toMatchObject({ isError: true, content: [{ text: "forbidden" }] });
    const bad = (await call("identity_audit", { resource: "x/ann@example.com" }))?.result as ToolResult;
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).not.toContain("example.com");
  });
});
