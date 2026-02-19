// Compose + squid file generation — absorbs generate-project-config.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseYaml } from './yaml.mjs';

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
  const name = image.split(':')[0].split('/').pop();
  return SERVICE_DEFAULTS[name] || {
    healthcheck: null,
    resources: { cpus: '1', memory: '1G' }
  };
}

// --- Compose YAML generation ---

function generateComposeYaml(services, envVars, squidRuntimePath) {
  const lines = ['services:'];

  if (!services || Object.keys(services).length === 0) {
    lines.push('  devcontainer: {}');
    return lines.join('\n') + '\n';
  }

  const serviceNames = Object.keys(services);

  for (const name of serviceNames) {
    const svc = services[name];
    const defaults = getServiceDefaults(svc.image);

    lines.push(`  ${name}:`);
    lines.push(`    image: ${svc.image}`);
    lines.push('    networks:');
    lines.push('      - sandbox');

    if (svc.env && Object.keys(svc.env).length > 0) {
      lines.push('    environment:');
      for (const [k, v] of Object.entries(svc.env)) {
        lines.push(`      ${k}: ${JSON.stringify(String(v))}`);
      }
    }

    const res = defaults.resources;
    lines.push('    deploy:');
    lines.push('      resources:');
    lines.push('        limits:');
    lines.push(`          cpus: '${res.cpus}'`);
    lines.push(`          memory: ${res.memory}`);

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
  lines.push(`      - ${squidRuntimePath}:/etc/squid/squid.conf:ro`);

  // Devcontainer: depends_on healthy services + env vars
  lines.push('  devcontainer:');

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

  const marker = '# Access rules';
  const idx = baseConf.indexOf(marker);
  const domainLines = extraDomains
    .map(d => `acl allowed_domains dstdomain ${d}`)
    .join('\n');

  if (idx === -1) {
    return baseConf + '\n# Project-specific domains\n' + domainLines + '\n';
  }

  const before = baseConf.slice(0, idx);
  const after = baseConf.slice(idx);
  return before + '# Project-specific domains (.moat.yml)\n' + domainLines + '\n\n' + after;
}

// Docker Hub domains to whitelist in squid when docker is enabled
const DOCKER_DOMAINS = [
  '.docker.io',
  '.docker.com',
  'production.cloudflare.docker.com',
];

/**
 * Generate docker-compose.docker.yml for the docker socket proxy.
 */
export function generateDockerYaml() {
  const lines = [
    'services:',
    '  docker-proxy:',
    '    image: lscr.io/linuxserver/socket-proxy:latest',
    '    networks:',
    '      - sandbox',
    '    volumes:',
    '      - /var/run/docker.sock:/var/run/docker.sock:ro',
    '    environment:',
    '      # Allowed APIs',
    '      - BUILD=1',
    '      - IMAGES=1',
    '      - CONTAINERS=1',
    '      - NETWORKS=1',
    '      - VOLUMES=1',
    '      - EVENTS=1',
    '      - INFO=1',
    '      - PING=1',
    '      - VERSION=1',
    '      - POST=1',
    '      - ALLOW_START=1',
    '      - ALLOW_STOP=1',
    '      - ALLOW_RESTARTS=1',
    '      # Blocked APIs',
    '      - EXEC=0',
    '      - AUTH=0',
    '      - SECRETS=0',
    '      - SWARM=0',
    '      - SERVICES=0',
    '      - TASKS=0',
    '      - NODES=0',
    '      - PLUGINS=0',
    '      - SYSTEM=0',
    '      - CONFIGS=0',
    '    read_only: true',
    '    tmpfs:',
    '      - /run',
    '    deploy:',
    '      resources:',
    '        limits:',
    "          cpus: '0.5'",
    '          memory: 256M',
    '    restart: unless-stopped',
    '  devcontainer:',
    '    depends_on:',
    '      - docker-proxy',
    '    environment:',
    '      - DOCKER_HOST=tcp://docker-proxy:2375',
  ];
  return lines.join('\n') + '\n';
}

/**
 * Generate docker-compose.extra-dirs.yml content for extra directories.
 */
export function generateExtraDirsYaml(extraDirs) {
  if (extraDirs.length === 0) {
    return 'services:\n  devcontainer: {}\n';
  }

  const lines = ['services:', '  devcontainer:', '    volumes:'];
  for (const dir of extraDirs) {
    lines.push(`      - ${dir}:/extra/${basename(dir)}:cached`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Generate docker-compose.extra-dirs.yml for attach fallback (existing mounts + new).
 */
export function generateExtraDirsYamlForAttach(existingSources, newDir, newName) {
  const lines = ['services:', '  devcontainer:', '    volumes:'];
  for (const src of existingSources) {
    if (!src) continue;
    lines.push(`      - ${src}:/extra/${basename(src)}:cached`);
  }
  lines.push(`      - ${newDir}:/extra/${newName}:cached`);
  return lines.join('\n') + '\n';
}

/**
 * Parse .moat.yml and generate compose + squid config files.
 * Returns metadata object.
 */
export function generateProjectConfig(workspace, repoDir, wsDataDir) {
  const configPath = join(workspace, '.moat.yml');
  const composePath = join(wsDataDir, 'docker-compose.services.yml');
  const squidBasePath = join(repoDir, 'squid.conf');
  const squidRuntimePath = join(wsDataDir, 'squid-runtime.conf');

  let config = {};
  let hasConfig = false;

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8');
      config = parseYaml(raw);
      hasConfig = true;
    } catch (e) {
      process.stderr.write(`[moat] Warning: failed to parse ${configPath}: ${e.message}\n`);
    }
  }

  const services = config.services || {};
  const envVars = config.env || {};
  const domains = config.domains || [];
  const hasServices = Object.keys(services).length > 0;
  const hasDocker = config.docker === true;

  // Generate docker-compose.services.yml
  const composeContent = generateComposeYaml(
    hasServices ? services : null,
    hasServices ? envVars : null,
    squidRuntimePath
  );
  writeFileSync(composePath, composeContent);

  // Generate docker-compose.docker.yml if docker is enabled
  if (hasDocker) {
    writeFileSync(join(wsDataDir, 'docker-compose.docker.yml'), generateDockerYaml());
  }

  // Generate squid-runtime.conf (add Docker Hub domains when docker is enabled)
  const allDomains = hasDocker ? [...domains, ...DOCKER_DOMAINS] : domains;
  let baseSquid = '';
  if (existsSync(squidBasePath)) {
    baseSquid = readFileSync(squidBasePath, 'utf8');
  }
  writeFileSync(squidRuntimePath, generateSquidConf(baseSquid, allDomains));

  return {
    has_config: hasConfig,
    has_services: hasServices,
    has_docker: hasDocker,
    service_names: Object.keys(services),
    env_vars: envVars,
    extra_domains: allDomains
  };
}
