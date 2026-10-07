# Windows Virtualization Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ERPNext Desktop detect and automatically enable the Windows WSL 2 optional features before Docker Desktop starts, while reporting firmware virtualization and restart blockers accurately.

**Architecture:** Add a small Windows-specific module that owns PowerShell scripts, structured-output parsing, feature-state normalization, and feature enablement. Keep `electron/installer.cjs` as the setup orchestrator, integrating that module through injectable dependencies so the no-Docker-before-reboot behavior can be tested without changing the machine.

**Tech Stack:** Electron/CommonJS, Node.js built-in test runner and assertions, Windows PowerShell 5.1 optional-feature cmdlets and CIM, Vite, electron-builder/NSIS.

---

## File Structure

- Create `electron/windows-requirements.cjs`: inspect optional features and firmware virtualization, parse marker-prefixed JSON, validate allow-listed feature names, and enable missing features.
- Create `electron/windows-requirements.test.cjs`: focused unit tests for parsing, normalization, enablement arguments/results, malformed output, and command failures.
- Create `electron/installer.test.cjs`: orchestration tests proving firmware, pending-restart, feature enablement, and Docker-start precedence.
- Modify `electron/installer.cjs`: integrate explicit Windows prerequisite state into preflight and automatic setup; allow narrow dependency injection for tests.
- Modify `src/main.jsx`: keep the web-preview bridge fallback aligned with the expanded preflight result.
- Modify `package.json`: add the Node test command.
- Modify `README.md`: clarify automatic Windows feature setup and the BIOS/UEFI boundary.

## Chunk 1: Test-Driven Implementation and Verification

### Task 1: Windows requirement inspection

**Files:**
- Create: `electron/windows-requirements.cjs`
- Create: `electron/windows-requirements.test.cjs`
- Modify: `package.json`

- [ ] **Step 1: Add the test runner script**

Add this script to `package.json` without changing existing scripts:

```json
"test": "node --test electron/*.test.cjs"
```

- [ ] **Step 2: Write failing tests for structured inspection**

Create tests using `node:test` and `node:assert/strict`. Supply a fake async runner with the same signature as the installer runner and assert:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  inspectWindowsRequirements,
  normalizeFeatureState
} = require('./windows-requirements.cjs');

test('normalizes Windows optional feature states', () => {
  assert.equal(normalizeFeatureState('Enabled'), 'enabled');
  assert.equal(normalizeFeatureState('Disabled'), 'disabled');
  assert.equal(normalizeFeatureState('DisabledWithPayloadRemoved'), 'disabled');
  assert.equal(normalizeFeatureState('EnablePending'), 'restart-pending');
  assert.equal(normalizeFeatureState('DisablePending'), 'restart-pending');
  assert.equal(normalizeFeatureState('Unexpected'), 'unknown');
});

test('reports enabled features and available firmware virtualization', async () => {
  const run = async () => ({
    stdout: 'ERPNextDesktopRequirements:{"features":{"Microsoft-Windows-Subsystem-Linux":"Enabled","VirtualMachinePlatform":"Enabled"},"processorVirtualization":[true],"hypervisorPresent":false}',
    stderr: ''
  });
  assert.deepEqual(await inspectWindowsRequirements(run), {
    features: { wsl: 'enabled', virtualMachinePlatform: 'enabled' },
    firmwareVirtualization: true
  });
});
```

Also test that two conclusive false signals produce `false`, missing/incomplete firmware signals produce `null`, and incidental stdout before the marker is ignored.

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `node --test electron/windows-requirements.test.cjs`

Expected: FAIL because `electron/windows-requirements.cjs` does not exist.

- [ ] **Step 4: Implement the minimal inspection module**

Implement these public pieces:

```js
const REQUIRED_FEATURES = Object.freeze({
  wsl: 'Microsoft-Windows-Subsystem-Linux',
  virtualMachinePlatform: 'VirtualMachinePlatform'
});

function normalizeFeatureState(state) {
  if (state === 'Enabled') return 'enabled';
  if (state === 'Disabled' || state === 'DisabledWithPayloadRemoved') return 'disabled';
  if (state === 'EnablePending' || state === 'DisablePending') return 'restart-pending';
  return 'unknown';
}

async function inspectWindowsRequirements(run) {
  const result = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', INSPECTION_SCRIPT
  ]);
  const payload = parseMarkedJson(result.stdout, 'ERPNextDesktopRequirements:');
  validateInspectionPayload(payload);
  return normalizeInspection(payload);
}
```

`INSPECTION_SCRIPT` must set `$ErrorActionPreference = 'Stop'`, call `Get-WindowsOptionalFeature -Online` for both exact feature names, query `Win32_Processor.VirtualizationFirmwareEnabled` plus `Win32_ComputerSystem.HypervisorPresent`, and write one marker-prefixed compressed JSON line. `parseMarkedJson` must locate the last marker-prefixed line and throw `Unable to inspect required Windows virtualization features.` for missing, malformed, or partial payloads.

Firmware normalization rules:

- return `true` if any processor flag or `HypervisorPresent` is true;
- return `false` only when at least one processor flag exists, every processor flag is false, and `HypervisorPresent` is false;
- otherwise return `null`.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run: `node --test electron/windows-requirements.test.cjs`

Expected: all inspection tests PASS with zero failures.

- [ ] **Step 6: Add malformed-output and command-failure tests**

Add tests asserting that missing marker, invalid JSON, and absent/non-string feature keys reject with the prerequisite-inspection error. Add a test proving an unrecognized but valid string state normalizes to `unknown`. Add a runner rejection test asserting the original sanitized message, such as `powershell.exe exited with code 1:\nAccess denied`, remains included in the wrapped error.

- [ ] **Step 7: Verify the new failure tests fail for the intended reason, then implement error wrapping**

Run the focused test after adding each behavior and confirm it fails on the missing validation/wrapping. Then minimally update `inspectWindowsRequirements()` so command failures become:

```text
Unable to inspect required Windows virtualization features. <original message>
```

Re-run: `node --test electron/windows-requirements.test.cjs`

Expected: all tests PASS.

- [ ] **Step 8: Commit the inspection unit**

```powershell
git add -- package.json electron/windows-requirements.cjs electron/windows-requirements.test.cjs
git commit -m "Add Windows virtualization inspection"
```

### Task 2: Safe Windows feature enablement

**Files:**
- Modify: `electron/windows-requirements.cjs`
- Modify: `electron/windows-requirements.test.cjs`

- [ ] **Step 1: Write failing allow-list and enablement tests**

Test `enableWindowsFeatures(run, names, emit)` for these behaviors:

- rejects an empty list and any name outside `Object.values(REQUIRED_FEATURES)` before invoking the runner;
- invokes `powershell.exe` with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`;
- the script contains only the requested allow-listed feature names;
- one `RestartNeeded: true` among multiple results returns `{ restartNeeded: true }`;
- all false values return `{ restartNeeded: false }`;
- malformed/partial marked JSON rejects;
- runner failure retains its sanitized diagnostic message;
- progress identifies `WSL 2 + Virtual Machine Platform`.

- [ ] **Step 2: Run the enablement tests and verify RED**

Run: `node --test electron/windows-requirements.test.cjs`

Expected: FAIL because `enableWindowsFeatures` is not exported/implemented.

- [ ] **Step 3: Implement minimal allow-listed enablement**

Implement:

```js
async function enableWindowsFeatures(run, featureNames, emit = () => {}) {
  validateRequestedFeatures(featureNames);
  emit({
    kind: 'progress',
    phase: 'Enabling Windows virtualization',
    image: 'WSL 2 + Virtual Machine Platform',
    line: 'Enabling the Windows features required by Docker Desktop.',
    progress: 5
  });
  const result = await run('powershell.exe', powershellArgs(buildEnableScript(featureNames)), {}, emit);
  const payload = parseMarkedJson(result.stdout, 'ERPNextDesktopFeatureEnablement:');
  validateEnablementPayload(payload, featureNames);
  return { restartNeeded: payload.results.some((item) => item.restartNeeded === true) };
}
```

The generated PowerShell must loop over the already-validated literal names, call `Enable-WindowsOptionalFeature -Online -FeatureName $name -All -NoRestart -PassThru`, and emit a marker-prefixed JSON object containing one result per requested feature. Do not accept caller-controlled feature strings outside the two-name allow list.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test electron/windows-requirements.test.cjs`

Expected: all inspection and enablement tests PASS.

- [ ] **Step 5: Commit feature enablement**

```powershell
git add -- electron/windows-requirements.cjs electron/windows-requirements.test.cjs
git commit -m "Enable required Windows virtualization features"
```

### Task 3: Installer orchestration and regression coverage

**Files:**
- Modify: `electron/installer.cjs:1-245,380`
- Create: `electron/installer.test.cjs`
- Modify: `src/main.jsx:20-25`

- [ ] **Step 1: Write failing orchestration tests**

Add an optional second `dependencies` argument to the desired `ensureRequirements` interface in tests. The production call remains `ensureRequirements(emit)`. Use fake functions and call counters to cover:

1. Firmware `false` plus disabled features throws the BIOS/UEFI message, never calls `enableWindowsFeatures`, `installRequirement`, or `startDockerDesktop`.
2. `restart-pending` throws the restart instruction before Docker starts.
3. WSL command present with `virtualMachinePlatform: 'disabled'` calls enablement with only `VirtualMachinePlatform`.
4. Enablement returning `restartNeeded: true` stops before Docker.
5. Enablement returning `false`, followed by both features enabled, can continue to a ready Docker status.
6. Enablement returning `false`, followed by `restart-pending`, stops with restart guidance.
7. Enablement failure retains its sanitized diagnostic and does not start Docker.
8. Firmware `null` with enabled features is allowed to continue.
9. Both features already enabled never calls `enableWindowsFeatures`.

Add a separate direct `preflight()` integration test. Inject `inspectWindowsRequirements`, `resolveTools`, and `commandExists` (not a stubbed `preflight`) and assert that production `preflight()`:

- invokes the injected Windows inspector;
- exposes `features` and `firmwareVirtualization` in its result;
- returns `ready: false` when Docker/Git checks pass but either feature is not `enabled`;
- returns `ready: true` when both features and all existing tool/engine checks are ready.

Use a helper status factory whose default is fully ready, and explicitly sequence `preflight` results per test so tests describe the state transition rather than implementation call count.

- [ ] **Step 2: Run installer tests and verify RED**

Run: `node --test electron/installer.test.cjs`

Expected: FAIL because explicit feature state and dependency injection are not implemented.

- [ ] **Step 3: Integrate Windows inspection into preflight**

Import:

```js
const {
  REQUIRED_FEATURES,
  inspectWindowsRequirements,
  enableWindowsFeatures
} = require('./windows-requirements.cjs');
```

Have `preflight(dependencies = {})` bind these exact dependency keys and defaults:

```js
const getTools = dependencies.resolveTools || resolveTools;
const exists = dependencies.commandExists || commandExists;
const inspect = dependencies.inspectWindowsRequirements || (() => inspectWindowsRequirements(run));
```

Use `getTools`, `exists`, and `inspect` inside production `preflight()` and return:

```js
{
  docker,
  compose,
  git,
  engine,
  winget,
  wsl,
  features: windows.features,
  firmwareVirtualization: windows.firmwareVirtualization,
  ready: docker && compose && git && engine &&
    windows.features.wsl === 'enabled' &&
    windows.features.virtualMachinePlatform === 'enabled'
}
```

Keep the existing `wsl` boolean because it indicates command/package availability, not optional-feature readiness.

- [ ] **Step 4: Implement prerequisite precedence in `ensureRequirements`**

Add `dependencies = {}` as the optional second argument and bind these exact keys/defaults:

```js
const checkPreflight = dependencies.preflight || preflight;
const enableFeatures = dependencies.enableWindowsFeatures || ((names, report) => enableWindowsFeatures(run, names, report));
const installMissingRequirement = dependencies.installRequirement || installRequirement;
const hasPendingRestart = dependencies.windowsRestartPending || windowsRestartPending;
const startDocker = dependencies.startDockerDesktop || startDockerDesktop;
const getTools = dependencies.resolveTools || resolveTools;
const waitForEngine = dependencies.waitForDockerEngine || waitForDockerEngine;
const recoverEngine = dependencies.recoverDockerEngine || recoverDockerEngine;
```

Replace the corresponding calls throughout `ensureRequirements()` with these local bindings. Tests may stub only the dependencies reached by their scenario. Immediately after `status = await checkPreflight()`:

```js
if (status.firmwareVirtualization === false) {
  throw new Error('Hardware virtualization is disabled. Enable Intel VT-x/VT-d or AMD-V/SVM in BIOS/UEFI, restart Windows, then reopen ERPNext Desktop. This firmware setting cannot be enabled automatically.');
}
const featureStates = Object.values(status.features);
if (featureStates.includes('restart-pending')) throw restartRequiredError();
if (featureStates.includes('unknown')) {
  throw new Error('Unable to inspect required Windows virtualization features. No changes were made.');
}
const missingFeatures = [];
if (status.features.wsl === 'disabled') missingFeatures.push(REQUIRED_FEATURES.wsl);
if (status.features.virtualMachinePlatform === 'disabled') missingFeatures.push(REQUIRED_FEATURES.virtualMachinePlatform);
if (missingFeatures.length) {
  const result = await enableFeatures(missingFeatures, emit);
  if (result.restartNeeded) throw restartRequiredError();
  status = await checkPreflight();
  if (Object.values(status.features).includes('restart-pending')) throw restartRequiredError();
  if (Object.values(status.features).some((state) => state !== 'enabled')) {
    throw new Error('Windows could not finish enabling the required virtualization features. Restart Windows, reopen ERPNext Desktop, and click Install again.');
  }
}
```

Use a small `restartRequiredError()` helper so every prerequisite restart path emits one consistent message. Only after this block may existing WSL package, Git, Docker Desktop, pending-restart, and engine logic run. Preserve current Docker recovery behavior.

- [ ] **Step 5: Run installer tests and verify GREEN**

Run: `node --test electron/installer.test.cjs`

Expected: all orchestration tests PASS and the call counters confirm Docker never starts in blocked/restart states.

- [ ] **Step 6: Align the web-preview fallback**

Update the fallback preflight object in `src/main.jsx` with:

```js
features: { wsl: 'unknown', virtualMachinePlatform: 'unknown' },
firmwareVirtualization: null
```

No production UI layout change is needed.

- [ ] **Step 7: Run the complete test suite**

Run: `npm test`

Expected: all tests PASS with zero failures.

- [ ] **Step 8: Commit orchestration**

```powershell
git add -- electron/installer.cjs electron/installer.test.cjs src/main.jsx
git commit -m "Integrate automatic virtualization prerequisites"
```

### Task 4: Documentation and release verification

**Files:**
- Modify: `README.md:12-45`

- [ ] **Step 1: Update user-facing prerequisite documentation**

State that ERPNext Desktop automatically enables Windows Subsystem for Linux and Virtual Machine Platform, a restart can be required before Docker starts, and disabled Intel/AMD virtualization in BIOS/UEFI must be enabled manually because Windows applications cannot change firmware settings.

- [ ] **Step 2: Run fresh syntax and unit verification**

Run:

```powershell
npm test
node --check electron/main.cjs
node --check electron/preload.cjs
node --check electron/installer.cjs
node --check electron/windows-requirements.cjs
```

Expected: every command exits 0; unit tests report zero failures.

- [ ] **Step 3: Run the production renderer build**

Run: `npm run build`

Expected: Vite exits 0 and writes the production bundle under `dist/`.

- [ ] **Step 4: Run the Windows installer packaging check**

Run: `npm run dist:win`

Expected: electron-builder exits 0 and produces `release/ERPNext-Desktop-Setup-0.1.2.exe` plus its blockmap. Do not publish or upload the artifact.

- [ ] **Step 5: Inspect the final diff and requirement checklist**

Confirm the final code and tests cover every success criterion in `docs/superpowers/specs/2026-10-07-windows-virtualization-prerequisites-design.md`, and that no unrelated files or generated `dist/`/`release/` artifacts are staged.

- [ ] **Step 6: Commit documentation**

```powershell
git add -- README.md
git commit -m "Document Windows virtualization setup"
```

- [ ] **Step 7: Inspect the final repository state and all implementation commits**

Run:

```powershell
git status --short
git diff --check HEAD~4..HEAD
git log -6 --oneline
```

Expected: working tree is clean, diff check reports no errors, and the four implementation commits include inspection, enablement, orchestration, and documentation.
