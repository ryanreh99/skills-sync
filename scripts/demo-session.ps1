[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet(
    "register-upstream",
    "add-skills-from-upstream",
    "agents-drift",
    "import-direct-from-source",
    "list-and-search-skills",
    "inspect-and-refresh-state",
    "workspace-sync"
  )]
  [string]$Workflow,
  [Parameter(Mandatory)]
  [string]$RecordingFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

. (Join-Path $PSScriptRoot "demo-common.ps1")

function Initialize-BaseWorkspace {
  Invoke-SkillsSyncHidden "init"
  Write-JsonFile -Path (Join-Path $env:SKILLS_SYNC_HOME "workspace/upstreams.json") -Object @{
    schemaVersion = 2
    upstreams = @()
  }
}

function Initialize-FullWorkspace {
  Initialize-BaseWorkspace
  Seed-UpstreamCache -UpstreamId "matlab_skills" -RepositoryPath $context.MatlabRepo
  Seed-UpstreamCache -UpstreamId "openai_curated" -RepositoryPath $context.OpenAiRepo
  Invoke-SkillsSyncHidden "upstream" "add" "--source" "matlab/skills" "--default-ref" "main"
  Invoke-SkillsSyncHidden "profile" "add-skill" "personal" "--upstream" "matlab_skills" "--path" "skills/matlab-test-generator"
  Invoke-SkillsSyncHidden "profile" "add-skill" "personal" "--source" "https://github.com/openai/skills/tree/main/skills/.curated" "--upstream-id" "openai_curated" "--all"
  Invoke-SkillsSyncHidden "sync" "--profile" "personal"
}

function New-RunStep {
  param(
    [Parameter(Mandatory)][string]$Command,
    [int]$PauseAfterMs = 3500
  )

  return [ordered]@{
    kind = "run"
    command = $Command
    pauseAfterMs = $PauseAfterMs
  }
}

function New-ExplorerStep {
  param(
    [Parameter(Mandatory)][string]$TargetId,
    [string]$Suffix = "",
    [int]$PauseAfterMs = 3500
  )

  $step = [ordered]@{
    kind = "explorer"
    targetId = $TargetId
    pauseAfterMs = $PauseAfterMs
  }

  if (-not [string]::IsNullOrEmpty($Suffix)) {
    $step.suffix = $Suffix
  }

  return $step
}

function New-GuidedTextInput {
  param([string]$Value = "")

  return [ordered]@{
    type = "text"
    value = $Value
  }
}

function New-GuidedSelectInput {
  param([int]$Moves = 0)

  return [ordered]@{
    type = "select"
    moves = $Moves
  }
}

function New-GuidedPickerInput {
  param(
    [int]$Moves = 0,
    [bool]$Toggle = $true
  )

  return [ordered]@{
    type = "picker"
    moves = $Moves
    toggle = $Toggle
  }
}

function New-GuidedSubmitInput {
  param([int]$Moves = 0)

  return [ordered]@{
    type = "submit"
    moves = $Moves
  }
}

function New-GuidedExplorerStep {
  param(
    [Parameter(Mandatory)][string]$TargetId,
    [Parameter(Mandatory)][object[]]$Inputs,
    [int]$PauseAfterMs = 3500
  )

  return [ordered]@{
    kind = "guided"
    targetId = $TargetId
    inputs = $Inputs
    pauseAfterMs = $PauseAfterMs
  }
}

function Get-WorkflowSteps {
  param([Parameter(Mandatory)][string]$WorkflowName)

  switch ($WorkflowName) {
    "register-upstream" {
      Initialize-BaseWorkspace
      return @(
        (New-GuidedExplorerStep -TargetId "profile-upstream-add" -PauseAfterMs 2600 -Inputs @(
          (New-GuidedTextInput -Value "matlab/skills"),
          (New-GuidedTextInput),
          (New-GuidedTextInput),
          (New-GuidedSubmitInput)
        )),
        (New-ExplorerStep -TargetId "explore-upstreams-list" -PauseAfterMs 2200)
      )
    }
    "add-skills-from-upstream" {
      Initialize-BaseWorkspace
      Seed-UpstreamCache -UpstreamId "matlab_skills" -RepositoryPath $context.MatlabRepo
      return @(
        (New-GuidedExplorerStep -TargetId "profile-upstream-add" -PauseAfterMs 2600 -Inputs @(
          (New-GuidedTextInput -Value "matlab/skills"),
          (New-GuidedTextInput),
          (New-GuidedTextInput),
          (New-GuidedSubmitInput)
        )),
        (New-GuidedExplorerStep -TargetId "explore-upstream-content" -PauseAfterMs 2400 -Inputs @(
          (New-GuidedSelectInput),
          (New-GuidedTextInput),
          (New-GuidedTextInput -Value "--verbose"),
          (New-GuidedSubmitInput)
        )),
        (New-GuidedExplorerStep -TargetId "profile-skills-add-upstream" -PauseAfterMs 3200 -Inputs @(
          (New-GuidedSelectInput),
          (New-GuidedTextInput),
          (New-GuidedSelectInput),
          (New-GuidedPickerInput),
          (New-GuidedTextInput),
          (New-GuidedSubmitInput)
        ))
      )
    }
    "agents-drift" {
      Initialize-FullWorkspace
      Remove-PathIfPresent -Path (Join-Path $env:HOME ".codex/skills/vendor_imports/openai_curated/spreadsheet")
      return @(
        (New-ExplorerStep -TargetId "explore-agents-inventory" -PauseAfterMs 2600),
        (New-ExplorerStep -TargetId "explore-agents-drift" -PauseAfterMs 3200)
      )
    }
    "import-direct-from-source" {
      Initialize-BaseWorkspace
      Seed-UpstreamCache -UpstreamId "openai_curated" -RepositoryPath $context.OpenAiRepo
      return @(
        (New-GuidedExplorerStep -TargetId "profile-skills-add-source" -PauseAfterMs 3600 -Inputs @(
          (New-GuidedTextInput -Value "https://github.com/openai/skills/tree/main/skills/.curated"),
          (New-GuidedTextInput),
          (New-GuidedSelectInput -Moves 1),
          (New-GuidedTextInput -Value "--upstream-id openai_curated"),
          (New-GuidedSubmitInput)
        ))
      )
    }
    "list-and-search-skills" {
      Initialize-FullWorkspace
      return @(
        (New-ExplorerStep -TargetId "explore-skills-list-full" -PauseAfterMs 3600),
        (New-ExplorerStep -TargetId "explore-skills-search" -Suffix "matlab --scope discoverable" -PauseAfterMs 2400),
        (New-ExplorerStep -TargetId "explore-skills-search" -Suffix "spreadsheet --profile personal --scope installed" -PauseAfterMs 2600)
      )
    }
    "inspect-and-refresh-state" {
      Initialize-FullWorkspace
      Update-MatlabRepository -RepositoryPath $context.MatlabRepo
      return @(
        (New-ExplorerStep -TargetId "profile-summary-inspect" -PauseAfterMs 2600),
        (New-GuidedExplorerStep -TargetId "profile-summary-refresh-dry-run" -PauseAfterMs 2600 -Inputs @(
          (New-GuidedSelectInput),
          (New-GuidedSelectInput),
          (New-GuidedTextInput),
          (New-GuidedSubmitInput)
        )),
        (New-GuidedExplorerStep -TargetId "profile-summary-refresh-upstream" -PauseAfterMs 3200 -Inputs @(
          (New-GuidedSelectInput),
          (New-GuidedSelectInput),
          (New-GuidedSelectInput),
          (New-GuidedTextInput),
          (New-GuidedSubmitInput)
        ))
      )
    }
    "workspace-sync" {
      Initialize-FullWorkspace
      return @(
        (New-RunStep -Command "workspace export" -PauseAfterMs 2200),
        (New-RunStep -Command "workspace diff --format json" -PauseAfterMs 3400),
        (New-RunStep -Command "workspace sync --dry-run" -PauseAfterMs 2800)
      )
    }
    default {
      throw "Unsupported workflow '$WorkflowName'."
    }
  }
}

function New-RecordingScenario {
  param(
    [Parameter(Mandatory)][string]$WorkflowName,
    [Parameter(Mandatory)][string]$OutputPath,
    [Parameter(Mandatory)][object[]]$Steps
  )

  return [ordered]@{
    workflow = $WorkflowName
    recordingFile = $OutputPath
    cwd = $context.RepoRoot
    entryPoint = (Get-SkillsSyncEntryPoint)
    cols = 88
    rows = 22
    promptText = "skills-sync(personal) > "
    readyMarker = "Active: Explorer"
    quietAfterPromptMs = 180
    quietAfterCommandMs = 550
    navigationDelayMs = 90
    expandDelayMs = 140
    typingDelayMs = 32
    timeoutMs = 90000
    env = [ordered]@{
      SKILLS_SYNC_HOME = $env:SKILLS_SYNC_HOME
      HOME = $env:HOME
      USERPROFILE = $env:USERPROFILE
      GIT_CONFIG_GLOBAL = $env:GIT_CONFIG_GLOBAL
      GIT_CONFIG_NOSYSTEM = $env:GIT_CONFIG_NOSYSTEM
      GIT_TERMINAL_PROMPT = $env:GIT_TERMINAL_PROMPT
      FORCE_COLOR = $env:FORCE_COLOR
      TERM = "xterm-256color"
      COLORTERM = "truecolor"
    }
    steps = $Steps
  }
}

$context = New-DemoContext -Workflow $Workflow
$steps = Get-WorkflowSteps -WorkflowName $Workflow
$scenarioPath = Join-Path $context.ScenarioRoot "recording-scenario.json"

try {
  Write-JsonFile -Path $scenarioPath -Object (New-RecordingScenario -WorkflowName $Workflow -OutputPath $RecordingFile -Steps $steps)

  Invoke-CheckedNative -FilePath "node" -Arguments @(
    (Join-Path $PSScriptRoot "record-demo-session.mjs"),
    "--scenario",
    $scenarioPath,
    "--output",
    $RecordingFile
  ) -WorkingDirectory $context.RepoRoot -Quiet
} finally {
  Remove-PathIfPresent -Path $scenarioPath
}
