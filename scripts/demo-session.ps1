[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet(
    "register-upstream",
    "import-direct-from-source",
    "list-and-search-skills",
    "inspect-and-refresh-state",
    "apply-selected-agents",
    "workspace-sync"
  )]
  [string]$Workflow,
  [string]$RecordingFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

. (Join-Path $PSScriptRoot "demo-common.ps1")

$script:IsRecording = $PSBoundParameters.ContainsKey("RecordingFile") -and -not [string]::IsNullOrWhiteSpace($RecordingFile)
$script:Records = New-Object System.Collections.Generic.List[object]
$script:ActiveProfile = "personal"
$script:DelayScale = 2
$escape = [string][char]27
$script:Ansi = [ordered]@{
  Reset = "${escape}[0m"
  BoldCyan = "${escape}[1;36m"
  BoldBlue = "${escape}[1;34m"
  BoldGreen = "${escape}[1;32m"
  Cyan = "${escape}[36m"
  Gray = "${escape}[90m"
}

function New-MenuOption {
  param(
    [Parameter(Mandatory)][string]$Label,
    [string]$Hint = ""
  )

  return [pscustomobject]@{
    Label = $Label
    Hint = $Hint
  }
}

$ProfileMenuOptions = @(
  (New-MenuOption -Label "show" -Hint "show active profile skills + MCP servers"),
  (New-MenuOption -Label "inspect" -Hint "check imports, freshness, and capability warnings"),
  (New-MenuOption -Label "refresh" -Hint "refresh imported skill sources"),
  (New-MenuOption -Label "add-skill" -Hint "add a skill import to profile"),
  (New-MenuOption -Label "remove-skill" -Hint "remove a skill import from profile"),
  (New-MenuOption -Label "new-skill" -Hint "scaffold a local skill directory"),
  (New-MenuOption -Label "add-upstream" -Hint "add an upstream repository"),
  (New-MenuOption -Label "remove-upstream" -Hint "remove an upstream repository"),
  (New-MenuOption -Label "add-mcp" -Hint "add or update an MCP server"),
  (New-MenuOption -Label "remove-mcp" -Hint "remove an MCP server"),
  (New-MenuOption -Label "export" -Hint "export profile config to JSON"),
  (New-MenuOption -Label "import" -Hint "import profile config JSON"),
  (New-MenuOption -Label "diff" -Hint "compare two profiles"),
  (New-MenuOption -Label "clone" -Hint "clone a profile pack")
)

$ListMenuOptions = @(
  (New-MenuOption -Label "profiles" -Hint "show available profiles"),
  (New-MenuOption -Label "skills" -Hint "show effective profile skills"),
  (New-MenuOption -Label "mcps" -Hint "show effective profile MCP servers"),
  (New-MenuOption -Label "upstreams" -Hint "show configured upstream repos"),
  (New-MenuOption -Label "agents" -Hint "show locally detected agents"),
  (New-MenuOption -Label "everything" -Hint "full profile inventory"),
  (New-MenuOption -Label "upstream-content" -Hint "skills and MCP manifests in upstream refs")
)

$SearchMenuOptions = @(
  (New-MenuOption -Label "skills" -Hint "fuzzy search skills"),
  (New-MenuOption -Label "skills verbose" -Hint "include title metadata and title matching")
)

$WorkspaceMenuOptions = @(
  (New-MenuOption -Label "export" -Hint "write a full workspace manifest"),
  (New-MenuOption -Label "diff" -Hint "compare manifest vs live workspace"),
  (New-MenuOption -Label "sync (dry-run)" -Hint "preview manifest reconciliation"),
  (New-MenuOption -Label "sync" -Hint "apply manifest reconciliation")
)

$DetailLevelOptions = @(
  (New-MenuOption -Label "concise" -Hint "compact inventory rows"),
  (New-MenuOption -Label "full" -Hint "show provenance and materialization details")
)

$SearchScopeOptions = @(
  (New-MenuOption -Label "discoverable" -Hint "search upstream content"),
  (New-MenuOption -Label "installed" -Hint "search skills attached to the profile"),
  (New-MenuOption -Label "all" -Hint "search installed and discoverable content")
)

$ImportSourceOptions = @(
  (New-MenuOption -Label "existing upstream" -Hint "use a registered upstream id"),
  (New-MenuOption -Label "source locator" -Hint "import directly from a repo or path")
)

$ImportSelectionOptions = @(
  (New-MenuOption -Label "all discoverable skills" -Hint "attach every matching skill"),
  (New-MenuOption -Label "pick explicit paths" -Hint "choose skill paths manually")
)

$ImportPostActionOptions = @(
  (New-MenuOption -Label "build" -Hint "update deterministic output now"),
  (New-MenuOption -Label "build + apply" -Hint "materialize runtime output immediately"),
  (New-MenuOption -Label "none" -Hint "defer build/apply")
)

$RefreshModeOptions = @(
  (New-MenuOption -Label "dry-run" -Hint "preview changes only"),
  (New-MenuOption -Label "refresh only" -Hint "update lock state without build/apply"),
  (New-MenuOption -Label "refresh + build + apply" -Hint "update and materialize immediately")
)

$UpstreamChoiceOptions = @(
  (New-MenuOption -Label "matlab_skills" -Hint "MATLAB demo upstream"),
  (New-MenuOption -Label "openai_curated" -Hint "curated OpenAI demo upstream")
)

$YesNoOptions = @(
  (New-MenuOption -Label "yes" -Hint "continue"),
  (New-MenuOption -Label "no" -Hint "cancel")
)

$OutputFormatOptions = @(
  (New-MenuOption -Label "text" -Hint "human-readable summary"),
  (New-MenuOption -Label "json" -Hint "machine-readable output")
)

function Add-RecordingChunk {
  param(
    [Parameter(Mandatory)][int]$DelayMilliseconds,
    [Parameter(Mandatory)][string]$Content
  )

  if (-not $script:IsRecording) {
    return
  }
  if ([string]::IsNullOrEmpty($Content)) {
    return
  }

  $normalizedContent = (($Content -replace "`r`n", "`n") -replace "`n", "`r`n")
  $scaledDelay = [int][Math]::Round($DelayMilliseconds * $script:DelayScale)

  $script:Records.Add([ordered]@{
      delay = $scaledDelay
      content = $normalizedContent
    })
}

function Write-LiteralText {
  param(
    [Parameter(Mandatory)][string]$Text,
    [int]$DelayMilliseconds = 0
  )

  if ([string]::IsNullOrEmpty($Text)) {
    return
  }

  if ($script:IsRecording) {
    Add-RecordingChunk -DelayMilliseconds $DelayMilliseconds -Content $Text
    return
  }

  if ($DelayMilliseconds -gt 0) {
    Start-Sleep -Milliseconds ([int][Math]::Round($DelayMilliseconds * $script:DelayScale))
  }
  [Console]::Out.Write($Text)
  [Console]::Out.Flush()
}

function Write-TypedText {
  param(
    [Parameter(Mandatory)][string]$Text,
    [int]$DelayMilliseconds = 16
  )

  foreach ($character in $Text.ToCharArray()) {
    if ($script:IsRecording) {
      Add-RecordingChunk -DelayMilliseconds $DelayMilliseconds -Content ([string]$character)
    } else {
      [Console]::Out.Write($character)
      [Console]::Out.Flush()
      Start-Sleep -Milliseconds ([int][Math]::Round($DelayMilliseconds * $script:DelayScale))
    }
  }
}

function Paint-Text {
  param(
    [Parameter(Mandatory)][string]$Text,
    [Parameter(Mandatory)][string]$Code
  )

  return "$Code$Text$($script:Ansi.Reset)"
}

function Format-ShellPrompt {
  $label = if ($script:ActiveProfile) {
    "skills-sync($($script:ActiveProfile))"
  } else {
    "skills-sync"
  }

  return "$(Paint-Text -Text $label -Code $script:Ansi.BoldCyan)$(Paint-Text -Text ' >' -Code $script:Ansi.Gray) "
}

function Get-ShellBannerText {
  $lines = @(
    "$(Paint-Text -Text 'skills-sync' -Code $script:Ansi.BoldCyan) $(Paint-Text -Text 'interactive shell' -Code $script:Ansi.BoldBlue)",
    "$(Paint-Text -Text 'Run CLI commands directly. Use help/:help for shell commands. Type exit to quit.' -Code $script:Ansi.Gray)",
    "$(Paint-Text -Text "Profile context enabled: $($script:ActiveProfile)" -Code $script:Ansi.Gray)",
    "$(Paint-Text -Text 'Modes:' -Code $script:Ansi.Gray)",
    "$(Paint-Text -Text '  setup   -> init | init --seed' -Code $script:Ansi.Gray)",
    "$(Paint-Text -Text '  sync    -> build -> apply' -Code $script:Ansi.Gray)",
    "$(Paint-Text -Text 'Explore and Manage:' -Code $script:Ansi.Gray)",
    "$(Paint-Text -Text '  list      -> profiles, skills, MCP servers, upstreams, and detected agents' -Code $script:Ansi.Gray)",
    "$(Paint-Text -Text '  agents    -> inventory/drift to identify drift and sync status' -Code $script:Ansi.Gray)",
    "$(Paint-Text -Text '  profile   -> inspect, refresh, scaffold, and manage skills/MCPs/upstreams' -Code $script:Ansi.Gray)",
    "$(Paint-Text -Text '  search    -> choose search mode, then enter query' -Code $script:Ansi.Gray)",
    "$(Paint-Text -Text '  workspace -> export, diff, and sync full environment manifests' -Code $script:Ansi.Gray)",
    ""
  )

  return ($lines -join "`n") + "`n"
}

function Normalize-DemoOutput {
  param([Parameter(Mandatory)][string]$Text)

  $normalized = $Text -replace "`r`n", "`n"
  $manifestPath = Join-Path $context.SkillsSyncHome "workspace/skills-sync.manifest.json"
  $escapedManifestPath = [regex]::Escape($manifestPath)
  $normalized = $normalized -replace $escapedManifestPath, "./workspace/skills-sync.manifest.json"

  return $normalized
}

function Write-CommandOutput {
  param(
    [Parameter(Mandatory)][string]$Text,
    [int]$InitialDelayMilliseconds = 180,
    [int]$LineDelayMilliseconds = 35
  )

  $normalized = Normalize-DemoOutput -Text $Text
  if (-not $script:IsRecording) {
    [Console]::Out.Write($normalized)
    [Console]::Out.Flush()
    return
  }

  $segments = [regex]::Matches($normalized, ".*?(?:`n|$)") | ForEach-Object { $_.Value } | Where-Object { $_.Length -gt 0 }
  $delay = $InitialDelayMilliseconds
  foreach ($segment in $segments) {
    Add-RecordingChunk -DelayMilliseconds $delay -Content $segment
    $delay = $LineDelayMilliseconds
  }
}

function Save-Recording {
  param([Parameter(Mandatory)][string]$Path)

  Write-JsonFile -Path $Path -Object ([ordered]@{
      config = (New-TerminalizerRecordingConfig)
      records = $script:Records.ToArray()
    })
}

function Write-ShellInput {
  param([Parameter(Mandatory)][string]$Text)

  Write-LiteralText -Text (Format-ShellPrompt) -DelayMilliseconds 220
  Write-TypedText -Text $Text
  Write-LiteralText -Text "`n"
}

function Invoke-CommandOutput {
  param([Parameter(Mandatory)][string[]]$Arguments)

  $output = Invoke-SkillsSyncCaptured @Arguments
  Write-CommandOutput -Text $output

  if (-not $script:IsRecording) {
    Start-Sleep -Milliseconds ([int][Math]::Round(320 * $script:DelayScale))
  }
}

function Get-MenuFrameLines {
  param(
    [Parameter(Mandatory)][string]$Title,
    [Parameter(Mandatory)][object[]]$Options,
    [Parameter(Mandatory)][int]$SelectedIndex
  )

  $maxLabelLength = 0
  foreach ($option in $Options) {
    $labelLength = ([string]$option.Label).Length
    if ($labelLength -gt $maxLabelLength) {
      $maxLabelLength = $labelLength
    }
  }

  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("$(Paint-Text -Text '?' -Code $script:Ansi.BoldBlue) $(Paint-Text -Text $Title -Code $script:Ansi.BoldBlue)")

  for ($index = 0; $index -lt $Options.Count; $index += 1) {
    $option = $Options[$index]
    $selected = $index -eq $SelectedIndex
    $prefix = if ($selected) {
      Paint-Text -Text ">" -Code $script:Ansi.BoldCyan
    } else {
      " "
    }
    $labelRaw = ([string]$option.Label).PadRight($maxLabelLength)
    $labelText = if ($selected) {
      Paint-Text -Text $labelRaw -Code $script:Ansi.BoldCyan
    } else {
      $labelRaw
    }
    $hintRaw = [string]$option.Hint
    $hintText = if ([string]::IsNullOrWhiteSpace($hintRaw)) {
      ""
    } else {
      "  $(Paint-Text -Text $hintRaw -Code $script:Ansi.Gray)"
    }
    $lines.Add("$prefix $labelText$hintText")
  }

  return $lines.ToArray()
}

function Get-MenuFrameText {
  param(
    [Parameter(Mandatory)][string]$Title,
    [Parameter(Mandatory)][object[]]$Options,
    [Parameter(Mandatory)][int]$SelectedIndex
  )

  $lines = Get-MenuFrameLines -Title $Title -Options $Options -SelectedIndex $SelectedIndex
  return ($lines -join "`n") + "`n"
}

function Get-MenuRedrawText {
  param(
    [Parameter(Mandatory)][string]$Title,
    [Parameter(Mandatory)][object[]]$Options,
    [Parameter(Mandatory)][int]$SelectedIndex
  )

  $lines = Get-MenuFrameLines -Title $Title -Options $Options -SelectedIndex $SelectedIndex
  $builder = [System.Text.StringBuilder]::new()
  [void]$builder.Append("${escape}[$($lines.Count)A")
  foreach ($line in $lines) {
    [void]$builder.Append("${escape}[2K`r")
    [void]$builder.Append($line)
    [void]$builder.Append("`n")
  }
  return $builder.ToString()
}

function Show-SelectPrompt {
  param(
    [Parameter(Mandatory)][string]$Title,
    [Parameter(Mandatory)][object[]]$Options,
    [Parameter(Mandatory)][int]$SelectedIndex
  )

  Write-LiteralText -Text (Get-MenuFrameText -Title $Title -Options $Options -SelectedIndex 0) -DelayMilliseconds 150
  for ($index = 1; $index -le $SelectedIndex; $index += 1) {
    Write-LiteralText -Text (Get-MenuRedrawText -Title $Title -Options $Options -SelectedIndex $index) -DelayMilliseconds 160
  }
}

function Show-TextPrompt {
  param(
    [Parameter(Mandatory)][string]$Title,
    [Parameter(Mandatory)][string]$Value
  )

  Write-LiteralText -Text ("$(Paint-Text -Text '?' -Code $script:Ansi.BoldBlue) $(Paint-Text -Text $Title -Code $script:Ansi.BoldBlue)`n") -DelayMilliseconds 140
  Write-LiteralText -Text ("$(Paint-Text -Text '|' -Code $script:Ansi.Gray) ")
  Write-TypedText -Text $Value
  Write-LiteralText -Text "`n"
}

function Start-ShellSession {
  Write-LiteralText -Text '$ ' -DelayMilliseconds 80
  Write-TypedText -Text 'skills-sync'
  Write-LiteralText -Text "`n"
  Write-CommandOutput -Text (Get-ShellBannerText) -InitialDelayMilliseconds 180 -LineDelayMilliseconds 28
}

function Stop-ShellSession {
  Write-ShellInput -Text 'exit'
  Write-CommandOutput -Text ("$(Paint-Text -Text 'Leaving shell mode.' -Code $script:Ansi.BoldGreen)`n") -InitialDelayMilliseconds 120 -LineDelayMilliseconds 28
}

function Add-FinalHold {
  $holdMilliseconds = 1500

  if ($script:IsRecording) {
    $rawDelay = [int][Math]::Ceiling($holdMilliseconds / $script:DelayScale)
    Add-RecordingChunk -DelayMilliseconds $rawDelay -Content $script:Ansi.Reset
    return
  }

  Start-Sleep -Milliseconds $holdMilliseconds
}

function Initialize-BaseWorkspace {
  Invoke-SkillsSyncHidden "init"
  Write-JsonFile -Path (Join-Path $env:SKILLS_SYNC_HOME "workspace/upstreams.json") -Object @{
    schemaVersion = 2
    upstreams = @()
  }
}

function Initialize-FullWorkspace {
  param([switch]$BuildProfile)

  Initialize-BaseWorkspace
  Seed-UpstreamCache -UpstreamId "matlab_skills" -RepositoryPath $context.MatlabRepo
  Seed-UpstreamCache -UpstreamId "openai_curated" -RepositoryPath $context.OpenAiRepo
  Invoke-SkillsSyncHidden "upstream" "add" "--source" "matlab/skills" "--default-ref" "main"
  Invoke-SkillsSyncHidden "profile" "add-skill" "personal" "--upstream" "matlab_skills" "--path" "skills/matlab-test-generator"
  Invoke-SkillsSyncHidden "profile" "add-skill" "personal" "--source" "https://github.com/openai/skills/tree/main/skills/.curated" "--upstream-id" "openai_curated" "--all"

  if ($BuildProfile) {
    Invoke-SkillsSyncHidden "build" "--profile" "personal"
  }
}

$context = New-DemoContext -Workflow $Workflow

Start-ShellSession

switch ($Workflow) {
  "register-upstream" {
    Initialize-BaseWorkspace

    Write-ShellInput -Text "profile"
    Show-SelectPrompt -Title "Profile options" -Options $ProfileMenuOptions -SelectedIndex 6
    Show-TextPrompt -Title "Source locator" -Value "matlab/skills"
    Invoke-CommandOutput -Arguments @("profile", "add-upstream", "--source", "matlab/skills")

    Write-ShellInput -Text "list"
    Show-SelectPrompt -Title "List options" -Options $ListMenuOptions -SelectedIndex 3
    Invoke-CommandOutput -Arguments @("list", "upstreams")
  }

  "import-direct-from-source" {
    Initialize-BaseWorkspace
    Seed-UpstreamCache -UpstreamId "openai_curated" -RepositoryPath $context.OpenAiRepo

    Write-ShellInput -Text "profile"
    Show-SelectPrompt -Title "Profile options" -Options $ProfileMenuOptions -SelectedIndex 3
    Show-SelectPrompt -Title "Import source" -Options $ImportSourceOptions -SelectedIndex 1
    Show-TextPrompt -Title "Source locator" -Value "https://github.com/openai/skills/tree/main/skills/.curated"
    Show-TextPrompt -Title "Preferred upstream id" -Value "openai_curated"
    Show-SelectPrompt -Title "Selection mode" -Options $ImportSelectionOptions -SelectedIndex 0
    Show-SelectPrompt -Title "After import" -Options $ImportPostActionOptions -SelectedIndex 0
    Invoke-CommandOutput -Arguments @(
      "profile",
      "add-skill",
      "personal",
      "--source",
      "https://github.com/openai/skills/tree/main/skills/.curated",
      "--upstream-id",
      "openai_curated",
      "--all",
      "--build"
    )
  }

  "list-and-search-skills" {
    Initialize-FullWorkspace -BuildProfile

    Write-ShellInput -Text "list"
    Show-SelectPrompt -Title "List options" -Options $ListMenuOptions -SelectedIndex 1
    Show-SelectPrompt -Title "Detail level" -Options $DetailLevelOptions -SelectedIndex 1
    Invoke-CommandOutput -Arguments @("list", "skills", "--profile", "personal", "--detail", "full")

    Write-ShellInput -Text "search"
    Show-SelectPrompt -Title "Search options" -Options $SearchMenuOptions -SelectedIndex 0
    Show-TextPrompt -Title "Search query" -Value "matlab"
    Show-SelectPrompt -Title "Search scope" -Options $SearchScopeOptions -SelectedIndex 0
    Invoke-CommandOutput -Arguments @("search", "skills", "--query", "matlab", "--scope", "discoverable")

    Write-ShellInput -Text "search"
    Show-SelectPrompt -Title "Search options" -Options $SearchMenuOptions -SelectedIndex 0
    Show-TextPrompt -Title "Search query" -Value "spreadsheet"
    Show-SelectPrompt -Title "Search scope" -Options $SearchScopeOptions -SelectedIndex 1
    Invoke-CommandOutput -Arguments @("search", "skills", "--query", "spreadsheet", "--profile", "personal", "--scope", "installed")
  }

  "inspect-and-refresh-state" {
    Initialize-FullWorkspace -BuildProfile
    Update-MatlabRepository -RepositoryPath $context.MatlabRepo

    Write-ShellInput -Text "profile"
    Show-SelectPrompt -Title "Profile options" -Options $ProfileMenuOptions -SelectedIndex 1
    Invoke-CommandOutput -Arguments @("profile", "inspect", "personal")

    Write-ShellInput -Text "profile"
    Show-SelectPrompt -Title "Profile options" -Options $ProfileMenuOptions -SelectedIndex 2
    Show-SelectPrompt -Title "Refresh mode" -Options $RefreshModeOptions -SelectedIndex 0
    Invoke-CommandOutput -Arguments @("profile", "refresh", "personal", "--dry-run")

    Write-ShellInput -Text "profile"
    Show-SelectPrompt -Title "Profile options" -Options $ProfileMenuOptions -SelectedIndex 2
    Show-SelectPrompt -Title "Upstream" -Options $UpstreamChoiceOptions -SelectedIndex 0
    Show-SelectPrompt -Title "Refresh mode" -Options $RefreshModeOptions -SelectedIndex 2
    Invoke-CommandOutput -Arguments @("profile", "refresh", "personal", "--upstream", "matlab_skills", "--build", "--apply")
  }

  "apply-selected-agents" {
    Initialize-FullWorkspace -BuildProfile

    Write-ShellInput -Text "apply"
    Show-TextPrompt -Title "Agents" -Value "codex,claude"
    Invoke-CommandOutput -Arguments @("apply", "--profile", "personal", "--agents", "codex,claude")

    Write-ShellInput -Text "unlink"
    Show-TextPrompt -Title "Agents" -Value "codex"
    Show-SelectPrompt -Title "Dry-run" -Options $YesNoOptions -SelectedIndex 0
    Invoke-CommandOutput -Arguments @("unlink", "--agents", "codex", "--dry-run")
  }

  "workspace-sync" {
    Initialize-FullWorkspace -BuildProfile

    Write-ShellInput -Text "workspace"
    Show-SelectPrompt -Title "Workspace options" -Options $WorkspaceMenuOptions -SelectedIndex 0
    Invoke-CommandOutput -Arguments @("workspace", "export")

    Write-ShellInput -Text "workspace"
    Show-SelectPrompt -Title "Workspace options" -Options $WorkspaceMenuOptions -SelectedIndex 1
    Show-SelectPrompt -Title "Output format" -Options $OutputFormatOptions -SelectedIndex 1
    Invoke-CommandOutput -Arguments @("workspace", "diff", "--format", "json")

    Write-ShellInput -Text "workspace"
    Show-SelectPrompt -Title "Workspace options" -Options $WorkspaceMenuOptions -SelectedIndex 2
    Invoke-CommandOutput -Arguments @("workspace", "sync", "--dry-run")
  }
}

Stop-ShellSession
Add-FinalHold

if ($script:IsRecording) {
  Save-Recording -Path $RecordingFile
}
