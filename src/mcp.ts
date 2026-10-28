import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createLogger,
  dispatchText,
  getCostReport,
  GuardError,
  LocalRouterAdapter,
  summarizeText,
  VendorError,
  type Guards,
  type Logger,
  type RouterAdapter,
} from "./core.js";
import { DEFAULT_BRAND } from "./index.js";

export interface McpDeps {
  router?: RouterAdapter;
  guards?: Guards;
  logger?: Logger;
}

const textShape = {
  text: z.string().describe("The text to handle."),
};

function errorResult(error: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

function okResult(value: unknown): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function createMcpServer(deps: McpDeps = {}): McpServer {
  const router = deps.router ?? new LocalRouterAdapter();
  const guards = deps.guards;
  const logger = deps.logger ?? createLogger({ quiet: true });
  const server = new McpServer({
    name: DEFAULT_BRAND.command,
    version: DEFAULT_BRAND.version,
  });

  server.registerTool(
    "summarize_text",
    {
      description: "Count chars, words, and lines in a text, with top words.",
      inputSchema: textShape,
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => okResult(summarizeText(text)),
  );

  server.registerTool(
    "dispatch_text",
    {
      description: "Route one text through the pack router. Pass dryRun to preview only.",
      inputSchema: {
        ...textShape,
        dryRun: z.boolean().optional().describe("Preview the route without delivery."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ text, dryRun }) => {
      try {
        return okResult(await dispatchText(text, { adapter: router, guards, logger, dryRun: dryRun ?? false }));
      } catch (error) {
        if (error instanceof GuardError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "get_cost_report",
    {
      description: "Read the cost report for this session.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => okResult(getCostReport()),
  );

  return server;
}

export async function startMcp(deps: McpDeps = {}): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
