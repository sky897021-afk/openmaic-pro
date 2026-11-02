#!/usr/bin/env node

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nextCli = path.join(repositoryRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const devArgs = process.argv.slice(2);

const OPENMAIC_PORT = 3003;
const POSTGRES_PORT = 5432;
const POSTGRES_HOST = process.env.OPENMAIC_POSTGRES_HOST ?? '127.0.0.1';
const POSTGRES_SERVICE = process.env.OPENMAIC_POSTGRES_SERVICE ?? 'postgresql-x64-17';
const POSTGRES_START_TIMEOUT_MS = 30_000;

function readRequestedPort(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--') continue;
    if (argument === '-p' || argument === '--port') {
      return parsePort(args[index + 1]);
    }
    if (argument.startsWith('--port=')) {
      return parsePort(argument.slice('--port='.length));
    }
    if (argument.startsWith('-p') && argument.length > 2) {
      return parsePort(argument.slice(2));
    }
  }

  return parsePort(process.env.PORT);
}

function parsePort(value) {
  if (value === undefined || value === null || value === '') return undefined;

  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function powershell(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readPostgresServiceState() {
  if (!/^[A-Za-z0-9_.-]+$/.test(POSTGRES_SERVICE)) {
    throw new Error(`Invalid PostgreSQL service name: ${POSTGRES_SERVICE}`);
  }

  const service = quotePowerShell(POSTGRES_SERVICE);
  const result = await powershell(
    `$service = Get-Service -Name ${service} -ErrorAction SilentlyContinue; ` +
      `if ($null -eq $service) { exit 3 }; ` +
      `if ($service.Status -eq 'Running') { exit 0 }; exit 1`,
  );

  if (result.code === 0) return 'running';
  if (result.code === 1) return 'stopped';
  if (result.code === 3) return 'missing';

  throw new Error(
    `Unable to query PostgreSQL service ${POSTGRES_SERVICE}: ${result.stderr.trim() || `exit ${result.code}`}`,
  );
}

async function startPostgresService() {
  const service = quotePowerShell(POSTGRES_SERVICE);
  const result = await powershell(
    `$ErrorActionPreference = 'Stop'; Start-Service -Name ${service}`,
  );

  if (result.code === 0) return;

  console.log(
    `[dev] PostgreSQL needs administrator permission; requesting approval to start ${POSTGRES_SERVICE}...`,
  );

  const elevatedResult = await powershell(
    `$process = Start-Process -FilePath 'sc.exe' ` +
      `-ArgumentList @('start', ${service}) -Verb RunAs -Wait -PassThru -WindowStyle Hidden; ` +
      `exit $process.ExitCode`,
  );

  if ((await readPostgresServiceState()) === 'running') return;

  throw new Error(
    `PostgreSQL service ${POSTGRES_SERVICE} did not start. ` +
      `Approve the Windows administrator prompt when it appears. ` +
      `${elevatedResult.stderr.trim() || `exit ${elevatedResult.code}`}`,
  );
}

function canConnectToPostgres() {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: POSTGRES_HOST,
      port: POSTGRES_PORT,
    });
    let settled = false;

    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };

    socket.setTimeout(1_000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForPostgres() {
  const deadline = Date.now() + POSTGRES_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await canConnectToPostgres()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `PostgreSQL did not accept connections on ${POSTGRES_HOST}:${POSTGRES_PORT} ` +
      `within ${POSTGRES_START_TIMEOUT_MS / 1_000} seconds.`,
  );
}

async function ensurePostgres() {
  const state = await readPostgresServiceState();

  if (state === 'missing') {
    throw new Error(`PostgreSQL service ${POSTGRES_SERVICE} was not found.`);
  }

  if (state === 'stopped') {
    console.log(`[dev] Starting PostgreSQL service ${POSTGRES_SERVICE}...`);
    await startPostgresService();
    console.log('[dev] Waiting for PostgreSQL to accept connections...');
  }

  await waitForPostgres();
  console.log('[dev] PostgreSQL is ready.');
}

function startNext() {
  const child = spawn(process.execPath, [nextCli, 'dev', ...devArgs], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      child.kill(signal);
    });
  }

  child.once('error', (error) => {
    console.error(`[dev] Failed to start Next.js: ${error.message}`);
    process.exitCode = 1;
  });

  child.once('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exitCode = code ?? 1;
  });
}

const requestedPort = readRequestedPort(devArgs);

if (requestedPort === OPENMAIC_PORT && process.platform === 'win32') {
  try {
    await ensurePostgres();
  } catch (error) {
    console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

startNext();
