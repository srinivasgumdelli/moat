#!/usr/bin/env node
// generate-project-config.mjs — Parse .moat.yml and generate compose + squid config
// Called by moat.sh before devcontainer up
// Usage: node generate-project-config.mjs --workspace /path --repo /path
//
// Reads: <workspace>/.moat.yml
// Generates:
//   <repo>/docker-compose.services.yml  — sidecar services on sandbox network
//   <repo>/squid-runtime.conf           — base squid.conf + project-specific domains
// Stdout: JSON metadata { has_services, env_vars }

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// --- Minimal YAML parser (handles the subset needed for .moat.yml) ---
// Supports: mappings, sequences (- item), quoted/unquoted scalars, nested maps
function parseYaml(text) {
  const lines = text.split('\n');
  let i = 0;

  function currentIndent(line) {
    const match = line.match(/^( *)/);
    return match ? match[1].length : 0;
  }

  function parseValue(val) {
    val = val.trim();
    if (val === '' || val === '~' || val === 'null') return null;
    if (val === 'true') return true;
    if (val === 'false') return false;
    // Quoted strings
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      return val.slice(1, -1);
    }
    // Numbers
    if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
    return val;
  }

  function parseBlock(minIndent) {
    if (i >= lines.length) return null;

    // Skip blank/comment lines, peek at first meaningful line
    while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#'))) i++;
    if (i >= lines.length) return null;

    const firstLine = lines[i];
    const firstIndent = currentIndent(firstLine);
    if (firstIndent < minIndent) return null;

    // Detect if this block is a sequence (starts with -)
    if (firstLine.trim().startsWith('- ')) {
      return parseSequence(firstIndent);
    }
    return parseMapping(firstIndent);
  }

  function parseSequence(baseIndent) {
    const result = [];
    while (i < lines.length) {
      // Skip blank/comment lines
      while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#'))) i++;
      if (i >= lines.length) break;

      const indent = currentIndent(lines[i]);
      if (indent < baseIndent) break;
      if (indent !== baseIndent || !lines[i].trim().startsWith('- ')) break;

      const val = lines[i].trim().slice(2).trim();
      i++;
      if (val.includes(':') && !val.startsWith('"') && !val.startsWith("'")) {
        // Inline mapping after dash: "- key: val" — reparse as mapping
        i--;
        // Adjust line to remove dash for re-parsing
        const saved = lines[i];
        lines[i] = ' '.repeat(baseIndent + 2) + val;
        const mapped = parseMapping(baseIndent + 2);
        lines[i] = saved; // restore (i already advanced past)
        result.push(mapped);
      } else {
        result.push(parseValue(val));
      }
    }
    return result;
  }

  function parseMapping(baseIndent) {
    const result = {};
    while (i < lines.length) {
      // Skip blank/comment lines
      while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#'))) i++;
      if (i >= lines.length) break;

      const indent = currentIndent(lines[i]);
      if (indent < baseIndent) break;
      if (indent > baseIndent) break; // unexpected deeper indent

      const line = lines[i].trim();
      if (line.startsWith('- ')) break; // sequence item, not a mapping

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) { i++; continue; }

      const key = line.slice(0, colonIdx).trim();
      const rest = line.slice(colonIdx + 1).trim();
      i++;

      if (rest === '' || rest === '|' || rest === '>') {
        // Value is a nested block
        const nested = parseBlock(baseIndent + 1);
        result[key] = nested !== null ? nested : '';
      } else {
        result[key] = parseValue(rest);
      }
    }
    return result;
  }

  return parseBlock(0) || {};
}

// --- Smart defaults for common service images ---
const SERVICE_DEFAULTS = {
  postgres: {
    healthcheck: {
      test: ['CMD-SHELL', 'pg_isready -U postgres'],
      interval: '5s', timeout: '5s', retries: 5
    },
    resources: { cpus: '1', memory: '1G' }
  },
  redis: {
    healthcheck: {
      test: ['CMD-SHELL', 'redis-cli ping'],
      interval: '5s', timeout: '5s', retries: 5
    },
    resources: { cpus: '0.5', memory: '512M' }
  },
  mysql: {
    healthcheck: {
      test: ['CMD-SHELL', 'mysqladmin ping -h localhost'],
      interval: '5s', timeout: '5s', retries: 5
    },
    resources: { cpus: '1', memory: '1G' }
  },
  mariadb: {
    healthcheck: {
      test: ['CMD-SHELL', 'mysqladmin ping -h localhost'],
      interval: '5s', timeout: '5s', retries: 5
    },
    resources: { cpus: '1', memory: '1G' }
  },
  mongo: {
    healthcheck: {
      test: ['CMD-SHELL', "mongosh --eval \"db.runCommand('ping')\""],
      interval: '5s', timeout: '5s', retries: 5
    },
    resources: { cpus: '1', memory: '1G' }
  }
};

function getServiceDefaults(image) {
  const name = image.split(':')[0].split('/').pop(); // handle org/image:tag
  return SERVICE_DEFAULTS[name] || {
    healthcheck: null,
    resources: { cpus: '1', memory: '1G' }
  };
}

// --- YAML writer (minimal, for compose output) ---
function yamlLine(indent, text) {
  return ' '.repeat(indent) + text;
}

function generateComposeYaml(services, envVars) {
  const lines = ['services:'];

  if (!services || Object.keys(services).length === 0) {
    // No services — empty placeholder with devcontainer stub
    lines.push('  devcontainer: {}');
    return lines.join('\n') + '\n';
  }

  const serviceNames = Object.keys(services);

  // Generate each sidecar service
  for (const name of serviceNames) {
    const svc = services[name];
    const defaults = getServiceDefaults(svc.image);

    lines.push(`  ${name}:`);
    lines.push(`    image: ${svc.image}`);
    lines.push('    networks:');
    lines.push('      - sandbox');

    // Environment
    if (svc.env && Object.keys(svc.env).length > 0) {
      lines.push('    environment:');
      for (const [k, v] of Object.entries(svc.env)) {
        lines.push(`      ${k}: ${JSON.stringify(String(v))}`);
      }
    }

    // Resource limits
    const res = defaults.resources;
    lines.push('    deploy:');
    lines.push('      resources:');
    lines.push('        limits:');
    lines.push(`          cpus: '${res.cpus}'`);
    lines.push(`          memory: ${res.memory}`);

    // Healthcheck
    if (defaults.healthcheck) {
      const hc = defaults.healthcheck;
      lines.push('    healthcheck:');
      lines.push(`      test: ["${hc.test.join('", "')}"]`);
      lines.push(`      interval: ${hc.interval}`);
      lines.push(`      timeout: ${hc.timeout}`);
      lines.push(`      retries: ${hc.retries}`);
    }
  }

  // Squid volume override for runtime config
  lines.push('  squid:');
  lines.push('    volumes:');
  lines.push('      - ./squid-runtime.conf:/etc/squid/squid.conf:ro');

  // Devcontainer: depends_on healthy services + env vars
  lines.push('  devcontainer:');

  // depends_on with health conditions
  const healthyServices = serviceNames.filter(name => {
    const defaults = getServiceDefaults(services[name].image);
    return defaults.healthcheck !== null;
  });

  if (healthyServices.length > 0) {
    lines.push('    depends_on:');
    for (const name of healthyServices) {
      lines.push(`      ${name}:`);
      lines.push('        condition: service_healthy');
    }
  }

  // Environment variables from config
  if (envVars && Object.keys(envVars).length > 0) {
    lines.push('    environment:');
    for (const [k, v] of Object.entries(envVars)) {
      lines.push(`      ${k}: ${JSON.stringify(String(v))}`);
    }
  }

  return lines.join('\n') + '\n';
}

function generateSquidConf(baseConf, extraDomains) {
  if (!extraDomains || extraDomains.length === 0) {
    return baseConf;
  }

  // Insert extra domain ACLs before the "# Access rules" comment
  const marker = '# Access rules';
  const idx = baseConf.indexOf(marker);
  if (idx === -1) {
    // Fallback: append before last line
    const domainLines = extraDomains
      .map(d => `acl allowed_domains dstdomain ${d}`)
      .join('\n');
    return baseConf + '\n# Project-specific domains\n' + domainLines + '\n';
  }

  const before = baseConf.slice(0, idx);
  const after = baseConf.slice(idx);
  const domainLines = extraDomains
    .map(d => `acl allowed_domains dstdomain ${d}`)
    .join('\n');

  return before + '# Project-specific domains (.moat.yml)\n' + domainLines + '\n\n' + after;
}

// --- Main ---
function main() {
  const args = process.argv.slice(2);
  let workspace = null;
  let repoDir = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) {
      workspace = args[++i];
    } else if (args[i] === '--repo' && args[i + 1]) {
      repoDir = args[++i];
    }
  }

  if (!workspace || !repoDir) {
    console.error('Usage: generate-project-config.mjs --workspace <path> --repo <path>');
    process.exit(1);
  }

  const configPath = join(workspace, '.moat.yml');
  const composePath = join(repoDir, 'docker-compose.services.yml');
  const squidBasePath = join(repoDir, 'squid.conf');
  const squidRuntimePath = join(repoDir, 'squid-runtime.conf');

  // Default output: no services, no extra domains
  let config = {};
  let hasConfig = false;

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8');
      config = parseYaml(raw);
      hasConfig = true;
    } catch (err) {
      console.error(`[moat] Warning: failed to parse ${configPath}: ${err.message}`);
    }
  }

  const services = config.services || {};
  const envVars = config.env || {};
  const domains = config.domains || [];
  const hasServices = Object.keys(services).length > 0;

  // Generate docker-compose.services.yml
  const composeContent = generateComposeYaml(
    hasServices ? services : null,
    hasServices ? envVars : null
  );
  writeFileSync(composePath, composeContent);

  // Generate squid-runtime.conf
  let baseSquid = '';
  if (existsSync(squidBasePath)) {
    baseSquid = readFileSync(squidBasePath, 'utf8');
  }
  const squidContent = generateSquidConf(baseSquid, domains);
  writeFileSync(squidRuntimePath, squidContent);

  // Output metadata as JSON
  const metadata = {
    has_config: hasConfig,
    has_services: hasServices,
    service_names: Object.keys(services),
    env_vars: envVars,
    extra_domains: domains
  };
  console.log(JSON.stringify(metadata));
}

main();
