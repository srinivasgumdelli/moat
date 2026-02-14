#!/usr/bin/env node
// ide-lsp MCP server — code intelligence via persistent language servers
// Tools: lsp_hover, lsp_definition, lsp_references, lsp_diagnostics, lsp_symbols, lsp_workspace_symbols

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// --- JSON-RPC transport over stdio ---

class JsonRpcConnection {
  constructor(proc) {
    this.proc = proc;
    this.requestId = 0;
    this.pending = new Map();
    this.notifications = [];
    this.buffer = "";

    proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      this._processBuffer();
    });

    proc.stderr.on("data", (chunk) => {
      // Ignore stderr from language servers (debug/log output)
    });

    proc.on("exit", () => {
      for (const [, { reject }] of this.pending) {
        reject(new Error("Language server exited"));
      }
      this.pending.clear();
    });
  }

  _processBuffer() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const contentStart = headerEnd + 4;
      if (this.buffer.length < contentStart + contentLength) return;

      const body = this.buffer.slice(contentStart, contentStart + contentLength);
      this.buffer = this.buffer.slice(contentStart + contentLength);

      try {
        const msg = JSON.parse(body);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (!msg.id && msg.method) {
          // Notification from server
          this.notifications.push(msg);
        }
      } catch {}
    }
  }

  send(method, params) {
    const id = ++this.requestId;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    this.proc.stdin.write(frame);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP request timed out: ${method}`));
        }
      }, 30_000);
    });
  }

  notify(method, params) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    this.proc.stdin.write(frame);
  }

  kill() {
    try {
      this.proc.kill();
    } catch {}
  }
}

// --- Language server manager ---

const servers = new Map(); // language -> { conn, files, workspaceRoot }

const SERVER_COMMANDS = {
  typescript: ["typescript-language-server", ["--stdio"]],
  python: ["pyright-langserver", ["--stdio"]],
  go: ["gopls", ["serve"]],
};

const LANG_IDS = {
  typescript: "typescript",
  typescriptreact: "typescriptreact",
  javascript: "javascript",
  javascriptreact: "javascriptreact",
  python: "python",
  go: "go",
};

function getLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "typescript", // use TS server for JS too
    ".jsx": "typescript",
    ".py": "python",
    ".go": "go",
  };
  return map[ext];
}

function getLangId(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".py": "python",
    ".go": "go",
  };
  return map[ext] || "plaintext";
}

async function findWorkspaceRoot(filePath) {
  let dir = path.dirname(path.resolve(filePath));
  const markers = ["package.json", "tsconfig.json", "pyproject.toml", "go.mod", ".git"];
  for (let i = 0; i < 10; i++) {
    for (const m of markers) {
      try {
        await readFile(path.join(dir, m));
        return dir;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(path.resolve(filePath));
}

async function getServer(language, filePath) {
  if (servers.has(language)) return servers.get(language);

  const cmdSpec = SERVER_COMMANDS[language];
  if (!cmdSpec) throw new Error(`No language server for: ${language}`);

  const workspaceRoot = await findWorkspaceRoot(filePath);
  const [cmd, args] = cmdSpec;
  const proc = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const conn = new JsonRpcConnection(proc);

  // Initialize
  await conn.send("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(workspaceRoot).href,
    rootPath: workspaceRoot,
    capabilities: {
      textDocument: {
        hover: { contentFormat: ["plaintext", "markdown"] },
        definition: {},
        references: {},
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        publishDiagnostics: {},
      },
      workspace: {
        symbol: {},
        workspaceFolders: true,
      },
    },
    workspaceFolders: [
      { uri: pathToFileURL(workspaceRoot).href, name: path.basename(workspaceRoot) },
    ],
  });

  conn.notify("initialized", {});

  const entry = { conn, files: new Map(), workspaceRoot };
  servers.set(language, entry);
  return entry;
}

async function syncFile(serverEntry, filePath) {
  const { conn, files } = serverEntry;
  const absPath = path.resolve(filePath);
  const uri = pathToFileURL(absPath).href;
  const content = await readFile(absPath, "utf8");
  const langId = getLangId(filePath);

  if (!files.has(absPath)) {
    conn.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: langId, version: 1, text: content },
    });
    files.set(absPath, 1);
  } else {
    const version = files.get(absPath) + 1;
    files.set(absPath, version);
    conn.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    });
  }

  // Small delay for server to process
  await new Promise((r) => setTimeout(r, 200));
  return uri;
}

// --- Result formatters ---

function formatHover(result) {
  if (!result || !result.contents) return "No hover information available.";
  const contents = result.contents;
  if (typeof contents === "string") return contents;
  if (contents.value) return contents.value;
  if (Array.isArray(contents)) {
    return contents
      .map((c) => (typeof c === "string" ? c : c.value || ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return JSON.stringify(contents);
}

function formatLocation(loc) {
  if (!loc) return "No location found.";
  const locations = Array.isArray(loc) ? loc : [loc];
  if (locations.length === 0) return "No location found.";
  return locations
    .map((l) => {
      const uri = l.uri || l.targetUri;
      const range = l.range || l.targetSelectionRange || l.targetRange;
      const filePath = uri ? fileURLToPath(uri) : "unknown";
      const line = range ? range.start.line + 1 : "?";
      const col = range ? range.start.character + 1 : "?";
      return `${filePath}:${line}:${col}`;
    })
    .join("\n");
}

function formatReferences(refs) {
  if (!refs || refs.length === 0) return "No references found.";
  const lines = refs.map((r) => {
    const filePath = fileURLToPath(r.uri);
    const line = r.range.start.line + 1;
    const col = r.range.start.character + 1;
    return `${filePath}:${line}:${col}`;
  });
  return `Found ${refs.length} references:\n${lines.join("\n")}`;
}

function formatSymbols(symbols, filePath) {
  if (!symbols || symbols.length === 0) return "No symbols found.";

  function flattenSymbols(syms, indent = 0) {
    const lines = [];
    for (const s of syms) {
      const kind = symbolKindName(s.kind);
      const line = s.range ? s.range.start.line + 1 : s.location?.range?.start?.line + 1 || "?";
      const prefix = "  ".repeat(indent);
      const detail = s.detail ? ` — ${s.detail}` : "";
      lines.push(`${prefix}${kind} ${s.name}${detail} (line ${line})`);
      if (s.children) lines.push(...flattenSymbols(s.children, indent + 1));
    }
    return lines;
  }

  return flattenSymbols(symbols).join("\n");
}

function formatWorkspaceSymbols(symbols) {
  if (!symbols || symbols.length === 0) return "No symbols found.";
  return symbols
    .map((s) => {
      const kind = symbolKindName(s.kind);
      const loc = s.location;
      const filePath = loc?.uri ? fileURLToPath(loc.uri) : "unknown";
      const line = loc?.range?.start?.line + 1 || "?";
      return `${kind} ${s.name} — ${filePath}:${line}`;
    })
    .join("\n");
}

function symbolKindName(kind) {
  const names = {
    1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
    6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
    11: "Interface", 12: "Function", 13: "Variable", 14: "Constant",
    15: "String", 16: "Number", 17: "Boolean", 18: "Array", 19: "Object",
    20: "Key", 21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
    25: "Operator", 26: "TypeParameter",
  };
  return names[kind] || `Kind(${kind})`;
}

function formatDiagnostics(serverEntry) {
  const diags = [];
  for (const notif of serverEntry.conn.notifications) {
    if (notif.method === "textDocument/publishDiagnostics" && notif.params?.diagnostics?.length) {
      const filePath = notif.params.uri ? fileURLToPath(notif.params.uri) : "unknown";
      for (const d of notif.params.diagnostics) {
        const severity = ["", "Error", "Warning", "Info", "Hint"][d.severity] || "Unknown";
        const line = d.range.start.line + 1;
        const col = d.range.start.character + 1;
        diags.push(`${severity}: ${filePath}:${line}:${col} — ${d.message}`);
      }
    }
  }
  return diags.length > 0 ? diags.join("\n") : "No diagnostics.";
}

// --- MCP Server setup ---

const mcpServer = new Server(
  { name: "ide-lsp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "lsp_hover",
      description:
        "Get type information and documentation for a symbol at a specific position in a file. Returns type signatures, doc comments, and other hover info from the language server.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file" },
          line: { type: "number", description: "Line number (1-based)" },
          character: { type: "number", description: "Column number (1-based)" },
        },
        required: ["file_path", "line", "character"],
      },
    },
    {
      name: "lsp_definition",
      description:
        "Go to definition of a symbol at a specific position. Returns the file path and line number where the symbol is defined.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file" },
          line: { type: "number", description: "Line number (1-based)" },
          character: { type: "number", description: "Column number (1-based)" },
        },
        required: ["file_path", "line", "character"],
      },
    },
    {
      name: "lsp_references",
      description:
        "Find all references to a symbol at a specific position. Returns all locations where the symbol is used across the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file" },
          line: { type: "number", description: "Line number (1-based)" },
          character: { type: "number", description: "Column number (1-based)" },
        },
        required: ["file_path", "line", "character"],
      },
    },
    {
      name: "lsp_diagnostics",
      description:
        "Get cached errors and warnings for a file from the language server. The file must have been previously opened via another LSP tool call.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file" },
        },
        required: ["file_path"],
      },
    },
    {
      name: "lsp_symbols",
      description:
        "List all symbols (functions, classes, variables, etc.) in a file. Returns a hierarchical list of symbols with their types and line numbers.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file" },
        },
        required: ["file_path"],
      },
    },
    {
      name: "lsp_workspace_symbols",
      description:
        "Search for symbols across the entire workspace by name. Useful for finding functions, classes, or types without knowing which file they're in.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Symbol name or pattern to search for" },
          file_path: {
            type: "string",
            description: "Any file in the workspace (used to determine workspace root and language)",
          },
        },
        required: ["query", "file_path"],
      },
    },
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const filePath = args.file_path;
    const language = filePath ? getLanguage(filePath) : null;

    if (name !== "lsp_workspace_symbols" && !language) {
      return {
        content: [
          {
            type: "text",
            text: `Unsupported file type: ${filePath}. Supported: .ts, .tsx, .js, .jsx, .py, .go`,
          },
        ],
        isError: true,
      };
    }

    const serverEntry = await getServer(language || getLanguage(args.file_path), filePath || args.file_path);

    let result;
    switch (name) {
      case "lsp_hover": {
        const uri = await syncFile(serverEntry, filePath);
        result = await serverEntry.conn.send("textDocument/hover", {
          textDocument: { uri },
          position: { line: args.line - 1, character: args.character - 1 },
        });
        return { content: [{ type: "text", text: formatHover(result) }] };
      }
      case "lsp_definition": {
        const uri = await syncFile(serverEntry, filePath);
        result = await serverEntry.conn.send("textDocument/definition", {
          textDocument: { uri },
          position: { line: args.line - 1, character: args.character - 1 },
        });
        return { content: [{ type: "text", text: formatLocation(result) }] };
      }
      case "lsp_references": {
        const uri = await syncFile(serverEntry, filePath);
        result = await serverEntry.conn.send("textDocument/references", {
          textDocument: { uri },
          position: { line: args.line - 1, character: args.character - 1 },
          context: { includeDeclaration: true },
        });
        return { content: [{ type: "text", text: formatReferences(result) }] };
      }
      case "lsp_diagnostics": {
        await syncFile(serverEntry, filePath);
        // Give server a moment to publish diagnostics
        await new Promise((r) => setTimeout(r, 500));
        return { content: [{ type: "text", text: formatDiagnostics(serverEntry) }] };
      }
      case "lsp_symbols": {
        const uri = await syncFile(serverEntry, filePath);
        result = await serverEntry.conn.send("textDocument/documentSymbol", {
          textDocument: { uri },
        });
        return { content: [{ type: "text", text: formatSymbols(result, filePath) }] };
      }
      case "lsp_workspace_symbols": {
        // Ensure server is started
        await syncFile(serverEntry, args.file_path);
        result = await serverEntry.conn.send("workspace/symbol", {
          query: args.query,
        });
        return { content: [{ type: "text", text: formatWorkspaceSymbols(result) }] };
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `LSP Error: ${err.message}` }],
      isError: true,
    };
  }
});

// Cleanup on exit
process.on("SIGTERM", () => {
  for (const [, entry] of servers) entry.conn.kill();
  process.exit(0);
});
process.on("SIGINT", () => {
  for (const [, entry] of servers) entry.conn.kill();
  process.exit(0);
});

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
