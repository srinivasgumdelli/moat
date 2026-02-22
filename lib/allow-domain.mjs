// allow-domain subcommand — hot-reload squid domain whitelist

import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { runCapture } from './exec.mjs';
import { log, err, BOLD, DIM, GREEN, CYAN, RESET } from './colors.mjs';
import { findContainer, findMoatContainers } from './container.mjs';
import { workspaceId, workspaceDataDir } from './workspace-id.mjs';

const DOMAIN_RE = /^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => { rl.close(); res(answer); });
  });
}

export async function allowDomain(args, workspace) {
  const domains = args.filter(a => !a.startsWith('-'));
  if (domains.length === 0) {
    err('Usage: moat allow-domain <domain> [domain...]');
    err('Example: moat allow-domain httpbin.org .elasticache.amazonaws.com');
    process.exit(1);
  }

  for (const d of domains) {
    if (!DOMAIN_RE.test(d)) {
      err(`Invalid domain: ${d}`);
      err('Domains must contain only alphanumeric characters, hyphens, and dots.');
      process.exit(1);
    }
  }

  // Find running moat container — exact workspace match first, then auto-detect
  let containerName = await findContainer(workspace);
  if (!containerName) {
    const running = await findMoatContainers();
    if (running.length === 0) {
      err("No running moat container. Start a session first with 'moat'.");
      process.exit(1);
    }
    if (running.length === 1) {
      containerName = running[0].name;
      workspace = running[0].workspace;
    } else {
      log('Multiple moat containers running. Which workspace?');
      for (let i = 0; i < running.length; i++) {
        console.log(`  ${BOLD}${i + 1}${RESET}) ${running[i].workspace}`);
      }
      const answer = await prompt(`\n  ${CYAN}?${RESET} Select workspace ${DIM}[1-${running.length}]${RESET} `);
      const idx = parseInt(answer, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= running.length) {
        err('Invalid selection.');
        process.exit(1);
      }
      containerName = running[idx].name;
      workspace = running[idx].workspace;
    }
  }

  // Derive workspace data directory
  const hash = workspaceId(workspace);
  const wsDataDir = workspaceDataDir(hash);
  const squidConfPath = `${wsDataDir}/squid-runtime.conf`;

  // Read current squid config
  let conf;
  try {
    conf = readFileSync(squidConfPath, 'utf-8');
  } catch {
    err(`Cannot read squid config: ${squidConfPath}`);
    process.exit(1);
  }

  // Insert new domains before the "# Access rules" marker
  const marker = '# Access rules';
  const markerIdx = conf.indexOf(marker);
  if (markerIdx === -1) {
    err('Cannot find "# Access rules" marker in squid config.');
    process.exit(1);
  }

  const added = [];
  const skipped = [];

  for (const domain of domains) {
    const aclLine = `acl allowed_domains dstdomain ${domain}`;
    if (conf.includes(aclLine)) {
      skipped.push(domain);
    } else {
      added.push(aclLine);
    }
  }

  if (added.length > 0) {
    const insertion = added.join('\n') + '\n';
    conf = conf.slice(0, markerIdx) + insertion + conf.slice(markerIdx);
    writeFileSync(squidConfPath, conf);
  }

  // Find squid container via compose labels
  const project = await getComposeProject(containerName);
  if (!project) {
    err('Cannot determine compose project name from container.');
    process.exit(1);
  }

  const squidResult = await runCapture('docker', [
    'ps',
    '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', 'label=com.docker.compose.service=squid',
    '--format', '{{.Names}}'
  ], { allowFailure: true });

  const squidContainer = squidResult.stdout.trim().split('\n')[0];
  if (!squidContainer) {
    err('Squid container not found.');
    process.exit(1);
  }

  // Signal squid to reload config
  await runCapture('docker', ['exec', squidContainer, 'squid', '-k', 'reconfigure']);

  // Log results
  const addedDomains = added.map(l => l.split(' ').pop());
  if (addedDomains.length > 0) {
    log(`Added: ${GREEN}${addedDomains.join(', ')}${RESET}`);
  }
  if (skipped.length > 0) {
    log(`Already allowed: ${DIM}${skipped.join(', ')}${RESET}`);
  }
  log('Squid config reloaded.');
}

async function getComposeProject(containerName) {
  try {
    const result = await runCapture('docker', [
      'inspect', containerName,
      '--format', '{{index .Config.Labels "com.docker.compose.project"}}'
    ], { allowFailure: true });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}
