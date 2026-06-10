// allow-domain subcommand — hot-reload squid domain whitelist

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { runCapture } from './exec.mjs';
import { log, err, BOLD, DIM, GREEN, CYAN, RESET } from './colors.mjs';
import { findMoatContainers, getComposeProject, sessionDirFromContainer } from './container.mjs';

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
  const all = await findMoatContainers();
  const forWorkspace = all.filter(c => c.workspace === workspace);
  let containerName = forWorkspace.length === 1 ? forWorkspace[0].name : null;
  if (!containerName) {
    const running = forWorkspace.length > 0 ? forWorkspace : all;
    if (running.length === 0) {
      err("No running moat container. Start a session first with 'moat'.");
      process.exit(1);
    }
    if (running.length === 1) {
      containerName = running[0].name;
      workspace = running[0].workspace;
    } else {
      log('Multiple moat sessions running. Which one?');
      for (let i = 0; i < running.length; i++) {
        console.log(`  ${BOLD}${i + 1}${RESET}) ${running[i].workspace}${running[i].session ? `  (${running[i].session})` : ''}`);
      }
      const answer = await prompt(`\n  ${CYAN}?${RESET} Select session ${DIM}[1-${running.length}]${RESET} `);
      const idx = parseInt(answer, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= running.length) {
        err('Invalid selection.');
        process.exit(1);
      }
      containerName = running[idx].name;
      workspace = running[idx].workspace;
    }
  }

  // Derive the session's data directory from the container labels
  const wsDataDir = await sessionDirFromContainer(containerName);
  if (!wsDataDir) {
    err('Cannot determine session data directory for this container.');
    process.exit(1);
  }
  const squidConfPath = `${wsDataDir}/squid-runtime.conf`;
  const extraDomainsPath = `${wsDataDir}/extra-domains.txt`;

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

    // Persist across sessions — generateProjectConfig rewrites squid-runtime.conf
    // from scratch each startup, so additions need their own durable store.
    let persisted = new Set();
    if (existsSync(extraDomainsPath)) {
      try {
        persisted = new Set(
          readFileSync(extraDomainsPath, 'utf8')
            .split('\n')
            .map(l => l.split('#')[0].trim())
            .filter(Boolean),
        );
      } catch {}
    }
    const addedDomainsOnly = added.map(l => l.split(' ').pop());
    const fresh = addedDomainsOnly.filter(d => !persisted.has(d));
    if (fresh.length > 0) {
      appendFileSync(extraDomainsPath, fresh.join('\n') + '\n');
    }
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
