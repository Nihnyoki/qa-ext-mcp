import { z } from "zod";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

function resolveLocalBin(binName: string, baseDir: string): string | undefined {
    const isWin = process.platform === "win32";
    const candidate = path.join(
        baseDir,
        "node_modules",
        ".bin",
        isWin ? `${binName}.cmd` : binName
    );
    return fs.existsSync(candidate) ? candidate : undefined;
}

function findUp(fileName: string, startDir: string): string | undefined {
    let current = path.resolve(startDir);
    while (true) {
        const candidate = path.join(current, fileName);
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

function resolveWorkspaceRoot(): string {
    const fromCwd = findUp("cucumber.json", process.cwd());
    if (fromCwd) return path.dirname(fromCwd);

    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const fromModule = findUp("cucumber.json", moduleDir);
    if (fromModule) return path.dirname(fromModule);

    return process.cwd();
}

function isWindowsCmdShim(binPath: string): boolean {
    return process.platform === "win32" && binPath.toLowerCase().endsWith(".cmd");
}

function prependPath(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
    const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    const sep = process.platform === "win32" ? ";" : ":";
    const cur = env[key] ?? "";
    return { ...env, [key]: cur ? `${dir}${sep}${cur}` : dir };
}

export function runDynamicTestsTool(server: any) {
    server.tool(
        "run_dynamic_tests",
        {
            runner: z.enum(["cucumber", "wdio"]),
            featurePath: z.string().optional(),
            tags: z.string().optional(),

            env: z.string().default("UAT"),
            opco: z.string().optional(),
            platform: z.string().optional(),

            team: z.string().optional(),
            appVersion: z.string().optional(),
            wdioConfig: z.string().optional(),
        },

        async (args: { runner: string; tags: string; featurePath: string; wdioConfig: any; env: any; opco: any; platform: any; team: any; appVersion: any; }) => {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

            const workspaceRoot = resolveWorkspaceRoot();

            const logDir = path.join(workspaceRoot, "qa-logs");
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

            const logFile = path.join(logDir, `run_${timestamp}.log`);

            let command = "";
            let cmdArgs: string[] = [];
            let localBinDir: string | undefined;
            let missingLocalBinMessage: string | undefined;

            if (args.runner === "cucumber") {
                const local = resolveLocalBin("cucumber-js", workspaceRoot);
                localBinDir = local ? path.dirname(local) : undefined;

                if (!local) {
                    missingLocalBinMessage =
                        "Local cucumber runner not found (node_modules/.bin/cucumber-js). " +
                        "Refusing to run `npx cucumber-js` because it may download an unrelated placeholder package.\n" +
                        "Fix: from the repo root, run `npm install` (ensure @cucumber/cucumber is installed), then retry.";
                } else if (isWindowsCmdShim(local)) {
                    command = local;
                    cmdArgs.push("--config", "cucumber.json");
                } else {
                    command = process.execPath;
                    cmdArgs.push(local, "--config", "cucumber.json");
                }

                if (args.tags) cmdArgs.push("--tags", args.tags);
                if (args.featurePath) cmdArgs.push(args.featurePath);
            }

            if (args.runner === "wdio") {
                const local = resolveLocalBin("wdio", workspaceRoot);
                localBinDir = local ? path.dirname(local) : undefined;

                if (!local) {
                    missingLocalBinMessage =
                        "Local WDIO runner not found (node_modules/.bin/wdio).\n" +
                        "Fix: from the repo root, run `npm install` (ensure @wdio/cli is installed), then retry.";
                } else if (isWindowsCmdShim(local)) {
                    command = local;
                    cmdArgs.push(
                        args.wdioConfig ??
                            "setup/bdd/mobile/mars/config/wdio-android-conf.ts"
                    );
                } else {
                    command = process.execPath;
                    cmdArgs.push(
                        local,
                        args.wdioConfig ??
                            "setup/bdd/mobile/mars/config/wdio-android-conf.ts"
                    );
                }
            }

            return await new Promise((resolve) => {
                const nodeModulesBin = path.join(workspaceRoot, "node_modules", ".bin");
                const expectedBinName = args.runner === "cucumber" ? "cucumber-js" : "wdio";
                const expectedLocalBin = path.join(
                    nodeModulesBin,
                    process.platform === "win32" ? `${expectedBinName}.cmd` : expectedBinName
                );
                const expectedConfig =
                    args.runner === "cucumber"
                        ? path.join(workspaceRoot, "cucumber.json")
                        : undefined;
                const debugLine =
                    `[debug] cwd=${workspaceRoot}; ` +
                    `node_exec=${process.execPath}; ` +
                    `node_modules_bin_exists=${fs.existsSync(nodeModulesBin)}; ` +
                    `${expectedBinName}_exists=${fs.existsSync(expectedLocalBin)}` +
                    (expectedConfig ? `; cucumber_json_exists=${fs.existsSync(expectedConfig)}` : "");

                let childEnv: NodeJS.ProcessEnv = {
                    ...process.env,
                    ENV: args.env,
                    OPCO: args.opco,
                    PLATFORM: args.platform,
                    TEAM: args.team,
                    APP_VERSION: args.appVersion,
                };
                const nodeDir = path.dirname(process.execPath);
                if (nodeDir && fs.existsSync(nodeDir)) childEnv = prependPath(childEnv, nodeDir);
                if (fs.existsSync(nodeModulesBin)) {
                    childEnv = prependPath(childEnv, nodeModulesBin);
                }
                if (localBinDir && localBinDir !== nodeModulesBin) {
                    childEnv = prependPath(childEnv, localBinDir);
                }

                const shouldUseShell =
                    command === "npx" ||
                    (process.platform === "win32" &&
                        /\.(cmd|bat)$/i.test(command));

                const child = spawn(command, cmdArgs, {
                    env: childEnv,
                    shell: shouldUseShell,
                    cwd: workspaceRoot,
                });

                const stream = fs.createWriteStream(logFile);
                let output = "";

                const fail = (message: string, exitCode = 127) => {
                    const text = message.trim();
                    stream.write(text + "\n");
                    stream.write(debugLine + "\n");
                    stream.close();
                    resolve({
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        status: "FAIL",
                                        run: {
                                            runner: args.runner,
                                            env: args.env,
                                            opco: args.opco,
                                            tags: args.tags,
                                            feature: args.featurePath,
                                            logFile,
                                            exitCode,
                                        },
                                        summary: {
                                            totalScenarios: 0,
                                            failedScenarios: 1,
                                            topErrors: [text],
                                        },
                                        nextActions: ["summarize_test_log"],
                                    },
                                    null,
                                    2
                                ),
                            },
                            { type: "text", text: text + "\n" },
                            { type: "text", text: debugLine + "\n" },
                        ],
                    });
                };

                if (missingLocalBinMessage) {
                    return fail(missingLocalBinMessage, 127);
                }

                child.on("error", (err: any) => {
                    const cmdDisplay = args.runner === "cucumber" ? "cucumber-js" : "wdio";
                    if (err?.code === "ENOENT") {
                        return fail(
                            `Unable to start ${cmdDisplay}.\n` +
                                `Fix: install dependencies so ${path.join(workspaceRoot, "node_modules", ".bin", cmdDisplay)} exists, and ensure Node.js is available.`
                        );
                    }
                    return fail(`Failed to start ${cmdDisplay}: ${err?.message ?? String(err)}`);
                });

                child.stdout.on("data", (data) => {
                    const chunk = data?.toString?.() ?? String(data);
                    output += chunk;
                    stream.write(chunk);
                });
                child.stderr.on("data", (data) => {
                    const chunk = data?.toString?.() ?? String(data);
                    output += chunk;
                    stream.write(chunk);
                });

                child.on("close", (code) => {
                    stream.close();

                    const trimmedOutput = output.trim();
                    const missingCmdMessage =
                        args.runner === "cucumber" &&
                        (trimmedOutput.includes("cucumber-js") && trimmedOutput.includes("command not found"))
                            ? "/bin/sh: cucumber-js: command not found"
                            : undefined;
                    const topErrors = code === 0 ? [] : [missingCmdMessage ?? (trimmedOutput || "Test run failed")];
                    const errorNote = missingCmdMessage ? `${missingCmdMessage}\n` : "";

                    resolve({
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        status: code === 0 ? "PASS" : "FAIL",
                                        run: {
                                            runner: args.runner,
                                            env: args.env,
                                            opco: args.opco,
                                            tags: args.tags,
                                            feature: args.featurePath,
                                            logFile,
                                            exitCode: code,
                                        },
                                        summary: {
                                            totalScenarios: 0,
                                            failedScenarios: code === 0 ? 0 : 1,
                                            topErrors,
                                        },
                                        nextActions: ["summarize_test_log"],
                                    },
                                    null,
                                    2
                                ),
                            },
                            ...(errorNote
                                ? [
                                      {
                                          type: "text",
                                          text: errorNote,
                                      },
                                  ]
                                : []),
                            ...(code === 0
                                ? []
                                : [
                                      {
                                          type: "text",
                                          text: debugLine + "\n",
                                      },
                                  ]),
                        ],
                    });
                });
            });
        }
    );
}
