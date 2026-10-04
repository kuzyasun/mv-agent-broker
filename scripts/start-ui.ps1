[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath,

  [Parameter(Mandatory = $false)]
  [ValidateRange(1, 65535)]
  [int]$Port = 4318,

  [Parameter(Mandatory = $false)]
  [string]$NodePath
)

$ErrorActionPreference = 'Stop'

function Quote-Argument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  throw "ConfigPath is required and cannot be empty."
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
  throw "CONFIG_NOT_FOUND: Config file not found at '$ConfigPath'."
}

$resolvedConfigPath = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $ConfigPath).Path)

try {
  $configRaw = [System.IO.File]::ReadAllText($resolvedConfigPath, [System.Text.Encoding]::UTF8)
  $config = $configRaw | ConvertFrom-Json
} catch {
  throw "CONFIG_INVALID: Could not parse operator config at '$resolvedConfigPath': $($_.Exception.Message)"
}

if (-not $config -or [string]::IsNullOrWhiteSpace($config.state_dir)) {
  throw "CONFIG_INVALID: Operator config is missing required 'state_dir'."
}

$configDir = Split-Path -Parent $resolvedConfigPath
if ([System.IO.Path]::IsPathRooted($config.state_dir)) {
  $resolvedStateDir = [System.IO.Path]::GetFullPath($config.state_dir)
} else {
  $resolvedStateDir = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($configDir, $config.state_dir))
}

$runtimeRecordPath = Join-Path $resolvedStateDir "operator-runtime.json"
if (-not (Test-Path -LiteralPath $runtimeRecordPath -PathType Leaf)) {
  throw "NO_ACCEPTED_RUNTIME: operator-runtime.json not found in state_dir '$resolvedStateDir'."
}

try {
  $recordRaw = [System.IO.File]::ReadAllText($runtimeRecordPath, [System.Text.Encoding]::UTF8)
  $record = $recordRaw | ConvertFrom-Json
} catch {
  throw "NO_ACCEPTED_RUNTIME: operator-runtime.json cannot be parsed: $($_.Exception.Message)"
}

if (-not $record -or
    [string]::IsNullOrWhiteSpace($record.runtime_identity) -or
    [string]::IsNullOrWhiteSpace($record.runtime_path) -or
    [string]::IsNullOrWhiteSpace($record.manifest_path) -or
    [string]::IsNullOrWhiteSpace($record.config_path)) {
  throw "NO_ACCEPTED_RUNTIME: operator-runtime.json is incomplete."
}

$recordedConfigPath = [System.IO.Path]::GetFullPath($record.config_path)
if ([string]::Compare($recordedConfigPath, $resolvedConfigPath, [System.StringComparison]::OrdinalIgnoreCase) -ne 0) {
  throw "CONFIG_IDENTITY_MISMATCH: accepted runtime config path '$recordedConfigPath' does not match requested config path '$resolvedConfigPath'."
}

$runtimePath = [System.IO.Path]::GetFullPath($record.runtime_path)
if (-not (Test-Path -LiteralPath $runtimePath -PathType Container)) {
  throw "NO_ACCEPTED_RUNTIME: runtime directory not found at '$runtimePath'."
}

$manifestPath = [System.IO.Path]::GetFullPath($record.manifest_path)
$expectedManifestPath = [System.IO.Path]::GetFullPath((Join-Path $runtimePath "runtime-manifest.json"))
if ([string]::Compare($manifestPath, $expectedManifestPath, [System.StringComparison]::OrdinalIgnoreCase) -ne 0) {
  throw "NO_ACCEPTED_RUNTIME: recorded manifest_path '$manifestPath' does not match expected location '$expectedManifestPath'."
}

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "NO_ACCEPTED_RUNTIME: runtime manifest file not found at '$manifestPath'."
}

try {
  $manifestRaw = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
  $manifest = $manifestRaw | ConvertFrom-Json
} catch {
  throw "NO_ACCEPTED_RUNTIME: runtime manifest cannot be parsed: $($_.Exception.Message)"
}

$origin = $manifest.origin
$expectedIdentity = $null
if ($origin -and $origin.kind -eq 'git') {
  if ([string]::IsNullOrWhiteSpace($origin.commit) -or $origin.commit -notmatch '^[0-9a-fA-F]{40}$') {
    throw "NO_ACCEPTED_RUNTIME: manifest Git commit '$($origin.commit)' is not a valid 40-character commit hash."
  }
  $expectedIdentity = "git:$($origin.commit)"
} elseif ($origin -and $origin.kind -eq 'npm-package') {
  if ([string]::IsNullOrWhiteSpace($origin.name) -or
      [string]::IsNullOrWhiteSpace($origin.version) -or
      [string]::IsNullOrWhiteSpace($origin.content_sha256) -or
      $origin.content_sha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw "NO_ACCEPTED_RUNTIME: manifest package origin is incomplete."
  }
  $expectedIdentity = "package:$($origin.name)@$($origin.version):$($origin.content_sha256)"
} else {
  throw "NO_ACCEPTED_RUNTIME: runtime manifest is missing a supported origin identity."
}

if ([string]::Compare([string]$record.runtime_identity, $expectedIdentity, [System.StringComparison]::OrdinalIgnoreCase) -ne 0) {
  throw "NO_ACCEPTED_RUNTIME: recorded runtime_identity '$($record.runtime_identity)' does not match manifest identity '$expectedIdentity'."
}

$runtimeEntry = [string]$manifest.runtime.entry
if ([string]::IsNullOrWhiteSpace($runtimeEntry)) {
  throw "NO_ACCEPTED_RUNTIME: runtime manifest does not declare its entry point."
}
$expectedEntry = if ($origin.kind -eq 'git') { 'src/operator/main.ts' } else { 'dist/operator/main.js' }
if ($runtimeEntry -ne $expectedEntry) { throw 'NO_ACCEPTED_RUNTIME: unexpected runtime entry point.' }
$entrypoint = Join-Path $runtimePath ($runtimeEntry -replace '/', '\')
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
  throw "NO_ACCEPTED_RUNTIME: runtime entry point not found at '$entrypoint'."
}

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd -or -not $nodeCmd.Source) {
    throw "NODE_NOT_FOUND: Node.js executable could not be resolved from PATH. Provide -NodePath explicitly."
  }
  $resolvedNodePath = [System.IO.Path]::GetFullPath($nodeCmd.Source)
} else {
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw "NODE_NOT_FOUND: Node.js executable does not exist at '$NodePath'."
  }
  $resolvedNodePath = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $NodePath).Path)
}

$sidecarPath = Join-Path $resolvedStateDir "operator-ui-$Port.json"

$ipProperties = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
$activeListeners = $ipProperties.GetActiveTcpListeners()
foreach ($listener in $activeListeners) {
  if ($listener.Port -eq $Port) {
    throw "PORT_ALREADY_OWNED: UI port $Port is already owned by an active TCP listener ($($listener.Address):$Port)."
  }
}

try {
  $testListener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback, $Port)
  $testListener.Start()
  $testListener.Stop()
} catch {
  throw "PORT_ALREADY_OWNED: UI port $Port cannot be bound ($($_.Exception.Message))."
}

# Git-snapshot runtimes keep TypeScript sources and need the transform flag;
# installed packages freeze compiled JavaScript and run plain Node.
$nodeArgs = @()
if ($entrypoint -match '\.ts$') { $nodeArgs += '--experimental-transform-types' }

$commandLine = (
  @(Quote-Argument $resolvedNodePath) + $nodeArgs + @(
    (Quote-Argument $entrypoint),
    'ui',
    '--config',
    (Quote-Argument $resolvedConfigPath),
    '--port',
    [string]$Port
  )
) -join ' '

$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = 0
$result = ([wmiclass]'Win32_Process').Create($commandLine, $runtimePath, $startup)
if ($result.ReturnValue -ne 0) {
  throw "Win32_Process.Create failed with return code $($result.ReturnValue)."
}

$processId = [int]$result.ProcessId
$creationDate = ''
for ($attempt = 0; $attempt -lt 5; $attempt++) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if ($null -ne $process) {
    $creationDate = $process.CreationDate.ToUniversalTime().ToString('o')
    break
  }
  Start-Sleep -Milliseconds 20
}

if (-not $creationDate) {
  throw 'UI_START_FAILED: could not observe the launched UI process identity.'
}

try {
  $ready = $false
  $readyDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while ([DateTime]::UtcNow -lt $readyDeadline) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    if ($null -eq $process -or $process.CreationDate.ToUniversalTime().ToString('o') -ne $creationDate) {
      throw 'UI_START_FAILED: launched process exited before serving the settings page.'
    }
    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listeners | Where-Object { $_.OwningProcess -eq $processId -and $_.LocalAddress -eq '127.0.0.1' }) {
      try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 1
        if ($response.StatusCode -eq 200) { $ready = $true; break }
      } catch { }
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $ready) { throw 'UI_START_FAILED: launched UI did not serve the settings page within 10 seconds.' }
} catch {
  $launchError = $_
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if ($null -ne $process -and $process.CreationDate.ToUniversalTime().ToString('o') -eq $creationDate -and $process.CommandLine -eq $commandLine) {
    Stop-Process -Id $processId -ErrorAction SilentlyContinue
  }
  throw $launchError
}

$sidecar = [ordered]@{
  port = $Port
  url = "http://127.0.0.1:$Port"
  pid = $processId
  creation_date = $creationDate
  runtime_identity = [string]$record.runtime_identity
  runtime_origin = $origin
  runtime_commit = $(if ($origin.kind -eq 'git') { [string]$origin.commit } else { $null })
  runtime_path = $runtimePath
  config_path = $resolvedConfigPath
  started_at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

$sidecarJson = $sidecar | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($sidecarPath, $sidecarJson + "`n", [System.Text.Encoding]::UTF8)

[ordered]@{
  url = "http://127.0.0.1:$Port"
  pid = $processId
  creation_date = $creationDate
  runtime_identity = [string]$record.runtime_identity
  runtime_origin = $origin
  runtime_commit = $(if ($origin.kind -eq 'git') { [string]$origin.commit } else { $null })
} | ConvertTo-Json -Compress
