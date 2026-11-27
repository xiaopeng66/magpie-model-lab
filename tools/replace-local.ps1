# RYP: shared local replacement; never activate a partially installed or unverified directory.
function Assert-LabPlainPath([string]$Path, [switch]$AllowMissing) {
  $full = [IO.Path]::GetFullPath($Path)
  if ($full.Length -gt [IO.Path]::GetPathRoot($full).Length) { $full = $full.TrimEnd('\','/') }
  $current = $full; $first = $true
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked path is not allowed: $current" }
      if (-not $first -and -not $item.PSIsContainer) { throw "Path ancestor is not a directory: $current" }
    } elseif (-not $AllowMissing) { throw "Path does not exist: $current" }
    $first = $false; $current = [IO.Path]::GetDirectoryName($current)
  }
  return $full
}
function Assert-LabPathWithin([string]$Path, [string]$Root) {
  $base = Assert-LabPlainPath $Root
  $full = Assert-LabPlainPath $Path -AllowMissing
  if (-not $full.StartsWith($base.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Path is outside the approved directory: $full" }
  return $full
}
function Get-LabDirectoryInventory([string]$Path) {
  $root = Assert-LabPlainPath $Path
  if (-not (Get-Item -LiteralPath $root -Force).PSIsContainer) { throw "Expected a directory: $root" }
  $files = @{}; $queue = New-Object 'System.Collections.Generic.Queue[string]'; $queue.Enqueue($root)
  while ($queue.Count) {
    foreach ($item in Get-ChildItem -LiteralPath $queue.Dequeue() -Force -ErrorAction Stop) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked entry is not allowed: $($item.FullName)" }
      if ($item.PSIsContainer) { $queue.Enqueue($item.FullName) }
      else { $relative = $item.FullName.Substring($root.Length + 1).Replace('\','/'); $files[$relative] = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash }
    }
  }
  return $files
}
function Assert-LabInventory([hashtable]$Actual, [hashtable]$Expected) {
  if ($Actual.Count -ne $Expected.Count) { throw 'Directory file count changed' }
  foreach ($name in $Expected.Keys) { if (-not $Actual.ContainsKey($name) -or $Actual[$name] -ne $Expected[$name]) { throw "Directory hash mismatch: $name" } }
}
function Copy-LabVerifiedDirectory([string]$Source, [string]$Destination, [string]$ApprovedRoot) {
  $from = Assert-LabPlainPath $Source; $to = Assert-LabPathWithin $Destination $ApprovedRoot
  if (Test-Path -LiteralPath $to) { throw "Backup/staging directory already exists: $to" }
  $before = Get-LabDirectoryInventory $from
  Copy-Item -LiteralPath $from -Destination $to -Recurse -Force -ErrorAction Stop
  Assert-LabInventory (Get-LabDirectoryInventory $to) $before
  Assert-LabInventory (Get-LabDirectoryInventory $from) $before
  return $before
}
function Assert-LabRelativePath([string]$Name) {
  if (-not $Name -or [IO.Path]::IsPathRooted($Name) -or $Name -match '[\x00-\x1f<>:"|?*]' -or $Name.Split('/') -contains '..' -or $Name.Split('/') -contains '.' -or $Name.Split('/') -contains '' -or $Name -match '(?:^|/)[^/]*[ .](?:/|$)' -or $Name -match '(?i)(?:^|/)(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|/|$)') { throw "Invalid archive path: $Name" }
}
function Get-LabEntryHash($Entry, [long]$ExpectedLength) {
  if ($Entry.Length -ne $ExpectedLength) { throw "Archive/source length mismatch: $($Entry.FullName)" }
  $stream = $Entry.Open(); $hash = [Security.Cryptography.SHA256]::Create(); $buffer = New-Object byte[] 65536; $total = 0L
  try {
    while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $total += $count; if ($total -gt $ExpectedLength) { throw "Archive entry exceeds source length: $($Entry.FullName)" }
      $hash.TransformBlock($buffer, 0, $count, $buffer, 0) | Out-Null
    }
    if ($total -ne $ExpectedLength) { throw "Incomplete archive entry: $($Entry.FullName)" }
    $hash.TransformFinalBlock((New-Object byte[] 0), 0, 0) | Out-Null
    return [BitConverter]::ToString($hash.Hash).Replace('-','').ToLowerInvariant()
  } finally { $hash.Dispose(); $stream.Dispose() }
}
function Confirm-LabArchive([string]$Archive, [string]$SourceRoot, $Manifest) {
  $zipPath = Assert-LabPlainPath $Archive; $source = Assert-LabPlainPath $SourceRoot
  if ($Manifest.allMatchSource -ne $true -or $Manifest.sha256 -notmatch '^[a-f0-9]{64}$' -or -not ($Manifest.files -is [array]) -or -not $Manifest.files.Count -or $Manifest.entries -ne $Manifest.files.Count) { throw 'Package manifest is invalid' }
  if ((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Manifest.sha256) { throw 'Package archive hash mismatch' }
  $expected = @{}; $lengths = @{}
  foreach ($relative in $Manifest.files) {
    if (-not ($relative -is [string]) -or $relative.Contains('\')) { throw 'Invalid manifest file path' }
    Assert-LabRelativePath $relative
    if ($expected.ContainsKey($relative)) { throw "Duplicate manifest path: $relative" }
    $file = Assert-LabPathWithin (Join-Path $source $relative) $source
    $item = Get-Item -LiteralPath $file -Force -ErrorAction Stop
    if ($item.PSIsContainer) { throw "Source is not a file: $relative" }
    $expected[$relative] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant(); $lengths[$relative] = $item.Length
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($zipPath); $seen = @{}; $checked = 0
  try {
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('\','/'); $directory = -not $entry.Name
      $relative = if ($directory) { $name.TrimEnd('/') } else { $name }
      Assert-LabRelativePath $relative
      $mode = ($entry.ExternalAttributes -shr 16) -band 0xf000
      if ($mode -notin @(0,0x4000,0x8000)) { throw "Linked/special archive entry: $name" }
      if ($seen.ContainsKey($relative)) { throw "Duplicate archive path: $name" }; $seen[$relative] = $true
      if ($directory) {
        if ($entry.Length -ne 0 -or -not @($expected.Keys | Where-Object { $_.StartsWith($relative + '/', [StringComparison]::OrdinalIgnoreCase) }).Count) { throw "Unexpected archive directory: $name" }
        continue
      }
      if (-not $expected.ContainsKey($relative)) { throw "Unexpected archive file: $name" }
      if ((Get-LabEntryHash $entry $lengths[$relative]) -ne $expected[$relative]) { throw "Archive/source hash mismatch: $name" }
      $checked++
    }
    if ($checked -ne $expected.Count) { throw 'Missing archive files' }
  } finally { $zip.Dispose() }
  return $expected
}
function Move-LabDirectory($Entry, [string]$Source, [string]$Destination) {
  foreach ($path in @($Source,$Destination)) {
    $full = Assert-LabPlainPath $path -AllowMissing
    if ($full -notin @($Entry.target,$Entry.stage,$Entry.backup,$Entry.failed) -or -not [string]::Equals([IO.Path]::GetDirectoryName($full), $Entry.parent, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe directory move: $full" }
  }
  if (Test-Path -LiteralPath $Destination) { throw "Move destination already exists: $Destination" }
  Move-Item -LiteralPath $Source -Destination $Destination -ErrorAction Stop | Out-Null
}
function Remove-LabStaging($Entry, [string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $full = Assert-LabPathWithin $Path $Entry.parent
  if ($full -notin @($Entry.stage,$Entry.failed)) { throw "Unsafe staging cleanup: $full" }
  Get-LabDirectoryInventory $full | Out-Null
  Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
}
function Remove-LabOldBackups($Entry, [string[]]$CurrentBackups) {
  $current = @($CurrentBackups | ForEach-Object { Assert-LabPathWithin $_ $Entry.parent })
  $older = @(Get-ChildItem -LiteralPath $Entry.parent -Directory -Force -ErrorAction Stop |
    Where-Object { $_.Name -match '^\.magpie-model-lab-backup-[a-f0-9]{32}$' -and -not ($current -contains [IO.Path]::GetFullPath($_.FullName)) } |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 1)
  foreach ($item in $older) {
    $full = Assert-LabPathWithin $item.FullName $Entry.parent
    Get-LabDirectoryInventory $full | Out-Null
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
  }
}
function Wait-LabPortRelease([int]$Port) {
  if (-not $Port) { return }
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    # Enumerating first returns an empty result for a released port instead of a CIM not-found error.
    $listeners = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Port -and $_.State -eq 'Listen' })
    if (-not $listeners.Count) { return }
    Start-Sleep -Milliseconds 250
  }
  throw 'Plugin still owns its port; no directories were switched'
}
function Invoke-LabPluginCommand([string]$MagpieExe, [string]$PluginSpec, [string]$Mode) {
  $previousErrorPreference = $ErrorActionPreference
  try {
    # Windows PowerShell treats redirected native stderr as an error record.
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = $null
    & $MagpieExe plugin $Mode $PluginSpec 2>&1 | Out-Null
    if ($null -eq $global:LASTEXITCODE -or $global:LASTEXITCODE -ne 0) { throw "Plugin $Mode command failed" }
  } finally { $ErrorActionPreference = $previousErrorPreference }
}
function Get-LabUpdatePaths([string[]]$Targets) {
  if (-not $Targets.Count) { throw 'No replacement targets' }
  $full = @($Targets | ForEach-Object { Assert-LabPlainPath $_ -AllowMissing } | Sort-Object)
  if (@($full | Select-Object -Unique).Count -ne $full.Count) { throw 'Duplicate replacement targets' }
  foreach ($target in $full) {
    Assert-LabPlainPath ([IO.Path]::GetDirectoryName($target)) | Out-Null
    foreach ($other in $full) { if ($target.StartsWith($other + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Replacement targets overlap' } }
  }
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    $key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes(($full -join "`n").ToLowerInvariant()))).Replace('-','').ToLowerInvariant()
  } finally { $hash.Dispose() }
  # Parent locks also serialize backup pruning for different targets sharing that parent.
  $parents = @($full | ForEach-Object { [IO.Path]::GetDirectoryName($_) } | Sort-Object -Unique)
  return [pscustomobject]@{ targets = $full; journal = (Join-Path ([IO.Path]::GetDirectoryName($full[0])) ('.magpie-model-lab-update-' + $key + '.json')); locks = @($parents | ForEach-Object { Join-Path $_ '.magpie-model-lab-update.lock' }); references = @($parents | ForEach-Object { Join-Path $_ '.magpie-model-lab-update.pending.json' }) }
}
function Open-LabUpdateLocks($Paths) {
  $handles = @()
  try {
    foreach ($path in $Paths.locks) {
      Assert-LabPlainPath $path -AllowMissing | Out-Null
      try { $handles += [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
      catch { throw 'Another local replacement is in progress or its lock cannot be opened' }
    }
    foreach ($path in $Paths.references) {
      Assert-LabPlainPath $path -AllowMissing | Out-Null
      if (-not (Test-Path -LiteralPath $path)) { continue }
      $info = Get-Item -LiteralPath $path -Force
      if ($info.PSIsContainer -or $info.Length -gt 65536) { throw 'Invalid pending update reference; preserved without changes' }
      $reference = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($reference.schema -ne 'magpie-local-update-reference-v1' -or -not ($reference.journal -is [string]) -or -not ($reference.targets -is [array]) -or -not $reference.targets.Count -or @($reference.targets | Where-Object { -not ($_ -is [string]) -or -not $_ }).Count) { throw 'Invalid pending update reference; preserved without changes' }
      $pending = Assert-LabPlainPath $reference.journal -AllowMissing
      $recorded = Get-LabUpdatePaths $reference.targets
      if ($recorded.journal -ne $pending -or $path -notin $recorded.references) { throw 'Pending update reference target mismatch; preserved without changes' }
      if (-not (Test-Path -LiteralPath $pending)) { throw 'The pending update journal is missing; preserved without changes' }
      if ($pending -ne $Paths.journal) { throw "An interrupted replacement must be recovered with its complete original target set first: $pending" }
    }
  } catch { foreach ($handle in $handles) { $handle.Dispose() }; throw }
  return ,$handles
}
function Write-LabUpdateReferences($Paths) {
  foreach ($path in $Paths.references) { Write-LabUpdateJournal $path ([ordered]@{ schema = 'magpie-local-update-reference-v1'; journal = $Paths.journal; targets = $Paths.targets }) }
}
function Complete-LabUpdateJournal($Paths) {
  # Clear references before their journal; interruption here already leaves a verified complete version.
  foreach ($path in $Paths.references) {
    Assert-LabPlainPath $path -AllowMissing | Out-Null
    if (Test-Path -LiteralPath $path) {
      $info = Get-Item -LiteralPath $path -Force
      if ($info.PSIsContainer -or $info.Length -gt 65536) { throw 'Pending update reference changed during cleanup' }
      $reference = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($reference.schema -ne 'magpie-local-update-reference-v1' -or $reference.journal -ne $Paths.journal) { throw 'Pending update reference changed during cleanup' }
      Remove-Item -LiteralPath $path -Force
    }
  }
  Assert-LabPlainPath $Paths.journal | Out-Null
  Remove-Item -LiteralPath $Paths.journal -Force
}
function Write-LabUpdateJournal([string]$Path, $Journal) {
  Assert-LabPlainPath $Path -AllowMissing | Out-Null
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Journal | ConvertTo-Json -Depth 12 -Compress))
  if ($bytes.Length -gt 8MB) { throw 'Update journal is too large' }
  $temp = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  try {
    $stream = [IO.File]::Open($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temp, $Path, [NullString]::Value) } else { [IO.File]::Move($temp, $Path) }
  } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}
function ConvertTo-LabInventory($Value) {
  if ($null -eq $Value -or -not ($Value -is [System.Management.Automation.PSCustomObject])) { throw 'Invalid journal inventory' }
  $result = @{}
  foreach ($property in $Value.PSObject.Properties) {
    Assert-LabRelativePath $property.Name
    if ($property.Value -notmatch '^[a-fA-F0-9]{64}$' -or $result.ContainsKey($property.Name)) { throw 'Invalid journal hash' }
    $result[$property.Name] = $property.Value
  }
  return ,$result
}
function Repair-LabReplacementJournal($Paths, [string]$MagpieExe, [string]$PluginSpec, [int]$Port) {
  if (-not (Test-Path -LiteralPath $Paths.journal)) { return [ordered]@{ recovered = $false } }
  $path = Assert-LabPlainPath $Paths.journal; $info = Get-Item -LiteralPath $path -Force
  if ($info.PSIsContainer -or $info.Length -gt 8MB) { throw 'Invalid update journal; preserved without changes' }
  $journal = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($journal.schema -ne 'magpie-local-update-v1' -or $journal.phase -notin @('prepared','switching','activating','committed','rolling-back','recovering-old') -or @($journal.entries).Count -ne $Paths.targets.Count) { throw 'Invalid update journal; preserved without changes' }
  $seen = @{}; $entries = @()
  foreach ($entry in $journal.entries) {
    $target = Assert-LabPlainPath $entry.target -AllowMissing; $parent = [IO.Path]::GetDirectoryName($target)
    if ($target -notin $Paths.targets -or $seen.ContainsKey($target) -or $entry.parent -ne $parent -or [IO.Path]::GetFileName($entry.backup) -notmatch '^\.magpie-model-lab-backup-([a-f0-9]{32})$') { throw 'Update journal target mismatch; preserved without changes' }
    $id = $Matches[1]; $seen[$target] = $true
    foreach ($kind in @('backup','stage','failed')) {
      $expected = Join-Path $parent ('.magpie-model-lab-' + $kind + '-' + $id)
      if ($entry.$kind -ne $expected) { throw 'Update journal path mismatch; preserved without changes' }
      Assert-LabPathWithin $entry.$kind $parent | Out-Null
    }
    $entries += [pscustomobject]@{ target = $target; parent = $parent; backup = $entry.backup; stage = $entry.stage; failed = $entry.failed; original = (ConvertTo-LabInventory $entry.original); prepared = (ConvertTo-LabInventory $entry.prepared); state = '' }
  }
  Write-LabUpdateReferences $Paths
  Invoke-LabPluginCommand $MagpieExe $PluginSpec 'off'; Wait-LabPortRelease $Port
  $keepNew = $journal.phase -in @('activating','committed')
  # Validate every directory before the first move, preserving any unrecognized external edits.
  foreach ($entry in $entries) {
    foreach ($kind in @('backup','stage','failed')) { if (Test-Path -LiteralPath $entry.$kind) { $expected = if ($kind -eq 'backup') { $entry.original } else { $entry.prepared }; Assert-LabInventory (Get-LabDirectoryInventory $entry.$kind) $expected } }
    if (Test-Path -LiteralPath $entry.target) {
      $actual = Get-LabDirectoryInventory $entry.target
      if ($keepNew) { Assert-LabInventory $actual $entry.prepared; $entry.state = 'new' }
      else {
        try { Assert-LabInventory $actual $entry.original; $entry.state = 'old' }
        catch { Assert-LabInventory $actual $entry.prepared; $entry.state = 'new' }
      }
    } else { $entry.state = 'missing' }
    if ($keepNew) { if ($entry.state -ne 'new') { throw 'An activated update no longer matches its verified new files; preserved without changes' } }
    elseif ($entry.state -ne 'old' -and -not (Test-Path -LiteralPath $entry.backup)) { throw 'The original backup is missing; preserved without changes' }
    if (-not $keepNew -and $entry.state -eq 'new' -and (Test-Path -LiteralPath $entry.failed)) { throw 'Ambiguous recovery directories; preserved without changes' }
  }
  if (-not $keepNew) {
    $journal.phase = 'recovering-old'; Write-LabUpdateJournal $path $journal
    for ($index = $entries.Count - 1; $index -ge 0; $index--) {
      $entry = $entries[$index]
      if ($entry.state -eq 'old') { continue }
      if ($entry.state -eq 'new') { Move-LabDirectory $entry $entry.target $entry.failed }
      Move-LabDirectory $entry $entry.backup $entry.target
    }
  }
  foreach ($entry in $entries) {
    $expected = if ($keepNew) { $entry.prepared } else { $entry.original }
    Assert-LabInventory (Get-LabDirectoryInventory $entry.target) $expected
    Remove-LabStaging $entry $entry.stage; Remove-LabStaging $entry $entry.failed
  }
  Complete-LabUpdateJournal $Paths
  return [ordered]@{ recovered = $true; version = $(if ($keepNew) { 'new' } else { 'old' }); keptDisabled = $true }
}
function Repair-LabLocalReplacement {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string[]]$Targets, [Parameter(Mandatory=$true)][string]$MagpieExe, [Parameter(Mandatory=$true)][string]$PluginSpec, [ValidateRange(0,65535)][int]$Port = 3489)
  $ErrorActionPreference = 'Stop'; $paths = Get-LabUpdatePaths $Targets; $handles = Open-LabUpdateLocks $paths
  try { return Repair-LabReplacementJournal $paths $MagpieExe $PluginSpec $Port } finally { foreach ($handle in $handles) { $handle.Dispose() } }
}
function Invoke-LabLocalReplacementCore {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$SourceRoot,
    [Parameter(Mandatory=$true)]$Manifest, [Parameter(Mandatory=$true)][string[]]$Targets,
    [Parameter(Mandatory=$true)][string]$MagpieExe, [Parameter(Mandatory=$true)][string]$PluginSpec, [ValidateRange(0,65535)][int]$Port = 3489,
    [string[]]$RemovedFiles = @(), [switch]$KeepDisabledOnRollback, [string]$JournalPath, $UpdatePaths)
  $ErrorActionPreference = 'Stop'
  $expected = Confirm-LabArchive $Archive $SourceRoot $Manifest
  $obsolete = @{}
  foreach ($name in $RemovedFiles) {
    if (-not $name -or $name.Contains('\')) { throw "Invalid removal path: $name" }
    Assert-LabRelativePath $name
    $sourceFile = Assert-LabPathWithin (Join-Path $SourceRoot $name) $SourceRoot
    if ($expected.ContainsKey($name) -or (Test-Path -LiteralPath $sourceFile)) { throw "Removal still exists in source: $name" }
    $obsolete[$name] = $true
  }
  if (-not $Targets.Count) { throw 'No replacement targets' }
  $entries = @(); $unique = @{}
  foreach ($target in $Targets) {
    $full = Assert-LabPlainPath $target; $parent = [IO.Path]::GetDirectoryName($full)
    if (-not $parent -or $unique.ContainsKey($full) -or -not (Get-Item -LiteralPath $full -Force).PSIsContainer) { throw "Invalid replacement target: $full" }
    foreach ($other in $unique.Keys) { if ($full.StartsWith($other + '\', [StringComparison]::OrdinalIgnoreCase) -or $other.StartsWith($full + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Replacement targets overlap' } }
    $unique[$full] = $true; $id = [Guid]::NewGuid().ToString('N')
    $entries += [pscustomobject]@{ target = $full; parent = $parent; stage = (Join-Path $parent ('.magpie-model-lab-stage-' + $id)); backup = (Join-Path $parent ('.magpie-model-lab-backup-' + $id)); failed = (Join-Path $parent ('.magpie-model-lab-failed-' + $id)); original = $null; prepared = $null; displaced = $false }
  }
  $disabled = $false; $portReleased = $false; $activationAttempted = $false; $installed = $false; $journal = $null
  try {
    foreach ($entry in $entries) {
      $entry.original = Copy-LabVerifiedDirectory $entry.target $entry.stage $entry.parent
      Expand-Archive -LiteralPath $Archive -DestinationPath $entry.stage -Force -ErrorAction Stop
      foreach ($name in $obsolete.Keys) {
        $obsoleteFile = Assert-LabPathWithin (Join-Path $entry.stage $name) $entry.stage
        if (Test-Path -LiteralPath $obsoleteFile) {
          if ((Get-Item -LiteralPath $obsoleteFile -Force -ErrorAction Stop).PSIsContainer) { throw "Removal is not a regular file: $name" }
          Remove-Item -LiteralPath $obsoleteFile -Force -ErrorAction Stop
        }
      }
      $entry.prepared = Get-LabDirectoryInventory $entry.stage
      foreach ($name in $expected.Keys) { if (-not $entry.prepared.ContainsKey($name) -or $entry.prepared[$name].ToLowerInvariant() -ne $expected[$name]) { throw "Staged source mismatch: $name" } }
      foreach ($name in $obsolete.Keys) { if ($entry.prepared.ContainsKey($name)) { throw "Obsolete file remains in staging: $name" } }
      foreach ($name in $entry.original.Keys) { if (-not $expected.ContainsKey($name) -and -not $obsolete.ContainsKey($name) -and $entry.prepared[$name] -ne $entry.original[$name]) { throw "Staging changed an extra file: $name" } }
    }
    $journal = [pscustomobject]@{ schema = 'magpie-local-update-v1'; phase = 'prepared'; entries = $entries }
    Write-LabUpdateJournal $JournalPath $journal
    Write-LabUpdateReferences $UpdatePaths
    Invoke-LabPluginCommand $MagpieExe $PluginSpec 'off'; $disabled = $true; Wait-LabPortRelease $Port; $portReleased = $true
    $journal.phase = 'switching'; Write-LabUpdateJournal $JournalPath $journal
    foreach ($entry in $entries) {
      Assert-LabInventory (Get-LabDirectoryInventory $entry.target) $entry.original
      Move-LabDirectory $entry $entry.target $entry.backup; $entry.displaced = $true
      Move-LabDirectory $entry $entry.stage $entry.target
      Assert-LabInventory (Get-LabDirectoryInventory $entry.target) $entry.prepared
    }
    $journal.phase = 'activating'; Write-LabUpdateJournal $JournalPath $journal
    $activationAttempted = $true; Invoke-LabPluginCommand $MagpieExe $PluginSpec 'on'; $installed = $true
    $journal.phase = 'committed'; Write-LabUpdateJournal $JournalPath $journal
    $backupCleanupWarnings = @()
    foreach ($entry in $entries) {
      $currentBackups = @($entries | Where-Object { [string]::Equals($_.parent, $entry.parent, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.backup })
      try { Remove-LabOldBackups $entry $currentBackups } catch { $backupCleanupWarnings += $_.Exception.Message }
    }
    Complete-LabUpdateJournal $UpdatePaths
    return [ordered]@{ stoppedBeforeOverwrite = $true; removedFiles = @($RemovedFiles); backups = @($entries | ForEach-Object { $_.backup }); backupCleanupWarnings = $backupCleanupWarnings; directories = @($entries | ForEach-Object { [ordered]@{ root = $_.target; filesChecked = $expected.Count; allMatchSource = $true } }) }
  } catch {
    $failure = $_.Exception.Message; $recovery = @(); $safe = $disabled -and $portReleased
    if ($disabled -and -not $portReleased) { $recovery += 'Plugin remains disabled; port shutdown could not be verified' }
    if ($disabled -and $activationAttempted) {
      try { Invoke-LabPluginCommand $MagpieExe $PluginSpec 'off'; Wait-LabPortRelease $Port } catch { $safe = $false; $recovery += $_.Exception.Message; $recovery += 'No rollback was attempted while shutdown remained unverified' }
    }
    if ($safe) {
      if ($journal) { $journal.phase = 'rolling-back'; Write-LabUpdateJournal $JournalPath $journal }
      for ($index = $entries.Count - 1; $index -ge 0; $index--) {
        $entry = $entries[$index]; if (-not $entry.displaced) { continue }
        try {
          if (Test-Path -LiteralPath $entry.target) { Move-LabDirectory $entry $entry.target $entry.failed }
          Move-LabDirectory $entry $entry.backup $entry.target
        } catch { $recovery += $_.Exception.Message }
      }
      foreach ($entry in $entries) { try { Assert-LabInventory (Get-LabDirectoryInventory $entry.target) $entry.original } catch { $recovery += $_.Exception.Message } }
      if (-not $recovery.Count -and $journal) { Complete-LabUpdateJournal $UpdatePaths; $journal = $null }
      if (-not $recovery.Count -and $KeepDisabledOnRollback) {
        $recovery += 'Old directories were restored and verified; plugin remains disabled until data compatibility is verified'
      } elseif (-not $recovery.Count) {
        try { Invoke-LabPluginCommand $MagpieExe $PluginSpec 'on'; $recovery += 'Old directories were restored, verified and re-enabled' }
        catch { $recovery += $_.Exception.Message; try { Invoke-LabPluginCommand $MagpieExe $PluginSpec 'off' } catch { $recovery += $_.Exception.Message } }
      } else { $recovery += 'Plugin remains disabled; recover from the preserved backups' }
    }
    if ($journal -and -not @($entries | Where-Object displaced).Count) { Complete-LabUpdateJournal $UpdatePaths; $journal = $null }
    $backups = @($entries | Where-Object { Test-Path -LiteralPath $_.backup } | ForEach-Object { $_.backup }) -join '; '
    if (-not $backups) { $backups = 'none; refer to the verified original target directories' }
    throw "Local replacement failed: $failure. $($recovery -join '; '). Preserved backups: $backups"
  } finally {
    foreach ($entry in $entries) {
      if (-not (Test-Path -LiteralPath $JournalPath)) { Remove-LabStaging $entry $entry.stage; if ($installed) { Remove-LabStaging $entry $entry.failed } }
    }
  }
}
function Invoke-LabLocalReplacement {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$SourceRoot,
    [Parameter(Mandatory=$true)]$Manifest, [Parameter(Mandatory=$true)][string[]]$Targets,
    [Parameter(Mandatory=$true)][string]$MagpieExe, [Parameter(Mandatory=$true)][string]$PluginSpec, [ValidateRange(0,65535)][int]$Port = 3489,
    [string[]]$RemovedFiles = @(), [switch]$KeepDisabledOnRollback)
  $ErrorActionPreference = 'Stop'; $paths = Get-LabUpdatePaths $Targets; $handles = Open-LabUpdateLocks $paths
  try {
    Repair-LabReplacementJournal $paths $MagpieExe $PluginSpec $Port | Out-Null
    return Invoke-LabLocalReplacementCore @PSBoundParameters -JournalPath $paths.journal -UpdatePaths $paths
  } finally { foreach ($handle in $handles) { $handle.Dispose() } }
}
