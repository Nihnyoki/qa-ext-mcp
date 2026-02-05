import { z } from "zod";
import fs from "fs";
import path from "path";
import { WebApi, getPersonalAccessTokenHandler } from "azure-devops-node-api";

type JsonPatchOperation = {
    op: number | string;
    path: string;
    from?: string;
    value?: unknown;
};

export function createAdoDefectTool(server: any) {
    // NOTE: These are currently stubs. They are registered so the VS Code sidebar
    // can route prompts to the correct operation and you can implement the real
    // Azure DevOps API calls behind them incrementally.

    server.tool(
        "ado_create_testcase",
        {
            featurePath: z.string(),
            storyId: z.string(),
            adoOrg: z.string().optional(),
            adoProject: z.string().optional(),
        },
        async ({ featurePath, storyId, adoOrg, adoProject }: { featurePath: string; storyId: string; adoOrg?: string; adoProject?: string; }) => {
            const project = adoProject ?? process.env.AZURE_PROJECT;
            if (!project) {
                throw new Error("Missing Azure DevOps project. Set AZURE_PROJECT or pass adoProject.");
            }

            const resolved = resolvePath(featurePath);
            if (!fs.existsSync(resolved)) {
                throw new Error(`Feature file not found: ${resolved}`);
            }

            const text = fs.readFileSync(resolved, "utf-8");
            const parsed = extractTestCasesFromFeatureText(text);
            if (parsed.testCases.length === 0) {
                throw new Error("No scenarios found in feature file.");
            }

            const { webApi, orgUrl } = await connectToAdoDirect({ adoOrg });
            const witApi = await webApi.getWorkItemTrackingApi();

            const created: Array<{ id: number; title: string }>
                = [];

            for (const tc of parsed.testCases) {
                const document: JsonPatchOperation[] = [
                    { op: 0, path: "/fields/System.Title", value: tc.title },
                    { op: 0, path: "/fields/System.Description", value: tc.descriptionHtml },
                    { op: 0, path: "/fields/Microsoft.VSTS.TCM.Steps", value: buildAdoSteps(tc.steps) },
                ];

                const wi = await witApi.createWorkItem(undefined, document, project, "Test Case");
                if (!wi.id) continue;

                created.push({ id: wi.id, title: tc.title });

                // Link story -> test case (tested-by). If it fails (custom process), fall back to related.
                await linkWorkItems(witApi, orgUrl, project, Number(storyId), wi.id, "tests");
            }

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                status: "created",
                                storyId: String(storyId),
                                featurePath: resolved,
                                createdTestCases: created,
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );

    server.tool(
        "ado_create_defect",
        {
            title: z.string(),
            description: z.string().optional(),
            severity: z.enum(["Low", "Medium", "High"]).default("High"),
            linkedTestcaseId: z.string().optional(),
            adoOrg: z.string().optional(),
            adoProject: z.string().optional(),
        },
        async ({ title, description, severity, linkedTestcaseId, adoOrg, adoProject }: { title: string; description?: string; severity: "Low" | "Medium" | "High"; linkedTestcaseId?: string; adoOrg?: string; adoProject?: string; }) => {
            const project = adoProject ?? process.env.AZURE_PROJECT;
            if (!project) {
                throw new Error("Missing Azure DevOps project. Set AZURE_PROJECT or pass adoProject.");
            }

            const workItemType = process.env.AZURE_DEFECT_WORK_ITEM_TYPE ?? "Bug";

            const { webApi, orgUrl } = await connectToAdoDirect({ adoOrg });
            const witApi = await webApi.getWorkItemTrackingApi();

            const fullDescription = [
                description ?? "",
                "",
                `Severity: ${severity}`,
            ].join("\n");

            const document: JsonPatchOperation[] = [
                { op: 0, path: "/fields/System.Title", value: title },
                { op: 0, path: "/fields/System.Description", value: fullDescription },
            ];

            // Best-effort: if supported by the process; otherwise we'll retry without it.
            document.push({ op: 0, path: "/fields/Microsoft.VSTS.Common.Severity", value: severity });

            const defect = await createWorkItemWithRetry(witApi, project, workItemType, document);
            if (!defect.id) {
                throw new Error("Defect creation failed: no work item id returned.");
            }

            if (linkedTestcaseId) {
                await linkWorkItems(witApi, orgUrl, project, defect.id, Number(linkedTestcaseId), "relates-to");
            }

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                status: "created",
                                defectId: String(defect.id),
                                workItemType,
                                linkedTestcaseId: linkedTestcaseId ? String(linkedTestcaseId) : null,
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );

    server.tool(
        "ado_link_items",
        {
            sourceId: z.string(),
            targetId: z.string(),
            linkType: z.enum(["tests", "relates-to", "parent-child"]),
        },
        async ({ sourceId, targetId, linkType }: { sourceId: string; targetId: string; linkType: "tests" | "relates-to" | "parent-child"; }) => {
            const project = process.env.AZURE_PROJECT;
            if (!project) {
                throw new Error("Missing Azure DevOps project. Set AZURE_PROJECT.");
            }

            const { webApi, orgUrl } = await connectToAdoDirect({});
            const witApi = await webApi.getWorkItemTrackingApi();

            await linkWorkItems(witApi, orgUrl, project, Number(sourceId), Number(targetId), linkType);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                status: "linked",
                                sourceId,
                                targetId,
                                linkType,
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );

    // Legacy alias kept for compatibility
    server.tool(
        "ado_create_defect_linked_to_testcase",
        {
            defectTitle: z.string(),
            testcaseId: z.string(),
            token: z.string().optional(),
        },
        async ({ defectTitle, testcaseId, token }: { defectTitle: string; testcaseId: string; token?: string; }) => {
            const project = process.env.AZURE_PROJECT;
            if (!project) {
                throw new Error("Missing Azure DevOps project. Set AZURE_PROJECT.");
            }
            const { webApi, orgUrl } = await connectToAdoDirect({ token });
            const witApi = await webApi.getWorkItemTrackingApi();

            const workItemType = process.env.AZURE_DEFECT_WORK_ITEM_TYPE ?? "Bug";
            const document: JsonPatchOperation[] = [
                { op: 0, path: "/fields/System.Title", value: defectTitle },
                { op: 0, path: "/fields/System.Description", value: `Linked to testcase: ${testcaseId}` },
            ];

            const defect = await witApi.createWorkItem(undefined, document, project, workItemType);
            if (!defect.id) {
                throw new Error("Defect creation failed: no work item id returned.");
            }

            await linkWorkItems(witApi, orgUrl, project, defect.id, Number(testcaseId), "relates-to");

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                status: "created",
                                defectId: String(defect.id),
                                linkedTestcaseId: String(testcaseId),
                                title: defectTitle,
                                note: "Legacy alias. Prefer ado_create_defect.",
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

function resolvePath(p: string): string {
    if (path.isAbsolute(p)) return p;
    return path.resolve(process.cwd(), p);
}

function extractTestCasesFromFeatureText(featureText: string): {
    featureName: string;
    testCases: Array<{ title: string; steps: string[]; descriptionHtml: string }>;
} {
    const lines = featureText.split(/\r?\n/);

    const featureName = (lines.find(l => /^\s*Feature:/i.test(l)) ?? "Feature").replace(/^\s*Feature:\s*/i, "").trim();

    const testCases: Array<{ title: string; steps: string[]; descriptionHtml: string }> = [];
    let currentScenario: string | undefined;
    let currentSteps: string[] = [];

    const flush = () => {
        if (!currentScenario) return;
        const title = `${featureName}: ${currentScenario}`;
        const descriptionHtml = `<p><b>Feature:</b> ${escapeHtml(featureName)}</p><p><b>Scenario:</b> ${escapeHtml(currentScenario)}</p>`;
        testCases.push({ title, steps: currentSteps, descriptionHtml });
        currentScenario = undefined;
        currentSteps = [];
    };

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        const scenarioMatch = line.match(/^(Scenario Outline|Scenario):\s*(.+)$/i);
        if (scenarioMatch) {
            flush();
            currentScenario = scenarioMatch[2].trim();
            continue;
        }

        if (/^(Given|When|Then|And|But)\b/i.test(line)) {
            currentSteps.push(line);
            continue;
        }
    }

    flush();
    return { featureName, testCases };
}

function buildAdoSteps(gherkinSteps: string[]): string {
    let id = 1;
    const last = gherkinSteps.length;

    const xml = gherkinSteps
        .map(step => `
    <step id="${id++}" type="ActionStep">
      <parameterizedString>${escapeXml(step)}</parameterizedString>
      <parameterizedString></parameterizedString>
    </step>
  `)
        .join("");

    return `<steps id="0" last="${last}">${xml}</steps>`;
}

function escapeXml(text: string) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtml(text: string) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;");
}

async function createWorkItemWithRetry(
    witApi: any,
    project: string,
    workItemType: string,
    document: JsonPatchOperation[]
) {
    try {
        return await witApi.createWorkItem(undefined, document, project, workItemType);
    } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (msg.includes("Microsoft.VSTS.Common.Severity") || msg.includes("Severity")) {
            const withoutSeverity = document.filter(op => op.path !== "/fields/Microsoft.VSTS.Common.Severity");
            return await witApi.createWorkItem(undefined, withoutSeverity, project, workItemType);
        }
        throw err;
    }
}

async function linkWorkItems(
    witApi: any,
    orgUrl: string,
    project: string,
    sourceId: number,
    targetId: number,
    linkType: "tests" | "relates-to" | "parent-child"
) {
    const base = orgUrl.replace(/\/+$/, "");
    const targetUrl = `${base}/${encodeURIComponent(project)}/_apis/wit/workItems/${targetId}`;

    const tryRels: string[] = (() => {
        switch (linkType) {
            case "parent-child":
                return ["System.LinkTypes.Hierarchy-Forward"];
            case "tests": {
                const preferred = process.env.AZURE_TEST_RELATION;
                return [
                    ...(preferred ? [preferred] : []),
                    "Microsoft.VSTS.Common.TestedBy",
                    "Microsoft.VSTS.Common.TestedBy-Reverse",
                ];
            }
            case "relates-to":
            default:
                return ["System.LinkTypes.Related"];
        }
    })();

    let lastError: unknown;
    for (const rel of tryRels) {
        const document: JsonPatchOperation[] = [
            {
                op: 0,
                path: "/relations/-",
                value: {
                    rel,
                    url: targetUrl,
                    attributes: { comment: "Linked by qa-agent-mcp" },
                },
            },
        ];
        try {
            await witApi.updateWorkItem(undefined, document, sourceId, project);
            return;
        } catch (err) {
            lastError = err;
        }
    }

    if (linkType === "tests") {
        const fallback: JsonPatchOperation[] = [
            {
                op: 0,
                path: "/relations/-",
                value: {
                    rel: "System.LinkTypes.Related",
                    url: targetUrl,
                    attributes: { comment: "Linked by qa-agent-mcp (fallback)" },
                },
            },
        ];
        await witApi.updateWorkItem(undefined, fallback, sourceId, project);
        return;
    }

    throw lastError;
}

function envAny(names: string[]): string | undefined {
    for (const n of names) {
        const v = process.env[n];
        if (v && v.trim()) return v.trim();
    }
    return undefined;
}

async function connectToAdoDirect(opts: { adoOrg?: string; token?: string }) {
    const orgUrl = opts.adoOrg
        ?? envAny(["AZURE_DEVOPS_ORG_URL", "AZURE_ORG_URL", "ADO_ORG_URL", "AZURE_ORG", "ADO_ORG"]);
    if (!orgUrl) {
        throw new Error(
            "Missing Azure DevOps org URL. Set AZURE_DEVOPS_ORG_URL (or AZURE_ORG_URL/ADO_ORG_URL) or pass adoOrg."
        );
    }

    const token = opts.token
        ?? envAny(["AZURE_DEVOPS_TOKEN", "AZURE_TOKEN", "ADO_TOKEN", "AZURE_PAT", "ADO_PAT"]);
    if (!token) {
        throw new Error(
            "Missing Azure DevOps PAT. Set AZURE_DEVOPS_TOKEN (or AZURE_TOKEN/ADO_TOKEN/AZURE_PAT)."
        );
    }

    const handler = getPersonalAccessTokenHandler(token);
    const webApi = new WebApi(orgUrl, handler);
    return { webApi, orgUrl };
}
