import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let client: Client | null = null;

export async function connectMcp(context: vscode.ExtensionContext) {
    if (client) return client;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // In Extension Development Host it's common to have no folder opened.
    // Fall back to the repo root (parent of the extension folder).
    const repoRoot = path.resolve(context.extensionPath, "..");
    const baseRoot = workspaceRoot ?? repoRoot;

    const cfg = vscode.workspace.getConfiguration("qa-agent");
    const entryRel = cfg.get<string>("mcpServerEntry") ?? "qa-agent-mcp/dist/index.js";
    const cwdCfg = cfg.get<string>("mcpCwd") ?? "";

    const serverPathCandidates = [
        path.resolve(baseRoot, entryRel),
        path.resolve(context.extensionPath, "..", "qa-agent-mcp", "dist", "index.js"),
    ];

    const serverPath = serverPathCandidates.find(p => fs.existsSync(p));
    if (!serverPath) {
        throw new Error(
            `MCP server entry not found. Tried:\n- ${serverPathCandidates.join("\n- ")}\n\nBuild it with: (cd qa-agent-mcp && npm run build)`
        );
    }

    console.log("🚀 Spawning MCP Server at:", serverPath);

    const transport = new StdioClientTransport({
        command: "node",
        args: [serverPath],
        cwd: cwdCfg ? path.resolve(baseRoot, cwdCfg) : baseRoot,
        env: {
            ...process.env,
            MCP_MODE: "stdio",
        },
    });

    client = new Client({
        name: "qa-agent-vscode-client",
        version: "1.0.0",
    });

    await client.connect(transport);

    console.log("✅ Connected to MCP Server successfully");

    return client;
}
