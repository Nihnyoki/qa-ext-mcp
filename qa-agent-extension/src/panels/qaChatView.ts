import * as vscode from "vscode";
import { connectMcp, ensureRunnerReady } from "../mcpClient";
import { parseRunCommand } from "../nlp/parseRunCommand";

export class QaAiChatViewProvider implements vscode.WebviewViewProvider {

  // ✅ This must match the "id" in package.json
  public static readonly viewType = "qa-agent.sidebarView";

  constructor(private readonly context: vscode.ExtensionContext) { }

  private lastRunLogFile: string | undefined;
  private pendingConfirmation:
    | {
      toolName: string;
      args: any;
      reason: string;
    }
    | undefined;

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg: any) => {
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "init") {
        await this.handleInit(webviewView.webview);
        return;
      }

      if (msg.type === "auto") {
        const prompt = String(msg.prompt ?? "").trim();
        if (!prompt) return;
        await this.handleAutoPrompt(webviewView.webview, prompt);
        return;
      }

      if (msg.type === "runTool") {
        const toolName = String(msg.toolName ?? "").trim();
        const argsText = String(msg.argsText ?? "{}");
        if (!toolName) return;
        await this.handleRunTool(webviewView.webview, toolName, argsText);
        return;
      }
    });
  }

  private async handleInit(webview: vscode.Webview) {
    webview.postMessage({ type: "append", role: "assistant", text: "Loading operations…" });

    let client: any;
    try {
      client = await connectMcp(this.context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      webview.postMessage({ type: "append", role: "assistant", text: `MCP connection failed:\n${message}` });
      return;
    }

    try {
      const listed = await client.listTools();
      const tools = Array.isArray(listed?.tools) ? listed.tools : [];

      webview.postMessage({
        type: "tools",
        tools: tools.map((t: any) => ({
          name: t?.name,
          description: t?.description,
          inputSchema: t?.inputSchema ?? null,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      webview.postMessage({ type: "append", role: "assistant", text: `Failed to load operations:\n${message}` });
    }
  }

  private async handleAutoPrompt(webview: vscode.Webview, prompt: string) {
    webview.postMessage({ type: "append", role: "user", text: prompt });

    let client: any;
    try {
      client = await connectMcp(this.context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      webview.postMessage({ type: "append", role: "assistant", text: `MCP connection failed:\n${message}` });
      return;
    }

    const upper = prompt.toUpperCase();

    // Confirmation flow for ADO operations
    if (upper === "CONFIRM" || upper === "YES" || upper === "Y") {
      if (!this.pendingConfirmation) {
        webview.postMessage({ type: "append", role: "assistant", text: "Nothing pending confirmation." });
        return;
      }

      const pending = this.pendingConfirmation;
      this.pendingConfirmation = undefined;

      webview.postMessage({
        type: "append",
        role: "assistant",
        text: "Confirmed. Running: " + pending.toolName + "\nArgs: " + JSON.stringify(pending.args, null, 2),
      });

      try {
        const result = await client.callTool({ name: pending.toolName, arguments: pending.args });
        webview.postMessage({ type: "append", role: "assistant", text: formatMcpResult(result) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: "append", role: "assistant", text: `Tool call failed:\n${message}` });
      }
      return;
    }

    if (upper === "CANCEL" || upper === "NO") {
      this.pendingConfirmation = undefined;
      webview.postMessage({ type: "append", role: "assistant", text: "Cancelled." });
      return;
    }

    // Tool selection heuristics
    let toolName: string | undefined;
    let args: any = {};
    let reason = "";

    if (upper.includes("LIST") && upper.includes("TOOL")) {
      try {
        const listed = await client.listTools();
        const names = (listed?.tools ?? []).map((t: any) => t?.name).filter(Boolean);
        webview.postMessage({ type: "append", role: "assistant", text: "Available tools:\n" + names.map((n: string) => "- " + n).join("\n") });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: "append", role: "assistant", text: `Failed to list tools:\n${message}` });
      }
      return;
    }

    const runReq = parseRunCommand(prompt);
    if (runReq) {
      toolName = "run_dynamic_tests";
      args = {
        runner: runReq.runner,
        env: runReq.env,
        opco: runReq.opco,
        platform: runReq.platform,
        tags: runReq.tags,
      };
      reason = "Detected a run request (runner/env/tags/opco) from your prompt.";

      try {
        await ensureRunnerReady(this.context, runReq.runner);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: "append", role: "assistant", text: `Prep step failed:\n${message}` });
        return;
      }
    } else if (upper.includes("SUMMAR") || upper.includes("LOG")) {
      toolName = "summarize_test_log";
      const logFromPrompt = extractLogPath(prompt);
      const logFile = logFromPrompt ?? this.lastRunLogFile;
      if (!logFile) {
        webview.postMessage({
          type: "append",
          role: "assistant",
          text: "To summarize, provide a log file path (e.g. `/path/to/run_....log`) or run tests first so I can reuse the last run log.",
        });
        return;
      }
      args = { logFile };
      reason = logFromPrompt
        ? "Detected a log path in your prompt."
        : "No log path provided; using the last run’s log file.";
    } else if (isAdoIntent(upper)) {
      const intent = detectAdoIntent(upper);
      const inferred = buildAdoArgsFromPrompt(prompt);

      if (intent === "ado_create_testcase") {
        toolName = "ado_create_testcase";

        const featurePath = inferred.featurePath ?? tryGetActiveFeaturePath();
        const storyId = inferred.storyId;
        if (!featurePath || !storyId) {
          webview.postMessage({
            type: "append",
            role: "assistant",
            text:
              "To create a test case, provide a story id and a feature file path.\n\nExamples:\n- `create ado testcase story 94803 from /abs/path/story-94803.feature`\n- open a `.feature` file and type: `create ado testcase story 94803`",
          });
          return;
        }

        args = {
          featurePath,
          storyId,
          adoOrg: inferred.adoOrg,
          adoProject: inferred.adoProject,
        };
        reason = "Detected an ADO testcase creation request.";
      }

      if (intent === "ado_create_defect") {
        toolName = "ado_create_defect";
        const title = inferred.title ?? "Automation failure";
        args = {
          title,
          description: inferred.description,
          severity: inferred.severity ?? "High",
          linkedTestcaseId: inferred.linkedTestcaseId,
          adoOrg: inferred.adoOrg,
          adoProject: inferred.adoProject,
        };
        reason = "Detected an ADO defect creation request.";
      }

      if (intent === "ado_link_items") {
        toolName = "ado_link_items";
        const sourceId = inferred.sourceId;
        const targetId = inferred.targetId;
        const linkType = inferred.linkType ?? "relates-to";

        if (!sourceId || !targetId) {
          webview.postMessage({
            type: "append",
            role: "assistant",
            text:
              "To link items, provide two ids. Example: `link ado 12345 to 67890 relates-to` (or `tests`, `parent-child`).",
          });
          return;
        }

        args = { sourceId, targetId, linkType };
        reason = "Detected an ADO link request.";
      }

      if (!toolName) {
        webview.postMessage({
          type: "append",
          role: "assistant",
          text: "I detected an ADO intent but couldn't decide which operation. Try: `create ado testcase ...`, `create ado defect ...`, or `link ado ...`.",
        });
        return;
      }

      // Require confirmation
      this.pendingConfirmation = { toolName, args, reason };
      webview.postMessage({
        type: "append",
        role: "assistant",
        text:
          "Selected tool: " +
          toolName +
          "\nReason: " +
          reason +
          "\nArgs: " +
          JSON.stringify(args, null, 2) +
          "\n\nThis will perform an ADO operation. Type `confirm` to proceed, or `cancel`.",
      });
      return;
    } else {
      webview.postMessage({
        type: "append",
        role: "assistant",
        text:
          "I can auto-run these intents right now:\n- `run api smoke uat gha`\n- `summarize /path/to/run.log`\n- `list tools`\n\nOr pick an operation from the dropdown and paste JSON args.",
      });
      return;
    }

    webview.postMessage({
      type: "append",
      role: "assistant",
      text: "Selected tool: " + toolName + "\nReason: " + reason + "\nArgs: " + JSON.stringify(args, null, 2),
    });

    try {
      const result = await client.callTool({ name: toolName, arguments: args });

      // Remember last run log file if present
      const parsed = tryParseFirstTextJson(result);
      const logFile = parsed?.run?.logFile ?? parsed?.logFile;
      if (typeof logFile === "string" && logFile.length > 0) {
        this.lastRunLogFile = logFile;
      }

      webview.postMessage({ type: "append", role: "assistant", text: formatMcpResult(result) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      webview.postMessage({ type: "append", role: "assistant", text: `Tool call failed:\n${message}` });
    }
  }

  private async handleRunTool(webview: vscode.Webview, toolName: string, argsText: string) {
    webview.postMessage({ type: "append", role: "user", text: `Run: ${toolName}` });

    let args: any = {};
    try {
      args = argsText?.trim() ? JSON.parse(argsText) : {};
    } catch {
      webview.postMessage({ type: "append", role: "assistant", text: "Invalid JSON in arguments." });
      return;
    }

    webview.postMessage({ type: "append", role: "assistant", text: "Working…" });

    let client: any;
    try {
      client = await connectMcp(this.context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      webview.postMessage({ type: "append", role: "assistant", text: `MCP connection failed:\n${message}` });
      return;
    }

    try {
      const result = await client.callTool({ name: toolName, arguments: args });
      webview.postMessage({ type: "append", role: "assistant", text: formatMcpResult(result) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      webview.postMessage({ type: "append", role: "assistant", text: `Tool call failed:\n${message}` });
    }
  }

  private getHtml(webview: vscode.Webview) {
    const nonce = getNonce();

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>QA Agent</title>
        <style>
          body { font-family: var(--vscode-font-family); padding: 10px; }
          .row { display: flex; gap: 8px; }
          input[type=text] { flex: 1; padding: 6px; }
          button { padding: 6px 10px; }
          .quick { margin: 8px 0; display: flex; gap: 8px; flex-wrap: wrap; }
          .log { margin-top: 10px; height: 360px; overflow: auto; border: 1px solid var(--vscode-editorWidget-border); padding: 8px; }
          .msg { white-space: pre-wrap; margin-bottom: 8px; }
          .user { color: var(--vscode-editor-foreground); font-weight: 600; }
          .assistant { color: var(--vscode-editor-foreground); }
          .muted { opacity: 0.85; }
        </style>
      </head>
      <body style="font-family: sans-serif; padding: 16px;">
        <h3>QA Agent – Operations</h3>

        <label for="prompt">Prompt</label>
        <div class="row" style="margin-bottom:8px;">
          <input id="prompt" type="text" placeholder="run api smoke uat gha | summarize /path/to/run.log | list tools" />
          <button id="auto">Auto</button>
        </div>

        <label for="toolSelect">Operation</label>
        <div class="row" style="margin-bottom:8px;">
          <select id="toolSelect" style="flex:1; padding:6px;"></select>
          <button id="run">Run</button>
        </div>

        <label for="args">Arguments (JSON)</label>
        <textarea id="args" rows="7" style="width:100%; padding:8px; box-sizing:border-box; font-family: var(--vscode-editor-font-family);"></textarea>

        <div class="quick">
          <button id="reload">Reload operations</button>
          <button id="clear">Clear output</button>
        </div>

        <div id="log" class="log" aria-label="QA Agent output"></div>

        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          const promptEl = document.getElementById('prompt');
          const autoBtn = document.getElementById('auto');
          const toolSelect = document.getElementById('toolSelect');
          const runBtn = document.getElementById('run');
          const argsEl = document.getElementById('args');
          const logEl = document.getElementById('log');
          const reloadBtn = document.getElementById('reload');
          const clearBtn = document.getElementById('clear');

          let catalogTools = [];

          function append(role, text) {
            const div = document.createElement('div');
            div.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');
            const label = role === 'user' ? 'You: ' : 'QA: ';
            div.textContent = label + (text ?? '');
            logEl.appendChild(div);
            logEl.scrollTop = logEl.scrollHeight;
          }

          function setArgsTemplate(toolName) {
            const tool = catalogTools.find(t => t.name === toolName);
            const inputs = (tool && tool.inputs) ? tool.inputs : {};

            const template = {};
            for (const key of Object.keys(inputs)) {
              template[key] = '';
            }

            // small sane defaults for common tools
            if (toolName === 'run_dynamic_tests') {
              template.runner = template.runner || 'cucumber';
              template.env = template.env || 'UAT';
              template.tags = template.tags || '@api and @smoke and @GHA';
            }

            argsEl.value = JSON.stringify(template, null, 2);
          }

          function populateTools(tools) {
            catalogTools = Array.isArray(tools) ? tools.filter(t => t && t.name) : [];
            toolSelect.textContent = '';
            for (const t of catalogTools) {
              const opt = document.createElement('option');
              opt.value = t.name;
              opt.textContent = t.name;
              toolSelect.appendChild(opt);
            }

            if (catalogTools.length > 0) {
              toolSelect.value = catalogTools[0].name;
              setArgsTemplate(toolSelect.value);
            } else {
              const opt = document.createElement('option');
              opt.value = '';
              opt.textContent = '(no operations found)';
              toolSelect.appendChild(opt);
              argsEl.value = '{}';
            }
          }

          runBtn.addEventListener('click', () => {
            const toolName = toolSelect.value;
            if (!toolName) return;
            vscode.postMessage({ type: 'runTool', toolName, argsText: argsEl.value });
          });

          autoBtn.addEventListener('click', () => {
            const t = (promptEl.value || '').trim();
            if (!t) return;
            vscode.postMessage({ type: 'auto', prompt: t });
            promptEl.value = '';
            promptEl.focus();
          });

          promptEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              autoBtn.click();
            }
          });

          toolSelect.addEventListener('change', () => {
            if (toolSelect.value) setArgsTemplate(toolSelect.value);
          });

          reloadBtn.addEventListener('click', () => vscode.postMessage({ type: 'init' }));
          clearBtn.addEventListener('click', () => { logEl.textContent = ''; });

          window.addEventListener('message', (event) => {
            const msg = event.data;
            if (!msg || typeof msg.type !== 'string') return;
            if (msg.type === 'append') {
              append(msg.role, msg.text);
            }
            if (msg.type === 'tools') {
              const tools = Array.isArray(msg.tools) ? msg.tools : [];
              populateTools(tools);
              append('assistant', 'Loaded ' + tools.length + ' operation(s).');
            }
          });

          // load tools on startup
          argsEl.value = '{}';
          vscode.postMessage({ type: 'init' });
        </script>
      </body>
      </html>
    `;
  }
}

function formatMcpResult(result: any): string {
  const content = result?.content;
  if (!Array.isArray(content) || content.length === 0) return "(No content returned)";

  const parts: string[] = [];
  for (const item of content) {
    if (!item) continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
      continue;
    }
    parts.push(JSON.stringify(item, null, 2));
  }
  return parts.join("\n\n");
}

function extractLogPath(prompt: string): string | undefined {
  // basic: pick first token that looks like a log file path
  const m = prompt.match(/(\/[^\s]+\.log)/i);
  return m?.[1];
}

function isAdoIntent(upperPrompt: string): boolean {
  return upperPrompt.includes("ADO") || upperPrompt.includes("DEVOPS") || upperPrompt.includes("TESTCASE") || upperPrompt.includes("DEFECT") || upperPrompt.includes("BUG") || upperPrompt.includes("LINK");
}

function detectAdoIntent(upperPrompt: string): "ado_create_testcase" | "ado_create_defect" | "ado_link_items" {
  if (upperPrompt.includes("LINK")) return "ado_link_items";
  if (upperPrompt.includes("TESTCASE") || upperPrompt.includes("TEST CASE")) return "ado_create_testcase";
  return "ado_create_defect";
}

function tryGetActiveFeaturePath(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  const fsPath = editor?.document?.uri?.fsPath;
  if (!fsPath) return undefined;
  if (fsPath.toLowerCase().endsWith(".feature")) return fsPath;
  return undefined;
}

function buildAdoArgsFromPrompt(prompt: string): {
  featurePath?: string;
  storyId?: string;
  title?: string;
  description?: string;
  severity?: "Low" | "Medium" | "High";
  linkedTestcaseId?: string;
  adoOrg?: string;
  adoProject?: string;
  sourceId?: string;
  targetId?: string;
  linkType?: "tests" | "relates-to" | "parent-child";
} {
  const out: any = {};

  const feature = prompt.match(/(\/[^\s]+\.feature)/i)?.[1] ?? prompt.match(/([\w./-]+\.feature)/i)?.[1];
  if (feature) out.featurePath = feature;

  const story = prompt.match(/STORY\s*#?\s*(\d+)/i)?.[1] ?? prompt.match(/\b(\d{4,})\b/)?.[1];
  if (story) out.storyId = String(story);

  const tc = prompt.match(/TC[- ]?(\d+)/i)?.[0] ?? prompt.match(/TESTCASE\s*#?\s*(\d+)/i)?.[1];
  if (tc) out.linkedTestcaseId = String(tc);

  const severity = prompt.match(/\b(LOW|MEDIUM|HIGH)\b/i)?.[1];
  if (severity) out.severity = severity[0].toUpperCase() + severity.slice(1).toLowerCase();

  const title = prompt.match(/TITLE\s*:\s*(.+)$/i)?.[1];
  if (title) out.title = title.trim();

  const desc = prompt.match(/DESC\s*:\s*(.+)$/i)?.[1];
  if (desc) out.description = desc.trim();

  const org = prompt.match(/ORG\s*:\s*([^\s]+)/i)?.[1];
  if (org) out.adoOrg = org;

  const proj = prompt.match(/PROJECT\s*:\s*([^\s]+)/i)?.[1];
  if (proj) out.adoProject = proj;

  const ids = [...prompt.matchAll(/\b(\d{3,})\b/g)].map(m => m[1]);
  if (ids.length >= 2) {
    out.sourceId = ids[0];
    out.targetId = ids[1];
  }

  if (prompt.toLowerCase().includes("parent")) out.linkType = "parent-child";
  else if (prompt.toLowerCase().includes("test")) out.linkType = "tests";
  else if (prompt.toLowerCase().includes("relates")) out.linkType = "relates-to";

  return out;
}

function tryParseFirstTextJson(result: any): any | undefined {
  const content = result?.content;
  const first = Array.isArray(content) ? content[0] : undefined;
  const text = first && first.type === "text" ? first.text : undefined;
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}