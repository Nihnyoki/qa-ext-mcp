import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export function getToolCatalogTool(server: any) {
    server.tool(
        "get_tool_catalog",
        {},
        async () => {
            const moduleDir = path.dirname(fileURLToPath(import.meta.url));

            const candidates = [
                // Preferred: copied alongside compiled JS (dist/tools/description/...)
                path.join(moduleDir, "description", "qa-agent.tools.json"),

                // Dev fallback when running from repo root
                path.resolve(process.cwd(), "qa-agent-mcp", "src", "tools", "description", "qa-agent.tools.json"),
                path.resolve(process.cwd(), "qa-agent-mcp", "dist", "tools", "description", "qa-agent.tools.json"),
            ];

            const filePath = candidates.find(p => fs.existsSync(p));
            if (!filePath) {
                throw new Error(
                    `Tool catalog JSON not found. Tried:\n- ${candidates.join("\n- ")}`
                );
            }

            const catalog = JSON.parse(fs.readFileSync(filePath, "utf-8"));

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(catalog, null, 2)
                    }
                ]
            };
        }
    );
}
