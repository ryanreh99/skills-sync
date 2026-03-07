Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

function Get-RepoRoot {
  return (Split-Path $PSScriptRoot -Parent)
}

function Get-DemoWorkflows {
  return @(
    "register-upstream",
    "import-direct-from-source",
    "list-and-search-skills",
    "inspect-and-refresh-state",
    "apply-selected-agents",
    "workspace-sync"
  )
}

function Remove-PathIfPresent {
  param([Parameter(Mandatory)][string]$Path)

  if (Test-Path -LiteralPath $Path) {
    for ($attempt = 1; $attempt -le 6; $attempt += 1) {
      try {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
        break
      } catch {
        if (-not (Test-Path -LiteralPath $Path)) {
          break
        }
        if ($attempt -eq 6) {
          throw
        }
        Start-Sleep -Milliseconds (100 * $attempt)
      }
    }
  }
}

function Ensure-Directory {
  param([Parameter(Mandatory)][string]$Path)

  New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function New-CleanDirectory {
  param([Parameter(Mandatory)][string]$Path)

  Remove-PathIfPresent -Path $Path
  Ensure-Directory -Path $Path
}

function Write-Utf8File {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Content
  )

  $parent = Split-Path -Parent $Path
  if ($parent) {
    Ensure-Directory -Path $parent
  }

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Write-JsonFile {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)]$Object
  )

  $json = $Object | ConvertTo-Json -Depth 20
  Write-Utf8File -Path $Path -Content ($json + "`n")
}

function Convert-PathToFileUri {
  param([Parameter(Mandatory)][string]$Path)

  $resolved = (Resolve-Path -LiteralPath $Path).Path -replace "\\", "/"
  if ($resolved -match "^[A-Za-z]:") {
    return "file:///$resolved/"
  }
  return "file://$resolved/"
}

function Invoke-CheckedNative {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [Parameter()][string[]]$Arguments = @(),
    [Parameter()][string]$WorkingDirectory = (Get-RepoRoot),
    [Parameter()][switch]$Quiet
  )

  Push-Location $WorkingDirectory
  try {
    $output = & $FilePath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($exitCode -ne 0) {
    $rendered = if ($output) { ($output -join "`n").Trim() } else { "" }
    throw "Command failed: $FilePath $($Arguments -join ' ')`n$rendered"
  }

  if (-not $Quiet) {
    return $output
  }
}

function Convert-NativeOutputToText {
  param([Parameter()]$Output)

  if ($null -eq $Output) {
    return ""
  }

  $lines = @($Output | ForEach-Object { $_.ToString() })
  if ($lines.Count -eq 0) {
    return ""
  }

  return (($lines -join "`n").TrimEnd("`r", "`n")) + "`n"
}

function Get-SkillsSyncEntryPoint {
  return (Join-Path (Get-RepoRoot) "dist/index.js")
}

function Invoke-SkillsSyncHidden {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  $allArguments = @((Get-SkillsSyncEntryPoint)) + $Arguments
  Invoke-CheckedNative -FilePath "node" -Arguments $allArguments -Quiet
}

function Invoke-SkillsSyncVisible {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  & node (Get-SkillsSyncEntryPoint) @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "skills-sync exited with code $LASTEXITCODE."
  }
}

function Invoke-SkillsSyncCaptured {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  $allArguments = @((Get-SkillsSyncEntryPoint)) + $Arguments
  $output = Invoke-CheckedNative -FilePath "node" -Arguments $allArguments
  return (Convert-NativeOutputToText -Output $output)
}

function Invoke-GitHidden {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  Invoke-CheckedNative -FilePath "git" -Arguments $Arguments -Quiet
}

function New-SkillMarkdown {
  param(
    [Parameter(Mandatory)][string]$Title,
    [Parameter(Mandatory)][string]$Summary,
    [Parameter(Mandatory)][string]$Body
  )

  return @(
    "---",
    "title: $Title",
    "summary: $Summary",
    "---",
    "",
    "# $Title",
    "",
    $Body,
    ""
  ) -join "`n"
}

function Initialize-MatlabRepository {
  param([Parameter(Mandatory)][string]$RepositoryPath)

  $parent = Split-Path -Parent $RepositoryPath
  Ensure-Directory -Path $parent
  $workingPath = Join-Path $parent "_matlab-working"
  New-CleanDirectory -Path $workingPath

  Invoke-GitHidden "init" "-b" "main" $workingPath
  Invoke-GitHidden "-C" $workingPath "config" "user.name" "skills-sync demo"
  Invoke-GitHidden "-C" $workingPath "config" "user.email" "demo@skills-sync.local"

  Write-Utf8File -Path (Join-Path $workingPath "README.md") -Content @"
# matlab skills

Deterministic demo content for README recordings.
"@
  Write-Utf8File -Path (Join-Path $workingPath "skills/matlab-test-generator/SKILL.md") -Content (
    New-SkillMarkdown `
      -Title "matlab-test-generator" `
      -Summary "Generate MATLAB tests for numeric code." `
      -Body "Use this skill when you need deterministic MATLAB test scaffolding for scientific code."
  )
  Write-Utf8File -Path (Join-Path $workingPath "skills/matlab-plot-debugger/SKILL.md") -Content (
    New-SkillMarkdown `
      -Title "matlab-plot-debugger" `
      -Summary "Debug MATLAB plotting issues and figure rendering." `
      -Body "Use this skill when MATLAB charts, legends, or exports behave unexpectedly."
  )

  Invoke-GitHidden "-C" $workingPath "add" "."
  Invoke-GitHidden "-C" $workingPath "commit" "--quiet" "-m" "Initial MATLAB demo skills"

  Remove-PathIfPresent -Path $RepositoryPath
  Invoke-GitHidden "clone" "--quiet" "--bare" $workingPath $RepositoryPath
  Remove-PathIfPresent -Path $workingPath
}

function Update-MatlabRepository {
  param([Parameter(Mandatory)][string]$RepositoryPath)

  $parent = Split-Path -Parent $RepositoryPath
  $workingPath = Join-Path $parent "_matlab-refresh"
  Remove-PathIfPresent -Path $workingPath

  Invoke-GitHidden "clone" "--quiet" $RepositoryPath $workingPath
  Invoke-GitHidden "-C" $workingPath "config" "user.name" "skills-sync demo"
  Invoke-GitHidden "-C" $workingPath "config" "user.email" "demo@skills-sync.local"

  Write-Utf8File -Path (Join-Path $workingPath "skills/matlab-test-generator/SKILL.md") -Content (
    New-SkillMarkdown `
      -Title "matlab-test-generator" `
      -Summary "Generate and harden MATLAB tests for numeric code." `
      -Body "Use this skill when you need stronger MATLAB regression coverage, fixture setup, and edge-case handling."
  )

  Write-Utf8File -Path (Join-Path $workingPath "skills/matlab-test-generator/references/checklist.md") -Content @"
# MATLAB test checklist

- cover matrix shapes
- cover NaN and Inf handling
- verify deterministic fixtures
"@

  Invoke-GitHidden "-C" $workingPath "add" "."
  Invoke-GitHidden "-C" $workingPath "commit" "--quiet" "-m" "Refresh MATLAB demo skill"
  Invoke-GitHidden "-C" $workingPath "push" "--quiet" "origin" "main"
  Remove-PathIfPresent -Path $workingPath
}

function Initialize-OpenAIRepository {
  param([Parameter(Mandatory)][string]$RepositoryPath)

  $parent = Split-Path -Parent $RepositoryPath
  Ensure-Directory -Path $parent
  $workingPath = Join-Path $parent "_openai-working"
  New-CleanDirectory -Path $workingPath

  Invoke-GitHidden "init" "-b" "main" $workingPath
  Invoke-GitHidden "-C" $workingPath "config" "user.name" "skills-sync demo"
  Invoke-GitHidden "-C" $workingPath "config" "user.email" "demo@skills-sync.local"

  Write-Utf8File -Path (Join-Path $workingPath "README.md") -Content @"
# openai skills

Curated demo content for README recordings.
"@
  Write-Utf8File -Path (Join-Path $workingPath "skills/.curated/spreadsheet/SKILL.md") -Content (
    New-SkillMarkdown `
      -Title "spreadsheet" `
      -Summary "Work effectively with spreadsheets, formulas, and workbook cleanup." `
      -Body "Use this skill when tasks involve CSV, XLSX, formula repair, or spreadsheet structure analysis."
  )
  Write-Utf8File -Path (Join-Path $workingPath "skills/.curated/skill-creator/SKILL.md") -Content (
    New-SkillMarkdown `
      -Title "skill-creator" `
      -Summary "Design or refine reusable skills for coding agents." `
      -Body "Use this skill when authoring or updating SKILL.md workflows and helper assets."
  )

  Invoke-GitHidden "-C" $workingPath "add" "."
  Invoke-GitHidden "-C" $workingPath "commit" "--quiet" "-m" "Initial curated demo skills"

  Remove-PathIfPresent -Path $RepositoryPath
  Invoke-GitHidden "clone" "--quiet" "--bare" $workingPath $RepositoryPath
  Remove-PathIfPresent -Path $workingPath
}

function New-DemoContext {
  param([Parameter(Mandatory)][string]$Workflow)

  $repoRoot = Get-RepoRoot
  $scenarioRoot = Join-Path $repoRoot "docs/demo/_sandbox/$Workflow"
  New-CleanDirectory -Path $scenarioRoot

  $skillsSyncHome = Join-Path $scenarioRoot "skills-sync-home"
  $userHome = Join-Path $scenarioRoot "user-home"
  $remotesRoot = Join-Path $scenarioRoot "remotes/github.com"
  Ensure-Directory -Path $skillsSyncHome
  Ensure-Directory -Path $userHome
  Ensure-Directory -Path $remotesRoot

  $gitConfigPath = Join-Path $scenarioRoot "gitconfig"
  $githubRewrite = ([System.IO.Path]::GetFullPath($remotesRoot) -replace "\\", "/").TrimEnd("/") + "/"
  Write-Utf8File -Path $gitConfigPath -Content @"
[url "$githubRewrite"]
    insteadOf = https://github.com/
"@

  $env:SKILLS_SYNC_HOME = $skillsSyncHome
  $env:HOME = $userHome
  $env:USERPROFILE = $userHome
  $env:GIT_CONFIG_GLOBAL = $gitConfigPath
  $env:GIT_CONFIG_NOSYSTEM = "1"
  $env:GIT_TERMINAL_PROMPT = "0"
  $env:FORCE_COLOR = "1"
  Remove-Item Env:NO_COLOR -ErrorAction Ignore

  $matlabRepo = Join-Path $remotesRoot "matlab/skills.git"
  $openAiRepo = Join-Path $remotesRoot "openai/skills.git"
  Initialize-MatlabRepository -RepositoryPath $matlabRepo
  Initialize-OpenAIRepository -RepositoryPath $openAiRepo

  return [pscustomobject]@{
    Workflow = $Workflow
    RepoRoot = $repoRoot
    ScenarioRoot = $scenarioRoot
    SkillsSyncHome = $skillsSyncHome
    UserHome = $userHome
    GitConfigPath = $gitConfigPath
    MatlabRepo = $matlabRepo
    OpenAiRepo = $openAiRepo
  }
}

function Seed-UpstreamCache {
  param(
    [Parameter(Mandatory)][string]$UpstreamId,
    [Parameter(Mandatory)][string]$RepositoryPath
  )

  $cacheRoot = Join-Path $env:SKILLS_SYNC_HOME "upstreams_cache"
  $cachePath = Join-Path $cacheRoot $UpstreamId
  Ensure-Directory -Path $cacheRoot
  Remove-PathIfPresent -Path $cachePath
  Invoke-GitHidden "clone" "--quiet" "--no-checkout" $RepositoryPath $cachePath
}

function New-TerminalizerRecordingConfig {
  return [ordered]@{
    command = $null
    cwd = $null
    env = [ordered]@{
      recording = $true
    }
    cols = 88
    rows = 22
    repeat = 0
    quality = 100
    frameDelay = "auto"
    maxIdleTime = 700
    frameBox = [ordered]@{
      type = "floating"
      title = "skills-sync"
      style = [ordered]@{
        border = "0px black solid"
      }
    }
    watermark = [ordered]@{
      imagePath = $null
      style = [ordered]@{
        position = "absolute"
        right = "15px"
        bottom = "15px"
        width = "100px"
        opacity = 0.9
      }
    }
    cursorStyle = "bar"
    fontFamily = "Cascadia Code, Consolas, Monaco, monospace"
    fontSize = 14
    lineHeight = 1.2
    letterSpacing = 0
    theme = [ordered]@{
      background = "#09111f"
      foreground = "#d9e2f2"
      cursor = "#f7c948"
      black = "#0b1220"
      red = "#ff7b72"
      green = "#7ee787"
      yellow = "#f2cc60"
      blue = "#79c0ff"
      magenta = "#d2a8ff"
      cyan = "#a5f3fc"
      white = "#c9d1d9"
      brightBlack = "#6e7681"
      brightRed = "#ffa198"
      brightGreen = "#56d364"
      brightYellow = "#e3b341"
      brightBlue = "#58a6ff"
      brightMagenta = "#bc8cff"
      brightCyan = "#76e3ea"
      brightWhite = "#f0f6fc"
    }
  }
}
