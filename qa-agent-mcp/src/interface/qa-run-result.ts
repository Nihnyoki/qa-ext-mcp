export type QaRunResult = {
    status: "PASS" | "FAIL";

    run: {
        runner: "cucumber" | "wdio";
        env: string;
        opco?: string;
        tags?: string;
        feature?: string;
        logFile: string;
        exitCode: number;
    };

    summary: {
        totalScenarios: number;
        failedScenarios: number;
        topErrors: string[];
    };

    defectCandidate?: {
        title: string;
        description: string;
        severity: "High" | "Medium" | "Low";
        evidenceLog: string;
    };

    nextActions: string[];
};
