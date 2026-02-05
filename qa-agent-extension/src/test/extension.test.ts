import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";

suite("QA Agent Extension Test Suite", () => {
	vscode.window.showInformationMessage("Start all tests.");

	test("qaAgent.cliPath setting is defined", () => {
		const config = vscode.workspace.getConfiguration("qaAgent");
		const cliRelativePath = config.get<string>("cliPath");

		assert.ok(
			cliRelativePath,
			"Expected qaAgent.cliPath to be defined"
		);
	});

	test("qaAgent.cliPath resolves to a valid path", () => {
		const config = vscode.workspace.getConfiguration("qaAgent");
		const cliRelativePath = config.get<string>("cliPath");

		assert.ok(cliRelativePath, "cliPath is undefined");

		const workspaceRoot =
			vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

		assert.ok(workspaceRoot, "No workspace folder is open");

		const cliPath = path.join(workspaceRoot, cliRelativePath!);

		assert.ok(
			cliPath.endsWith(".ts"),
			"Expected cliPath to point to a TypeScript file"
		);
	});

	test("Sample sanity test", () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});
