[CmdletBinding()]
param(
  [string]$DataHome,
  [string[]]$Clients,
  [switch]$All,
  [switch]$NonInteractive,
  [switch]$SkipDependencies,
  [switch]$SkipBuild,
  [switch]$NoPersistUserEnvironment,
  [switch]$DryRun,
  [string]$NodePath,
  [string]$ServerPath,
  [string]$ConfigRoot
)

$ErrorActionPreference = 'Stop'
$serverName = 'linkedin'
$repositoryRoot = $PSScriptRoot
$clientIds = @('Codex', 'ClaudeCode', 'ClaudeDesktop', 'VSCode', 'CopilotCLI', 'Cursor', 'Antigravity')
$clientLabels = [ordered]@{
  Codex = 'Codex CLI, IDE extension, and ChatGPT desktop'
  ClaudeCode = 'Claude Code CLI'
  ClaudeDesktop = 'Claude Desktop'
  VSCode = 'VS Code and GitHub Copilot Chat'
  CopilotCLI = 'GitHub Copilot CLI'
  Cursor = 'Cursor IDE and CLI'
  Antigravity = 'Google Antigravity IDE and CLI'
}

function Write-Stage([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Resolve-AbsolutePath([string]$Value, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "$Label cannot be empty."
  }
  $full = [IO.Path]::GetFullPath($Value.Trim())
  if (-not [IO.Path]::IsPathRooted($full)) {
    throw "$Label must be an absolute path."
  }
  $root = [IO.Path]::GetPathRoot($full)
  if ($full -eq $root) { return $full }
  return $full.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Find-Command([string]$Name) {
  foreach ($candidate in @("$Name.cmd", "$Name.exe", $Name)) {
    $found = Get-Command $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $found) { return $found.Source }
  }
  return $null
}

function Get-ConfigPath([string]$Client) {
  if ($ConfigRoot) {
    $fileNames = @{
      Codex = 'codex-config.toml'
      ClaudeCode = 'claude-code.json'
      ClaudeDesktop = 'claude-desktop.json'
      VSCode = 'vscode-mcp.json'
      CopilotCLI = 'copilot-mcp.json'
      Cursor = 'cursor-mcp.json'
      Antigravity = 'antigravity-mcp.json'
    }
    return Join-Path $ConfigRoot $fileNames[$Client]
  }

  switch ($Client) {
    'Codex' { return Join-Path $env:USERPROFILE '.codex\config.toml' }
    'ClaudeCode' { return Join-Path $env:USERPROFILE '.claude.json' }
    'ClaudeDesktop' { return Join-Path $env:APPDATA 'Claude\claude_desktop_config.json' }
    'VSCode' { return Join-Path $env:APPDATA 'Code\User\mcp.json' }
    'CopilotCLI' { return Join-Path $env:USERPROFILE '.copilot\mcp-config.json' }
    'Cursor' { return Join-Path $env:USERPROFILE '.cursor\mcp.json' }
    'Antigravity' { return Join-Path $env:USERPROFILE '.gemini\config\mcp_config.json' }
    default { throw "Unknown client '$Client'." }
  }
}

function Backup-Config([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $backup = "$Path.linkedin-mcp-backup-$stamp"
  Copy-Item -LiteralPath $Path -Destination $backup
  return $backup
}

function Restore-Config([string]$Path, [string]$Backup, [bool]$Existed) {
  if ($Backup) {
    Copy-Item -LiteralPath $Backup -Destination $Path -Force
  } elseif (-not $Existed -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Remove-Item -LiteralPath $Path -Force
  }
}

function New-StandardEntry([switch]$WithType, [switch]$WithTools) {
  $entry = [ordered]@{}
  if ($WithType) { $entry['type'] = 'stdio' }
  $entry['command'] = $script:resolvedNode
  $entry['args'] = @($script:resolvedServer)
  $entry['env'] = [ordered]@{ LINKEDIN_MCP_HOME = $script:resolvedHome }
  if ($WithTools) { $entry['tools'] = @('*') }
  return $entry
}

function Set-JsonMcpEntry(
  [string]$Path,
  [string]$RootKey,
  [System.Collections.IDictionary]$Entry
) {
  if ($DryRun) {
    Write-Host "Would update $Path ($RootKey.$serverName)"
    return 'planned'
  }

  $directory = Split-Path -Parent $Path
  if ($directory) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
  $existed = Test-Path -LiteralPath $Path -PathType Leaf
  if ($existed) {
    $raw = [IO.File]::ReadAllText($Path)
    try {
      $config = if ([string]::IsNullOrWhiteSpace($raw)) {
        [pscustomobject]@{}
      } else {
        $raw | ConvertFrom-Json
      }
    } catch {
      throw "$Path is not strict JSON. Open it in the client, fix its syntax, and rerun setup; it was not modified."
    }
  } else {
    $config = [pscustomobject]@{}
  }

  if (-not ($config -is [System.Management.Automation.PSCustomObject])) {
    throw "$Path must contain a JSON object at its root; it was not modified."
  }

  $rootProperty = $config.PSObject.Properties[$RootKey]
  if ($null -eq $rootProperty) {
    $config | Add-Member -NotePropertyName $RootKey -NotePropertyValue ([pscustomobject]@{})
  } elseif (-not ($rootProperty.Value -is [System.Management.Automation.PSCustomObject])) {
    throw "$Path has a non-object '$RootKey' value; it was not modified."
  }

  $servers = $config.PSObject.Properties[$RootKey].Value
  $desired = [pscustomobject]$Entry
  $current = $servers.PSObject.Properties[$serverName]
  if ($null -ne $current) {
    $currentJson = $current.Value | ConvertTo-Json -Depth 20 -Compress
    $desiredJson = $desired | ConvertTo-Json -Depth 20 -Compress
    if ($currentJson -eq $desiredJson) {
      Write-Host "Already configured: $Path"
      return 'unchanged'
    }
  }

  $backup = Backup-Config $Path
  try {
    $servers | Add-Member -NotePropertyName $serverName -NotePropertyValue $desired -Force
    $json = $config | ConvertTo-Json -Depth 20
    $temp = "$Path.linkedin-mcp-tmp-$PID"
    [IO.File]::WriteAllText($temp, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $Path -Force
    Write-Host "Configured: $Path"
    if ($backup) { Write-Host "Backup:     $backup" -ForegroundColor DarkGray }
    return 'configured'
  } catch {
    Restore-Config $Path $backup $existed
    throw
  }
}

function Invoke-ManagedCli(
  [string]$Client,
  [string]$CommandName,
  [string[]]$RemoveArguments,
  [string[]]$AddArguments
) {
  $command = Find-Command $CommandName
  if (-not $command) {
    throw "$CommandName is not installed or is not on PATH. Install it, or choose another client and use the manual recipe in linkedin-mcp-server/README.md."
  }
  if ($DryRun) {
    Write-Host "Would run $CommandName to replace only the '$serverName' MCP entry."
    return 'planned'
  }

  $configPath = Get-ConfigPath $Client
  $existed = Test-Path -LiteralPath $configPath -PathType Leaf
  $backup = Backup-Config $configPath
  try {
    & $command @RemoveArguments *> $null
    & $command @AddArguments
    if ($LASTEXITCODE -ne 0) {
      throw "$CommandName exited with code $LASTEXITCODE."
    }
    if ($backup) { Write-Host "Backup:     $backup" -ForegroundColor DarkGray }
    return 'configured'
  } catch {
    Restore-Config $configPath $backup $existed
    throw
  }
}

function Configure-Client([string]$Client) {
  switch ($Client) {
    'Codex' {
      if ($ConfigRoot) { throw 'Codex CLI configuration cannot be redirected; use -DryRun in tests.' }
      return Invoke-ManagedCli $Client 'codex' @('mcp', 'remove', $serverName) @(
        'mcp', 'add', $serverName,
        '--env', "LINKEDIN_MCP_HOME=$script:resolvedHome",
        '--', $script:resolvedNode, $script:resolvedServer
      )
    }
    'ClaudeCode' {
      if ($ConfigRoot) { throw 'Claude Code configuration cannot be redirected; use -DryRun in tests.' }
      return Invoke-ManagedCli $Client 'claude' @('mcp', 'remove', '--scope', 'user', $serverName) @(
        'mcp', 'add',
        '--env', "LINKEDIN_MCP_HOME=$script:resolvedHome",
        '--transport', 'stdio', '--scope', 'user',
        $serverName, '--', $script:resolvedNode, $script:resolvedServer
      )
    }
    'ClaudeDesktop' {
      return Set-JsonMcpEntry (Get-ConfigPath $Client) 'mcpServers' (New-StandardEntry)
    }
    'VSCode' {
      if (-not $ConfigRoot) {
        $code = Find-Command 'code'
        if ($code) {
          $path = Get-ConfigPath $Client
          $existed = Test-Path -LiteralPath $path -PathType Leaf
          $backup = if ($DryRun) { $null } else { Backup-Config $path }
          $definition = [ordered]@{
            name = $serverName
            type = 'stdio'
            command = $script:resolvedNode
            args = @($script:resolvedServer)
            env = [ordered]@{ LINKEDIN_MCP_HOME = $script:resolvedHome }
          } | ConvertTo-Json -Depth 10 -Compress
          if ($DryRun) {
            Write-Host "Would run VS Code's --add-mcp installer for the '$serverName' entry."
            return 'planned'
          }
          try {
            & $code --add-mcp $definition
            if ($LASTEXITCODE -ne 0) { throw "code --add-mcp exited with code $LASTEXITCODE." }
            if ($backup) { Write-Host "Backup:     $backup" -ForegroundColor DarkGray }
            return 'configured'
          } catch {
            Restore-Config $path $backup $existed
            throw
          }
        }
        Write-Warning 'VS Code CLI was not found; updating the default user-profile mcp.json directly.'
      }
      return Set-JsonMcpEntry (Get-ConfigPath $Client) 'servers' (New-StandardEntry -WithType)
    }
    'CopilotCLI' {
      $entry = New-StandardEntry -WithTools
      $entry['type'] = 'local'
      return Set-JsonMcpEntry (Get-ConfigPath $Client) 'mcpServers' $entry
    }
    'Cursor' {
      return Set-JsonMcpEntry (Get-ConfigPath $Client) 'mcpServers' (New-StandardEntry)
    }
    'Antigravity' {
      return Set-JsonMcpEntry (Get-ConfigPath $Client) 'mcpServers' (New-StandardEntry)
    }
    default { throw "Unsupported client '$Client'." }
  }
}

try {
  Write-Host 'LinkedIn MCP setup assistant' -ForegroundColor Green
  Write-Host 'All selected clients will use one local data home. No LinkedIn token is requested or written to an AI-agent config.'

  $defaultHome = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'linkedin-mcp'
  if (-not $DataHome) {
    if ($NonInteractive) {
      $DataHome = $defaultHome
    } else {
      $answer = Read-Host "Shared data home [$defaultHome]"
      $DataHome = if ([string]::IsNullOrWhiteSpace($answer)) { $defaultHome } else { $answer }
    }
  }
  $script:resolvedHome = Resolve-AbsolutePath $DataHome 'DataHome'
  if ($script:resolvedHome -eq [IO.Path]::GetPathRoot($script:resolvedHome)) {
    throw 'DataHome cannot be a filesystem root; choose a dedicated application folder.'
  }

  if ($All) {
    $selected = $clientIds
  } elseif ($Clients -and $Clients.Count -gt 0) {
    $selected = @(
      $Clients |
        ForEach-Object { $_ -split ',' } |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ } |
        Select-Object -Unique
    )
    foreach ($client in $selected) {
      if ($client -notin $clientIds) {
        throw "Unknown client '$client'. Valid names: $($clientIds -join ', ')."
      }
    }
  } elseif ($NonInteractive) {
    throw 'Non-interactive setup requires -Clients <names> or -All.'
  } else {
    Write-Host "`nChoose clients (comma-separated numbers, or A for all):"
    for ($i = 0; $i -lt $clientIds.Count; $i++) {
      Write-Host ("  {0}. {1}" -f ($i + 1), $clientLabels[$clientIds[$i]])
    }
    $choice = (Read-Host 'Selection').Trim()
    if ($choice -match '^(?i:a|all)$') {
      $selected = $clientIds
    } else {
      $selected = @()
      foreach ($part in $choice.Split(',')) {
        $number = 0
        if (-not [int]::TryParse($part.Trim(), [ref]$number) -or $number -lt 1 -or $number -gt $clientIds.Count) {
          throw "Invalid client selection '$part'."
        }
        $selected += $clientIds[$number - 1]
      }
      $selected = @($selected | Select-Object -Unique)
    }
  }

  $script:resolvedNode = if ($NodePath) {
    Resolve-AbsolutePath $NodePath 'NodePath'
  } else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $nodeCommand) { throw 'Node.js 24 or newer is required and node.exe was not found on PATH.' }
    $nodeCommand.Source
  }
  $nodeMajor = [int]((& $script:resolvedNode -p 'parseInt(process.versions.node,10)') | Select-Object -First 1)
  if ($nodeMajor -lt 24) { throw "Node.js 24 or newer is required; found major version $nodeMajor." }

  if (-not $SkipDependencies -and -not (Test-Path -LiteralPath (Join-Path $repositoryRoot 'node_modules'))) {
    Write-Stage 'Installing repository dependencies'
    if (-not $DryRun) {
      & npm.cmd install
      if ($LASTEXITCODE -ne 0) { throw "npm install exited with code $LASTEXITCODE." }
    }
  }

  if (-not $SkipBuild) {
    Write-Stage 'Building the MCP server'
    if (-not $DryRun) {
      & npm.cmd run mcp:build
      if ($LASTEXITCODE -ne 0) { throw "MCP build exited with code $LASTEXITCODE." }
    }
  }

  $script:resolvedServer = if ($ServerPath) {
    Resolve-AbsolutePath $ServerPath 'ServerPath'
  } else {
    Join-Path $repositoryRoot 'linkedin-mcp-server\dist\index.js'
  }
  if (-not $DryRun -and -not (Test-Path -LiteralPath $script:resolvedServer -PathType Leaf)) {
    throw "Compiled MCP server not found at $script:resolvedServer. Rerun without -SkipBuild."
  }

  Write-Stage 'Establishing the shared application home'
  Write-Host $script:resolvedHome
  if (-not $DryRun) {
    New-Item -ItemType Directory -Path $script:resolvedHome -Force | Out-Null
    $env:LINKEDIN_MCP_HOME = $script:resolvedHome
    if (-not $NoPersistUserEnvironment) {
      [Environment]::SetEnvironmentVariable('LINKEDIN_MCP_HOME', $script:resolvedHome, 'User')
      Write-Host 'Saved LINKEDIN_MCP_HOME for future dashboard and terminal sessions.'
    }
  }

  $configured = @()
  $unchanged = @()
  $planned = @()
  $failed = @()
  foreach ($client in $selected) {
    Write-Stage "Configuring $($clientLabels[$client])"
    try {
      $result = Configure-Client $client
      if ($result -eq 'unchanged') {
        $unchanged += $client
      } elseif ($result -eq 'planned') {
        $planned += $client
      } else {
        $configured += $client
      }
    } catch {
      $failed += $client
      Write-Error -ErrorAction Continue "$client`: $($_.Exception.Message)"
    }
  }

  Write-Stage 'Setup summary'
  Write-Host "Shared home: $script:resolvedHome"
  if ($configured.Count -gt 0) { Write-Host "Configured:  $($configured -join ', ')" }
  if ($unchanged.Count -gt 0) { Write-Host "Unchanged:   $($unchanged -join ', ')" }
  if ($planned.Count -gt 0) { Write-Host "Planned:     $($planned -join ', ')" }
  if ($failed.Count -gt 0) { Write-Host "Failed:      $($failed -join ', ')" -ForegroundColor Red }
  Write-Host "`nRestart configured AI clients so they reload MCP settings."
  Write-Host 'For a custom home, open a new terminal before starting the dashboard so it inherits the saved user environment.'
  Write-Host 'The MCP runs without the dashboard. Start the optional shared-state dashboard with: npm run dashboard'

  if ($failed.Count -gt 0) { exit 1 }
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
