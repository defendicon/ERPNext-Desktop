const { spawn } = require('node:child_process');
const { mkdir, writeFile, access, rm } = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const {
  REQUIRED_FEATURES,
  enableWindowsFeatures,
  inspectWindowsRequirements
} = require('./windows-requirements.cjs');

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

function createLineCollector(onLine) {
  let remainder = '';
  return {
    push(chunk) {
      remainder += String(chunk);
      let newlineIndex = remainder.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = remainder.slice(0, newlineIndex).replace(/\r$/, '');
        remainder = remainder.slice(newlineIndex + 1);
        if (line) onLine(line);
        newlineIndex = remainder.indexOf('\n');
      }
    },
    flush() {
      const line = remainder.replace(/\r$/, '');
      remainder = '';
      if (line) onLine(line);
    }
  };
}

function run(command, args, options = {}, onLine = () => {}) {
  return new Promise((resolve, reject) => {
    const output = { stdout: [], stderr: [] };
    const child = spawn(command, args, { ...options, windowsHide: true, shell: false });
    const collectors = {};
    const collectorFor = (kind) => createLineCollector((line) => {
      output[kind].push(line);
      if (output[kind].length > 80) output[kind].shift();
      onLine({ kind, line });
    });
    collectors.stdout = collectorFor('stdout');
    collectors.stderr = collectorFor('stderr');
    child.stdout?.on('data', (chunk) => collectors.stdout.push(chunk));
    child.stderr?.on('data', (chunk) => collectors.stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      collectors.stdout.flush();
      collectors.stderr.flush();
      if (code === 0) return resolve({ stdout: output.stdout.join('\n'), stderr: output.stderr.join('\n') });
      const details = [...output.stderr, ...output.stdout]
        .map((line) => line.replace(/\0/g, '').replace(/\x1b\[[0-9;]*m/g, '').trim())
        .filter(Boolean)
        .slice(-12)
        .join('\n')
        .slice(-2400);
      const error = new Error(`${path.basename(command)} exited with code ${code}${details ? `:\n${details}` : ''}`);
      error.code = code;
      error.stdout = output.stdout.join('\n');
      error.stderr = output.stderr.join('\n');
      reject(error);
    });
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
    path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
    path.join(localAppData, 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe')
  ]);
  return { git: git || 'git', docker: docker || 'docker' };
}

async function commandExists(command, args = ['--version']) {
  try { await run(command, args); return true; } catch { return false; }
}

async function windowsRestartPending() {
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'
  ];
  for (const key of keys) {
    if (await commandExists('reg.exe', ['query', key])) return true;
  }
  // PendingFileRenameOperations is intentionally ignored here. Browsers and
  // updaters commonly leave unrelated entries behind after a successful boot,
  // so treating it as a WSL/Docker restart signal creates a permanent loop.
  return false;
}

async function preflight(dependencies = {}) {
  const getTools = dependencies.resolveTools || resolveTools;
  const exists = dependencies.commandExists || commandExists;
  const inspectRequirements = dependencies.inspectWindowsRequirements || (() => inspectWindowsRequirements(run));
  const tools = await getTools();
  const [docker, compose, git, winget, wsl, windowsRequirements] = await Promise.all([
    exists(tools.docker),
    exists(tools.docker, ['compose', 'version']),
    exists(tools.git),
    exists('winget.exe', ['--version']),
    exists('wsl.exe', ['--status']),
    inspectRequirements()
  ]);
  let engine = false;
  if (docker) engine = await exists(tools.docker, ['ps', '--format', '{{.ID}}']);
  const featuresReady = windowsRequirements.features.wsl === 'enabled' &&
    windowsRequirements.features.virtualMachinePlatform === 'enabled';
  return {
    docker,
    compose,
    git,
    engine,
    winget,
    wsl,
    ...windowsRequirements,
    ready: docker && compose && git && engine && featuresReady
  };
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
  const args = [
    'install', '--id', requirement.wingetId, '--exact', '--source', 'winget',
    '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity', '--silent'
  ];
  if (id === 'docker') {
    args.push('--override', 'install --quiet --accept-license --backend=wsl-2 --always-run-service');
  }
  await run('winget.exe', args, {}, emit);
  return { id, installed: true, restartRequired: false };
}

async function startDockerDesktop(emit = () => {}) {
  const tools = await resolveTools();
  if (await commandExists(tools.docker, ['desktop', 'version'])) {
    try {
      await run(tools.docker, ['desktop', 'start', '--detach'], {}, emit);
      return { started: true, method: 'cli' };
    } catch { /* Older or unhealthy Desktop versions can require the executable fallback. */ }
  }
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const localAppData = process.env.LOCALAPPDATA || '';
  const executable = await firstExisting([
    path.join(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe'),
    path.join(localAppData, 'Programs', 'DockerDesktop', 'Docker Desktop.exe')
  ]);
  if (!executable) throw new Error('Docker Desktop is not installed.');
  const child = spawn(executable, ['--minimized'], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
  return { started: true, method: 'executable' };
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForDockerEngine(tools, emit = () => {}, attempts = 150) {
  let lastError;
  let recoverableFailures = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await run(tools.docker, ['ps', '--format', '{{.ID}}']);
      return true;
    } catch (error) {
      lastError = error;
      recoverableFailures = isRecoverableDockerError(error) ? recoverableFailures + 1 : 0;
      if (recoverableFailures >= 3) throw error;
    }
    if (attempt % 10 === 0) emit({ kind: 'progress', line: 'Waiting for the Docker engine to become ready…', progress: 15 });
    await pause(2000);
  }
  throw lastError || new Error('Docker engine did not become ready.');
}

function isRecoverableDockerError(error) {
  return /Docker Desktop is unable to start|DockerDesktop\/Wsl\/ExecError|dockerDesktopLinuxEngine\/_ping|500 Internal Server Error/i.test(String(error?.message || error));
}

async function recoverDockerEngine(emit = () => {}) {
  const tools = await resolveTools();
  emit({ kind: 'progress', phase: 'Repairing the Docker engine', image: 'Docker Desktop + WSL 2', line: 'Restarting the private Docker WSL engine in the background.', progress: 20 });
  try { await run(tools.docker, ['desktop', 'stop']); } catch { /* It may already be stopped. */ }
  try { await run('wsl.exe', ['--terminate', 'docker-desktop']); } catch { /* The distro may not be running yet. */ }
  await startDockerDesktop(emit);
  await waitForDockerEngine(tools, emit, 90);
  return true;
}

async function runDocker(tools, args, options, onLine, allowRecovery = true) {
  try {
    return await run(tools.docker, args, options, onLine);
  } catch (error) {
    if (!allowRecovery || !isRecoverableDockerError(error)) throw error;
    await recoverDockerEngine(onLine);
    return run(tools.docker, args, options, onLine);
  }
}

function restartRequiredError() {
  return new Error('Windows must restart to finish WSL 2 and virtualization setup. Restart Windows, reopen ERPNext Desktop, and click Install—the selected apps are saved and no Docker login is required.');
}

async function ensureRequirements(emit = () => {}, dependencies = {}) {
  const checkPreflight = dependencies.preflight || preflight;
  const enableFeatures = dependencies.enableWindowsFeatures || ((names, report) => enableWindowsFeatures(run, names, report));
  const installMissingRequirement = dependencies.installRequirement || installRequirement;
  const hasPendingRestart = dependencies.windowsRestartPending || windowsRestartPending;
  const startDocker = dependencies.startDockerDesktop || startDockerDesktop;
  const getTools = dependencies.resolveTools || resolveTools;
  const waitForEngine = dependencies.waitForDockerEngine || waitForDockerEngine;
  const recoverEngine = dependencies.recoverDockerEngine || recoverDockerEngine;

  emit({ kind: 'progress', phase: 'Checking Windows requirements', image: 'System readiness scan', line: 'Checking WSL, Git, Docker Desktop and Docker Compose.', progress: 2 });
  let status = await checkPreflight();
  let restartRequired = false;

  if (status.firmwareVirtualization === false) {
    throw new Error('Hardware virtualization is disabled. Enable Intel VT-x/VT-d or AMD-V/SVM in BIOS/UEFI, restart Windows, then reopen ERPNext Desktop. This firmware setting cannot be enabled automatically.');
  }

  const initialFeatureStates = Object.values(status.features);
  if (initialFeatureStates.includes('restart-pending')) throw restartRequiredError();
  if (initialFeatureStates.includes('unknown')) {
    throw new Error('Unable to inspect required Windows virtualization features. No changes were made.');
  }

  const missingFeatures = Object.entries(status.features)
    .filter(([, state]) => state === 'disabled')
    .map(([id]) => REQUIRED_FEATURES[id]);
  if (missingFeatures.length > 0) {
    const result = await enableFeatures(missingFeatures, emit);
    if (result.restartNeeded) throw restartRequiredError();

    status = await checkPreflight();
    const updatedFeatureStates = Object.values(status.features);
    if (updatedFeatureStates.includes('restart-pending')) throw restartRequiredError();
    if (updatedFeatureStates.some((state) => state !== 'enabled')) {
      throw new Error('Windows could not finish enabling the required virtualization features. Restart Windows, reopen ERPNext Desktop, and click Install again.');
    }
  }

  if (!status.wsl) {
    emit({ kind: 'progress', phase: 'Installing Windows Subsystem for Linux', image: 'Microsoft.WSL', line: 'Downloading and enabling WSL 2 silently.', progress: 5 });
    emit({ kind: 'progress', line: 'Enabling Windows Subsystem for Linux…', progress: 4 });
    const result = await installMissingRequirement('wsl', emit);
    restartRequired ||= result.restartRequired;
  }
  if (!status.git) {
    emit({ kind: 'progress', phase: 'Installing Git', image: 'Git.Git', line: 'Downloading the verified Git for Windows package.', progress: 9 });
    emit({ kind: 'progress', line: 'Installing Git from the official Windows package…', progress: 7 });
    await installMissingRequirement('git', emit);
  }

  status = await checkPreflight();
  if (!status.docker || !status.compose) {
    emit({ kind: 'progress', phase: 'Installing Docker Desktop', image: 'Docker.DockerDesktop', line: 'Downloading Docker Desktop and Docker Compose silently.', progress: 14 });
    emit({ kind: 'progress', line: 'Installing Docker Desktop and Docker Compose…', progress: 11 });
    const result = await installMissingRequirement('docker', emit);
    restartRequired ||= result.restartRequired;
  }

  if (restartRequired) {
    throw restartRequiredError();
  }

  status = await checkPreflight();
  if (!status.engine && await hasPendingRestart()) {
    throw restartRequiredError();
  }
  if (!status.engine && status.docker) {
    emit({ kind: 'progress', phase: 'Starting the container engine', image: 'Docker Desktop', line: 'Starting Docker Desktop in the background.', progress: 20 });
    emit({ kind: 'progress', line: 'Starting Docker Desktop…', progress: 14 });
    await startDocker(emit);
    const tools = await getTools();
    try { await waitForEngine(tools, emit); }
    catch (error) {
      if (!isRecoverableDockerError(error)) throw error;
      await recoverEngine(emit);
    }
  }

  status = await checkPreflight();
  if (!status.ready) {
    if (restartRequired) throw restartRequiredError();
    throw new Error('Docker Desktop did not become ready. Restart Windows, reopen ERPNext Desktop, and click Install again; no Docker login is required.');
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
  return ({ kind, line, phase: reportedPhase, image: reportedImage, progress: reportedProgress }) => {
    value = Math.min(to, value + 1);
    emit({
      kind,
      phase: reportedPhase || phase,
      image: reportedImage || imageFromLine(line, fallbackImage),
      line,
      progress: reportedProgress === undefined ? value : reportedProgress
    });
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
  try { await runDocker(tools, ['ps', '--format', '{{.ID}}'], {}, () => {}); }
  catch (error) { throw new Error(`Docker's Linux engine could not be prepared. ${error.message}`); }
  await mkdir(rootDir, { recursive: true });
  const dockerDir = path.join(rootDir, 'frappe_docker');
  emit({ kind: 'progress', phase: 'Downloading ERPNext build tools', image: 'frappe/frappe_docker', line: 'Getting the official Frappe Docker configuration.', progress: 26 });
  try { await access(path.join(dockerDir, '.git')); }
  catch { await run(tools.git, ['clone', '--depth', '1', 'https://github.com/frappe/frappe_docker.git', dockerDir], {}, progressReporter(emit, 'Downloading ERPNext build tools', 'frappe/frappe_docker', 26, 31)); }
  const appsPath = path.join(rootDir, 'apps.json');
  await writeFile(appsPath, JSON.stringify(plan.apps.map(({ url, branch }) => ({ url, branch })), null, 2));
  emit({ kind: 'progress', line: 'Building the selected official apps…', progress: 28 });
  emit({ kind: 'progress', phase: 'Building your ERPNext image', image: plan.image, line: 'Downloading image layers and adding the selected official apps.', progress: 32 });
  await runDocker(tools, ['build', '--progress', 'plain', '--build-arg', `FRAPPE_BRANCH=version-${plan.config.version}`, '--secret', `id=apps_json,src=${appsPath}`, '--tag', plan.image, '--file', 'images/layered/Containerfile', '.'], { cwd: dockerDir }, progressReporter(emit, 'Building your ERPNext image', plan.image, 32, 79));
  const dbPassword = crypto.randomBytes(24).toString('base64url');
  const adminPassword = plan.config.adminPassword || crypto.randomBytes(14).toString('base64url');
  await writeFile(path.join(rootDir, 'compose.yaml'), composeYaml(plan, dbPassword, adminPassword));
  await writeFile(path.join(rootDir, 'credentials.json'), JSON.stringify({ site: plan.config.siteName, admin: 'Administrator', password: adminPassword, url: `http://127.0.0.1:${plan.config.port}` }, null, 2), { mode: 0o600 });
  emit({ kind: 'progress', line: 'Starting ERPNext services…', progress: 82 });
  emit({ kind: 'progress', phase: 'Preparing your site', image: plan.config.siteName, line: 'Writing the private local configuration and credentials.', progress: 82 });
  emit({ kind: 'progress', phase: 'Starting ERPNext services', image: 'mariadb:10.11 + redis:7-alpine', line: 'Downloading the database and cache images.', progress: 86 });
  await runDocker(tools, ['compose', '--progress', 'plain', '-f', 'compose.yaml', 'up', '-d'], { cwd: rootDir }, progressReporter(emit, 'Starting ERPNext services', plan.image, 86, 98));
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

module.exports = { createLineCollector, preflight, installRequirement, startDockerDesktop, ensureRequirements, makePlan, install, workspaceStatus, removeWorkspace };
