import { z } from "zod";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

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

            const logDir = path.join(process.cwd(), "qa-logs");
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

            const logFile = path.join(logDir, `run_${timestamp}.log`);

            let command = "";
            let cmdArgs: string[] = [];

            if (args.runner === "cucumber") {
                command = "cucumber-js";
                cmdArgs.push("--config", "cucumber.json");

                if (args.tags) cmdArgs.push("--tags", args.tags);
                if (args.featurePath) cmdArgs.push(args.featurePath);
            }

            if (args.runner === "wdio") {
                command = "wdio";
                cmdArgs.push(
                    args.wdioConfig ??
                    "setup/bdd/mobile/mars/config/wdio-android-conf.ts"
                );
            }

            return await new Promise((resolve) => {
                const child = spawn(command, cmdArgs, {
                    env: {
                        ...process.env,
                        ENV: args.env,
                        OPCO: args.opco,
                        PLATFORM: args.platform,
                        TEAM: args.team,
                        APP_VERSION: args.appVersion,
                    },
                    shell: true,
                });

                const stream = fs.createWriteStream(logFile);

                child.stdout.on("data", (data) => stream.write(data));
                child.stderr.on("data", (data) => stream.write(data));

                child.on("close", (code) => {
                    stream.close();

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
                                            topErrors: [],
                                        },
                                        nextActions: ["summarize_test_log"],
                                    },
                                    null,
                                    2
                                ),
                            },
                        ],
                    });
                });
            });
        }
    );
}
