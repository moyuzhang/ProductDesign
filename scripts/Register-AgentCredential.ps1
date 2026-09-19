[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param(
  [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$PrincipalId,
  [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$AgentId,
  [Parameter(Mandatory=$true)][ValidatePattern('^[^\s]{1,300}$')][string]$WorkerId,
  [Parameter(Mandatory=$true)][ValidateSet('designer','builder','auditor','approver')][string]$Role,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$ProjectId,
  [ValidatePattern('^https?://')][string]$BaseUrl = 'http://127.0.0.1:4310',
  [SecureString]$AdminToken,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$BaseUrl = $BaseUrl.TrimEnd('/')
$registrationUri = "$BaseUrl/api/agent-security/credentials"
$healthUri = "$BaseUrl/api/health"
$payloadObject = [ordered]@{
  principalId = $PrincipalId; agentId = $AgentId; workerId = $WorkerId
  allowedRoles = @($Role); allowedProjects = @($ProjectId)
}

try {
  $health = Invoke-RestMethod -NoProxy -Method Get -Uri $healthUri -TimeoutSec 5
  if (-not $health.ok) { throw "Service returned unhealthy status from $healthUri" }
} catch {
  throw "ProductDesign service is unavailable at $healthUri. Start or repair port 4310 first. Cause: $($_.Exception.Message)"
}

if ($DryRun -or $WhatIfPreference) {
  [pscustomobject]@{ mode='dry-run'; endpoint=$registrationUri; request=$payloadObject; adminTokenRead=$false; writesPerformed=$false }
  return
}

if (-not $PSCmdlet.ShouldProcess("$AgentId / $WorkerId / $ProjectId", 'Register one scoped Agent credential')) { return }
if (-not $AdminToken) { $AdminToken = Read-Host 'Enter PCS Agent administrator token (input is hidden)' -AsSecureString }
if (-not $AdminToken -or $AdminToken.Length -eq 0) { throw 'A non-empty administrator token is required.' }

$tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($AdminToken)
try {
  $plainAdminToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)
  $payload = $payloadObject | ConvertTo-Json -Depth 4
  try {
    $result = Invoke-RestMethod -NoProxy -Method Post -Uri $registrationUri -TimeoutSec 10 `
      -Headers @{ Authorization = "Bearer $plainAdminToken" } -ContentType 'application/json' -Body $payload
  } catch {
    $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($status -eq 403) { throw 'Administrator authentication failed. The token was not printed; retry from an authorized human session.' }
    if ($status -eq 409) { throw 'Registration conflicts with existing identity or policy state. Recheck principalId, agentId, workerId, role and projectId.' }
    throw "Credential registration failed at $registrationUri (HTTP $status): $($_.Exception.Message)"
  }
} finally {
  if ($tokenPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr) }
  Remove-Variable plainAdminToken -ErrorAction SilentlyContinue
}

if (-not $result.credentialId -or -not $result.credentialSecret) {
  throw 'Registration succeeded without the required one-time credential result; do not retry blindly. Inspect the server audit log.'
}

# The administrator token is never returned. credentialSecret is emitted exactly once by the server.
[pscustomobject]@{
  credentialId = $result.credentialId; credentialSecret = $result.credentialSecret
  principalId = $PrincipalId; agentId = $AgentId; workerId = $WorkerId
  allowedRoles = @($Role); allowedProjects = @($ProjectId); oneTimeSecret = $true
}
