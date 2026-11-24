# RYP: exercise the production owner resolver against actual Windows window handles.
$ErrorActionPreference = 'Stop'
$pickerAssembly = [Reflection.Assembly]::LoadFrom((Join-Path $PSScriptRoot '../vendor/json-save/SaveJson.exe'))
$pickerType = $pickerAssembly.GetType('SaveJson', $true)
$ownerResolver = $pickerType.GetMethod('ResolveParentWindow', [Reflection.BindingFlags]'NonPublic,Static')
if (-not $ownerResolver) { throw 'The native picker cannot resolve a visible Magpie owner when its background parent has no window' }
$magpieWindow = Get-Process -Name magpie -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $magpieWindow) { throw 'A visible Magpie window is required for native owner acceptance' }
$cases = @(
  [pscustomobject]@{name='existing Magpie owner';pid=$magpieWindow.Id},
  [pscustomobject]@{name='exited background parent';pid=2147483000},
  [pscustomobject]@{name='headless test process';pid=$PID}
)
foreach ($case in $cases) {
  $resolved = [IntPtr]$ownerResolver.Invoke($null, @([int]$case.pid))
  if ($resolved -ne $magpieWindow.MainWindowHandle) { throw "Invalid owner for $($case.name): $resolved" }
  [pscustomobject]@{case=$case.name;pass=$true;owner=$resolved.ToInt64();expected=$magpieWindow.MainWindowHandle.ToInt64()}
}
