param([Parameter(Mandatory=$true)][string]$Path)

$ErrorActionPreference = 'Stop'
$expected = [IO.Path]::GetFullPath($Path)
if (-not [IO.File]::Exists($expected)) { throw 'Provide an existing GIF fixture' }
$helper = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../vendor/gifenc/CopyGif.ps1'))
$encoded = & powershell.exe -NoLogo -NoProfile -NonInteractive -STA -File $helper $expected
if ($LASTEXITCODE -ne 0) { throw 'The GIF clipboard helper failed' }
if (-not $encoded -or $encoded.Trim() -notmatch '^[A-Za-z0-9+/]+={0,2}$') { throw 'The clipboard helper returned an invalid confirmation' }
try { $confirmedPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded.Trim())) }
catch { throw 'The clipboard helper returned an invalid confirmation' }
if (-not [string]::Equals($confirmedPath, $expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'The clipboard confirmation does not match the supplied GIF' }
Add-Type -AssemblyName System.Windows.Forms
$files = @([Windows.Forms.Clipboard]::GetFileDropList())
if ($files.Count -ne 1 -or -not [string]::Equals($files[0], $expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'The clipboard does not reference the supplied GIF' }
[ordered]@{ pass=$true; files=$files.Count; exists=[IO.File]::Exists($files[0]); bytes=(Get-Item -LiteralPath $files[0]).Length; clipboardContainsRequestedFile=$true } | ConvertTo-Json
