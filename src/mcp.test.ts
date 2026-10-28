import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { createMcpServer } from "./mcp.js";

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content[0].text;
}

describe("mcp server", () => {
  test("serves three tools over a client link", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    await server.connect(serverTransport);
    const client = new Client({ name: "probe", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(["dispatch_text", "get_cost_report", "summarize_text"]);

      const summary = await client.callTool({
        name: "summarize_text",
        arguments: { text: "a b a" },
      });
      expect(JSON.parse(textOf(summary))).toMatchObject({ words: 3 });

      const preview = await client.callTool({
        name: "dispatch_text",
        arguments: { text: "hi", dryRun: true },
      });
      expect(JSON.parse(textOf(preview))).toMatchObject({ dryRun: true });

      const report = await client.callTool({ name: "get_cost_report", arguments: {} });
      expect(JSON.parse(textOf(report))).toHaveProperty("dispatches");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("a blocked dispatch returns a tool error, not a crash", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { createGuards } = await import("./core.js");
    const server = createMcpServer({ guards: createGuards({ blocklist: ["nope"] }) });
    await server.connect(serverTransport);
    const client = new Client({ name: "probe", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "dispatch_text",
        arguments: { text: "nope" },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain("blocklisted");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
