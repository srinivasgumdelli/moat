// ps subcommand — list running moat sessions

import { BOLD, DIM, RESET } from './colors.mjs';
import { runCapture } from './exec.mjs';

export async function ps() {
  // Find all running moat devcontainers
  const result = await runCapture('docker', [
    'ps', '--filter', 'label=devcontainer.local_folder',
    '--filter', 'name=moat-',
    '--format', '{{.Names}}\t{{.Status}}\t{{.Label "devcontainer.local_folder"}}',
  ], { allowFailure: true });

  const lines = result.stdout.trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    console.log('No running moat sessions.');
    return;
  }

  console.log('');
  console.log(`${BOLD}Running Sessions${RESET}`);
  console.log('');

  for (const line of lines) {
    const [name, status, workspace] = line.split('\t');
    console.log(`  ${BOLD}${workspace || '(unknown)'}${RESET}`);
    console.log(`  ${DIM}container: ${name}  |  ${status}${RESET}`);

    // Count agents for this session
    const agentResult = await runCapture('docker', [
      'ps', '--filter', `label=moat.agent=true`,
      '--filter', `name=moat-agent-`,
      '--format', '{{.Names}}\t{{.Status}}',
    ], { allowFailure: true });
    const agents = agentResult.stdout.trim().split('\n').filter(Boolean);
    if (agents.length > 0) {
      console.log(`  ${DIM}agents: ${agents.length} running${RESET}`);
    }
    console.log('');
  }

  // Show resource usage summary
  const statsResult = await runCapture('docker', [
    'stats', '--no-stream', '--filter', 'name=moat-',
    '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}',
  ], { allowFailure: true });

  const statsLines = statsResult.stdout.trim().split('\n').filter(Boolean);
  if (statsLines.length > 0) {
    console.log(`${BOLD}Resources${RESET}`);
    console.log('');
    console.log(`  ${'NAME'.padEnd(35)} ${'CPU'.padEnd(10)} MEMORY`);
    for (const sline of statsLines) {
      const [sname, cpu, mem] = sline.split('\t');
      console.log(`  ${DIM}${sname.padEnd(35)}${RESET} ${cpu.padEnd(10)} ${mem}`);
    }
    console.log('');
  }
}
