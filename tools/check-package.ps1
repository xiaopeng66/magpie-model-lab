param([Parameter(Mandatory=$true)][string]$Archive, [switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
$pelicanRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pelicanArchive = [System.IO.Path]::GetFullPath($Archive)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$pelicanExpected = @{}
foreach ($pelicanItem in @('package.json','index.mjs','serve.mjs','lib','page','ui','vendor','docs/usage.md','docs/favorites-guide.md','docs/publishing.md','tools','tests','README.md','CHANGELOG.md','LICENSE','THIRD_PARTY_NOTICES.md','.gitignore')) {
  foreach ($pelicanFile in Get-ChildItem -LiteralPath (Join-Path $pelicanRoot $pelicanItem) -File -Recurse -Force) {
    $pelicanName = $pelicanFile.FullName.Substring($pelicanRoot.Length + 1).Replace('\','/')
    $pelicanExpected[$pelicanName] = (Get-FileHash -LiteralPath $pelicanFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
$pelicanZip = [System.IO.Compression.ZipFile]::OpenRead($pelicanArchive)
$pelicanAlgorithm = [System.Security.Cryptography.SHA256]::Create()
$pelicanChecked = @()
try {
  foreach ($pelicanEntry in $pelicanZip.Entries) {
    if (-not $pelicanEntry.Name) { continue }
    $pelicanName = $pelicanEntry.FullName.Replace('\','/')
    if (-not $pelicanExpected.ContainsKey($pelicanName)) { throw "Unexpected archive entry: $pelicanName" }
    $pelicanStream = $pelicanEntry.Open()
    try { $pelicanDigest = [BitConverter]::ToString($pelicanAlgorithm.ComputeHash($pelicanStream)).Replace('-','').ToLowerInvariant() }
    finally { $pelicanStream.Dispose() }
    if ($pelicanDigest -ne $pelicanExpected[$pelicanName]) { throw "Source mismatch: $pelicanName" }
    $pelicanChecked += $pelicanName
  }
  if ($pelicanChecked.Count -ne $pelicanExpected.Count) { throw 'Missing archive files' }
  if (($pelicanChecked | Select-Object -Unique).Count -ne $pelicanChecked.Count) { throw 'Duplicate archive entries' }
} finally { $pelicanAlgorithm.Dispose(); $pelicanZip.Dispose() }
$pelicanHash = (Get-FileHash -LiteralPath $pelicanArchive -Algorithm SHA256).Hash.ToLowerInvariant()
$pelicanChecksum = '{0}  {1}' -f $pelicanHash, [System.IO.Path]::GetFileName($pelicanArchive)
$pelicanResult = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); archive = $pelicanArchive; entries = $pelicanChecked.Count; allMatchSource = $true; sha256 = $pelicanHash; files = $pelicanChecked }
if (-not $VerifyOnly) {
  [System.IO.File]::WriteAllText($pelicanArchive + '.sha256', $pelicanChecksum + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
  $pelicanAuditDir = Join-Path $pelicanRoot '.test-data'
  New-Item -ItemType Directory -Path $pelicanAuditDir -Force | Out-Null
  $pelicanReportName = [System.IO.Path]::GetFileNameWithoutExtension($pelicanArchive) + '-archive-check.json'
  $pelicanResult | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $pelicanAuditDir $pelicanReportName) -Encoding UTF8
}
Write-Output ([ordered]@{ at = $pelicanResult.at; archive = $pelicanResult.archive; entries = $pelicanResult.entries; allMatchSource = $pelicanResult.allMatchSource; sha256 = $pelicanResult.sha256 } | ConvertTo-Json)
