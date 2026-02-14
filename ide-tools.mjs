#!/usr/bin/env node
// ide-tools MCP server — deep analysis and test-running tools
// Tools: run_diagnostics, run_tests, list_tests, get_project_info

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access, stat } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);

const MAX_OUTPUT = 50_000; // truncate output beyond this

// --- Helpers ---

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function truncate(str) {
  if (str.length > MAX_OUTPUT) {
    return str.slice(0, MAX_OUTPUT) + "\n... (truncated)";
  }
  return str;
}

async function run(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      ...opts,
    });
    return { stdout: stdout || "", stderr: stderr || "", exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || "",
      exitCode: err.code ?? 1,
    };
  }
}

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".go": "go",
  };
  return map[ext] || "unknown";
}

async function detectProjectLanguage(dir) {
  if (await fileExists(path.join(dir, "package.json"))) return "typescript";
  if (await fileExists(path.join(dir, "tsconfig.json"))) return "typescript";
  if (await fileExists(path.join(dir, "pyproject.toml"))) return "python";
  if (await fileExists(path.join(dir, "setup.py"))) return "python";
  if (await fileExists(path.join(dir, "requirements.txt"))) return "python";
  if (await fileExists(path.join(dir, "go.mod"))) return "go";
  return "unknown";
}

async function findProjectRoot(startPath) {
  let dir = startPath;
  if (!(await isDirectory(dir))) dir = path.dirname(dir);
  const markers = [
    "package.json",
    "tsconfig.json",
    "pyproject.toml",
    "setup.py",
    "go.mod",
    ".git",
  ];
  for (let i = 0; i < 10; i++) {
    for (const m of markers) {
      if (await fileExists(path.join(dir, m))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startPath;
}

// --- Tool implementations ---

async function runDiagnostics({ file_path, project_dir }) {
  const dir = project_dir || (file_path ? await findProjectRoot(file_path) : process.cwd());
  const lang = file_path ? detectLanguage(file_path) : await detectProjectLanguage(dir);

  switch (lang) {
    case "typescript":
    case "javascript": {
      // Try tsc --noEmit first for type checking
      const tscResult = await run("npx", ["tsc", "--noEmit", "--pretty", "false"], { cwd: dir });
      let output = "";
      if (tscResult.stdout || tscResult.stderr) {
        const raw = (tscResult.stdout + "\n" + tscResult.stderr).trim();
        // Filter to relevant file if specified
        if (file_path && raw) {
          const abs = path.resolve(file_path);
          const lines = raw.split("\n").filter(
            (l) => l.includes(abs) || l.includes(path.relative(dir, abs)) || !l.match(/^[\/.]/)
          );
          output = lines.join("\n");
        } else {
          output = raw;
        }
      }
      return {
        language: lang,
        tool: "tsc --noEmit",
        diagnostics: truncate(output || "No errors found."),
        exitCode: tscResult.exitCode,
      };
    }
    case "python": {
      const args = ["--outputjson"];
      if (file_path) args.push(file_path);
      else args.push(dir);
      const result = await run("pyright", args, { cwd: dir });
      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        parsed = null;
      }
      if (parsed) {
        const diags = (parsed.generalDiagnostics || []).map((d) => ({
          file: d.file,
          line: d.range?.start?.line,
          severity: d.severity,
          message: d.message,
          rule: d.rule,
        }));
        return {
          language: "python",
          tool: "pyright",
          summary: parsed.summary || {},
          diagnostics: diags,
          exitCode: result.exitCode,
        };
      }
      return {
        language: "python",
        tool: "pyright",
        diagnostics: truncate((result.stdout + "\n" + result.stderr).trim()),
        exitCode: result.exitCode,
      };
    }
    case "go": {
      const args = ["run", "--out-format", "json"];
      if (file_path) args.push(file_path);
      else args.push("./...");
      const result = await run("golangci-lint", args, { cwd: dir });
      const issues = [];
      for (const line of (result.stdout || "").split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.Issues) {
            for (const iss of obj.Issues) {
              issues.push({
                file: iss.Pos?.Filename,
                line: iss.Pos?.Line,
                severity: iss.Severity,
                message: iss.Text,
                rule: iss.FromLinter,
              });
            }
          }
        } catch {
          // skip non-JSON lines
        }
      }
      return {
        language: "go",
        tool: "golangci-lint",
        diagnostics: issues.length > 0 ? issues : "No issues found.",
        exitCode: result.exitCode,
      };
    }
    default:
      return { error: `Unsupported language for file: ${file_path || dir}` };
  }
}

async function runTests({ file_path, project_dir, test_name, extra_args }) {
  const dir = project_dir || (file_path ? await findProjectRoot(file_path) : process.cwd());
  const lang = file_path ? detectLanguage(file_path) : await detectProjectLanguage(dir);
  const extraArgsList = extra_args ? extra_args.split(" ") : [];

  switch (lang) {
    case "typescript":
    case "javascript": {
      // Detect test runner
      let runner = "vitest";
      const pkgPath = path.join(dir, "package.json");
      if (await fileExists(pkgPath)) {
        try {
          const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (allDeps.jest && !allDeps.vitest) runner = "jest";
        } catch {}
      }

      const args =
        runner === "vitest"
          ? ["vitest", "run", "--reporter=json"]
          : ["jest", "--json"];
      if (file_path) args.push(file_path);
      if (test_name) args.push("-t", test_name);
      args.push(...extraArgsList);

      const result = await run("npx", args, { cwd: dir });
      // Try to extract JSON from output
      const jsonMatch = (result.stdout || "").match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[0]);
          const suites = (data.testResults || []).map((s) => ({
            file: s.name,
            status: s.status,
            tests: (s.assertionResults || []).map((t) => ({
              name: t.fullName || t.ancestorTitles?.concat(t.title).join(" > "),
              status: t.status,
              duration: t.duration,
              failureMessages: t.failureMessages?.length ? t.failureMessages : undefined,
            })),
          }));
          return {
            language: lang,
            runner,
            passed: data.numPassedTests || 0,
            failed: data.numFailedTests || 0,
            total: data.numTotalTests || 0,
            suites,
            exitCode: result.exitCode,
          };
        } catch {}
      }
      return {
        language: lang,
        runner,
        output: truncate((result.stdout + "\n" + result.stderr).trim()),
        exitCode: result.exitCode,
      };
    }
    case "python": {
      const args = ["-m", "pytest", "--tb=short"];
      // Try json-report if available
      args.push("--json-report", "--json-report-file=-");
      if (file_path) args.push(file_path);
      if (test_name) args.push("-k", test_name);
      args.push(...extraArgsList);

      const result = await run("python3", args, { cwd: dir });
      // Try JSON report
      try {
        const data = JSON.parse(result.stdout);
        const tests = (data.tests || []).map((t) => ({
          name: t.nodeid,
          outcome: t.outcome,
          duration: t.duration,
          message: t.call?.longrepr,
        }));
        return {
          language: "python",
          runner: "pytest",
          summary: data.summary || {},
          tests,
          exitCode: result.exitCode,
        };
      } catch {
        // Fall back to raw output
        return {
          language: "python",
          runner: "pytest",
          output: truncate((result.stdout + "\n" + result.stderr).trim()),
          exitCode: result.exitCode,
        };
      }
    }
    case "go": {
      const args = ["test", "-json"];
      if (file_path) {
        args.push(path.dirname(file_path) + "/...");
      } else {
        args.push("./...");
      }
      if (test_name) args.push("-run", test_name);
      args.push(...extraArgsList);

      const result = await run("go", args, { cwd: dir });
      const tests = [];
      for (const line of (result.stdout || "").split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.Test && (ev.Action === "pass" || ev.Action === "fail" || ev.Action === "skip")) {
            tests.push({
              package: ev.Package,
              name: ev.Test,
              status: ev.Action,
              elapsed: ev.Elapsed,
            });
          }
        } catch {}
      }
      const passed = tests.filter((t) => t.status === "pass").length;
      const failed = tests.filter((t) => t.status === "fail").length;
      return {
        language: "go",
        runner: "go test",
        passed,
        failed,
        total: tests.length,
        tests,
        exitCode: result.exitCode,
      };
    }
    default:
      return { error: `Unsupported language for tests: ${file_path || dir}` };
  }
}

async function listTests({ file_path, project_dir }) {
  const dir = project_dir || (file_path ? await findProjectRoot(file_path) : process.cwd());
  const lang = file_path ? detectLanguage(file_path) : await detectProjectLanguage(dir);

  switch (lang) {
    case "typescript":
    case "javascript": {
      const args = ["vitest", "list"];
      if (file_path) args.push(file_path);
      const result = await run("npx", args, { cwd: dir });
      if (result.exitCode !== 0) {
        // Try jest
        const jestArgs = ["jest", "--listTests"];
        if (file_path) jestArgs.push(file_path);
        const jestResult = await run("npx", jestArgs, { cwd: dir });
        return {
          language: lang,
          runner: "jest",
          tests: (jestResult.stdout || "").trim().split("\n").filter(Boolean),
        };
      }
      return {
        language: lang,
        runner: "vitest",
        tests: (result.stdout || "").trim().split("\n").filter(Boolean),
      };
    }
    case "python": {
      const args = ["-m", "pytest", "--collect-only", "-q"];
      if (file_path) args.push(file_path);
      const result = await run("python3", args, { cwd: dir });
      const lines = (result.stdout || "")
        .trim()
        .split("\n")
        .filter((l) => l.includes("::"));
      return { language: "python", runner: "pytest", tests: lines };
    }
    case "go": {
      const args = ["test", "-list", ".*"];
      if (file_path) args.push(path.dirname(file_path) + "/...");
      else args.push("./...");
      const result = await run("go", args, { cwd: dir });
      const tests = (result.stdout || "")
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("Test") || l.startsWith("Benchmark"));
      return { language: "go", runner: "go test", tests };
    }
    default:
      return { error: `Unsupported language: ${lang}` };
  }
}

async function getProjectInfo({ project_dir }) {
  const dir = project_dir || process.cwd();
  const info = { directory: dir, languages: [], frameworks: [], testRunners: [], buildTools: [] };

  // Check TypeScript/JavaScript
  const pkgPath = path.join(dir, "package.json");
  if (await fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      info.languages.push("javascript");
      if (allDeps.typescript || (await fileExists(path.join(dir, "tsconfig.json")))) {
        info.languages.push("typescript");
      }
      // Frameworks
      for (const fw of ["react", "next", "vue", "nuxt", "svelte", "express", "fastify", "nestjs"]) {
        if (allDeps[fw]) info.frameworks.push(fw);
      }
      if (allDeps["@angular/core"]) info.frameworks.push("angular");
      // Test runners
      if (allDeps.vitest) info.testRunners.push("vitest");
      if (allDeps.jest) info.testRunners.push("jest");
      if (allDeps.mocha) info.testRunners.push("mocha");
      if (allDeps.playwright || allDeps["@playwright/test"]) info.testRunners.push("playwright");
      // Build tools
      if (allDeps.vite) info.buildTools.push("vite");
      if (allDeps.webpack) info.buildTools.push("webpack");
      if (allDeps.esbuild) info.buildTools.push("esbuild");
      if (allDeps.turbo) info.buildTools.push("turborepo");
      info.packageManager = pkg.packageManager?.split("@")[0] || "npm";
      info.name = pkg.name;
      info.scripts = pkg.scripts ? Object.keys(pkg.scripts) : [];
    } catch {}
  }

  // Check Python
  const pyprojectPath = path.join(dir, "pyproject.toml");
  if (await fileExists(pyprojectPath)) {
    info.languages.push("python");
    info.buildTools.push("pyproject.toml");
    try {
      const content = await readFile(pyprojectPath, "utf8");
      if (content.includes("pytest")) info.testRunners.push("pytest");
      if (content.includes("django")) info.frameworks.push("django");
      if (content.includes("flask")) info.frameworks.push("flask");
      if (content.includes("fastapi")) info.frameworks.push("fastapi");
    } catch {}
  } else if (await fileExists(path.join(dir, "setup.py"))) {
    info.languages.push("python");
    info.buildTools.push("setup.py");
  } else if (await fileExists(path.join(dir, "requirements.txt"))) {
    info.languages.push("python");
  }

  // Check Go
  const goModPath = path.join(dir, "go.mod");
  if (await fileExists(goModPath)) {
    info.languages.push("go");
    info.testRunners.push("go test");
    info.buildTools.push("go");
    try {
      const content = await readFile(goModPath, "utf8");
      const modLine = content.match(/^module\s+(.+)$/m);
      if (modLine) info.goModule = modLine[1];
      const goLine = content.match(/^go\s+(.+)$/m);
      if (goLine) info.goVersion = goLine[1];
    } catch {}
  }

  // Deduplicate
  info.languages = [...new Set(info.languages)];
  info.frameworks = [...new Set(info.frameworks)];
  info.testRunners = [...new Set(info.testRunners)];
  info.buildTools = [...new Set(info.buildTools)];

  return info;
}

// --- MCP Server setup ---

const server = new Server(
  { name: "ide-tools", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "run_diagnostics",
      description:
        "Run full type-checking and linting diagnostics for a file or project. Uses tsc for TypeScript, pyright for Python, golangci-lint for Go. Returns structured diagnostic output.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Path to file to check (optional if project_dir given)",
          },
          project_dir: {
            type: "string",
            description: "Project root directory (auto-detected from file_path if not given)",
          },
        },
      },
    },
    {
      name: "run_tests",
      description:
        "Run tests with structured JSON output. Supports vitest/jest for TypeScript/JavaScript, pytest for Python, go test for Go. Returns pass/fail counts and per-test results.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Test file to run (runs all tests if not given)",
          },
          project_dir: {
            type: "string",
            description: "Project root directory (auto-detected from file_path if not given)",
          },
          test_name: {
            type: "string",
            description: "Specific test name or pattern to run",
          },
          extra_args: {
            type: "string",
            description: "Additional CLI arguments to pass to test runner",
          },
        },
      },
    },
    {
      name: "list_tests",
      description:
        "List available tests without running them. Returns test names/IDs for a file or project.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Test file to list tests from",
          },
          project_dir: {
            type: "string",
            description: "Project root directory",
          },
        },
      },
    },
    {
      name: "get_project_info",
      description:
        "Detect project language, framework, test runner, build system, and other metadata by examining project files (package.json, pyproject.toml, go.mod, etc.).",
      inputSchema: {
        type: "object",
        properties: {
          project_dir: {
            type: "string",
            description: "Project root directory to analyze (defaults to cwd)",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;
    switch (name) {
      case "run_diagnostics":
        result = await runDiagnostics(args || {});
        break;
      case "run_tests":
        result = await runTests(args || {});
        break;
      case "list_tests":
        result = await listTests(args || {});
        break;
      case "get_project_info":
        result = await getProjectInfo(args || {});
        break;
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
