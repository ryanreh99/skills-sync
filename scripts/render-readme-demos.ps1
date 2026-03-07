[CmdletBinding()]
param(
  [Parameter()]
  [ValidateSet(
    "register-upstream",
    "import-direct-from-source",
    "list-and-search-skills",
    "inspect-and-refresh-state",
    "apply-selected-agents",
    "workspace-sync"
  )]
  [string[]]$Workflow = @(
    "register-upstream",
    "import-direct-from-source",
    "list-and-search-skills",
    "inspect-and-refresh-state",
    "apply-selected-agents",
    "workspace-sync"
  ),
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

. (Join-Path $PSScriptRoot "demo-common.ps1")

$repoRoot = Get-RepoRoot
$demoDir = Join-Path $repoRoot "docs/demo"
$sessionScript = Join-Path $PSScriptRoot "demo-session.ps1"
Ensure-Directory -Path $demoDir

if (-not $SkipBuild) {
  Invoke-CheckedNative -FilePath "npm" -Arguments @("run", "build") -WorkingDirectory $repoRoot -Quiet
}

foreach ($name in $Workflow) {
  $recordingBase = Join-Path $demoDir $name
  Remove-PathIfPresent -Path "$recordingBase.yml"
  Remove-PathIfPresent -Path "$recordingBase.gif"

  Invoke-CheckedNative -FilePath "powershell" -Arguments @(
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $sessionScript,
    "-Workflow",
    $name,
    "-RecordingFile",
    "$recordingBase.yml"
  ) -WorkingDirectory $repoRoot -Quiet

  $previousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
  $previousNativeErrorPreference = $PSNativeCommandUseErrorActionPreference
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction Ignore
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    Push-Location $repoRoot
    try {
      & terminalizer render "$recordingBase.yml" --output "$recordingBase.gif" --quality 90 --step 1 | Out-Null
      if ($LASTEXITCODE -ne 0) {
        throw "terminalizer render failed with exit code $LASTEXITCODE for '$name'."
      }
    } finally {
      Pop-Location
    }
  } finally {
    $PSNativeCommandUseErrorActionPreference = $previousNativeErrorPreference
    if ($null -ne $previousElectronRunAsNode) {
      $env:ELECTRON_RUN_AS_NODE = $previousElectronRunAsNode
    }
  }
}
