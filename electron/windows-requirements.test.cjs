const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUIRED_FEATURES,
  inspectWindowsRequirements,
  normalizeFeatureState
} = require('./windows-requirements.cjs');

const MARKER = 'ERPNextDesktopRequirements:';
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
