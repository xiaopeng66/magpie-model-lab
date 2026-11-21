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
  Move-Item -LiteralPath $Source -Destination $Destination -ErrorAction Stop
}
function Remove-LabStaging($Entry, [string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $full = Assert-LabPathWithin $Path $Entry.parent
  if ($full -notin @($Entry.stage,$Entry.failed)) { throw "Unsafe staging cleanup: $full" }
  Get-LabDirectoryInventory $full | Out-Null
  Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
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
  & $MagpieExe plugin $Mode $PluginSpec | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Plugin $Mode command failed" }
}
function Invoke-LabLocalReplacement {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$SourceRoot,
    [Parameter(Mandatory=$true)]$Manifest, [Parameter(Mandatory=$true)][string[]]$Targets,
    [Parameter(Mandatory=$true)][string]$MagpieExe, [Parameter(Mandatory=$true)][string]$PluginSpec, [ValidateRange(0,65535)][int]$Port = 3489,
    [string[]]$RemovedFiles = @())
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
  $disabled = $false; $portReleased = $false; $activationAttempted = $false; $installed = $false
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
    Invoke-LabPluginCommand $MagpieExe $PluginSpec 'off'; $disabled = $true; Wait-LabPortRelease $Port; $portReleased = $true
    foreach ($entry in $entries) {
      Assert-LabInventory (Get-LabDirectoryInventory $entry.target) $entry.original
      Move-LabDirectory $entry $entry.target $entry.backup; $entry.displaced = $true
      Move-LabDirectory $entry $entry.stage $entry.target
      Assert-LabInventory (Get-LabDirectoryInventory $entry.target) $entry.prepared
    }
    $activationAttempted = $true; Invoke-LabPluginCommand $MagpieExe $PluginSpec 'on'; $installed = $true
    return [ordered]@{ stoppedBeforeOverwrite = $true; removedFiles = @($RemovedFiles); backups = @($entries | ForEach-Object { $_.backup }); directories = @($entries | ForEach-Object { [ordered]@{ root = $_.target; filesChecked = $expected.Count; allMatchSource = $true } }) }
  } catch {
    $failure = $_.Exception.Message; $recovery = @(); $safe = $disabled -and $portReleased
    if ($disabled -and -not $portReleased) { $recovery += 'Plugin remains disabled; port shutdown could not be verified' }
    if ($disabled -and $activationAttempted) {
      try { Invoke-LabPluginCommand $MagpieExe $PluginSpec 'off'; Wait-LabPortRelease $Port } catch { $safe = $false; $recovery += $_.Exception.Message; $recovery += 'No rollback was attempted while shutdown remained unverified' }
    }
    if ($safe) {
      for ($index = $entries.Count - 1; $index -ge 0; $index--) {
        $entry = $entries[$index]; if (-not $entry.displaced) { continue }
        try {
          if (Test-Path -LiteralPath $entry.target) { Move-LabDirectory $entry $entry.target $entry.failed }
          Move-LabDirectory $entry $entry.backup $entry.target
        } catch { $recovery += $_.Exception.Message }
      }
      foreach ($entry in $entries) { try { Assert-LabInventory (Get-LabDirectoryInventory $entry.target) $entry.original } catch { $recovery += $_.Exception.Message } }
      if (-not $recovery.Count) {
        try { Invoke-LabPluginCommand $MagpieExe $PluginSpec 'on'; $recovery += 'Old directories were restored, verified and re-enabled' }
        catch { $recovery += $_.Exception.Message; try { Invoke-LabPluginCommand $MagpieExe $PluginSpec 'off' } catch { $recovery += $_.Exception.Message } }
      } else { $recovery += 'Plugin remains disabled; recover from the preserved backups' }
    }
    $backups = @($entries | Where-Object { Test-Path -LiteralPath $_.backup } | ForEach-Object { $_.backup }) -join '; '
    if (-not $backups) { $backups = 'none; refer to the verified original target directories' }
    throw "Local replacement failed: $failure. $($recovery -join '; '). Preserved backups: $backups"
  } finally {
    foreach ($entry in $entries) {
      Remove-LabStaging $entry $entry.stage
      if ($installed) { Remove-LabStaging $entry $entry.failed }
    }
  }
}
