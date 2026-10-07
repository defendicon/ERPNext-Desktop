# Windows Virtualization Prerequisites Design

## Goal

Prevent ERPNext Desktop's automatic setup from launching Docker Desktop while the Windows virtualization prerequisites for its WSL 2 backend are disabled. The installer must enable supported Windows features automatically, request only the already-configured administrator access, stop cleanly for a required reboot, and distinguish an operating-system feature problem from firmware virtualization that the application cannot change.

## Root Cause

The current preflight treats a successful `wsl.exe --status` invocation as proof that WSL 2 is ready. On Windows, the command can exist and return successfully while `VirtualMachinePlatform` is disabled. In that state ERPNext Desktop skips WSL setup, starts Docker Desktop, and Docker reports `Virtual Machine Platform not enabled` and `No virtualization available`.

## Scope

This change covers Windows prerequisite detection, automatic feature enablement, restart handling, firmware-virtualization diagnostics, user-facing progress/errors, and focused automated tests.

It does not attempt to edit BIOS/UEFI settings, suppress a Windows restart, change Docker's backend, or alter ERPNext image/site installation.

## Design

### Windows readiness inspection

Add a focused Windows-requirements unit used by `electron/installer.cjs`. It will query these optional features through elevated Windows PowerShell:

- `Microsoft-Windows-Subsystem-Linux`
- `VirtualMachinePlatform`

The query will return structured JSON rather than relying on localized console prose. Each feature state is normalized to the string union `enabled | disabled | restart-pending | unknown`: Windows `Enabled` maps to `enabled`; `Disabled` and `DisabledWithPayloadRemoved` map to `disabled`; `EnablePending` and `DisablePending` map to `restart-pending`; and a missing or unreadable state becomes `unknown`. Neither pending nor unknown is treated as ready.

The same unit will query `Win32_Processor.VirtualizationFirmwareEnabled` and `Win32_ComputerSystem.HypervisorPresent`. Firmware virtualization is normalized to `true | false | null`: it is `true` when either the firmware flag or an active hypervisor proves availability, `false` only when the available values definitively report both as false, and `null` when the query supplies no conclusive value. Unknown results remain distinct from a confirmed `false` result so older or restricted systems are not rejected without evidence.

`preflight()` will expose the two feature states and firmware result in addition to the existing Git, Docker, Compose, WSL-command, and engine states. Overall readiness still requires the Docker engine, but prerequisite decisions will use the explicit feature states instead of the `wsl.exe --status` exit code alone.

### Automatic feature enablement

Before Docker Desktop is installed or started, `ensureRequirements()` will enable any disabled required feature using `Enable-WindowsOptionalFeature -Online -All -NoRestart -PassThru`. ERPNext Desktop already runs with `requestedExecutionLevel: requireAdministrator`, so this does not introduce a second elevation mechanism.

Feature enablement will be idempotent: already-enabled features are omitted, and only missing features are passed to Windows. Progress events will name the Windows virtualization components being configured.

PowerShell's boolean `RestartNeeded` result is authoritative. When enabling multiple features, `enableWindowsFeatures()` aggregates all returned results and reports `restartNeeded: true` if any result requires a restart. If it is `true`, setup stops with the restart-required message and Docker is not started. If it is `false`, the installer re-inspects the feature states. It continues only when both are now `enabled`; a `restart-pending` result requests a restart, while `disabled` or `unknown` reports that Windows could not complete feature activation. The existing UI preserves the selected applications in its active state, and after a required restart the user can reopen ERPNext Desktop and click Install to continue.

### Firmware virtualization handling

If Windows reports firmware virtualization as definitively disabled, automatic setup will stop before changing Windows features or launching Docker and explain that Intel VT-x/VT-d or AMD-V/SVM must be enabled in BIOS/UEFI. The message will state that this setting cannot be changed by ERPNext Desktop. This check has precedence because Windows feature changes and a restart cannot make firmware virtualization available.

If firmware state is unknown, setup will not fail early. Docker remains the final functional check, and any Docker failure will retain its diagnostic details.

### Error handling

- A failed Windows-feature query produces a specific prerequisite-inspection error rather than silently assuming readiness.
- A failed feature enable command includes the sanitized tail of PowerShell output through the existing process runner.
- A successful enable operation obeys `RestartNeeded`; a no-restart result must pass feature re-inspection before Docker startup.
- A confirmed firmware-disabled state produces an actionable BIOS/UEFI message.
- Existing Docker recovery remains responsible only for recoverable Docker engine failures; it will not retry a missing Windows feature or confirmed firmware blocker.

## Components and Interfaces

### `electron/windows-requirements.cjs`

Owns Windows-specific scripts and normalization. Its public operations are:

- inspect required optional-feature states and firmware virtualization;
- build/execute the enablement request for only the missing features;
- return structured, testable results without UI concerns.

The command runner is supplied by the caller, keeping process execution in the existing installer boundary and allowing unit tests to exercise behavior without mutating the developer machine. Its contract is `(command, args, options?, onLine?) => Promise<{ stdout: string, stderr: string }>`.

The public contracts are:

- `inspectWindowsRequirements(run) => Promise<{ features: { wsl: FeatureState, virtualMachinePlatform: FeatureState }, firmwareVirtualization: boolean | null }>` where `FeatureState` is `enabled | disabled | restart-pending | unknown`;
- `enableWindowsFeatures(run, featureNames, emit?) => Promise<{ restartNeeded: boolean }>` where `featureNames` is a non-empty allow-listed subset of the two required feature names and `restartNeeded` is true when any returned feature result requires restart;
- malformed, partial, or non-JSON PowerShell output throws a prerequisite-inspection error; command failures retain the existing sanitized process diagnostics.

### `electron/installer.cjs`

Continues to orchestrate setup. It will:

- include explicit Windows readiness in `preflight()`;
- enable missing features before Git/Docker setup proceeds;
- return the existing restart instruction after enablement;
- block on confirmed firmware virtualization failure;
- retain current Git, Docker Desktop, engine recovery, and ERPNext installation behavior.

### UI and documentation

No new screen is required. Existing progress and error surfaces will display the more accurate phase and message. README prerequisite wording will clarify that Windows features are automatic but BIOS/UEFI virtualization, when disabled, requires the user.

## Orchestration Precedence

| Required feature state | Firmware state | Pending restart | Docker action | Outcome |
| --- | --- | --- | --- | --- |
| Any | `false` | Any | Do not install or start | Stop with BIOS/UEFI virtualization instructions |
| Any `restart-pending` | `true` or `null` | Any | Do not install or start | Stop with restart instruction |
| No pending and any `unknown` | `true` or `null` | Any | Do not install or start | Stop with prerequisite-inspection error |
| Any `disabled` | `true` or `null` | Any | Do not install or start yet | Enable only disabled features; obey `RestartNeeded`, then re-inspect if no restart is needed |
| All `enabled` | `true` or `null` | `true` and engine unavailable | Do not start | Stop with existing pending-restart instruction |
| All `enabled` | `true` or `null` | `false` | Start or verify as needed | Continue existing Docker and ERPNext flow |

The firmware blocker is evaluated first, feature inspection/enablement second, pending Windows restart third, and Docker installation/startup last.

## Test Strategy

Use Node's built-in test runner to avoid a new runtime dependency. Tests will be added before implementation and will cover:

1. WSL command present but `VirtualMachinePlatform` disabled is classified as missing and triggers enablement.
2. Both Windows features enabled causes no enable command.
3. Only the missing feature is included in the enable command.
4. Successful feature enablement requires restart and prevents Docker startup in the same run.
5. Confirmed firmware virtualization disabled produces the BIOS/UEFI blocker.
6. Unknown firmware state is allowed to continue to Docker's functional readiness check.
7. Structured PowerShell output is parsed without depending on display-language text.
8. Feature-query command failure and malformed or partial structured output produce a prerequisite-inspection error.
9. Feature-enable command failure preserves sanitized diagnostic output and does not start Docker.
10. `RestartNeeded: true` stops before Docker, while `RestartNeeded: false` re-inspects and continues only if both features are enabled.
11. When firmware is disabled and features are missing, the firmware blocker wins and no feature mutation occurs.
12. Multiple feature-enable results aggregate restart requirements with logical OR.
13. Reopening before reboot with `EnablePending` or `DisablePending` stops before Docker and repeats the restart instruction.

Verification will include the focused unit tests, the complete test suite, syntax checks for Electron files, the Vite production build, and the Windows NSIS packaging command where supported by the current environment.

## Success Criteria

- The screenshot scenario cannot reach Docker startup while `VirtualMachinePlatform` is disabled.
- ERPNext Desktop automatically enables both required Windows features when possible.
- A Windows restart is requested when PowerShell reports it is needed or when a post-enable inspection shows activation is incomplete; a confirmed no-restart activation continues without forcing one.
- A confirmed BIOS/UEFI virtualization problem is reported separately and accurately.
- Existing automatic Git, Docker Desktop, Compose, and ERPNext setup behavior remains intact.
- Automated regression tests and production packaging checks pass.
