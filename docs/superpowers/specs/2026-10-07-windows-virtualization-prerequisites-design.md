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

The query will return structured JSON rather than relying on localized console prose. Each feature will be represented as enabled or not enabled. A missing or unreadable state is not treated as ready.

The same unit will query `Win32_Processor.VirtualizationFirmwareEnabled` and `Win32_ComputerSystem.HypervisorPresent`. Firmware virtualization is considered available when either the firmware flag or an active hypervisor proves availability. Unknown results remain distinct from a confirmed `false` result so older or restricted systems are not rejected without evidence.

`preflight()` will expose the two feature states and firmware result in addition to the existing Git, Docker, Compose, WSL-command, and engine states. Overall readiness still requires the Docker engine, but prerequisite decisions will use the explicit feature states instead of the `wsl.exe --status` exit code alone.

### Automatic feature enablement

Before Docker Desktop is installed or started, `ensureRequirements()` will enable any disabled required feature using `Enable-WindowsOptionalFeature -Online -All -NoRestart`. ERPNext Desktop already runs with `requestedExecutionLevel: requireAdministrator`, so this does not introduce a second elevation mechanism.

Feature enablement will be idempotent: already-enabled features are omitted, and only missing features are passed to Windows. Progress events will name the Windows virtualization components being configured.

After a successful enable operation, setup will stop with a restart-required result/message. The existing UI preserves the selected applications in its active state, and after restart the user can reopen ERPNext Desktop and click Install to continue. Docker will not be started in the pre-restart state.

### Firmware virtualization handling

If Windows reports firmware virtualization as definitively disabled, automatic setup will stop before launching Docker and explain that Intel VT-x/VT-d or AMD-V/SVM must be enabled in BIOS/UEFI. The message will state that this setting cannot be changed by ERPNext Desktop.

If firmware state is unknown, setup will not fail early. Docker remains the final functional check, and any Docker failure will retain its diagnostic details.

### Error handling

- A failed Windows-feature query produces a specific prerequisite-inspection error rather than silently assuming readiness.
- A failed feature enable command includes the sanitized tail of PowerShell output through the existing process runner.
- A successful enable operation always requests a Windows restart before Docker startup.
- A confirmed firmware-disabled state produces an actionable BIOS/UEFI message.
- Existing Docker recovery remains responsible only for recoverable Docker engine failures; it will not retry a missing Windows feature or confirmed firmware blocker.

## Components and Interfaces

### `electron/windows-requirements.cjs`

Owns Windows-specific scripts and normalization. Its public operations are:

- inspect required optional-feature states and firmware virtualization;
- build/execute the enablement request for only the missing features;
- return structured, testable results without UI concerns.

The command runner is supplied by the caller, keeping process execution in the existing installer boundary and allowing unit tests to exercise behavior without mutating the developer machine.

### `electron/installer.cjs`

Continues to orchestrate setup. It will:

- include explicit Windows readiness in `preflight()`;
- enable missing features before Git/Docker setup proceeds;
- return the existing restart instruction after enablement;
- block on confirmed firmware virtualization failure;
- retain current Git, Docker Desktop, engine recovery, and ERPNext installation behavior.

### UI and documentation

No new screen is required. Existing progress and error surfaces will display the more accurate phase and message. README prerequisite wording will clarify that Windows features are automatic but BIOS/UEFI virtualization, when disabled, requires the user.

## Test Strategy

Use Node's built-in test runner to avoid a new runtime dependency. Tests will be added before implementation and will cover:

1. WSL command present but `VirtualMachinePlatform` disabled is classified as missing and triggers enablement.
2. Both Windows features enabled causes no enable command.
3. Only the missing feature is included in the enable command.
4. Successful feature enablement requires restart and prevents Docker startup in the same run.
5. Confirmed firmware virtualization disabled produces the BIOS/UEFI blocker.
6. Unknown firmware state is allowed to continue to Docker's functional readiness check.
7. Structured PowerShell output is parsed without depending on display-language text.

Verification will include the focused unit tests, the complete test suite, syntax checks for Electron files, the Vite production build, and the Windows NSIS packaging command where supported by the current environment.

## Success Criteria

- The screenshot scenario cannot reach Docker startup while `VirtualMachinePlatform` is disabled.
- ERPNext Desktop automatically enables both required Windows features when possible.
- A Windows restart is requested exactly when feature changes require it.
- A confirmed BIOS/UEFI virtualization problem is reported separately and accurately.
- Existing automatic Git, Docker Desktop, Compose, and ERPNext setup behavior remains intact.
- Automated regression tests and production packaging checks pass.
