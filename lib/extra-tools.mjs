// Extra CLI tools from .moat.yml
//
// Installs user-listed tools into the devcontainer at start, as the `node`
// user, so they survive container rebuilds without hand-installing:
//
//   extra_tools:
//     uv:                       # `uv tool install <spec>` -> ~/.local/bin
//       - ruff
//       - "my-tool[extras]==1.2.0"
//     npm:                      # `npm install -g <spec>` -> npm global prefix
//       - prettier
//     go:                       # `go install <module/path@version>` -> ~/go/bin
//       - github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0
//
// Installs run through `docker exec`, so they inherit the container's
// HTTP(S)_PROXY and go through squid. PyPI (.pypi.org, .pythonhosted.org),
// npm (.npmjs.org) and the Go module proxy (proxy.golang.org, sum.golang.org)
// are already in the base allowlist.
//
// A marker file records the installed spec list; when the list is unchanged
// and the container already ran the install, nothing is reinstalled.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml.mjs';
import { runCapture } from './exec.mjs';
import { log, err, DIM, RESET } from './colors.mjs';

export const SUPPORTED_INSTALLERS = ['uv', 'npm', 'go'];
const MARKER = '/home/node/.local/share/moat/extra-tools.sha256';

export class ExtraToolsError extends Error {}

/**
 * Validate and normalize the extra_tools section of a parsed .moat.yml.
 * Returns { uv: [...], npm: [...], go: [...] } (empty arrays when unset).
 * Throws ExtraToolsError with a user-facing message on bad input.
 */
export function parseExtraTools(config) {
  const out = Object.fromEntries(SUPPORTED_INSTALLERS.map(k => [k, []]));
  const section = config?.extra_tools;
  if (section === undefined || section === null || section === '') return out;
  if (typeof section !== 'object' || Array.isArray(section)) {
    throw new ExtraToolsError(`extra_tools must be a mapping with keys: ${SUPPORTED_INSTALLERS.join(', ')}`);
  }
  for (const [installer, list] of Object.entries(section)) {
    if (!SUPPORTED_INSTALLERS.includes(installer)) {
      throw new ExtraToolsError(`extra_tools.${installer} is not supported (use: ${SUPPORTED_INSTALLERS.join(', ')})`);
    }
    if (list === null || list === '') continue;
    if (!Array.isArray(list)) {
      throw new ExtraToolsError(`extra_tools.${installer} must be a list of package specs`);
    }
    for (const item of list) {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new ExtraToolsError(`extra_tools.${installer} entries must be non-empty strings (got ${JSON.stringify(item)})`);
      }
      const spec = item.trim();
      if (spec.startsWith('-') || /\s/.test(spec)) {
        throw new ExtraToolsError(`extra_tools.${installer}: "${spec}" must be a single package spec, not flags`);
      }
      if (installer === 'go' && !/^[^@]+@[^@]+$/.test(spec)) {
        throw new ExtraToolsError(`extra_tools.go: "${spec}" must be a module path with a version, like example.com/cmd/tool@v1.2.3`);
      }
      out[installer].push(spec);
    }
  }
  return out;
}

export function hasExtraTools(tools) {
  return SUPPORTED_INSTALLERS.some(k => tools[k].length > 0);
}

/**
 * Stable hash of the tool list, used to skip reinstalling an unchanged list.
 * Installers added later (go) are included only when used, so an existing
 * uv/npm list keeps its hash and is not reinstalled after an upgrade.
 */
export function toolsHash(tools) {
  const keys = SUPPORTED_INSTALLERS.filter(k => k === 'uv' || k === 'npm' || tools[k].length > 0);
  return createHash('sha256').update(JSON.stringify(keys.map(k => [k, tools[k]]))).digest('hex');
}

/** Read .moat.yml from the workspace and parse extra_tools. */
export function loadExtraTools(workspace) {
  const cfgPath = join(workspace, '.moat.yml');
  if (!existsSync(cfgPath)) return parseExtraTools({});
  return parseExtraTools(parseYaml(readFileSync(cfgPath, 'utf-8')));
}

/**
 * Build the ordered list of argv commands (run as `node` in the container)
 * that install the tools. Pure, for testing.
 */
export function installCommands(tools) {
  const cmds = [];
  if (tools.uv.length > 0) {
    // Bootstrap uv for images built before it was baked in.
    cmds.push(['sh', '-c', 'command -v uv >/dev/null 2>&1 || python3 -m pip install --user --break-system-packages --quiet uv']);
    for (const spec of tools.uv) cmds.push(['uv', 'tool', 'install', spec]);
  }
  for (const spec of tools.npm) cmds.push(['npm', 'install', '-g', spec]);
  for (const spec of tools.go) cmds.push(['go', 'install', spec]);
  return cmds;
}

async function execAsNode(containerName, argv) {
  return runCapture('docker', ['exec', '-u', 'node', containerName, ...argv], { allowFailure: true });
}

/**
 * Install extra tools into the container. Non-fatal: failures are reported
 * and the session continues. Skips entirely when the marker matches.
 */
export async function installExtraTools(containerName, tools) {
  if (!hasExtraTools(tools)) return;
  const hash = toolsHash(tools);

  const marker = await execAsNode(containerName, ['cat', MARKER]);
  if (marker.exitCode === 0 && marker.stdout.trim() === hash) {
    log(`Extra tools already installed ${DIM}(${SUPPORTED_INSTALLERS.flatMap(k => tools[k]).join(', ')})${RESET}`);
    return;
  }

  log(`Installing extra tools ${DIM}(via squid proxy)${RESET}...`);
  let failed = 0;
  for (const argv of installCommands(tools)) {
    const res = await execAsNode(containerName, argv);
    if (res.exitCode !== 0) {
      failed++;
      const label = argv[0] === 'sh' ? 'uv bootstrap' : argv.join(' ');
      const detail = (res.stderr || res.stdout).trim().split('\n').slice(-3).join(' | ');
      err(`Extra tool install failed: ${label} ${DIM}${detail}${RESET}`);
      if (argv[0] === 'sh') break;
    }
  }

  if (failed > 0) {
    err('Some extra tools failed to install. If a download host was blocked, add it to domains: in .moat.yml.');
    return;
  }
  await execAsNode(containerName, ['sh', '-c', `mkdir -p "$(dirname ${MARKER})" && printf '%s' ${hash} > ${MARKER}`]);
  log(`Installed extra tools ${DIM}(${SUPPORTED_INSTALLERS.flatMap(k => tools[k]).join(', ')})${RESET}`);
}
