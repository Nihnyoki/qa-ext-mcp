# QA Agent VS Code Extension

QA Agent is an internal VS Code extension that generates Cucumber BDD
feature files and step definitions from Azure DevOps user stories.

The extension acts as a UI launcher for a domain-aware QA CLI that:
- Fetches Azure DevOps user stories
- Generates Cucumber `.feature` files
- Generates WebdriverIO + Cucumber step definitions
- Supports multiple operating companies (OpCos)

## Features

- Generate BDD tests from Azure DevOps user stories
- Multi-OpCo support (CMR, CIV, GHA, UGN, ZMB, etc.)
- Configurable output paths
- Live execution logs inside VS Code
- Uses a local Ollama LLM (no cloud dependency)

## Requirements

- Node.js 18+
- Ollama running locally
- Access to Azure DevOps
- QA Agent CLI available in the workspace

## Extension Settings

This extension contributes the following setting:

## Rebuild & Repackage
npm run compile
npx vsce package

## Extension Install & Verify

code --install-extension qa-agent-0.0.1.vsix

- `qaAgent.cliPath`: Path to the QA Agent CLI entry point (`index.ts`)

Example:
```json
{
  "qaAgent.cliPath": "setup/ai/index.ts"
}
