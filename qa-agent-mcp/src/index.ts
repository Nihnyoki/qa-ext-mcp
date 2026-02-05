import "dotenv/config";
import { startStdio } from "./transports/stdio.js";
//import { startHttp } from "./transports/http.js";

const mode = process.env.MCP_MODE ?? "stdio";

if (mode === "http") {
    //startHttp(Number(process.env.PORT ?? 3333));
} else {
    startStdio();
}
