/*import express from "express";
import { buildQaAgentServer } from "../server.js";
//import { HttpServerTransport } from "@modelcontextprotocol/sdk/server/http.js";


export async function startHttp(port: number) {
    const app = express();
    app.use(express.json());

    const server = buildQaAgentServer();
    //const transport = new HttpServerTransport(app);

    //await server.connect(transport);

    app.listen(port, () => {
        console.log(`✅ QA Agent MCP running in HTTP mode on port ${port}`);
    });
}
*/