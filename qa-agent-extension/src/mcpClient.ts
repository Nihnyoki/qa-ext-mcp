import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let client: Client | null = null;

function resolveBaseRoot(context: vscode.ExtensionContext): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const repoRoot = path.resolve(context.extensionPath, "..");
    return workspaceRoot ?? repoRoot;
}

async function executeTaskAndWait(task: vscode.Task): Promise<number | undefined> {
    const exec = await vscode.tasks.executeTask(task);
    return await new Promise((resolve) => {
        const sub = vscode.tasks.onDidEndTaskProcess((e) => {
            if (e.execution === exec) {
                sub.dispose();
                resolve(e.exitCode);
            }
        });
    });
}

let installInFlight: Promise<void> | null = null;

export async function ensureRunnerReady(context: vscode.ExtensionContext, runner: string): Promise<void> {
    const baseRoot = resolveBaseRoot(context);
    const nodeModulesBin = path.join(baseRoot, "node_modules", ".bin");

    const binName = runner === "wdio" ? "wdio" : "cucumber-js";
    const binPath = path.join(nodeModulesBin, process.platform === "win32" ? `${binName}.cmd` : binName);

    if (fs.existsSync(binPath)) return;

    if (!installInFlight) {
        installInFlight = (async () => {
            const task = new vscode.Task(
                { type: "shell", task: "qa-agent-npm-install" },
                vscode.TaskScope.Workspace,
                "qa-agent: npm install (repo root)",
                "qa-agent",
                new vscode.ShellExecution("npm", ["install"], { cwd: baseRoot })
            );

            const exitCode = await executeTaskAndWait(task);
            if (exitCode !== 0 && exitCode !== undefined) {
                throw new Error(`Dependency install failed (exit code ${exitCode}).`);
            }
        })().finally(() => {
            installInFlight = null;
        });
    }

    await installInFlight;

    if (!fs.existsSync(binPath)) {
        throw new Error(
            `Runner binary not found after install: ${binPath}. ` +
                `Ensure the repo root dependencies include ${runner === "wdio" ? "@wdio/cli" : "@cucumber/cucumber"}.`
        );
    }
}

export async function connectMcp(context: vscode.ExtensionContext) {
    if (client) return client;

    const baseRoot = resolveBaseRoot(context);

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
        command: process.execPath,
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
