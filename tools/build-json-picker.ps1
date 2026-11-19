$ErrorActionPreference = 'Stop'
$magpieProject = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$magpiePicker = Join-Path $magpieProject 'vendor\json-save'
$magpieCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $magpieCompiler)) { throw 'The Windows .NET Framework C# compiler is required to rebuild the bundled JSON picker.' }
$magpieBinary = Join-Path $magpiePicker 'SaveJson.exe'
$magpieSource = Join-Path $magpiePicker 'SaveJson.cs'
$magpieManifest = Join-Path $magpiePicker 'SaveJson.manifest'
& $magpieCompiler /nologo /target:winexe /optimize+ /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/win32manifest:$magpieManifest" "/out:$magpieBinary" $magpieSource
if ($LASTEXITCODE -ne 0) { throw 'JSON picker compilation failed' }
Get-FileHash -LiteralPath (Join-Path $magpiePicker 'SaveJson.exe') -Algorithm SHA256
