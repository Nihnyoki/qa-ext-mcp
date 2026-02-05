export type RunRequest = {
    runner: "cucumber" | "wdio";
    env: string;
    opco?: string;
    tags?: string;
    platform?: string;
};

const OPCOS = ["CIV", "GHA", "CMR", "UGA", "NGA"];
const ENVS = ["UAT", "SIT", "PROD"];
const PLATFORMS = ["API", "ANDROID", "IOS"];

export function parseRunCommand(prompt: string): RunRequest | null {
    const text = prompt.toUpperCase();

    // Must include "RUN"
    if (!text.includes("RUN")) return null;

    // Default values
    let env = "UAT";
    let runner: "cucumber" | "wdio" = "cucumber";

    // Extract ENV  
    for (const e of ENVS) {
        if (text.includes(e)) env = e;
    }

    // Extract OPCO
    let opco: string | undefined;
    for (const o of OPCOS) {
        if (text.includes(o)) opco = o;
    }

    // Extract Platform
    let platform: string | undefined;
    for (const p of PLATFORMS) {
        if (text.includes(p)) platform = p;
    }

    // Detect runner type
    if (text.includes("MOBILE") || text.includes("WDIO")) {
        runner = "wdio";
    }

    // Detect tags
    const tags: string[] = [];

    if (text.includes("MOMO")) tags.push("@momo");
    if (text.includes("API")) tags.push("@api");
    if (text.includes("SMOKE")) tags.push("@smoke");

    if (opco) tags.push(`@${opco}`);

    return {
        runner,
        env,
        opco,
        platform,
        tags: tags.length > 0 ? tags.join(" and ") : undefined,
    };
}
