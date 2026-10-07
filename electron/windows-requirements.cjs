const REQUIRED_FEATURES = Object.freeze({
  wsl: 'Microsoft-Windows-Subsystem-Linux',
  virtualMachinePlatform: 'VirtualMachinePlatform'
});

const INSPECTION_MARKER = 'ERPNextDesktopRequirements:';
const INSPECTION_ERROR = 'Unable to inspect required Windows virtualization features.';

const INSPECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$wslState = (Get-WindowsOptionalFeature -Online -FeatureName 'Microsoft-Windows-Subsystem-Linux').State.ToString()
$virtualMachinePlatformState = (Get-WindowsOptionalFeature -Online -FeatureName 'VirtualMachinePlatform').State.ToString()
$processorVirtualization = @(
  Get-CimInstance -ClassName Win32_Processor |
    ForEach-Object { $_.VirtualizationFirmwareEnabled }
)
$hypervisorPresent = (Get-CimInstance -ClassName Win32_ComputerSystem).HypervisorPresent
$payload = @{
  features = @{
    'Microsoft-Windows-Subsystem-Linux' = $wslState
    'VirtualMachinePlatform' = $virtualMachinePlatformState
  }
  processorVirtualization = $processorVirtualization
  hypervisorPresent = $hypervisorPresent
}
Write-Output ('ERPNextDesktopRequirements:' + ($payload | ConvertTo-Json -Compress))
`;

function normalizeFeatureState(state) {
  if (state === 'Enabled') return 'enabled';
  if (state === 'Disabled' || state === 'DisabledWithPayloadRemoved') return 'disabled';
  if (state === 'EnablePending' || state === 'DisablePending') return 'restart-pending';
  return 'unknown';
}

function inspectionError(detail) {
  return new Error(detail ? `${INSPECTION_ERROR} ${detail}` : INSPECTION_ERROR);
}

function parseMarkedJson(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/);
  const markedLines = lines.filter((line) => line.startsWith(INSPECTION_MARKER));
  if (markedLines.length === 0) throw inspectionError();

  const json = markedLines.at(-1).slice(INSPECTION_MARKER.length);
  try {
    return JSON.parse(json);
  } catch {
    throw inspectionError();
  }
}

function validateInspectionPayload(payload) {
  if (!payload || typeof payload !== 'object' || !payload.features || typeof payload.features !== 'object') {
    throw inspectionError();
  }

  for (const featureName of Object.values(REQUIRED_FEATURES)) {
    if (typeof payload.features[featureName] !== 'string') throw inspectionError();
  }
}

function normalizeFirmwareVirtualization(payload) {
  const processorValues = Array.isArray(payload.processorVirtualization)
    ? payload.processorVirtualization
    : typeof payload.processorVirtualization === 'boolean'
      ? [payload.processorVirtualization]
      : [];

  if (processorValues.some((value) => value === true) || payload.hypervisorPresent === true) {
    return true;
  }
  if (
    processorValues.length > 0 &&
    processorValues.every((value) => value === false) &&
    payload.hypervisorPresent === false
  ) {
    return false;
  }
  return null;
}

function normalizeInspection(payload) {
  return {
    features: {
      wsl: normalizeFeatureState(payload.features[REQUIRED_FEATURES.wsl]),
      virtualMachinePlatform: normalizeFeatureState(
        payload.features[REQUIRED_FEATURES.virtualMachinePlatform]
      )
    },
    firmwareVirtualization: normalizeFirmwareVirtualization(payload)
  };
}

async function inspectWindowsRequirements(run) {
  let result;
  try {
    result = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      INSPECTION_SCRIPT
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw inspectionError(message);
  }

  const payload = parseMarkedJson(result?.stdout);
  validateInspectionPayload(payload);
  return normalizeInspection(payload);
}

module.exports = {
  REQUIRED_FEATURES,
  normalizeFeatureState,
  inspectWindowsRequirements
};
