#requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [string]$NodePath,

    [int]$Port = 4310,

    [ValidateRange(1, 60)]
    [int]$PollSeconds = 5,

    [ValidateRange(5, 120)]
    [int]$StartupTimeoutSeconds = 60,

    [ValidateRange(2, 20)]
    [int]$UnhealthyThreshold = 6
)

$ErrorActionPreference = "Stop"

function Write-StartupLog {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $Path -Value "[$timestamp] $Message" -Encoding UTF8
}

function Move-LogToArchive {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return
    }

    $item = Get-Item -LiteralPath $Path
    if ($item.Length -eq 0) {
        Remove-Item -LiteralPath $Path -Force
        return
    }

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
    $archivePath = Join-Path $item.DirectoryName "$($item.BaseName).$timestamp$($item.Extension)"
    Move-Item -LiteralPath $Path -Destination $archivePath
}

function Get-PortListener {
    param([int]$ListenerPort)

    Get-NetTCPConnection -LocalPort $ListenerPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

function Test-ServiceHealth {
    param([int]$HealthPort)

    $response = $null
    try {
        $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$HealthPort/api/health")
        $request.Method = "GET"
        $request.Proxy = $null
        $request.Timeout = 2500
        $request.ReadWriteTimeout = 2500
        $response = [System.Net.HttpWebResponse]$request.GetResponse()
        if ([int]$response.StatusCode -ne 200) {
            return $false
        }
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        try {
            $body = $reader.ReadToEnd()
        } finally {
            $reader.Dispose()
        }
        return $body -match '"ok"\s*:\s*true'
    } catch {
        return $false
    } finally {
        if ($null -ne $response) {
            $response.Dispose()
        }
    }
}

function Test-IsProductDesignProcess {
    param(
        [int]$ProcessId,
        [string]$ExpectedEntryPoint
    )

    try {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
        if ($null -eq $processInfo -or [string]::IsNullOrWhiteSpace($processInfo.CommandLine)) {
            return $false
        }
        return $processInfo.CommandLine.IndexOf($ExpectedEntryPoint, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    } catch {
        return $false
    }
}

$mutex = $null
$ownsMutex = $false

try {
    $resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
    $resolvedNode = (Resolve-Path -LiteralPath $NodePath).Path
    $entryPoint = Join-Path $resolvedRoot "dist\node\server\index.js"
    if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
        throw "Missing build output: $entryPoint. Run npm run build first."
    }

    $runtimeDir = Join-Path $resolvedRoot "data\runtime"
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    $launcherLog = Join-Path $runtimeDir "launcher.log"
    $stdoutLog = Join-Path $runtimeDir "server.stdout.log"
    $stderrLog = Join-Path $runtimeDir "server.stderr.log"

    if ((Test-Path -LiteralPath $launcherLog) -and (Get-Item -LiteralPath $launcherLog).Length -gt 10MB) {
        Move-LogToArchive -Path $launcherLog
    }

    $mutexName = "Local\ProductDesignSupervisor-$Port"
    $mutex = New-Object System.Threading.Mutex($false, $mutexName)
    try {
        $ownsMutex = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }
    if (-not $ownsMutex) {
        Write-StartupLog -Path $launcherLog -Message "Supervisor already running for port $Port; duplicate startup skipped."
        exit 0
    }

    Set-Location -LiteralPath $resolvedRoot
    Write-StartupLog -Path $launcherLog -Message "Supervisor started for $resolvedNode $entryPoint on port $Port."

    $managedProcess = $null
    $adoptedPid = 0
    $unhealthyChecks = 0
    $restartDelaySeconds = 2
    $lastHeartbeat = Get-Date

    while ($true) {
        $listener = Get-PortListener -ListenerPort $Port
        if ($null -ne $listener) {
            $listenerPid = [int]$listener.OwningProcess
            if (Test-ServiceHealth -HealthPort $Port) {
                if ($adoptedPid -ne $listenerPid) {
                    Write-StartupLog -Path $launcherLog -Message "Monitoring healthy ProductDesign instance PID $listenerPid."
                    $adoptedPid = $listenerPid
                }
                $unhealthyChecks = 0
                $restartDelaySeconds = 2
                if (((Get-Date) - $lastHeartbeat).TotalMinutes -ge 15) {
                    Write-StartupLog -Path $launcherLog -Message "Heartbeat healthy for PID $listenerPid."
                    $lastHeartbeat = Get-Date
                }
                Start-Sleep -Seconds $PollSeconds
                continue
            }

            $unhealthyChecks += 1
            if ($unhealthyChecks -eq 1) {
                Write-StartupLog -Path $launcherLog -Message "Health check failed for port $Port owned by PID $listenerPid."
            }
            if ($unhealthyChecks -ge $UnhealthyThreshold) {
                if (Test-IsProductDesignProcess -ProcessId $listenerPid -ExpectedEntryPoint $entryPoint) {
                    Write-StartupLog -Path $launcherLog -Message "ProductDesign PID $listenerPid remained unhealthy for $unhealthyChecks checks; restarting it."
                    Stop-Process -Id $listenerPid -Force -ErrorAction SilentlyContinue
                    Start-Sleep -Seconds 2
                    $managedProcess = $null
                    $adoptedPid = 0
                    $unhealthyChecks = 0
                    continue
                }
                Write-StartupLog -Path $launcherLog -Message "Port $Port is held by non-ProductDesign PID $listenerPid; supervisor will not terminate it."
                $unhealthyChecks = 0
            }
            Start-Sleep -Seconds $PollSeconds
            continue
        }

        if ($null -ne $managedProcess) {
            try {
                if ($managedProcess.HasExited) {
                    Write-StartupLog -Path $launcherLog -Message "ProductDesign PID $($managedProcess.Id) exited with code $($managedProcess.ExitCode)."
                }
            } catch {
                Write-StartupLog -Path $launcherLog -Message "Managed ProductDesign process ended: $($_.Exception.Message)"
            }
            $managedProcess = $null
        }

        if ($restartDelaySeconds -gt 2) {
            Write-StartupLog -Path $launcherLog -Message "Waiting $restartDelaySeconds seconds before restart."
            Start-Sleep -Seconds $restartDelaySeconds
        }

        Move-LogToArchive -Path $stdoutLog
        Move-LogToArchive -Path $stderrLog
        Write-StartupLog -Path $launcherLog -Message "Starting ProductDesign: $resolvedNode $entryPoint"
        $managedProcess = Start-Process `
            -FilePath $resolvedNode `
            -ArgumentList @($entryPoint) `
            -WorkingDirectory $resolvedRoot `
            -NoNewWindow `
            -PassThru `
            -RedirectStandardOutput $stdoutLog `
            -RedirectStandardError $stderrLog

        $startedAt = Get-Date
        $healthy = $false
        while (((Get-Date) - $startedAt).TotalSeconds -lt $StartupTimeoutSeconds) {
            if ($managedProcess.HasExited) {
                break
            }
            if (Test-ServiceHealth -HealthPort $Port) {
                $healthy = $true
                break
            }
            Start-Sleep -Seconds 1
        }

        if ($healthy) {
            Write-StartupLog -Path $launcherLog -Message "ProductDesign PID $($managedProcess.Id) became healthy."
            $adoptedPid = $managedProcess.Id
            $unhealthyChecks = 0
            $restartDelaySeconds = 2
            continue
        }

        if ($managedProcess.HasExited) {
            Write-StartupLog -Path $launcherLog -Message "ProductDesign PID $($managedProcess.Id) failed during startup with code $($managedProcess.ExitCode)."
        } else {
            Write-StartupLog -Path $launcherLog -Message "ProductDesign PID $($managedProcess.Id) did not become healthy within $StartupTimeoutSeconds seconds; terminating it."
            Stop-Process -Id $managedProcess.Id -Force -ErrorAction SilentlyContinue
        }
        $managedProcess = $null
        $restartDelaySeconds = [Math]::Min(30, [Math]::Max(4, $restartDelaySeconds * 2))
    }
} catch {
    $fallbackDir = Join-Path $ProjectRoot "data\runtime"
    New-Item -ItemType Directory -Path $fallbackDir -Force -ErrorAction SilentlyContinue | Out-Null
    $fallbackLog = Join-Path $fallbackDir "launcher.log"
    Write-StartupLog -Path $fallbackLog -Message "Supervisor failed: $($_.Exception.ToString())"
    exit 1
} finally {
    if ($ownsMutex -and $null -ne $mutex) {
        try { $mutex.ReleaseMutex() } catch { }
    }
    if ($null -ne $mutex) {
        $mutex.Dispose()
    }
}
