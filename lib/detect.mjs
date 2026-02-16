// Dependency scanner — detects services needed by the project
// Scans: package.json, requirements.txt, pyproject.toml, go.mod, .env.example, docker-compose.yml

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Map of dependency patterns to detected service
const SERVICE_MAP = {
  postgres: {
    npm: ['pg', 'pg-promise', 'pgx', 'postgres', 'knex', 'sequelize', 'typeorm', 'prisma', '@prisma/client', 'drizzle-orm'],
    pip: ['psycopg2', 'psycopg2-binary', 'psycopg', 'asyncpg', 'sqlalchemy', 'django'],
    go: ['github.com/lib/pq', 'github.com/jackc/pgx', 'gorm.io/driver/postgres'],
    env: ['DATABASE_URL=postgres', 'POSTGRES_', 'PG_HOST', 'PGHOST'],
  },
  redis: {
    npm: ['redis', 'ioredis', 'bull', 'bullmq', '@bull-board/api'],
    pip: ['redis', 'celery', 'rq', 'django-redis', 'aioredis'],
    go: ['github.com/go-redis/redis', 'github.com/redis/go-redis'],
    env: ['REDIS_URL', 'REDIS_HOST'],
  },
  mongo: {
    npm: ['mongodb', 'mongoose', 'mongoist'],
    pip: ['pymongo', 'motor', 'mongoengine', 'beanie'],
    go: ['go.mongodb.org/mongo-driver'],
    env: ['MONGO_URL', 'MONGODB_URI', 'MONGO_HOST'],
  },
  mysql: {
    npm: ['mysql', 'mysql2'],
    pip: ['mysqlclient', 'pymysql', 'aiomysql'],
    go: ['github.com/go-sql-driver/mysql'],
    env: ['MYSQL_URL', 'MYSQL_HOST', 'DATABASE_URL=mysql'],
  },
  rabbitmq: {
    npm: ['amqplib', 'amqp-connection-manager'],
    pip: ['pika', 'aio-pika', 'celery'],
    go: ['github.com/rabbitmq/amqp091-go', 'github.com/streadway/amqp'],
    env: ['RABBITMQ_URL', 'AMQP_URL'],
  },
};

// Service configs for .moat.yml generation
export const SERVICE_CONFIGS = {
  postgres: {
    image: 'postgres:16',
    env: { POSTGRES_PASSWORD: 'moat', POSTGRES_DB: 'dev' },
    appEnv: { DATABASE_URL: 'postgres://postgres:moat@postgres:5432/dev' },
  },
  redis: {
    image: 'redis:7',
    env: {},
    appEnv: { REDIS_URL: 'redis://redis:6379' },
  },
  mongo: {
    image: 'mongo:7',
    env: {},
    appEnv: { MONGO_URL: 'mongodb://mongo:27017/dev' },
  },
  mysql: {
    image: 'mysql:8',
    env: { MYSQL_ROOT_PASSWORD: 'moat', MYSQL_DATABASE: 'dev' },
    appEnv: { DATABASE_URL: 'mysql://root:moat@mysql:3306/dev' },
  },
  rabbitmq: {
    image: 'rabbitmq:3-management',
    env: {},
    appEnv: { RABBITMQ_URL: 'amqp://rabbitmq:5672' },
  },
};

/**
 * Scan workspace for dependency files and detect needed services.
 * Returns array of service names (e.g., ['postgres', 'redis']).
 */
export function detectDependencies(workspace) {
  const detected = new Set();

  // Scan package.json
  scanNpm(workspace, detected);

  // Scan requirements.txt
  scanPip(workspace, detected);

  // Scan pyproject.toml (simplified — just look for dependency names)
  scanPyproject(workspace, detected);

  // Scan go.mod
  scanGoMod(workspace, detected);

  // Scan .env.example / .env.sample
  scanEnvFile(workspace, detected);

  // Remove services already in existing docker-compose.yml
  removeExistingServices(workspace, detected);

  return [...detected].sort();
}

function scanNpm(workspace, detected) {
  const pkgPath = join(workspace, 'package.json');
  if (!existsSync(pkgPath)) return;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };
    const depNames = Object.keys(allDeps);

    for (const [service, patterns] of Object.entries(SERVICE_MAP)) {
      if (patterns.npm.some(p => depNames.includes(p))) {
        detected.add(service);
      }
    }
  } catch {}
}

function scanPip(workspace, detected) {
  for (const filename of ['requirements.txt', 'requirements-dev.txt', 'requirements/base.txt']) {
    const filePath = join(workspace, filename);
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, 'utf8').toLowerCase();
      const lines = content.split('\n').map(l => l.split('==')[0].split('>=')[0].split('[')[0].trim());

      for (const [service, patterns] of Object.entries(SERVICE_MAP)) {
        if (patterns.pip.some(p => lines.includes(p))) {
          detected.add(service);
        }
      }
    } catch {}
  }
}

function scanPyproject(workspace, detected) {
  const pyprojectPath = join(workspace, 'pyproject.toml');
  if (!existsSync(pyprojectPath)) return;

  try {
    const content = readFileSync(pyprojectPath, 'utf8').toLowerCase();
    for (const [service, patterns] of Object.entries(SERVICE_MAP)) {
      if (patterns.pip.some(p => content.includes(`"${p}"`) || content.includes(`'${p}'`) || content.includes(`${p}>=`) || content.includes(`${p}==`))) {
        detected.add(service);
      }
    }
  } catch {}
}

function scanGoMod(workspace, detected) {
  const goModPath = join(workspace, 'go.mod');
  if (!existsSync(goModPath)) return;

  try {
    const content = readFileSync(goModPath, 'utf8');
    for (const [service, patterns] of Object.entries(SERVICE_MAP)) {
      if (patterns.go.some(p => content.includes(p))) {
        detected.add(service);
      }
    }
  } catch {}
}

function scanEnvFile(workspace, detected) {
  for (const filename of ['.env.example', '.env.sample', '.env.template']) {
    const filePath = join(workspace, filename);
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, 'utf8');
      for (const [service, patterns] of Object.entries(SERVICE_MAP)) {
        if (patterns.env.some(p => content.includes(p))) {
          detected.add(service);
        }
      }
    } catch {}
  }
}

function removeExistingServices(workspace, detected) {
  const composePath = join(workspace, 'docker-compose.yml');
  if (!existsSync(composePath)) return;

  try {
    const content = readFileSync(composePath, 'utf8');
    // Simple check: if the service name appears as an image reference, skip it
    for (const service of [...detected]) {
      if (content.includes(`image: ${service}`) || content.includes(`image: '${service}`) || content.includes(`${service}:`)) {
        detected.delete(service);
      }
    }
  } catch {}
}
