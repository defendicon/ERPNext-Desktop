const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createLineCollector,
  ensureRequirements,
  preflight,
  runDocker
} = require('./installer.cjs');
const { REQUIRED_FEATURES } = require('./windows-requirements.cjs');

const ENABLED_FEATURES = Object.freeze({
  wsl: 'enabled',
  virtualMachinePlatform: 'enabled'
});

function status(overrides = {}) {
  const result = {
    docker: true,
    compose: true,
    git: true,
    engine: true,
    winget: true,
    wsl: true,
    features: { ...ENABLED_FEATURES },
    firmwareVirtualization: true,
    ...overrides
  };
  result.features = { ...ENABLED_FEATURES, ...(overrides.features || {}) };
  result.ready = overrides.ready ?? (
    result.docker && result.compose && result.git && result.engine &&
    result.features.wsl === 'enabled' &&
    result.features.virtualMachinePlatform === 'enabled'
  );
  return result;
}

function sequence(values) {
  let index = 0;
  return async () => values[Math.min(index++, values.length - 1)];
}

function harness(preflightStatuses, overrides = {}) {
  const actions = { enable: [], install: [], start: 0, wait: 0, recover: 0 };
  const dependencies = {
    preflight: sequence(preflightStatuses),
    enableWindowsFeatures: async (names) => {
      actions.enable.push([...names]);
      return { restartNeeded: false };
    },
    installRequirement: async (id) => {
      actions.install.push(id);
      return { id, installed: true, restartRequired: false };
    },
    windowsRestartPending: async () => false,
    startDockerDesktop: async () => { actions.start += 1; },
    resolveTools: async () => ({ git: 'git', docker: 'docker' }),
    waitForDockerEngine: async () => { actions.wait += 1; },
    recoverDockerEngine: async () => { actions.recover += 1; },
    ...overrides
  };
  return { actions, dependencies };
}

test('line collector reconstructs a marker JSON line split across process chunks', () => {
  const lines = [];
  const collector = createLineCollector((line) => lines.push(line));

  collector.push('ERPNextDesktopRequire');
  collector.push('ments:{"features":{"VirtualMachine');
  collector.push('Platform":"Enabled"}}\r');
  collector.push('\nnext line\nfinal fragment');
  collector.flush();

  assert.deepEqual(lines, [
    'ERPNextDesktopRequirements:{"features":{"VirtualMachinePlatform":"Enabled"}}',
    'next line',
    'final fragment'
  ]);
});

test('line collector reconstructs UTF-8 characters split across Buffer chunks', () => {
  const lines = [];
  const collector = createLineCollector((line) => lines.push(line));
  const encoded = Buffer.from('virtualisation café\n', 'utf8');
  const splitAt = encoded.indexOf(0xc3) + 1;

  collector.push(encoded.subarray(0, splitAt));
  collector.push(encoded.subarray(splitAt));
  collector.flush();

  assert.deepEqual(lines, ['virtualisation café']);
});

test('line collector caps an unterminated fragment while retaining its diagnostic tail', () => {
  const lines = [];
  const collector = createLineCollector((line) => lines.push(line), 8);

  collector.push('discard-this-diagnostic-tail');
  collector.flush();

  assert.deepEqual(lines, ['tic-tail']);
});

test('line collector caps a completed overlong line before emitting its diagnostic tail', () => {
  const lines = [];
  const collector = createLineCollector((line) => lines.push(line), 8);

  collector.push('discard-this-diagnostic-tail\nshort\n');
  collector.flush();

  assert.deepEqual(lines, ['tic-tail', 'short']);
});

test('production preflight invokes the Windows inspector and gates readiness on both features', async () => {
  let inspections = 0;
  const dependencies = {
    resolveTools: async () => ({ git: 'git.exe', docker: 'docker.exe' }),
    commandExists: async () => true,
    inspectWindowsRequirements: async () => {
      inspections += 1;
      return {
        features: { wsl: 'disabled', virtualMachinePlatform: 'enabled' },
        firmwareVirtualization: true
      };
    }
  };

  const blocked = await preflight(dependencies);
  assert.equal(inspections, 1);
  assert.deepEqual(blocked.features, { wsl: 'disabled', virtualMachinePlatform: 'enabled' });
  assert.equal(blocked.firmwareVirtualization, true);
  assert.equal(blocked.ready, false);

  dependencies.inspectWindowsRequirements = async () => {
    inspections += 1;
    return { features: { wsl: 'enabled' }, firmwareVirtualization: true };
  };
  const incomplete = await preflight(dependencies);
  assert.equal(incomplete.ready, false);

  dependencies.inspectWindowsRequirements = async () => {
    inspections += 1;
    return { features: { ...ENABLED_FEATURES }, firmwareVirtualization: null };
  };
  const ready = await preflight(dependencies);
  assert.equal(inspections, 3);
  assert.equal(ready.ready, true);
});

test('firmware disabled takes precedence over disabled features and blocks all mutations', async () => {
  const { actions, dependencies } = harness([status({
    features: { wsl: 'disabled', virtualMachinePlatform: 'disabled' },
    firmwareVirtualization: false
  })]);

  await assert.rejects(
    ensureRequirements(() => {}, dependencies),
    /Hardware virtualization is disabled\. Enable Intel VT-x\/VT-d or AMD-V\/SVM in BIOS\/UEFI/
  );
  assert.deepEqual(actions, { enable: [], install: [], start: 0, wait: 0, recover: 0 });
});

test('a restart-pending feature requests restart before Docker or package changes', async () => {
  const { actions, dependencies } = harness([status({ features: { wsl: 'restart-pending' } })]);

  await assert.rejects(ensureRequirements(() => {}, dependencies), /Windows must restart to finish WSL 2 and virtualization setup/);
  assert.deepEqual(actions, { enable: [], install: [], start: 0, wait: 0, recover: 0 });
});

test('enables only Virtual Machine Platform when it is the only disabled feature', async () => {
  const initial = status({ features: { virtualMachinePlatform: 'disabled' } });
  const enabled = status();
  const { actions, dependencies } = harness([initial, enabled]);

  await ensureRequirements(() => {}, dependencies);
  assert.deepEqual(actions.enable, [[REQUIRED_FEATURES.virtualMachinePlatform]]);
  assert.deepEqual(actions.install, []);
  assert.equal(actions.start, 0);
});

test('stops before Docker when feature enablement requires a restart', async () => {
  const initial = status({ features: { virtualMachinePlatform: 'disabled' } });
  const { actions, dependencies } = harness([initial], {
    enableWindowsFeatures: async (names) => {
      actions.enable.push([...names]);
      return { restartNeeded: true };
    }
  });

  await assert.rejects(ensureRequirements(() => {}, dependencies), /Windows must restart to finish WSL 2 and virtualization setup/);
  assert.deepEqual(actions.enable, [[REQUIRED_FEATURES.virtualMachinePlatform]]);
  assert.deepEqual(actions.install, []);
  assert.equal(actions.start, 0);
});

test('continues to ready when feature enablement completes without restart', async () => {
  const { actions, dependencies } = harness([
    status({ features: { wsl: 'disabled', virtualMachinePlatform: 'disabled' } }),
    status()
  ]);

  const result = await ensureRequirements(() => {}, dependencies);
  assert.equal(result.ready, true);
  assert.deepEqual(actions.enable, [[REQUIRED_FEATURES.wsl, REQUIRED_FEATURES.virtualMachinePlatform]]);
  assert.deepEqual(actions.install, []);
  assert.equal(actions.start, 0);
});

test('requests restart when reinspection after enablement reports pending state', async () => {
  const { actions, dependencies } = harness([
    status({ features: { virtualMachinePlatform: 'disabled' } }),
    status({ features: { virtualMachinePlatform: 'restart-pending' } })
  ]);

  await assert.rejects(ensureRequirements(() => {}, dependencies), /Windows must restart to finish WSL 2 and virtualization setup/);
  assert.deepEqual(actions.install, []);
  assert.equal(actions.start, 0);
});

test('preserves feature enablement diagnostics and never starts Docker after failure', async () => {
  const diagnostic = new Error('Unable to enable required Windows virtualization features. Access denied.');
  const { actions, dependencies } = harness([
    status({ features: { wsl: 'disabled' } })
  ], {
    enableWindowsFeatures: async () => { throw diagnostic; }
  });

  await assert.rejects(ensureRequirements(() => {}, dependencies), (error) => error === diagnostic);
  assert.deepEqual(actions.install, []);
  assert.equal(actions.start, 0);
});

test('allows unknown firmware state when both Windows features are enabled', async () => {
  const { actions, dependencies } = harness([status({ firmwareVirtualization: null })]);

  const result = await ensureRequirements(() => {}, dependencies);
  assert.equal(result.ready, true);
  assert.deepEqual(actions.enable, []);
});

test('does not enable features when both are already enabled', async () => {
  const { actions, dependencies } = harness([status()]);

  await ensureRequirements(() => {}, dependencies);
  assert.deepEqual(actions.enable, []);
});

test('unknown feature state blocks all mutations with an inspection error', async () => {
  const { actions, dependencies } = harness([status({ features: { wsl: 'unknown' } })]);

  await assert.rejects(
    ensureRequirements(() => {}, dependencies),
    /Unable to inspect required Windows virtualization features\. No changes were made\./
  );
  assert.deepEqual(actions, { enable: [], install: [], start: 0, wait: 0, recover: 0 });
});

test('fails safely when enabled features do not become enabled after reinspection', async () => {
  const { actions, dependencies } = harness([
    status({ features: { virtualMachinePlatform: 'disabled' } }),
    status({ features: { virtualMachinePlatform: 'disabled' } })
  ]);

  await assert.rejects(
    ensureRequirements(() => {}, dependencies),
    /Windows could not finish enabling the required virtualization features/
  );
  assert.deepEqual(actions.install, []);
  assert.equal(actions.start, 0);
});

const laterBlockedStates = [
  {
    name: 'disabled',
    blocked: status({ features: { virtualMachinePlatform: 'disabled' } }),
    expected: /Windows could not finish enabling the required virtualization features/,
    needsReinspection: true
  },
  {
    name: 'restart-pending',
    blocked: status({ features: { virtualMachinePlatform: 'restart-pending' } }),
    expected: /Windows must restart to finish WSL 2 and virtualization setup/
  },
  {
    name: 'unknown',
    blocked: status({ features: { virtualMachinePlatform: 'unknown' } }),
    expected: /Unable to inspect required Windows virtualization features\. No changes were made\./
  },
  {
    name: 'firmware-disabled',
    blocked: status({ firmwareVirtualization: false }),
    expected: /Hardware virtualization is disabled/
  }
];

for (const blockedState of laterBlockedStates) {
  test(`blocks Docker installation when prerequisites become ${blockedState.name} after WSL handling`, async () => {
    const statuses = [
      status({ wsl: false, ready: false }),
      blockedState.blocked
    ];
    if (blockedState.needsReinspection) statuses.push(blockedState.blocked);
    const { actions, dependencies } = harness(statuses);

    await assert.rejects(ensureRequirements(() => {}, dependencies), blockedState.expected);
    assert.equal(actions.install.includes('docker'), false);
    assert.equal(actions.start, 0);
    assert.equal(actions.wait, 0);
    assert.equal(actions.recover, 0);
  });

  test(`blocks Docker startup when prerequisites become ${blockedState.name} after Docker installation`, async () => {
    const missingDocker = status({ docker: false, compose: false, engine: false, ready: false });
    const statuses = [missingDocker, missingDocker, blockedState.blocked];
    if (blockedState.needsReinspection) statuses.push(blockedState.blocked);
    const { actions, dependencies } = harness(statuses);

    await assert.rejects(ensureRequirements(() => {}, dependencies), blockedState.expected);
    assert.deepEqual(actions.install, ['docker']);
    assert.equal(actions.start, 0);
    assert.equal(actions.wait, 0);
    assert.equal(actions.recover, 0);
  });
}

test('blocks recovery when prerequisites regress after a recoverable engine wait failure', async () => {
  const stopped = status({ engine: false, ready: false });
  const firmwareBlocked = status({ engine: false, ready: false, firmwareVirtualization: false });
  const recoverable = new Error('Docker Desktop is unable to start');
  let waitFailed = false;
  const { actions, dependencies } = harness([stopped], {
    preflight: async () => waitFailed ? firmwareBlocked : stopped,
    waitForDockerEngine: async () => {
      actions.wait += 1;
      waitFailed = true;
      throw recoverable;
    }
  });

  await assert.rejects(ensureRequirements(() => {}, dependencies), /Hardware virtualization is disabled/);
  assert.equal(actions.start, 1);
  assert.equal(actions.wait, 1);
  assert.equal(actions.recover, 0);
});

test('final preflight reports a prerequisite regression instead of a generic Docker error', async () => {
  const running = status();
  const unknown = status({ features: { wsl: 'unknown' }, ready: false });
  const { actions, dependencies } = harness([running, running, running, unknown]);

  await assert.rejects(
    ensureRequirements(() => {}, dependencies),
    /Unable to inspect required Windows virtualization features\. No changes were made\./
  );
  assert.equal(actions.start, 0);
  assert.equal(actions.wait, 0);
  assert.equal(actions.recover, 0);
});

test('a WSL installation restart requirement stops before any Docker installation', async () => {
  const missing = status({ wsl: false, docker: false, compose: false, engine: false, ready: false });
  const { actions, dependencies } = harness([missing], {
    installRequirement: async (id) => {
      actions.install.push(id);
      return { id, installed: true, restartRequired: id === 'wsl' };
    }
  });

  await assert.rejects(ensureRequirements(() => {}, dependencies), /Windows must restart to finish WSL 2 and virtualization setup/);
  assert.deepEqual(actions.install, ['wsl']);
  assert.equal(actions.start, 0);
  assert.equal(actions.wait, 0);
  assert.equal(actions.recover, 0);
});

test('an OS pending restart stops before Docker installation', async () => {
  const missingDocker = status({ docker: false, compose: false, engine: false, ready: false });
  const { actions, dependencies } = harness([missingDocker], {
    windowsRestartPending: async () => true
  });

  await assert.rejects(ensureRequirements(() => {}, dependencies), /Windows must restart to finish WSL 2 and virtualization setup/);
  assert.deepEqual(actions.install, []);
  assert.equal(actions.start, 0);
});

test('a newly pending OS restart blocks Docker recovery after engine wait failure', async () => {
  const stopped = status({ engine: false, ready: false });
  let waitFailed = false;
  const { actions, dependencies } = harness([stopped], {
    windowsRestartPending: async () => waitFailed,
    waitForDockerEngine: async () => {
      actions.wait += 1;
      waitFailed = true;
      throw new Error('Docker Desktop is unable to start');
    }
  });

  await assert.rejects(ensureRequirements(() => {}, dependencies), /Windows must restart to finish WSL 2 and virtualization setup/);
  assert.equal(actions.start, 1);
  assert.equal(actions.wait, 1);
  assert.equal(actions.recover, 0);
});

const runDockerBlockedStates = [
  {
    name: 'feature remains disabled',
    statuses: [
      status({ features: { virtualMachinePlatform: 'disabled' } }),
      status({ features: { virtualMachinePlatform: 'disabled' } })
    ],
    expected: /Windows could not finish enabling the required virtualization features/
  },
  {
    name: 'feature is restart-pending',
    statuses: [status({ features: { virtualMachinePlatform: 'restart-pending' } })],
    expected: /Windows must restart to finish WSL 2 and virtualization setup/
  },
  {
    name: 'firmware virtualization is disabled',
    statuses: [status({ firmwareVirtualization: false })],
    expected: /Hardware virtualization is disabled/
  }
];

for (const blockedState of runDockerBlockedStates) {
  test(`runDocker blocks automatic recovery when ${blockedState.name}`, async () => {
    let recoveries = 0;
    const recoverable = new Error('Docker Desktop is unable to start');

    await assert.rejects(
      runDocker(
        { docker: 'docker.exe' },
        ['ps'],
        {},
        () => {},
        true,
        {
          run: async () => { throw recoverable; },
          preflight: sequence(blockedState.statuses),
          enableWindowsFeatures: async () => ({ restartNeeded: false }),
          windowsRestartPending: async () => false,
          recoverDockerEngine: async () => { recoveries += 1; }
        }
      ),
      blockedState.expected
    );
    assert.equal(recoveries, 0);
  });
}

test('runDocker blocks automatic recovery while Windows has an OS pending restart', async () => {
  let recoveries = 0;

  await assert.rejects(
    runDocker(
      { docker: 'docker.exe' },
      ['ps'],
      {},
      () => {},
      true,
      {
        run: async () => { throw new Error('Docker Desktop is unable to start'); },
        preflight: async () => status(),
        windowsRestartPending: async () => true,
        recoverDockerEngine: async () => { recoveries += 1; }
      }
    ),
    /Windows must restart to finish WSL 2 and virtualization setup/
  );
  assert.equal(recoveries, 0);
});

test('runDocker reports firmware virtualization before a simultaneous OS pending restart', async () => {
  let recoveries = 0;

  await assert.rejects(
    runDocker(
      { docker: 'docker.exe' },
      ['ps'],
      {},
      () => {},
      true,
      {
        run: async () => { throw new Error('Docker Desktop is unable to start'); },
        preflight: async () => status({ firmwareVirtualization: false }),
        windowsRestartPending: async () => true,
        recoverDockerEngine: async () => { recoveries += 1; }
      }
    ),
    /Hardware virtualization is disabled/
  );
  assert.equal(recoveries, 0);
});

test('healthy running Docker is not blocked by an unrelated OS pending restart', async () => {
  const ready = status();
  const { actions, dependencies } = harness([ready], {
    windowsRestartPending: async () => true
  });

  const result = await ensureRequirements(() => {}, dependencies);

  assert.equal(result.ready, true);
  assert.deepEqual(actions, { enable: [], install: [], start: 0, wait: 0, recover: 0 });
});

test('runDocker recovers once and retries when shared Docker prerequisites are healthy', async () => {
  let runs = 0;
  let recoveries = 0;
  const result = await runDocker(
    { docker: 'docker.exe' },
    ['ps'],
    {},
    () => {},
    true,
    {
      run: async () => {
        runs += 1;
        if (runs === 1) throw new Error('Docker Desktop is unable to start');
        return { stdout: 'ready', stderr: '' };
      },
      preflight: async () => status(),
      windowsRestartPending: async () => false,
      recoverDockerEngine: async () => { recoveries += 1; }
    }
  );

  assert.equal(result.stdout, 'ready');
  assert.equal(runs, 2);
  assert.equal(recoveries, 1);
});
