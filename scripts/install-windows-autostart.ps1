#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$TaskName = "ProductDesign Local Server"
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$launcherPath = Join-Path $PSScriptRoot "start-windows.ps1"
$entryPoint = Join-Path $projectRoot "dist\node\server\index.js"
$nodePath = (Get-Command node -ErrorAction Stop).Source
$powershellPath = Join-Path $PSHOME "powershell.exe"
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    throw "Startup script not found: $launcherPath"
}
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "Missing build output: $entryPoint. Run npm run build first."
}

$arguments = @(
    "-NoProfile"
    "-NonInteractive"
    "-ExecutionPolicy Bypass"
    "-WindowStyle Hidden"
    "-File `"$launcherPath`""
    "-ProjectRoot `"$projectRoot`""
    "-NodePath `"$nodePath`""
) -join " "

$action = New-ScheduledTaskAction `
    -Execute $powershellPath `
    -Argument $arguments `
    -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Limited
$task = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Run the single-instance ProductDesign supervisor at Windows logon."

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

[pscustomobject]@{
    TaskName = $TaskName
    User = $currentUser
    ProjectRoot = $projectRoot
    NodePath = $nodePath
    Trigger = "AtLogOn"
    RestartCount = 3
    RestartIntervalMinutes = 1
}
