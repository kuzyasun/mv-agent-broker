param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$RuntimeEntry,
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$RuntimePath,
  [Parameter(Mandatory = $true)][string]$StateDir
)

$ErrorActionPreference = 'Stop'

function Quote-Argument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

# Git-snapshot runtimes keep TypeScript sources and need the transform flag;
# installed packages freeze compiled JavaScript and run plain Node.
$nodeArgs = @()
if ($RuntimeEntry -match '\.ts$') { $nodeArgs += '--experimental-transform-types' }

$commandLine = (
  @(Quote-Argument $NodePath) + $nodeArgs + @(
    (Quote-Argument $RuntimeEntry),
    'daemon',
    '--config',
    (Quote-Argument $ConfigPath)
  )
) -join ' '

$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = 0
$result = ([wmiclass]'Win32_Process').Create($commandLine, $RuntimePath, $startup)
if ($result.ReturnValue -ne 0) {
  throw "Win32_Process.Create failed with return code $($result.ReturnValue)."
}

$processId = [int]$result.ProcessId
$creationDate = ''
for ($attempt = 0; $attempt -lt 50; $attempt++) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if ($null -ne $process) {
    $creationDate = [string]$process.CreationDate
    break
  }
  Start-Sleep -Milliseconds 20
}

if (-not $creationDate) {
  throw 'Could not observe the launched daemon process identity.'
}

[ordered]@{
  pid = $processId
  creationDate = $creationDate
} | ConvertTo-Json -Compress
