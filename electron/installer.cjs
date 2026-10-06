const { spawn } = require('node:child_process');
const { mkdir, writeFile, access, rm } = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

const APP_CATALOG = {
  erpnext: { url: 'https://github.com/frappe/erpnext', branches: { 15: 'version-15', 16: 'version-16' } },
  hrms: { url: 'https://github.com/frappe/hrms', branches: { 15: 'version-15', 16: 'version-16' } },
  payments: { url: 'https://github.com/frappe/payments', branches: { 15: 'version-15', 16: 'version-16' } },
  crm: { url: 'https://github.com/frappe/crm', branches: { 15: 'main', 16: 'main' } },
  helpdesk: { url: 'https://github.com/frappe/helpdesk', branches: { 15: 'main', 16: 'main' } },
  lms: { url: 'https://github.com/frappe/lms', branches: { 15: 'version-15', 16: 'version-16' } },
  insights: { url: 'https://github.com/frappe/insights', branches: { 15: 'main', 16: 'main' } },
  drive: { url: 'https://github.com/frappe/drive', branches: { 15: 'main', 16: 'main' } },
  builder: { url: 'https://github.com/frappe/builder', branches: { 15: 'master', 16: 'master' } },
  wiki: { url: 'https://github.com/frappe/wiki', branches: { 15: 'master', 16: 'master' } }
};

function run(command, args, options = {}, onLine = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true, shell: false });
    const pump = (kind) => (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => onLine({ kind, line }));
    child.stdout?.on('data', pump('stdout'));
    child.stderr?.on('data', pump('stderr'));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function firstExisting(paths) {
  for (const candidate of paths) {
    try { await access(candidate); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

async function resolveTools() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const localAppData = process.env.LOCALAPPDATA || '';
  const git = await firstExisting([
    path.join(programFiles, 'Git', 'cmd', 'git.exe'),
    path.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe')
  ]);
  const docker = await firstExisting([
    path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')
  ]);
  return { git: git || 'git', docker: docker || 'docker' };
}

async function commandExists(command, args = ['--version']) {
  try { await run(command, args); return true; } catch { return false; }
}

async function preflight() {
  const tools = await resolveTools();
  const [docker, compose, git, winget, wsl] = await Promise.all([
    commandExists(tools.docker),
    commandExists(tools.docker, ['compose', 'version']),
    commandExists(tools.git),
    commandExists('winget.exe', ['--version']),
    commandExists('wsl.exe', ['--status'])
  ]);
  let engine = false;
  if (docker) engine = await commandExists(tools.docker, ['info']);
  return { docker, compose, git, engine, winget, wsl, ready: docker && compose && git && engine };
}

const REQUIREMENTS = {
  git: { wingetId: 'Git.Git', label: 'Git' },
  docker: { wingetId: 'Docker.DockerDesktop', label: 'Docker Desktop' }
};

async function installRequirement(id, emit = () => {}) {
  if (id === 'wsl') {
    emit({ kind: 'progress', phase: 'Installing Windows Subsystem for Linux', image: 'Microsoft.WSL', line: 'Enabling WSL 2 with administrator access.' });
    await run('wsl.exe', ['--install', '--no-distribution'], {}, emit);
    return { id, installed: true, restartRequired: true };
  }
  const requirement = REQUIREMENTS[id];
  if (!requirement) throw new Error('Unknown requirement requested.');
  if (!await commandExists('winget.exe', ['--version'])) {
    throw new Error('Microsoft App Installer (winget) is required. Install App Installer from Microsoft Store, then try again.');
  }
  emit({ kind: 'progress', phase: `Installing ${requirement.label}`, image: requirement.wingetId, line: `Downloading ${requirement.label} silently.` });
  emit({ kind: 'progress', line: `Downloading ${requirement.label} from its verified winget package…` });
  await run('winget.exe', [
    'install', '--id', requirement.wingetId, '--exact', '--source', 'winget',
    '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity', '--silent'
  ], {}, emit);
  return { id, installed: true, restartRequired: id === 'docker' };
}

async function startDockerDesktop() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const executable = await firstExisting([path.join(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe')]);
  if (!executable) throw new Error('Docker Desktop is not installed.');
  const child = spawn(executable, ['--minimized'], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
  return { started: true };
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function ensureRequirements(emit = () => {}) {
  emit({ kind: 'progress', phase: 'Checking Windows requirements', image: 'System readiness scan', line: 'Checking WSL, Git, Docker Desktop and Docker Compose.', progress: 2 });
  let status = await preflight();
  let restartRequired = false;

  if (!status.wsl) {
    emit({ kind: 'progress', phase: 'Installing Windows Subsystem for Linux', image: 'Microsoft.WSL', line: 'Downloading and enabling WSL 2 silently.', progress: 5 });
    emit({ kind: 'progress', line: 'Enabling Windows Subsystem for Linux…', progress: 4 });
    const result = await installRequirement('wsl', emit);
    restartRequired ||= result.restartRequired;
  }
  if (!status.git) {
    emit({ kind: 'progress', phase: 'Installing Git', image: 'Git.Git', line: 'Downloading the verified Git for Windows package.', progress: 9 });
    emit({ kind: 'progress', line: 'Installing Git from the official Windows package…', progress: 7 });
    await installRequirement('git', emit);
  }

  status = await preflight();
  if (!status.docker || !status.compose) {
    emit({ kind: 'progress', phase: 'Installing Docker Desktop', image: 'Docker.DockerDesktop', line: 'Downloading Docker Desktop and Docker Compose silently.', progress: 14 });
    emit({ kind: 'progress', line: 'Installing Docker Desktop and Docker Compose…', progress: 11 });
    const result = await installRequirement('docker', emit);
    restartRequired ||= result.restartRequired;
  }

  status = await preflight();
  if (!status.engine && status.docker) {
    emit({ kind: 'progress', phase: 'Starting the container engine', image: 'Docker Desktop', line: 'Starting Docker Desktop in the background.', progress: 20 });
    emit({ kind: 'progress', line: 'Starting Docker Desktop…', progress: 14 });
    await startDockerDesktop();
    const tools = await resolveTools();
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (await commandExists(tools.docker, ['info'])) break;
      if (attempt % 10 === 0) emit({ kind: 'progress', line: 'Waiting for the Docker engine to become ready…', progress: 15 });
      await pause(2000);
    }
  }

  status = await preflight();
  if (!status.ready) {
    if (restartRequired) throw new Error('Windows must restart to finish WSL 2 and Docker setup. Restart the PC, reopen ERPNext Desktop, and click Install—the selected apps are saved.');
    throw new Error('Automatic prerequisite setup did not finish. Open Docker Desktop once, accept its first-run prompt if shown, then click Install again.');
  }
  emit({ kind: 'progress', phase: 'Windows requirements are ready', image: 'WSL 2 + Git + Docker Desktop', line: 'All prerequisites are installed and running.', progress: 24 });
  return status;
}

function imageFromLine(line, fallback = '') {
  const text = String(line || '');
  const match = text.match(/(?:docker\.io\/|ghcr\.io\/)?(?:frappe\/|library\/)?(?:frappe|erpnext|mariadb|redis)[a-z0-9_.\/-]*(?::[a-z0-9_.-]+)?/i);
  return match?.[0] || fallback;
}

function progressReporter(emit, phase, fallbackImage, from, to) {
  let value = from;
  return ({ kind, line }) => {
    value = Math.min(to, value + 1);
    emit({ kind, phase, image: imageFromLine(line, fallbackImage), line, progress: value });
  };
}

function normalizeConfig(input) {
  const version = input.version === '15' ? '15' : '16';
  const selected = [...new Set(['erpnext', ...(input.apps || [])])].filter((id) => APP_CATALOG[id]);
  const rawSiteName = String(input.siteName || 'erp').toLowerCase().replace(/[^a-z0-9.-]/g, '') || 'erp';
  return {
    version,
    apps: selected,
    siteName: rawSiteName.includes('.') ? rawSiteName : `${rawSiteName}.localhost`,
    port: Math.max(1024, Math.min(65535, Number(input.port) || 8080)),
    adminPassword: String(input.adminPassword || '')
  };
}

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(start = 8080) {
  for (let port = start; port < start + 100; port += 1) {
    if (await portIsAvailable(port)) return port;
  }
  throw new Error('No free local port was found between 8080 and 8179.');
}

function makePlan(raw, rootDir) {
  const config = normalizeConfig(raw);
  const apps = config.apps.map((id) => ({
    id,
    url: APP_CATALOG[id].url,
    branch: APP_CATALOG[id].branches[config.version]
  }));
  return {
    config,
    apps,
    rootDir,
    image: `erpnext-desktop:${config.version}-${crypto.createHash('sha1').update(JSON.stringify(apps)).digest('hex').slice(0, 8)}`,
    steps: [
      'Check Docker Desktop and Git',
      'Download official frappe_docker tooling',
      `Build ERPNext v${config.version} image with ${apps.length - 1} selected add-on${apps.length === 2 ? '' : 's'}`,
      `Create site ${config.siteName}`,
      'Start database, Redis, workers, realtime and web services'
    ]
  };
}

function composeYaml(plan, dbPassword, adminPassword) {
  const apps = plan.apps.map((app) => app.id).join(' ');
  return `name: erpnext-desktop\n\nx-image: &image\n  image: ${plan.image}\n  restart: unless-stopped\n  volumes:\n    - sites:/home/frappe/frappe-bench/sites\n    - logs:/home/frappe/frappe-bench/logs\n\nservices:\n  db:\n    image: mariadb:10.11\n    restart: unless-stopped\n    command: --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci\n    environment:\n      MARIADB_ROOT_PASSWORD: ${dbPassword}\n    volumes: [db:/var/lib/mysql]\n\n  redis-cache:\n    image: redis:7-alpine\n    restart: unless-stopped\n  redis-queue:\n    image: redis:7-alpine\n    restart: unless-stopped\n\n  configurator:\n    <<: *image\n    restart: no\n    entrypoint: [bash, -c]\n    command: >-\n      ls -1 apps > sites/apps.txt;\n      bench set-config -g db_host db;\n      bench set-config -gp db_port 3306;\n      bench set-config -g redis_cache redis://redis-cache:6379;\n      bench set-config -g redis_queue redis://redis-queue:6379;\n      bench set-config -g redis_socketio redis://redis-queue:6379;\n      bench set-config -gp socketio_port 9000;\n\n  create-site:\n    <<: *image\n    restart: no\n    depends_on:\n      configurator: { condition: service_completed_successfully }\n      db: { condition: service_started }\n    entrypoint: [bash, -c]\n    command: >-\n      wait-for-it -t 120 db:3306;\n      test -d sites/${plan.config.siteName} ||\n      bench new-site ${plan.config.siteName} --mariadb-user-host-login-scope='%' --admin-password '${adminPassword}' --db-root-username root --db-root-password '${dbPassword}' --install-app erpnext;\n      ${plan.apps.filter((a) => a.id !== 'erpnext').map((a) => `bench --site ${plan.config.siteName} install-app ${a.id};`).join('\n      ')}\n      bench --site ${plan.config.siteName} set-config developer_mode 0;\n\n  backend:\n    <<: *image\n    depends_on:\n      create-site: { condition: service_completed_successfully }\n  websocket:\n    <<: *image\n    command: [node, /home/frappe/frappe-bench/apps/frappe/socketio.js]\n    depends_on:\n      create-site: { condition: service_completed_successfully }\n  queue-short:\n    <<: *image\n    command: [bench, worker, --queue, short,default]\n    depends_on:\n      create-site: { condition: service_completed_successfully }\n  queue-long:\n    <<: *image\n    command: [bench, worker, --queue, long,default,short]\n    depends_on:\n      create-site: { condition: service_completed_successfully }\n  scheduler:\n    <<: *image\n    command: [bench, schedule]\n    depends_on:\n      create-site: { condition: service_completed_successfully }\n  frontend:\n    <<: *image\n    command: [nginx-entrypoint.sh]\n    environment:\n      BACKEND: backend:8000\n      FRAPPE_SITE_NAME_HEADER: ${plan.config.siteName}\n      SOCKETIO: websocket:9000\n      UPSTREAM_REAL_IP_ADDRESS: 127.0.0.1\n      UPSTREAM_REAL_IP_HEADER: X-Forwarded-For\n      UPSTREAM_REAL_IP_RECURSIVE: 'off'\n      PROXY_READ_TIMEOUT: 120\n      CLIENT_MAX_BODY_SIZE: 50m\n    ports: ['${plan.config.port}:8080']\n    depends_on:\n      backend: { condition: service_started }\n      websocket: { condition: service_started }\n\nvolumes:\n  db:\n  sites:\n  logs:\n`;
}

async function install(raw, appDataDir, emit) {
  const rootDir = path.join(appDataDir, 'instances', 'default');
  const port = raw.port || await findAvailablePort();
  const plan = makePlan({ ...raw, port, version: '16' }, rootDir);
  await ensureRequirements(emit);
  const tools = await resolveTools();
  await mkdir(rootDir, { recursive: true });
  const dockerDir = path.join(rootDir, 'frappe_docker');
  emit({ kind: 'progress', phase: 'Downloading ERPNext build tools', image: 'frappe/frappe_docker', line: 'Getting the official Frappe Docker configuration.', progress: 26 });
  try { await access(path.join(dockerDir, '.git')); }
  catch { await run(tools.git, ['clone', '--depth', '1', 'https://github.com/frappe/frappe_docker.git', dockerDir], {}, progressReporter(emit, 'Downloading ERPNext build tools', 'frappe/frappe_docker', 26, 31)); }
  const appsPath = path.join(rootDir, 'apps.json');
  await writeFile(appsPath, JSON.stringify(plan.apps.map(({ url, branch }) => ({ url, branch })), null, 2));
  emit({ kind: 'progress', line: 'Building the selected official apps…', progress: 28 });
  emit({ kind: 'progress', phase: 'Building your ERPNext image', image: plan.image, line: 'Downloading image layers and adding the selected official apps.', progress: 32 });
  await run(tools.docker, ['build', '--progress', 'plain', '--build-arg', `FRAPPE_BRANCH=version-${plan.config.version}`, '--secret', `id=apps_json,src=${appsPath}`, '--tag', plan.image, '--file', 'images/layered/Containerfile', '.'], { cwd: dockerDir }, progressReporter(emit, 'Building your ERPNext image', plan.image, 32, 79));
  const dbPassword = crypto.randomBytes(24).toString('base64url');
  const adminPassword = plan.config.adminPassword || crypto.randomBytes(14).toString('base64url');
  await writeFile(path.join(rootDir, 'compose.yaml'), composeYaml(plan, dbPassword, adminPassword));
  await writeFile(path.join(rootDir, 'credentials.json'), JSON.stringify({ site: plan.config.siteName, admin: 'Administrator', password: adminPassword, url: `http://127.0.0.1:${plan.config.port}` }, null, 2), { mode: 0o600 });
  emit({ kind: 'progress', line: 'Starting ERPNext services…', progress: 82 });
  emit({ kind: 'progress', phase: 'Preparing your site', image: plan.config.siteName, line: 'Writing the private local configuration and credentials.', progress: 82 });
  emit({ kind: 'progress', phase: 'Starting ERPNext services', image: 'mariadb:10.11 + redis:7-alpine', line: 'Downloading the database and cache images.', progress: 86 });
  await run(tools.docker, ['compose', '--progress', 'plain', '-f', 'compose.yaml', 'up', '-d'], { cwd: rootDir }, progressReporter(emit, 'Starting ERPNext services', plan.image, 86, 98));
  emit({ kind: 'progress', phase: 'ERPNext is ready', image: plan.config.siteName, line: 'Your local ERP workspace is ready to open.', progress: 100 });
  return { ...plan, url: `http://127.0.0.1:${plan.config.port}`, adminPassword };
}

async function workspaceStatus(appDataDir) {
  const rootDir = path.join(appDataDir, 'instances', 'default');
  try {
    await access(path.join(rootDir, 'compose.yaml'));
    return { installed: true, rootDir };
  } catch { return { installed: false, rootDir }; }
}

async function removeWorkspace(appDataDir, options, emit = () => {}) {
  const status = await workspaceStatus(appDataDir);
  if (!status.installed) return { removed: false, reason: 'not-installed' };
  const tools = await resolveTools();
  const deleteData = options?.deleteData === true;
  if (await commandExists(tools.docker)) {
    const args = ['compose', '-f', 'compose.yaml', 'down', '--remove-orphans'];
    if (deleteData) args.push('--volumes', '--rmi', 'local');
    emit({ kind: 'progress', line: deleteData ? 'Stopping services and deleting ERP data volumes…' : 'Stopping ERPNext services…' });
    await run(tools.docker, args, { cwd: status.rootDir }, emit);
  } else if (deleteData) {
    throw new Error('Docker Desktop is required to safely remove the ERP data volumes.');
  }
  if (deleteData) await rm(status.rootDir, { recursive: true, force: true });
  return { removed: true, dataDeleted: deleteData };
}

module.exports = { preflight, installRequirement, startDockerDesktop, ensureRequirements, makePlan, install, workspaceStatus, removeWorkspace };
