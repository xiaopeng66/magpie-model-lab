param([string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
$pelicanProject = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $pelicanProject 'dist' }
$pelicanOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $pelicanOutput -Force | Out-Null
$pelicanMetadata = Get-Content -LiteralPath (Join-Path $pelicanProject 'package.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$pelicanArchive = Join-Path $pelicanOutput ("magpie-pelican-bench-{0}.zip" -f $pelicanMetadata.version)
if (Test-Path -LiteralPath $pelicanArchive) { throw "Archive already exists: $pelicanArchive. Choose another output directory." }
$pelicanFiles = @('package.json', 'index.mjs', 'serve.mjs', 'lib', 'page', 'ui', 'vendor', 'docs/usage.md', 'docs/favorites-guide.md', 'docs/publishing.md', 'tools', 'tests', 'README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$pelicanTempArchive = Join-Path $pelicanOutput ('.magpie-package-stage-' + [Guid]::NewGuid().ToString('N') + '.zip')
$pelicanZip = $null
try {
  $pelicanZip = [System.IO.Compression.ZipFile]::Open($pelicanTempArchive, [System.IO.Compression.ZipArchiveMode]::Create)
  foreach ($pelicanItem in $pelicanFiles) {
    foreach ($pelicanFile in Get-ChildItem -LiteralPath (Join-Path $pelicanProject $pelicanItem) -File -Recurse -Force) {
      $pelicanName = $pelicanFile.FullName.Substring($pelicanProject.Length + 1).Replace('\','/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($pelicanZip, $pelicanFile.FullName, $pelicanName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  }
  $pelicanZip.Dispose(); $pelicanZip = $null
  & (Join-Path $PSScriptRoot 'check-package.ps1') -Archive $pelicanTempArchive -VerifyOnly | Out-Null
  [IO.File]::Move($pelicanTempArchive, $pelicanArchive)
} finally {
  if ($pelicanZip) { $pelicanZip.Dispose() }
  if (Test-Path -LiteralPath $pelicanTempArchive) {
    if (-not [string]::Equals([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($pelicanTempArchive)), $pelicanOutput, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe temporary archive cleanup target' }
    Remove-Item -LiteralPath $pelicanTempArchive -Force
  }
}
$pelicanHash = Get-FileHash -LiteralPath $pelicanArchive -Algorithm SHA256
Write-Output $pelicanArchive
Write-Output $pelicanHash.Hash
