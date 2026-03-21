# VS Code Diff MCP Server

A Model Context Protocol (MCP) server that runs directly inside your Visual Studio Code. It empowers AI agents with advanced, state-of-the-art file editing capabilities while ensuring you stay in complete control of your codebase.

Instead of AI agents blindly overwriting files, this extension generates an interactive diff review panel inside VS Code, allowing you to explicitly Accept or Reject any changes proposed by the AI.

## Features

- **Interactive Diff Reviewer:** All AI-proposed edits are presented in a native VS Code split-screen diff view. You can review the changes before finalizing them.
- **Surgical Code Edits (`edit_block`):** The AI can search for a specific block of code and replace it.
- **Fuzzy Search Fallback:** If the exact string isn't found, the powerful Levenshtein fuzzy matching engine will find the closest match and guide the AI to correct its prompt automatically.
- **Live Diagnostics Feedback:** Once an edit is proposed, the extension automatically hooks into VS Code's language servers (TypeScript, ESLint, Python, etc.) and reports any syntax errors or warnings back to the AI immediately!
- **State Management:** Multiple edits to the same file are intelligently combined into a single pending diff.

## Installation

You can either install the pre-compiled VSIX or build from source.

### Option 1: Install from VSIX (Recommended)
1. Go to the [Actions tab](https://github.com/iiNothh/vscode-diff-mcp/actions) or the Repository Releases.
2. Download the latest `vscode-diff-mcp-vsix` artifact.
3. Open VS Code, press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac).
4. Type and select **Extensions: Install from VSIX...**
5. Select the `.vsix` file you just downloaded.
6. Reload VS Code.

### Option 2: Build from Source
1. Clone the repository: `git clone https://github.com/iiNothh/vscode-diff-mcp.git`
2. Run `npm install` to install dependencies.
3. Run `npm run compile` to build the typescript files.
4. Run `npx @vscode/vsce package` to create the VSIX file.
5. Install as mentioned in Option 1.

## Usage / Connecting the AI Agent

Once the extension is installed and VS Code is running, the MCP server automatically starts in the background and listens for SSE connections on port `6070`.

To connect your AI client (like Claude Desktop, Antigravity, or Cursor), add the following configuration to your MCP settings file (e.g., `mcp.json`):

```json
{
  "servers": {
    "vscode-diff-mcp": {
      "url": "http://127.0.0.1:6070/mcp"
    }
  }
}
```

The AI agent will then be equipped with the powerful `write_file` and `edit_block` tools seamlessly connected to your VS Code session.

## Contributing
Feel free to open Issues or Pull Requests if you find a bug or want to enhance the file-edit engine further.
