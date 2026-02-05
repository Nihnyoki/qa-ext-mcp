import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildQaAgentServer } from "../server.js";

export async function startStdio() {
    const server = buildQaAgentServer();
    await server.connect(new StdioServerTransport());

    console.log("✅ QA Agent MCP running in STDIO mode");
}
