# RYP: actual child-process interruption fixtures; every mutation stays in the supplied temporary root.
param([string]$FixtureRoot, [string]$SourceRoot, [string]$Mode = 'install', [string]$Checkpoint = '', [string]$Layout = 'same')
$ErrorActionPreference = 'Stop'
$fixture = [IO.Path]::GetFullPath($FixtureRoot)
if (-not (Test-Path -LiteralPath $fixture -PathType Container) -or [IO.Path]::GetFileName($fixture) -notlike 'magpie-installer-proof-*') { throw 'Invalid isolated fixture root' }
. (Join-Path $SourceRoot 'tools/replace-local.ps1')
$packageSource = Join-Path $fixture 'source'; $archive = Join-Path $fixture 'fixture.zip'
$targets = @((Join-Path $fixture 'first-target'), (Join-Path $fixture $(if ($Layout -eq 'split') { 'second-parent/second-target' } else { 'second-target' })))
$cliPath = Join-Path $fixture 'fake-cli.ps1'; $cliLog = Join-Path $fixture 'cli.log'
if (-not (Test-Path -LiteralPath $packageSource)) {
  New-Item -ItemType Directory -Path $packageSource | Out-Null
  [IO.File]::WriteAllText((Join-Path $packageSource 'index.mjs'), 'new-version')
  Compress-Archive -LiteralPath (Join-Path $packageSource 'index.mjs') -DestinationPath $archive
  foreach ($target in $targets) { New-Item -ItemType Directory -Path $target -Force | Out-Null; [IO.File]::WriteAllText((Join-Path $target 'index.mjs'), $(if ($Layout -eq 'identical') { 'new-version' } else { 'old-version' })); [IO.File]::WriteAllText((Join-Path $target 'extra.txt'), 'unchanged-extra') }
  $cliText = 'param($Verb,$Mode,$Spec)' + [Environment]::NewLine + '[IO.File]::AppendAllText(''' + $cliLog.Replace("'", "''") + ''', $Mode + [Environment]::NewLine)' + [Environment]::NewLine + 'exit 0'
  [IO.File]::WriteAllText($cliPath, $cliText)
}
$manifest = [pscustomobject]@{ sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant(); entries = 1; allMatchSource = $true; files = @('index.mjs') }
$script:firstTarget = $targets[0]; $script:cutPoint = $Checkpoint
$script:writeJournal = if (Get-Command Write-LabUpdateJournal -ErrorAction SilentlyContinue) { (Get-Command Write-LabUpdateJournal).ScriptBlock } else { $null }
if ($script:cutPoint -in @('after-preparation','before-activation','after-activation')) {
  function Write-LabUpdateJournal([string]$Path, $Journal) {
    & $script:writeJournal $Path $Journal
    $phase = @{ 'after-preparation' = 'prepared'; 'before-activation' = 'activating'; 'after-activation' = 'committed' }[$script:cutPoint]
    if ($Journal.phase -eq $phase) { [Console]::WriteLine('UPDATE_CHECKPOINT ' + $script:cutPoint); [Console]::Out.Flush(); while ($true) { Start-Sleep -Milliseconds 100 } }
  }
}
function Move-Item {
  [CmdletBinding()]param([string]$LiteralPath, [string]$Destination)
  $pause = ($script:cutPoint -eq 'before-second-install' -and $Destination -eq $targets[1] -and $LiteralPath -match '\.magpie-model-lab-stage-')
  if (-not $pause) { Microsoft.PowerShell.Management\Move-Item @PSBoundParameters }
  $pause = $pause -or ($script:cutPoint -eq 'after-backup' -and $LiteralPath -eq $script:firstTarget -and $Destination -match '\.magpie-model-lab-backup-') -or ($script:cutPoint -eq 'after-first-install' -and $Destination -eq $script:firstTarget -and $LiteralPath -match '\.magpie-model-lab-stage-') -or ($script:cutPoint -eq 'during-recovery' -and $Destination -eq $script:firstTarget -and $LiteralPath -match '\.magpie-model-lab-backup-')
  if ($pause) { [Console]::WriteLine('UPDATE_CHECKPOINT ' + $script:cutPoint); [Console]::Out.Flush(); while ($true) { Start-Sleep -Milliseconds 100 } }
}
if ($Mode -eq 'subset-install') { $targets = @($targets[1]) }
if ($Mode -eq 'other-install') {
  $targets = @((Join-Path ([IO.Path]::GetDirectoryName($targets[1])) 'third-target'))
  if (-not (Test-Path -LiteralPath $targets[0])) { New-Item -ItemType Directory -Path $targets[0] | Out-Null; [IO.File]::WriteAllText((Join-Path $targets[0] 'index.mjs'), 'old-version') }
}
if ($Mode -eq 'recover') { Repair-LabLocalReplacement -Targets $targets -MagpieExe $cliPath -PluginSpec 'isolated-fixture' -Port 0 | ConvertTo-Json -Depth 4 }
else { Invoke-LabLocalReplacement -Archive $archive -SourceRoot $packageSource -Manifest $manifest -Targets $targets -MagpieExe $cliPath -PluginSpec 'isolated-fixture' -Port 0 | ConvertTo-Json -Depth 4 }
