// ps subcommand — list running moat sessions grouped by workspace

import { BOLD, DIM, RESET } from './colors.mjs';
import { runCapture } from './exec.mjs';
import { findMoatContainers } from './container.mjs';

export async function ps() {
  const sessions = await findMoatContainers();
  if (sessions.length === 0) {
    console.log('No running moat sessions.');
    return;
  }

  // Uptime/status per container
  const statusResult = await runCapture('docker', [
    'ps', '--filter', 'label=devcontainer.local_folder',
    '--format', '{{.Names}}\t{{.Status}}',
  ], { allowFailure: true });
  const statusByName = {};
  for (const line of statusResult.stdout.trim().split('\n').filter(Boolean)) {
    const [n, s] = line.split('\t');
    statusByName[n] = s;
  }

  // CPU/mem per container (single stats snapshot)
  const statsResult = await runCapture('docker', [
    'stats', '--no-stream', '--filter', 'name=moat-',
    '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}',
  ], { allowFailure: true });
  const statsByName = {};
  for (const line of statsResult.stdout.trim().split('\n').filter(Boolean)) {
    const [n, cpu, mem] = line.split('\t');
    statsByName[n] = { cpu, mem };
  }

  // Group sessions by workspace
  const byWorkspace = new Map();
  for (const s of sessions) {
    const key = s.workspace || '(unknown)';
    if (!byWorkspace.has(key)) byWorkspace.set(key, []);
    byWorkspace.get(key).push(s);
  }

  console.log('');
  for (const [workspace, list] of byWorkspace) {
    console.log(`${BOLD}${workspace}${RESET}`);
    for (const s of list) {
      const status = statusByName[s.name] || '';
      const stats = statsByName[s.name];
      const sessionName = s.session || 'legacy';
      const resources = stats ? `  ${DIM}cpu ${stats.cpu}  mem ${stats.mem}${RESET}` : '';
      console.log(`  ${BOLD}${sessionName.padEnd(12)}${RESET} ${status}${resources}`);
      console.log(`  ${DIM}${''.padEnd(12)} ${s.name}${RESET}`);

      // Agents scoped to this session via the moat.workspace_hash label
      const sid = s.project.startsWith('moat-') ? s.project.slice('moat-'.length) : null;
      if (sid) {
        const agentResult = await runCapture('docker', [
          'ps', '--filter', `label=moat.workspace_hash=${sid}`,
          '--filter', 'name=moat-agent-',
          '--format', '{{.Names}}',
        ], { allowFailure: true });
        const agents = agentResult.stdout.trim().split('\n').filter(Boolean);
        if (agents.length > 0) {
          console.log(`  ${DIM}${''.padEnd(12)} agents: ${agents.length} running${RESET}`);
        }
      }
    }
    console.log('');
  }
}
