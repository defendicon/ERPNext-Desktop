const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUIRED_FEATURES,
  enableWindowsFeatures,
  inspectWindowsRequirements,
  normalizeFeatureState
} = require('./windows-requirements.cjs');

const MARKER = 'ERPNextDesktopRequirements:';
const ENABLEMENT_MARKER = 'ERPNextDesktopFeatureEnablement:';
const FEATURE_STATES = {
  'Microsoft-Windows-Subsystem-Linux': 'Enabled',
  VirtualMachinePlatform: 'Enabled'
};

function output(payload, before = '') {
  return {
    stdout: `${before}${MARKER}${JSON.stringify(payload)}`,
    stderr: ''
  };
}

function payload(overrides = {}) {
  return {
    features: { ...FEATURE_STATES },
    processorVirtualization: [true],
    hypervisorPresent: false,
    ...overrides
  };
}

function enablementOutput(results) {
  return {
    stdout: `${ENABLEMENT_MARKER}${JSON.stringify({ results })}`,
    stderr: ''
  };
}

function enablementResult(featureName, restartNeeded) {
  return { featureName, restartNeeded };
}

test('exports the exact required Windows feature names', () => {
  assert.deepEqual(REQUIRED_FEATURES, {
    wsl: 'Microsoft-Windows-Subsystem-Linux',
    virtualMachinePlatform: 'VirtualMachinePlatform'
  });
});

test('normalizes every Windows optional feature state', () => {
  assert.equal(normalizeFeatureState('Enabled'), 'enabled');
  assert.equal(normalizeFeatureState('Disabled'), 'disabled');
  assert.equal(normalizeFeatureState('DisabledWithPayloadRemoved'), 'disabled');
  assert.equal(normalizeFeatureState('EnablePending'), 'restart-pending');
  assert.equal(normalizeFeatureState('DisablePending'), 'restart-pending');
  assert.equal(normalizeFeatureState('Unexpected'), 'unknown');
});

test('runs the structured PowerShell inspection and reports enabled requirements', async () => {
  let invocation;
  const run = async (...args) => {
    invocation = args;
    return output(payload());
  };

  assert.deepEqual(await inspectWindowsRequirements(run), {
    features: { wsl: 'enabled', virtualMachinePlatform: 'enabled' },
    firmwareVirtualization: true
  });

  assert.equal(invocation[0], 'powershell.exe');
  assert.deepEqual(invocation[1].slice(0, 5), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'
  ]);
  const script = invocation[1][5];
  assert.match(script, /\$ErrorActionPreference\s*=\s*'Stop'/);
  assert.match(script, /Get-WindowsOptionalFeature\s+-Online\s+-FeatureName\s+'Microsoft-Windows-Subsystem-Linux'/);
  assert.match(script, /Get-WindowsOptionalFeature\s+-Online\s+-FeatureName\s+'VirtualMachinePlatform'/);
  assert.match(script, /Win32_Processor/);
  assert.match(script, /VirtualizationFirmwareEnabled/);
  assert.match(script, /Win32_ComputerSystem/);
  assert.match(script, /HypervisorPresent/);
  assert.match(script, /ConvertTo-Json\s+-Compress/);
  assert.match(script, /ERPNextDesktopRequirements:/);
});

test('reports false only from conclusive false firmware signals', async () => {
  const run = async () => output(payload({
    processorVirtualization: [false, false],
    hypervisorPresent: false
  }));

  assert.equal((await inspectWindowsRequirements(run)).firmwareVirtualization, false);
});

test('reports null for incomplete firmware signals', async () => {
  const cases = [
    { processorVirtualization: [], hypervisorPresent: false },
    { processorVirtualization: [false], hypervisorPresent: null },
    { processorVirtualization: null, hypervisorPresent: false },
    { processorVirtualization: [], hypervisorPresent: null }
  ];

  for (const signals of cases) {
    const run = async () => output(payload(signals));
    assert.equal((await inspectWindowsRequirements(run)).firmwareVirtualization, null);
  }
});

test('treats an active hypervisor as conclusive virtualization evidence', async () => {
  const run = async () => output(payload({
    processorVirtualization: [],
    hypervisorPresent: true
  }));

  assert.equal((await inspectWindowsRequirements(run)).firmwareVirtualization, true);
});

test('uses the last marked line and ignores incidental stdout', async () => {
  const earlier = output(payload({
    features: {
      ...FEATURE_STATES,
      VirtualMachinePlatform: 'Disabled'
    }
  })).stdout;
  const latest = output(payload()).stdout;
  const run = async () => ({
    stdout: `PowerShell startup notice\n${earlier}\nMore incidental output\n${latest}\n`,
    stderr: ''
  });

  assert.equal(
    (await inspectWindowsRequirements(run)).features.virtualMachinePlatform,
    'enabled'
  );
});

test('rejects output without the inspection marker', async () => {
  const run = async () => ({ stdout: JSON.stringify(payload()), stderr: '' });

  await assert.rejects(
    inspectWindowsRequirements(run),
    /^Error: Unable to inspect required Windows virtualization features\./
  );
});

test('rejects malformed marked JSON', async () => {
  const run = async () => ({ stdout: `${MARKER}{not-json`, stderr: '' });

  await assert.rejects(
    inspectWindowsRequirements(run),
    /^Error: Unable to inspect required Windows virtualization features\./
  );
});

test('rejects absent or non-string required feature states', async () => {
  const invalidFeatures = [
    { VirtualMachinePlatform: 'Enabled' },
    { 'Microsoft-Windows-Subsystem-Linux': 'Enabled' },
    { ...FEATURE_STATES, 'Microsoft-Windows-Subsystem-Linux': null },
    { ...FEATURE_STATES, VirtualMachinePlatform: 1 }
  ];

  for (const features of invalidFeatures) {
    const run = async () => output(payload({ features }));
    await assert.rejects(
      inspectWindowsRequirements(run),
      /^Error: Unable to inspect required Windows virtualization features\./
    );
  }
});

test('normalizes an unknown but valid feature state to unknown', async () => {
  const run = async () => output(payload({
    features: {
      ...FEATURE_STATES,
      VirtualMachinePlatform: 'SupersededState'
    }
  }));

  assert.equal(
    (await inspectWindowsRequirements(run)).features.virtualMachinePlatform,
    'unknown'
  );
});

test('wraps runner failures while preserving the sanitized diagnostic', async () => {
  const diagnostic = 'powershell.exe exited with code 1:\nAccess denied';
  const run = async () => { throw new Error(diagnostic); };

  await assert.rejects(
    inspectWindowsRequirements(run),
    (error) => {
      assert.match(error.message, /^Unable to inspect required Windows virtualization features\./);
      assert.match(error.message, /powershell\.exe exited with code 1:\nAccess denied$/);
      return true;
    }
  );
});

test('rejects empty or non-allow-listed feature requests before invoking the runner', async () => {
  for (const featureNames of [[], ['Containers'], [REQUIRED_FEATURES.wsl, 'Containers']]) {
    let invoked = false;
    const run = async () => {
      invoked = true;
      return enablementOutput([]);
    };

    await assert.rejects(
      enableWindowsFeatures(run, featureNames),
      /^Error: Unable to enable required Windows virtualization features\./
    );
    assert.equal(invoked, false);
  }
});

test('rejects duplicate feature requests before invoking the runner', async () => {
  let invoked = false;
  const run = async () => {
    invoked = true;
    return enablementOutput([]);
  };

  await assert.rejects(
    enableWindowsFeatures(run, [REQUIRED_FEATURES.wsl, REQUIRED_FEATURES.wsl]),
    /^Error: Unable to enable required Windows virtualization features\./
  );
  assert.equal(invoked, false);
});

test('rejects sparse feature request arrays before invoking the runner', async () => {
  let invoked = false;
  const run = async () => {
    invoked = true;
    return enablementOutput([]);
  };
  const sparseFeatures = [];
  sparseFeatures.length = 1;

  await assert.rejects(
    enableWindowsFeatures(run, sparseFeatures),
    /^Error: Unable to enable required Windows virtualization features\./
  );
  assert.equal(invoked, false);
});

test('runs PowerShell with the exact safe arguments and only requested feature names', async () => {
  let invocation;
  const run = async (...args) => {
    invocation = args;
    return enablementOutput([
      enablementResult(REQUIRED_FEATURES.wsl, false)
    ]);
  };

  await enableWindowsFeatures(run, [REQUIRED_FEATURES.wsl]);

  assert.equal(invocation[0], 'powershell.exe');
  assert.deepEqual(invocation[1].slice(0, 5), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'
  ]);
  assert.equal(invocation[1].length, 6);
  const script = invocation[1][5];
  assert.match(script, /\$ErrorActionPreference\s*=\s*'Stop'/);
  assert.match(script, /\$featureNames\s*=\s*@\([\s\S]*'Microsoft-Windows-Subsystem-Linux'[\s\S]*\)/);
  assert.doesNotMatch(script, /VirtualMachinePlatform/);
  assert.match(script, /foreach\s*\(\$name\s+in\s+\$featureNames\)/);
  assert.match(script, /Enable-WindowsOptionalFeature\s+-Online\s+-FeatureName\s+\$name\s+-All\s+-NoRestart\s+-PassThru/);
  assert.match(script, /ConvertTo-Json\s+-Compress/);
  assert.match(script, /ERPNextDesktopFeatureEnablement:/);
});

test('uses the entry snapshot when the progress callback mutates the caller array', async () => {
  const injection = "Containers'; Write-Output 'injected";
  const requested = [REQUIRED_FEATURES.wsl];
  let script;
  const run = async (_command, args) => {
    script = args[5];
    return enablementOutput([
      enablementResult(REQUIRED_FEATURES.wsl, false)
    ]);
  };
  const emit = () => requested.push(injection);

  assert.deepEqual(
    await enableWindowsFeatures(run, requested, emit),
    { restartNeeded: false }
  );
  assert.match(script, /'Microsoft-Windows-Subsystem-Linux'/);
  assert.doesNotMatch(script, /Containers|injected/);
});

test('reports restart needed when any requested feature requires it', async () => {
  const run = async () => enablementOutput([
    enablementResult(REQUIRED_FEATURES.wsl, false),
    enablementResult(REQUIRED_FEATURES.virtualMachinePlatform, true)
  ]);

  assert.deepEqual(
    await enableWindowsFeatures(run, Object.values(REQUIRED_FEATURES)),
    { restartNeeded: true }
  );
});

test('reports no restart when every requested feature returns false', async () => {
  const run = async () => enablementOutput([
    enablementResult(REQUIRED_FEATURES.wsl, false),
    enablementResult(REQUIRED_FEATURES.virtualMachinePlatform, false)
  ]);

  assert.deepEqual(
    await enableWindowsFeatures(run, Object.values(REQUIRED_FEATURES)),
    { restartNeeded: false }
  );
});

test('rejects malformed marked enablement JSON', async () => {
  const run = async () => ({
    stdout: `${ENABLEMENT_MARKER}{not-json`,
    stderr: ''
  });

  await assert.rejects(
    enableWindowsFeatures(run, [REQUIRED_FEATURES.wsl]),
    /^Error: Unable to enable required Windows virtualization features\./
  );
});

test('rejects partial, mismatched, extra, or non-boolean enablement results', async () => {
  const requested = Object.values(REQUIRED_FEATURES);
  const invalidResults = [
    [enablementResult(REQUIRED_FEATURES.wsl, false)],
    [
      enablementResult(REQUIRED_FEATURES.wsl, false),
      enablementResult('Containers', false)
    ],
    [
      enablementResult(REQUIRED_FEATURES.wsl, false),
      enablementResult(REQUIRED_FEATURES.virtualMachinePlatform, false),
      enablementResult(REQUIRED_FEATURES.virtualMachinePlatform, false)
    ],
    [
      enablementResult(REQUIRED_FEATURES.wsl, false),
      enablementResult(REQUIRED_FEATURES.virtualMachinePlatform, 'false')
    ]
  ];

  for (const results of invalidResults) {
    const run = async () => enablementOutput(results);
    await assert.rejects(
      enableWindowsFeatures(run, requested),
      /^Error: Unable to enable required Windows virtualization features\./
    );
  }
});

test('wraps enablement runner failures while preserving the sanitized diagnostic', async () => {
  const diagnostic = 'powershell.exe exited with code 1:\nAccess denied';
  const run = async () => { throw new Error(diagnostic); };

  await assert.rejects(
    enableWindowsFeatures(run, [REQUIRED_FEATURES.wsl]),
    (error) => {
      assert.match(error.message, /^Unable to enable required Windows virtualization features\./);
      assert.match(error.message, /powershell\.exe exited with code 1:\nAccess denied$/);
      return true;
    }
  );
});

test('emits the exact Windows virtualization enablement progress event', async () => {
  const events = [];
  const run = async () => enablementOutput([
    enablementResult(REQUIRED_FEATURES.wsl, false)
  ]);

  await enableWindowsFeatures(run, [REQUIRED_FEATURES.wsl], (event) => events.push(event));

  assert.deepEqual(events, [{
    kind: 'progress',
    phase: 'Enabling Windows virtualization',
    image: 'WSL 2 + Virtual Machine Platform',
    line: 'Enabling the Windows features required by Docker Desktop.',
    progress: 5
  }]);
});
