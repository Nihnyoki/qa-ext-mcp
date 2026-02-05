import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getToolCatalogTool } from "./tools/getToolCatalog.js";
import { runDynamicTestsTool } from "./tools/runDynamicTests.js";
import { summarizeTestLogTool } from "./tools/summarizeTestLog.js";
import { createAdoDefectTool } from "./tools/adoCreateDefect.js";

export function buildQaAgentServer() {
    const server = new McpServer({
        name: "qa-agent-mcp",
        version: "1.0.0",
    });

    // Register QA tools
    getToolCatalogTool(server);
    runDynamicTestsTool(server);
    summarizeTestLogTool(server);
    createAdoDefectTool(server);

    return server;
}
