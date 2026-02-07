import * as vscode from "vscode";
import { spawn } from "child_process";
import * as path from "path";
import { connectMcp, ensureRunnerReady } from "./mcpClient";
import { parseRunCommand } from "./nlp/parseRunCommand";
import { QaAiChatViewProvider } from "./panels/qaChatView";

let mcpClient: any;

/**
 * Session state for the chat agent
 */
const agentState: {
  awaitingDefectConfirmation: boolean;
  defectCandidate?: any;
} = {
  awaitingDefectConfirmation: false,
};

export function activate(context: vscode.ExtensionContext) {
  vscode.window.showInformationMessage("🔥 QA Agent Activated!");
  console.log("🔥 QA Agent Activated!");

const provider = new QaAiChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      QaAiChatViewProvider.viewType,
      provider
    )
  );

  console.log(`✅ QA Agent View Provider Registered: ${JSON.stringify(provider)}`);

  context.subscriptions.push(
    vscode.commands.registerCommand("qa-agent.generateFromStory", () => {
      QAGeneratorPanel.createOrShow(context);
    })
  );
  
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ) => {
    stream.markdown("🧪 **QA Agent Online**\n\n");

    let client: any;
    try {
      client = await connectMcp(context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`❌ MCP connection failed:\n\n${escapeMarkdown(msg)}\n\n`);
      stream.markdown("Tip: run the VS Code debug config once; it now builds `qa-agent-mcp/dist` automatically.\n");
      return;
    }

    const prompt = request.prompt?.trim() ?? "";
    if (!prompt) {
      stream.markdown("Say something like: `run api smoke uat gha` or `list tools`.\n");
      return;
    }

    // Simple routing -> MCP tools
    const upper = prompt.toUpperCase();

    try {
      if (upper.includes("TOOL") || upper.includes("CATALOG") || upper.includes("LIST")) {
        const result = await client.callTool({
          name: "get_tool_catalog",
          arguments: {},
        });
        renderMcpResult(stream, result);
        return;
      }

      const runReq = parseRunCommand(prompt);
      if (runReq) {
        stream.markdown(
          `Running **${runReq.runner}** tests (env: **${runReq.env}**${runReq.opco ? `, opco: **${runReq.opco}**` : ""})...\n\n`
        );

        try {
          await ensureRunnerReady(context, runReq.runner);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          stream.markdown(`❌ Prep step failed:\n\n${escapeMarkdown(msg)}\n\n`);
          return;
        }

        const result = await client.callTool({
          name: "run_dynamic_tests",
          arguments: {
            runner: runReq.runner,
            env: runReq.env,
            opco: runReq.opco,
            platform: runReq.platform,
            tags: runReq.tags,
          },
        });
        renderMcpResult(stream, result);
        return;
      }

      stream.markdown("I can currently:\n\n- `list tools`\n- `run ...` (e.g. `run api smoke uat gha`)\n\nIf you want a new intent wired up, tell me the phrasing + tool to call.\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`❌ MCP tool call failed:\n\n${escapeMarkdown(msg)}\n`);
    }
  };

  const qaAgent = vscode.chat.createChatParticipant(
    "internal.qa-agent.qa-agent",
    handler
  );

  qaAgent.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "media",
    "qa-icon.png"
  );

  context.subscriptions.push(qaAgent);
  
}

function renderMcpResult(stream: vscode.ChatResponseStream, result: any) {
  const content = result?.content;
  if (!Array.isArray(content) || content.length === 0) {
    stream.markdown("(No content returned)\n");
    return;
  }

  for (const item of content) {
    if (!item) continue;

    if (item.type === "text" && typeof item.text === "string") {
      stream.markdown(`${item.text}\n\n`);
      continue;
    }

    if (item.type === "json") {
      const json = item.json ?? {};
      stream.markdown("```json\n" + JSON.stringify(json, null, 2) + "\n```\n\n");
      continue;
    }

    // Fallback
    stream.markdown("```\n" + JSON.stringify(item, null, 2) + "\n```\n\n");
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}\[\]()#+\-.!]/g, "\\$&");
}

class QAGeneratorPanel {
  public static currentPanel: QAGeneratorPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  static createOrShow(context: vscode.ExtensionContext) {
    if (this.currentPanel) {
      this.currentPanel.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "qa-agent.panel",
      "QA Agent – AI Generator",
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    this.currentPanel = new QAGeneratorPanel(panel);
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    panel.webview.html = getWebviewHtml();

    panel.webview.onDidReceiveMessage(msg => {
      if (msg.type === "generate") this.runCli(msg.payload);
    });

    panel.onDidDispose(() => {
      QAGeneratorPanel.currentPanel = undefined;
    });
  }

  private runCli(payload: any) {
    const { storyId, opcos, targetPath, featurePath, stepContextPath, testType, operation, testPlanId, testSuiteId, agent } = payload;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return vscode.window.showErrorMessage("No workspace open.");

    const cliRel = vscode.workspace.getConfiguration("qa-agent").get<string>("cliPath");
    if (!cliRel) return vscode.window.showErrorMessage("qa-agent.cliPath not configured.");

    const cliPath = path.join(workspaceRoot, cliRel);

    const args = [
      cliPath,
      `--operation=${operation}`
    ];

    if (opcos?.length && operation !== "publishToADO") {
      args.push(`--opcos=${opcos.join(",")}`);
    }


    if (storyId) args.push(`--storyId=${storyId}`);
    if (targetPath) args.push(`--targetPath=${targetPath}`);
    if (featurePath) args.push(`--featurePath=${featurePath}`);
    if (testType) args.push(`--testType=${testType}`);
    if (stepContextPath) args.push(`--stepContextPath=${stepContextPath}`);
    if (testPlanId) args.push(`--testPlanId=${testPlanId}`);
    if (testSuiteId) args.push(`--testSuiteId=${testSuiteId}`);
    if (agent) args.push(`--agent=${agent}`);

    this.postLog(`▶ Running CLI:\n${args.join(" ")}\n`);

    const proc = spawn("npx", ["ts-node", ...args], {
      cwd: workspaceRoot,
      shell: false
    });

    proc.stdout.on("data", d => this.postLog(d.toString()));
    proc.stderr.on("data", d => this.postLog(`❌ ${d.toString()}`));
    proc.on("close", code => {
      this.postLog(
        code === 0
          ? "\n✅ Operation complete\n"
          : `\n❌ CLI exited with ${code}\n`
      );

      this.panel.webview.postMessage({ type: "done" });
    });


    proc.on("error", err => this.postLog(`❌ Spawn error: ${err.message}\n`));

  }


  private postLog(message: string) {
    this.panel.webview.postMessage({ type: "log", message });
  }
}


function getWebviewHtml(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>QA Agent</title>
<style>
body { font-family: var(--vscode-font-family); padding:16px }
input, select { width:100%; margin-bottom:8px }
.opcos { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px }
button { margin-top:12px }
.hidden { display:none }
pre {
  height:220px;
  overflow:auto;
  background:#4e4e4e;
  padding:8px;
  color:#FFFFFF;
}
label { display:block; margin-top:6px }
</style>
</head>
<body>

<h2>QA Agent – BDD Generator</h2>

<label>Operation
<select id="operation">
  <option value="generateFeatureFile">Generate Feature File</option>
  <option value="generateScripts">Generate Script</option>
  <option value="publishToADO">Publish To ADO</option>
</select>
</label>

<div id="featureGenFields">
  <label>Story ID
    <input id="storyId" placeholder="94803"/>
  </label>

  <label>Target Path (Features Folder)
    <input id="targetPath" placeholder="setup/bdd/api/mars_momo/src/tests/GHA/features"/>
  </label>

  <label>Test Type
    <select id="featureTestType">
      <option value="API">API</option>
      <option value="UI">UI</option>
    </select>
  </label>

<label>OpCos</label>
<div class="opcos">
  <label><input type="checkbox" value="CMR"/>CMR</label>
  <label><input type="checkbox" value="CIV"/>CIV</label>
  <label><input type="checkbox" value="GHA"/>GHA</label>
  <label><input type="checkbox" value="UGN"/>UGN</label>
  <label><input type="checkbox" value="ZMB"/>ZMB</label>
</div>

</div>

<div id="scriptGenFields" class="hidden">
  <label>Feature File Path
    <input id="featurePath" placeholder=".../features/story-94803.feature"/>
  </label>

  <label>Target Path (Steps Folder)
    <input id="scriptTargetPath" placeholder=".../steps"/>
  </label>

<label>OpCos</label>
<div class="opcos">
  <label><input type="checkbox" value="CMR"/>CMR</label>
  <label><input type="checkbox" value="CIV"/>CIV</label>
  <label><input type="checkbox" value="GHA"/>GHA</label>
  <label><input type="checkbox" value="UGN"/>UGN</label>
  <label><input type="checkbox" value="ZMB"/>ZMB</label>
</div>


</div>

<div id="publishFields" class="hidden">
  <label>Feature File Path
    <input id="publishFeaturePath" placeholder=".../features/story-94803.feature"/>
  </label>

  <label>Test Plan ID
    <input id="testPlanId" placeholder="88868"/>
  </label>

  <label>Test Suite ID
    <input id="testSuiteId" placeholder="117818"/>
  </label>

  <label>Test Type
    <select id="publishTestType">
      <option value="API">API</option>
      <option value="UI">UI</option>
    </select>
  </label>

</div>

<label>Step Context (Optional)
  <input id="stepContextPath" placeholder=".../steps/common"/>
</label>

<label>LLM Provider</label>
<select id="agent">
  <option value="ollama:deepseek-r1">Ollama – DeepSeek R1 (Local)</option>
  <option value="openai:gpt-4.1">OpenAI – GPT-4.1 (API)</option>
  <option value="openai:gpt-5.2-codex">OpenAI – GPT-5.2-Codex (API)</option>
</select>


<button id="submitBtn">Submit</button>

<pre id="log"></pre>

<script>
const vscode = acquireVsCodeApi();
const logEl = document.getElementById("log");

const getValue = (id) => {
  const el = document.getElementById(id);
  return el ? el.value.trim() : "";
};

const operationSelect = document.getElementById("operation");
const featureGenFields = document.getElementById("featureGenFields");
const scriptGenFields = document.getElementById("scriptGenFields");
const publishFields = document.getElementById("publishFields");

function updateVisibility() {
  const op = operationSelect.value;

  featureGenFields.classList.toggle("hidden", op !== "generateFeatureFile");
  scriptGenFields.classList.toggle("hidden", op !== "generateScripts");
  publishFields.classList.toggle("hidden", op !== "publishToADO");
}

function clearOpcos() {
  document.querySelectorAll(".opcos input").forEach(cb => cb.checked = false);
}

// 👇 THIS is the missing piece
operationSelect.addEventListener("change", () => {
  clearOpcos();
  updateVisibility();
});

// 👇 Ensure correct state on load
updateVisibility();

const btn = document.getElementById("submitBtn");

window.addEventListener("message", (event) => {
  const msg = event.data;

  if (msg.type === "log") {
    logEl.textContent += msg.message;
    logEl.scrollTop = logEl.scrollHeight;
  }

  if (msg.type === "done") {
    btn.disabled = false;
  }
});

document.getElementById("submitBtn").onclick = () => {

  btn.disabled = true;

  console.log("SubmitBtn clicked.")

  const operation = document.getElementById("operation").value;

  const opcos = [...document.querySelectorAll(".opcos input:checked")]
    .map(e => e.value);

  if (operation !== "publishToADO" && opcos.length === 0) {
    alert("Please select at least one OpCo.");
      console.log("Please select at least one OpCo.")
     btn.disabled = false;
    return;
  }

  const testType =
  operation === "publishToADO"
    ? getValue("publishTestType")
    : getValue("featureTestType");

      console.log("operation === publishToADO.")

  const payload = {
    operation,
    testType,
    stepContextPath: getValue("stepContextPath"),
    agent: document.getElementById("agent").value
  };

  if (operation === "generateFeatureFile") {
    payload.storyId = getValue("storyId");
    payload.targetPath = getValue("targetPath");
    payload.opcos = opcos;
  }

  if (operation === "generateScripts") {
    payload.featurePath = getValue("featurePath"); 
    payload.targetPath = getValue("scriptTargetPath");
    payload.opcos = opcos;
  }

  if (operation === "publishToADO") {
    payload.featurePath = getValue("publishFeaturePath");
    payload.testPlanId = getValue("testPlanId");
    payload.testSuiteId = getValue("testSuiteId");
  }

  vscode.postMessage({
    type: "generate",
    payload
  });
  
};
</script>

</body>
</html>
`;
}


