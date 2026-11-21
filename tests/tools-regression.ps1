param([string]$Report = '')
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Archive -ErrorAction Stop
Import-Module NetTCPIP -ErrorAction Stop
$toolsProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolsTempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
$toolsTestRoot = Join-Path $toolsTempParent ('magpie-tools-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $toolsTestRoot | Out-Null
$script:results = @()
$global:labToolsTestFault = ''
$global:labToolsTestSecondTarget = ''
$global:labToolsTestFirstTarget = ''
$global:labToolsTestEnableAttempts = 0

function Assert-TestPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($toolsTestRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Test path outside temporary workspace: $full" }
  return $full
}
function Check([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Write-TestFile([string]$Path, [string]$Text) {
  $full = Assert-TestPath $Path
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($full)) -Force | Out-Null
  [IO.File]::WriteAllText($full, $Text, [Text.UTF8Encoding]::new($false))
}
function Invoke-Case([string]$Name, [scriptblock]$Work) {
  try { & $Work; $script:results += [ordered]@{ case = $Name; pass = $true }; Write-Output "PASS $Name" }
  catch { $script:results += [ordered]@{ case = $Name; pass = $false; error = $_.Exception.Message }; Write-Output "FAIL $Name : $($_.Exception.Message)" }
  finally { $global:labToolsTestFault = ''; $global:labToolsTestEnableAttempts = 0 }
}
function New-TestProject([string]$Name, [switch]$MissingIndex) {
  $root = Assert-TestPath (Join-Path $toolsTestRoot $Name)
  foreach ($dir in @('lib','page','ui','vendor','docs','tests','tools')) { New-Item -ItemType Directory -Path (Join-Path $root $dir) -Force | Out-Null }
  foreach ($relative in @('package.json','serve.mjs','docs/usage.md','docs/favorites-guide.md','docs/publishing.md','README.md','CHANGELOG.md','LICENSE','THIRD_PARTY_NOTICES.md','.gitignore')) { Write-TestFile (Join-Path $root $relative) ('fixture ' + $relative) }
  Write-TestFile (Join-Path $root 'package.json') '{"name":"fixture-model-lab","version":"1.0.4"}'
  if (-not $MissingIndex) { Write-TestFile (Join-Path $root 'index.mjs') 'new-version' }
  foreach ($name in @('package.ps1','check-package.ps1','replace-local.ps1')) {
    $source = Join-Path $toolsProject ('tools/' + $name)
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $root ('tools/' + $name)) }
  }
  return $root
}
function New-InstallFixture([string]$Name, [string[]]$RemovedFiles = @()) {
  $root = New-TestProject $Name
  $files = @(Get-ChildItem -LiteralPath $root -File -Recurse -Force | Where-Object { -not $_.FullName.StartsWith((Join-Path $root '.test-data') + '\', [StringComparison]::OrdinalIgnoreCase) })
  $out = Assert-TestPath (Join-Path $toolsTestRoot ($Name + '-output'))
  $archive = Join-Path $out 'package-final/magpie-pelican-bench-1.0.4.zip'
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($archive)) -Force | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Create)
  $names = @()
  try { foreach ($file in $files) { $relative = $file.FullName.Substring($root.Length + 1).Replace('\','/'); $names += $relative; [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $relative) | Out-Null } }
  finally { $zip.Dispose() }
  $manifest = [ordered]@{ sha256 = (Get-FileHash -LiteralPath $archive).Hash.ToLowerInvariant(); entries = $names.Count; allMatchSource = $true; files = $names }
  Write-TestFile (Join-Path $root '.test-data/magpie-pelican-bench-1.0.4-archive-check.json') ($manifest | ConvertTo-Json -Depth 5)
  $targets = @((Join-Path $toolsTestRoot ($Name + '-local')), (Join-Path $toolsTestRoot ($Name + '-modules')))
  foreach ($target in $targets) { Write-TestFile (Join-Path $target 'index.mjs') 'old-version'; Write-TestFile (Join-Path $target 'extra.txt') 'preserved-extra' }
  $log = Join-Path $toolsTestRoot ($Name + '-cli.log')
  $cli = Join-Path $toolsTestRoot ($Name + '-cli.ps1')
  Write-TestFile $cli ("param(`$Verb,`$Mode,`$Spec)`n[IO.File]::AppendAllText('$($log.Replace("'","''"))', `$Mode + [Environment]::NewLine)`n`$fixtureExit = 0`nif (`$Mode -eq 'off' -and `$global:labToolsTestFault -eq 'disable-fails') { `$fixtureExit = 1 }`nif (`$Mode -eq 'on') { `$global:labToolsTestEnableAttempts++; if (`$global:labToolsTestFault -eq 'enable-fails' -or (`$global:labToolsTestFault -eq 'enable-once' -and `$global:labToolsTestEnableAttempts -eq 1)) { `$fixtureExit = 1 } }`nexit `$fixtureExit`n")
  # Exercise the bundled helper without requiring private installer scripts in an exported ZIP.
  $source = @'
$ErrorActionPreference = 'Stop'
$taskRoot = ''
. (Join-Path $taskRoot 'tools/replace-local.ps1')
$outputRoot = ''
$magpieExe = ''
$targets = @(
)
$archive = Join-Path $outputRoot 'package-final/magpie-pelican-bench-1.0.4.zip'
$manifest = Get-Content -LiteralPath (Join-Path $taskRoot '.test-data/magpie-pelican-bench-1.0.4-archive-check.json') -Raw | ConvertFrom-Json
Invoke-LabLocalReplacement -Archive $archive -SourceRoot $taskRoot -Manifest $manifest -Targets $targets -MagpieExe $magpieExe -PluginSpec 'fixture'
'@
  foreach ($entry in @(@('taskRoot',$root), @('outputRoot',$out), @('magpieExe',$cli))) {
    $source = [regex]::Replace($source, '(?m)^\$' + $entry[0] + ' = .*$', { param($match) '$' + $entry[0] + " = '" + $entry[1].Replace("'","''") + "'" })
  }
  $replacement = "`$targets = @('" + $targets[0].Replace("'","''") + "','" + $targets[1].Replace("'","''") + "')"
  $source = [regex]::Replace($source, '(?ms)^\$targets = @\(.*?^\)', { param($match) $replacement })
  if ($RemovedFiles.Count) {
    $removedArgument = " -RemovedFiles @(" + (($RemovedFiles | ForEach-Object { "'" + $_.Replace("'","''") + "'" }) -join ',') + ')'
    $source = $source.Replace("-PluginSpec 'fixture'", "-PluginSpec 'fixture'" + $removedArgument)
  }
  Check ($source -notmatch '(?i)[A-Z]:\\Users\\[^\\]+\\(?:\.config\\magpie|\.magpie|AppData\\(?:Local|Roaming)\\magpie)') 'The fixture installer references a real user installation'
  $installer = Join-Path $toolsTestRoot ($Name + '-installer.ps1'); Write-TestFile $installer $source
  $global:labToolsTestFirstTarget = $targets[0]; $global:labToolsTestSecondTarget = $targets[1]
  return [pscustomobject]@{ root = $root; output = $out; archive = $archive; targets = $targets; log = $log; installer = $installer }
}

# Only these fixture functions override cmdlets; native operations stay in this PowerShell process.
function Get-NetTCPConnection {
  [CmdletBinding()]param($LocalPort, $State)
  if ($global:labToolsTestFault -eq 'real-port') { NetTCPIP\Get-NetTCPConnection @PSBoundParameters }
  elseif ($global:labToolsTestFault -eq 'port-query-fails') { throw 'fixture port lookup failure' }
  elseif ($global:labToolsTestFault -eq 'busy-port') { [pscustomobject]@{ LocalPort = 3489; State = 'Listen' } }
}
function Expand-Archive {
  [CmdletBinding()]param([string]$LiteralPath, [string]$DestinationPath, [switch]$Force)
  if ($global:labToolsTestFault -in @('second-switch','rollback-fails') -and $DestinationPath -eq $global:labToolsTestSecondTarget) { throw 'fixture second target failure' }
  Microsoft.PowerShell.Archive\Expand-Archive @PSBoundParameters
  if ($global:labToolsTestFault -eq 'staged-content') { Write-TestFile (Join-Path $DestinationPath 'index.mjs') 'fixture corrupt extraction' }
  if ($global:labToolsTestFault -eq 'target-changed') { Write-TestFile (Join-Path $global:labToolsTestFirstTarget 'index.mjs') 'external-change' }
}
function Move-Item {
  [CmdletBinding()]param([string]$LiteralPath, [string]$Destination)
  if ($global:labToolsTestFault -in @('second-switch','rollback-fails') -and $Destination -eq $global:labToolsTestSecondTarget -and $LiteralPath -match '\.magpie-model-lab-stage-') { throw 'fixture second target failure' }
  if ($global:labToolsTestFault -eq 'rollback-fails' -and $Destination -eq $global:labToolsTestFirstTarget -and $LiteralPath -match '\.magpie-model-lab-backup-') { throw 'fixture rollback failure' }
  Microsoft.PowerShell.Management\Move-Item @PSBoundParameters
}

try {
  Invoke-Case '015 failure leaves no final or temporary ZIP' {
    $root = New-TestProject 'package-failure' -MissingIndex; $out = Assert-TestPath (Join-Path $toolsTestRoot 'package-failure-out')
    try { & (Join-Path $root 'tools/package.ps1') -OutputDirectory $out | Out-Null; throw 'Expected packaging failure' } catch { Check ($_.Exception.Message -notmatch 'Expected packaging failure') 'The invalid project unexpectedly packaged' }
    Check (-not (Test-Path -LiteralPath (Join-Path $out 'magpie-pelican-bench-1.0.4.zip'))) 'A failed package left the final ZIP behind'
    Check (@(Get-ChildItem -LiteralPath $out -Force -File).Count -eq 0) 'A failed package left staging files behind'
  }
  Invoke-Case '015 repaired project retries the same output and protects an existing ZIP' {
    $root = New-TestProject 'package-retry' -MissingIndex; $out = Assert-TestPath (Join-Path $toolsTestRoot 'package-retry-out')
    try { & (Join-Path $root 'tools/package.ps1') -OutputDirectory $out | Out-Null } catch {}
    Write-TestFile (Join-Path $root 'index.mjs') 'new-version'; & (Join-Path $root 'tools/package.ps1') -OutputDirectory $out | Out-Null
    $archive = Join-Path $out 'magpie-pelican-bench-1.0.4.zip'; $hash = (Get-FileHash -LiteralPath $archive).Hash
    try { & (Join-Path $root 'tools/package.ps1') -OutputDirectory $out | Out-Null; throw 'Expected existing archive rejection' } catch { Check ($_.Exception.Message -match 'already exists') 'Existing ZIP protection did not explain the conflict' }
    Check ((Get-FileHash -LiteralPath $archive).Hash -eq $hash) 'Existing ZIP was changed'
  }
  Invoke-Case '016 successful replacement keeps extras and enables after both directories validate' {
    $fixture = New-InstallFixture 'install-success'; & $fixture.installer | Out-Null
    foreach ($target in $fixture.targets) { Check ((Get-Content -LiteralPath (Join-Path $target 'index.mjs') -Raw) -eq 'new-version') 'A target did not update'; Check ((Get-Content -LiteralPath (Join-Path $target 'extra.txt') -Raw) -eq 'preserved-extra') 'Extra installed files were lost' }
    Check ((Get-Content -LiteralPath $fixture.log) -join ',' -eq 'off,on') 'Unexpected enable/disable sequence'
  }
  Invoke-Case '016 explicit removed files disappear from both targets while other extras survive' {
    $removed = @('ui/batch-summary.mjs','tests/batch-summary.test.mjs','tests/summary-ui.test.mjs')
    $fixture = New-InstallFixture 'removed-success' -RemovedFiles $removed
    foreach ($target in $fixture.targets) {
      foreach ($relative in $removed) { Write-TestFile (Join-Path $target $relative) ('old ' + $relative) }
    }
    $result = & $fixture.installer
    foreach ($target in $fixture.targets) {
      foreach ($relative in $removed) { Check (-not (Test-Path -LiteralPath (Join-Path $target $relative))) "An obsolete file survived: $relative" }
      Check ((Get-Content -LiteralPath (Join-Path $target 'extra.txt') -Raw) -eq 'preserved-extra') 'An unrelated installed file was removed'
      Check ((Get-Content -LiteralPath (Join-Path $target 'index.mjs') -Raw) -eq 'new-version') 'The current entry was not installed'
    }
    Check (@($result.removedFiles).Count -eq $removed.Count) 'The replacement report omitted explicit removals'
    Check ((Get-Content -LiteralPath $fixture.log) -join ',' -eq 'off,on') 'Explicit removal changed activation order'
  }
  Invoke-Case '016 a failed replacement restores explicit removed files with both original directories' {
    $relative = 'ui/batch-summary.mjs'
    $fixture = New-InstallFixture 'removed-rollback' -RemovedFiles @($relative)
    foreach ($target in $fixture.targets) { Write-TestFile (Join-Path $target $relative) 'old-summary' }
    $global:labToolsTestFault = 'second-switch'
    try { & $fixture.installer | Out-Null; throw 'Expected removal rollback' }
    catch { Check ($_.Exception.Message -notmatch 'Expected removal rollback') 'The replacement failure was not injected' }
    foreach ($target in $fixture.targets) {
      Check ((Get-Content -LiteralPath (Join-Path $target $relative) -Raw) -eq 'old-summary') 'Rollback lost an original obsolete file'
      Check ((Get-Content -LiteralPath (Join-Path $target 'index.mjs') -Raw) -eq 'old-version') 'Rollback kept the new entry'
    }
    Check ((Get-Content -LiteralPath $fixture.log) -join ',' -eq 'off,on') 'Rollback enabled an unverified directory'
  }
  foreach ($relative in @('../extra.txt','ui\batch-summary.mjs','index.mjs','tools')) {
    Invoke-Case ("016 unsafe or current-source removal $relative is rejected before disabling") {
      $fixture = New-InstallFixture ('removed-invalid-' + [Guid]::NewGuid().ToString('N')) -RemovedFiles @($relative)
      try { & $fixture.installer | Out-Null; throw 'Expected removal rejection' }
      catch { Check ($_.Exception.Message -match 'Invalid removal path|Invalid archive path|Removal still exists in source') 'The removal list was not validated against source and path boundaries' }
      Check (-not (Test-Path -LiteralPath $fixture.log)) 'An invalid removal disabled the plugin'
      foreach ($target in $fixture.targets) { Check ((Get-Content -LiteralPath (Join-Path $target 'index.mjs') -Raw) -eq 'old-version') 'An invalid removal changed an installed directory' }
    }
  }
  Invoke-Case '016 a removal naming an installed directory is rejected without recursive deletion' {
    $relative = 'ui/batch-summary.mjs'
    $fixture = New-InstallFixture 'removed-directory' -RemovedFiles @($relative)
    Write-TestFile (Join-Path $fixture.targets[0] ($relative + '/extra.txt')) 'preserve-directory'
    try { & $fixture.installer | Out-Null; throw 'Expected directory removal rejection' }
    catch { Check ($_.Exception.Message -match 'Removal is not a regular file') 'An installed directory was treated as an obsolete file' }
    Check (-not (Test-Path -LiteralPath $fixture.log)) 'A directory removal disabled the plugin'
    Check ((Get-Content -LiteralPath (Join-Path $fixture.targets[0] ($relative + '/extra.txt')) -Raw) -eq 'preserve-directory') 'A rejected directory removal destroyed data'
  }
  Invoke-Case '016 second target failure restores both old directories before enabling' {
    $fixture = New-InstallFixture 'install-failure'; $global:labToolsTestFault = 'second-switch'
    try { & $fixture.installer | Out-Null; throw 'Expected switch failure' } catch { Check ($_.Exception.Message -notmatch 'Expected switch failure') 'Switch failure was not injected' }
    foreach ($target in $fixture.targets) { Check ((Get-Content -LiteralPath (Join-Path $target 'index.mjs') -Raw) -eq 'old-version') 'A failed replacement left mixed versions'; Check ((Get-Content -LiteralPath (Join-Path $target 'extra.txt') -Raw) -eq 'preserved-extra') 'Old extras were not restored' }
    Check ((Get-Content -LiteralPath $fixture.log) -join ',' -eq 'off,on') 'The verified old version was not re-enabled'
  }
  Invoke-Case '016 rollback failure keeps the plugin off and retains the recoverable backup' {
    $fixture = New-InstallFixture 'rollback-failure'; $global:labToolsTestFault = 'rollback-fails'
    try { & $fixture.installer | Out-Null; throw 'Expected rollback failure' } catch { Check ($_.Exception.Message -notmatch 'Expected rollback failure') 'Rollback failure was not injected' }
    Check ((Get-Content -LiteralPath $fixture.log) -join ',' -eq 'off') 'The plugin was enabled after rollback failed'
    $backups = @(Get-ChildItem -LiteralPath $toolsTestRoot -Directory -Force | Where-Object { $_.Name -like '.magpie-model-lab-backup-*' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'index.mjs')) })
    Check (@($backups | Where-Object { (Get-Content -LiteralPath (Join-Path $_.FullName 'index.mjs') -Raw) -eq 'old-version' }).Count -gt 0) 'No intact old backup remains'
  }
  Invoke-Case '016 source/archive mismatch is rejected before disabling or touching targets' {
    $fixture = New-InstallFixture 'stage-failure'; Write-TestFile (Join-Path $fixture.root 'index.mjs') 'changed-after-package'
    try { & $fixture.installer | Out-Null; throw 'Expected source mismatch' } catch { Check ($_.Exception.Message -notmatch 'Expected source mismatch') 'Mismatch was not rejected' }
    Check (-not (Test-Path -LiteralPath $fixture.log)) 'The plugin was disabled before package/source validation'
    foreach ($target in $fixture.targets) { Check ((Get-Content -LiteralPath (Join-Path $target 'index.mjs') -Raw) -eq 'old-version') 'Stage failure touched the installed version' }
  }
  Invoke-Case '016 a real released temporary port is recognized without a not-found error' {
    . (Join-Path $toolsProject 'tools/replace-local.ps1')
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $listener.Start(); $port = $listener.LocalEndpoint.Port
    $global:labToolsTestFault = 'real-port'
    try { Check (@(NetTCPIP\Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.LocalPort -eq $port -and $_.State -eq 'Listen' }).Count -eq 1) 'The real query did not detect the fixture listener' }
    finally { $listener.Stop() }
    Wait-LabPortRelease $port
  }
  foreach ($fault in @('port-query-fails','busy-port')) {
    Invoke-Case ("016 $fault prevents directory changes and keeps the plugin off") {
      $fixture = New-InstallFixture $fault; $global:labToolsTestFault = $fault
      try { & $fixture.installer | Out-Null; throw 'Expected port failure' } catch { Check ($_.Exception.Message -notmatch 'Expected port failure') 'Port failure was not injected' }
      foreach ($target in $fixture.targets) { Check ((Get-Content -LiteralPath (Join-Path $target 'index.mjs') -Raw) -eq 'old-version') 'A port failure changed a target' }
      Check ((Get-Content -LiteralPath $fixture.log) -join ',' -eq 'off') 'The plugin was re-enabled before port shutdown was verified'
    }
  }
  Invoke-Case '016 a failed disable command leaves all installed files untouched' {
    $fixture = New-InstallFixture 'disable-failure'; $global:labToolsTestFault = 'disable-fails'
    try { & $fixture.installer | Out-Null; throw 'Expected disable failure' } catch { Check ($_.Exception.Message -notmatch 'Expected disable failure') 'Disable failure was not injected' }
    foreach ($target in $fixture.targets) { Check ((Get-Content -LiteralPath (Join-Path $target 'index.mjs') -Raw) -eq 'old-version') 'Disable failure changed a target' }
    Check ((Get-Content -LiteralPath $fixture.log) -join ',' -eq 'off') 'An enable command ran after disable failed'
  }
  Invoke-Case '016 a failed first activation stops and restores both verified old directories' {
    $fixture = New-InstallFixture 'enable-once'; $global:labToolsTestFault = 'enable-once'
    try { & $fixture.installer | Out-Null; throw 'Expected activation failure' } catch { $activationError = $_.Exception.Message; Check ($activationError -notmatch 'Expected activation failure') 'Activation failure was not injected' }
    foreach ($target in $fixture.targets) { Check ((Get-Content -LiteralPath (Join-Path $target 'index.mjs') -Raw) -eq 'old-version') 'Activation failure left the new version installed' }
    $modes = (Get-Content -LiteralPath $fixture.log) -join ','
    Check ($modes -eq 'off,on,off,on') "Unexpected activation rollback modes ($modes): $activationError"
  }
  Invoke-Case '016 repeated activation failure retains the verified old files and ends disabled' {
    $fixture = New-InstallFixture 'enable-fails'; $global:labToolsTestFault = 'enable-fails'
    try { & $fixture.installer | Out-Null; throw 'Expected repeated activation failure' } catch { $activationError = $_.Exception.Message; Check ($activationError -notmatch 'Expected repeated activation failure') 'Repeated activation failure was not injected' }
    foreach ($target in $fixture.targets) { Check ((Get-Content -LiteralPath (Join-Path $target 'index.mjs') -Raw) -eq 'old-version') 'Failed reactivation did not retain old files' }
    $modes = (Get-Content -LiteralPath $fixture.log) -join ','
    Check ($modes -eq 'off,on,off,on,off') "Unexpected repeated activation modes ($modes): $activationError"
  }
  Invoke-Case '016 corrupted staged extraction is rejected before disabling or touching targets' {
    $fixture = New-InstallFixture 'staged-content'; $global:labToolsTestFault = 'staged-content'
    try { & $fixture.installer | Out-Null; throw 'Expected staged corruption' } catch { Check ($_.Exception.Message -match 'Staged source mismatch') 'Staged corruption was not detected by the content check' }
    Check (-not (Test-Path -LiteralPath $fixture.log)) 'Corrupted staging disabled the plugin'
    foreach ($target in $fixture.targets) { Check ((Get-Content -LiteralPath (Join-Path $target 'index.mjs') -Raw) -eq 'old-version') 'Corrupted staging touched a target' }
  }
  Invoke-Case '016 an external change to the target is preserved and prevents replacement' {
    $fixture = New-InstallFixture 'target-changed'; $global:labToolsTestFault = 'target-changed'
    try { & $fixture.installer | Out-Null; throw 'Expected target mismatch' } catch { Check ($_.Exception.Message -match 'Directory hash mismatch') 'A changed target was not detected' }
    Check ((Get-Content -LiteralPath (Join-Path $fixture.targets[0] 'index.mjs') -Raw) -eq 'external-change') 'The external change was overwritten'
    Check ((Get-Content -LiteralPath (Join-Path $fixture.targets[1] 'index.mjs') -Raw) -eq 'old-version') 'An unaffected target was changed'
    Check ((Get-Content -LiteralPath $fixture.log) -join ',' -eq 'off') 'Changed unverified targets were re-enabled'
  }
  foreach ($unsafe in @('traversal','linked-entry')) {
    Invoke-Case ("016 $unsafe archive is rejected before extraction and disabling") {
      $fixture = New-InstallFixture $unsafe
      $zip = [IO.Compression.ZipFile]::Open($fixture.archive, [IO.Compression.ZipArchiveMode]::Update)
      try { $entry = $zip.CreateEntry($(if ($unsafe -eq 'traversal') { '../escape.txt' } else { 'link.txt' })); if ($unsafe -eq 'linked-entry') { $entry.ExternalAttributes = -1610612736 } }
      finally { $zip.Dispose() }
      $manifestPath = Join-Path $fixture.root '.test-data/magpie-pelican-bench-1.0.4-archive-check.json'
      $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json; $manifest.sha256 = (Get-FileHash -LiteralPath $fixture.archive).Hash.ToLowerInvariant()
      Write-TestFile $manifestPath ($manifest | ConvertTo-Json -Depth 5)
      try { & $fixture.installer | Out-Null; throw 'Expected unsafe archive rejection' } catch { Check ($_.Exception.Message -match 'Invalid archive path|Linked/special archive entry') 'An unsafe entry was not rejected at validation' }
      Check (-not (Test-Path -LiteralPath $fixture.log)) 'An unsafe archive disabled the plugin'
      Check (-not (Test-Path -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($fixture.archive)) 'escape.txt'))) 'An archive traversal wrote outside its destination'
      foreach ($target in $fixture.targets) { Check ((Get-Content -LiteralPath (Join-Path $target 'index.mjs') -Raw) -eq 'old-version') 'An unsafe archive changed a target' }
    }
  }
  Invoke-Case '016 linked target paths are rejected without changing their destination' {
    . (Join-Path $toolsProject 'tools/replace-local.ps1')
    $fixture = New-InstallFixture 'linked-target'; $link = Assert-TestPath (Join-Path $toolsTestRoot 'target-junction')
    New-Item -ItemType Junction -Path $link -Target $fixture.targets[0] | Out-Null
    try {
      $manifest = Get-Content -LiteralPath (Join-Path $fixture.root '.test-data/magpie-pelican-bench-1.0.4-archive-check.json') -Raw | ConvertFrom-Json
      try { Invoke-LabLocalReplacement -Archive $fixture.archive -SourceRoot $fixture.root -Manifest $manifest -Targets @($link) -MagpieExe (Join-Path $toolsTestRoot 'linked-target-cli.ps1') -PluginSpec 'fixture' | Out-Null; throw 'Expected linked path rejection' }
      catch { Check ($_.Exception.Message -match 'Linked path is not allowed') 'The linked target was not rejected' }
      Check (-not (Test-Path -LiteralPath $fixture.log)) 'A linked path disabled the plugin'
      Check ((Get-Content -LiteralPath (Join-Path $fixture.targets[0] 'index.mjs') -Raw) -eq 'old-version') 'A linked target was changed'
    } finally { [IO.Directory]::Delete((Assert-TestPath $link)) }
  }
} finally {
  $resolved = (Resolve-Path -LiteralPath $toolsTestRoot).Path
  if (-not [string]::Equals($resolved, $toolsTestRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetDirectoryName($resolved) -ne $toolsTempParent -or [IO.Path]::GetFileName($resolved) -notlike 'magpie-tools-test-*') { throw 'Unsafe test cleanup target' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
if ($Report) { [IO.File]::WriteAllText([IO.Path]::GetFullPath($Report), ($script:results | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false)) }
if (@($script:results | Where-Object { -not $_.pass }).Count) { throw 'Tool regression checks failed' }
