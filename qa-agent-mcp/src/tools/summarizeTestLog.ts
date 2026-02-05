import { z } from "zod";
import fs from "fs";

export function summarizeTestLogTool(server: any) {
    server.tool(
        "summarize_test_log",
        { logFile: z.string() },

        async ({ logFile }: { logFile: string}) => {
            const text = fs.readFileSync(logFile, "utf-8");

            const scenarios = text.match(/Scenario:.*/g) ?? [];
            const failures = text.match(/FAIL|ERROR|AssertionError/g) ?? [];

            const topErrors = failures.slice(0, 5);

            const status = failures.length > 0 ? "FAIL" : "PASS";

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                status,
                                summary: {
                                    totalScenarios: scenarios.length,
                                    failedScenarios: failures.length,
                                    topErrors,
                                },

                                defectCandidate:
                                    status === "FAIL"
                                        ? {
                                            title: `Automation Failure Detected (${failures.length} errors)`,
                                            description: `Failures detected during execution.\n\nTop errors:\n${topErrors.join("\n")}\n\nSee logfile: ${logFile}`,
                                            severity: "High",
                                            evidenceLog: logFile,
                                        }
                                        : null,

                                nextActions:
                                    status === "FAIL"
                                        ? ["ask_user_create_defect"]
                                        : ["no_action_required"],
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );
}
