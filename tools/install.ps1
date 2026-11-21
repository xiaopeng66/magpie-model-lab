param(
    [string]$MagpiePath = 'magpie'
)
$ErrorActionPreference = 'Stop'
$pelicanProject = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not (Test-Path -LiteralPath $MagpiePath -PathType Leaf)) {
    $pelicanCommand = Get-Command magpie -ErrorAction SilentlyContinue
    if (-not $pelicanCommand) { throw 'Magpie was not found. Pass -MagpiePath with the executable path.' }
    $MagpiePath = $pelicanCommand.Source
}
if (-not (Test-Path -LiteralPath (Join-Path $pelicanProject 'package.json'))) { throw 'Plugin package.json is missing.' }
& $MagpiePath plugin add $pelicanProject
if ($LASTEXITCODE -ne 0) { throw "Magpie plugin installation failed (exit $LASTEXITCODE)." }
Write-Output 'Installed Model Lab. Open Plugins > Model Lab in Magpie.'
