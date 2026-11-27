param([Parameter(Mandatory=$true)][string]$Path)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
if (-not [System.IO.File]::Exists($Path)) { throw 'GIF file does not exist' }
$files = New-Object System.Collections.Specialized.StringCollection
[void]$files.Add([System.IO.Path]::GetFullPath($Path))
[System.Windows.Forms.Clipboard]::SetFileDropList($files)
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($Path))))
