[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$SkipVerification
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$indexPath = Join-Path $projectRoot 'src\mcp\index.ts'
$schemaPath = Join-Path $projectRoot 'src\mcp\agentWriteSchema.ts'

if (-not (Test-Path -LiteralPath $indexPath) -or -not (Test-Path -LiteralPath $schemaPath)) {
    throw 'ProductDesign source files were not found. Run this script from its original scripts directory.'
}

$indexBefore = Get-Content -Raw -LiteralPath $indexPath
$schemaBefore = Get-Content -Raw -LiteralPath $schemaPath

$oldSchema = @'
export const AGENT_WRITE_CONTEXT_DESCRIPTION =
  "先完成 begin_agent_auth → complete_agent_auth → ack_agent_policy；再用 action=mcp.<toolName>、target=mcp:<toolName> 和请求正文 SHA-256 调用 issue_agent_write_nonce。所有字段必须与当前工单、连接和一次性 nonce 一致。";
'@
$newSchema = @'
export const AGENT_WRITE_CONTEXT_DESCRIPTION =
  "先调用 claim_next_agent_task 领取当前任务。后续写入必须携带领取结果中的 workOrderId、leaseToken、taskKey、taskRevision、workerId、agentId、role 和稳定 idempotencyKey。";

/** Task-scoped lease fields used by the local-first external Agent mode. */
export const leaseWriteContextSchema = {
  workOrderId: z.string().min(1).max(300),
  leaseToken: z.string().min(1).max(300),
  taskKey: z.string().min(1).max(2000),
  taskRevision: z.string().min(1).max(500),
  workerId: z.string().min(1).max(300),
  agentId: z.string().min(1).max(200),
  role: z.enum(["designer", "builder", "auditor", "approver"]),
  idempotencyKey: z.string().min(1).max(300),
} as const;
'@

$oldImport = 'import { agentWriteContextSchema, AGENT_WRITE_CONTEXT_DESCRIPTION } from "./agentWriteSchema.js";'
$newImport = 'import { agentWriteContextSchema, leaseWriteContextSchema, AGENT_WRITE_CONTEXT_DESCRIPTION } from "./agentWriteSchema.js";'

$oldRegistration = @'
    const onboarding = ["begin_agent_auth", "complete_agent_auth", "ack_agent_policy", "issue_agent_write_nonce", "claim_next_agent_task"].includes(name);
    const securedConfig = !options.trustedInternal && risk !== "read" && !onboarding ? {
      ...config,
      description: `${config.description ?? ""}\n${AGENT_WRITE_CONTEXT_DESCRIPTION}`.trim(),
      inputSchema: { ...(config.inputSchema ?? {}), ...agentWriteContextSchema },
    } : config;
'@
$newRegistration = @'
    const onboarding = ["begin_agent_auth", "complete_agent_auth", "ack_agent_policy", "issue_agent_write_nonce", "claim_next_agent_task"].includes(name);
    const securedConfig = !options.trustedInternal && risk === "controlled" && !onboarding ? {
      ...config,
      description: `${config.description ?? ""}\n${AGENT_WRITE_CONTEXT_DESCRIPTION}`.trim(),
      inputSchema: { ...(config.inputSchema ?? {}), ...leaseWriteContextSchema },
    } : config;
'@

$oldAssertion = @'
          assertAgentWorkOrderContext(store, {
            ...(input as any), projectId: project.id, action: `mcp.${name}`, target: `mcp:${name}`,
          });
'@
$newAssertion = @'
          const required = ["workOrderId", "leaseToken", "taskKey", "taskRevision", "workerId", "agentId", "role", "idempotencyKey"] as const;
          const missing = required.filter((key) => typeof input[key] !== "string" || !(input[key] as string).trim());
          if (missing.length) throw new AgentSecurityError(409, "WORK_ORDER_CONTEXT_INVALID", `Missing: ${missing.join(", ")}`);
          const now = new Date().toISOString();
          const lease = store.db.prepare("SELECT * FROM agent_task_leases WHERE id=? AND lease_token=?")
            .get(input.workOrderId, input.leaseToken) as Record<string, string> | undefined;
          if (!lease || !["claimed", "running"].includes(lease.status) || lease.lease_expires_at <= now
            || lease.task_key !== input.taskKey || lease.task_revision !== input.taskRevision
            || lease.project_id !== project.id || lease.agent_id !== input.agentId
            || lease.worker_id !== input.workerId || lease.role !== input.role) {
            throw new AgentSecurityError(409, "WORK_ORDER_CONTEXT_INVALID", "Work order, lease, task revision or identity does not match");
          }
'@

$oldLeaseSchema = @'
    ...(options.trustedInternal ? {
      leaseToken: z.string().trim().min(1).max(300),
      agentId: z.string().trim().min(1).max(200),
      idempotencyKey: z.string().trim().min(1).max(300),
    } : agentWriteContextSchema),
'@
$newLeaseSchema = @'
    ...(options.trustedInternal ? {
      leaseToken: z.string().trim().min(1).max(300),
      agentId: z.string().trim().min(1).max(200),
      idempotencyKey: z.string().trim().min(1).max(300),
    } : leaseWriteContextSchema),
'@

$checks = @(
    @{ Name = 'schema description'; Text = $schemaBefore; Old = $oldSchema },
    @{ Name = 'schema import'; Text = $indexBefore; Old = $oldImport },
    @{ Name = 'tool registration'; Text = $indexBefore; Old = $oldRegistration },
    @{ Name = 'work-order assertion'; Text = $indexBefore; Old = $oldAssertion },
    @{ Name = 'lease control schema'; Text = $indexBefore; Old = $oldLeaseSchema }
)
foreach ($check in $checks) {
    if (-not $check.Text.Contains($check.Old)) {
        throw "Source drift detected at $($check.Name). No files were changed."
    }
}

Write-Host 'Planned change:' -ForegroundColor Cyan
Write-Host '  - External Agent writes use the claimed work-order lease directly.'
Write-Host '  - credential/policy-token/nonce fields are no longer required on MCP writes.'
Write-Host '  - high-risk MCP actions remain rejected for Agents.'
Write-Host '  - original files are copied to a timestamped backup directory first.'

if (-not $Apply) {
    Write-Host ''
    Write-Host 'Dry run only. No files changed.' -ForegroundColor Yellow
    Write-Host 'After reviewing, run: .\scripts\Restore-LeaseAuthorizedAgentMode.ps1 -Apply'
    exit 0
}

$answer = Read-Host 'Type APPLY to confirm this authentication-policy rollback'
if ($answer -cne 'APPLY') {
    throw 'Confirmation did not match APPLY. No files were changed.'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $projectRoot "data\manual-backups\lease-auth-rollback-$stamp"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
Copy-Item -LiteralPath $indexPath -Destination (Join-Path $backupRoot 'index.ts')
Copy-Item -LiteralPath $schemaPath -Destination (Join-Path $backupRoot 'agentWriteSchema.ts')

$schemaAfter = $schemaBefore.Replace($oldSchema, $newSchema)
$indexAfter = $indexBefore.Replace($oldImport, $newImport)
$indexAfter = $indexAfter.Replace($oldRegistration, $newRegistration)
$indexAfter = $indexAfter.Replace($oldAssertion, $newAssertion)
$indexAfter = $indexAfter.Replace($oldLeaseSchema, $newLeaseSchema)

Set-Content -LiteralPath $schemaPath -Value $schemaAfter -Encoding utf8NoBOM
Set-Content -LiteralPath $indexPath -Value $indexAfter -Encoding utf8NoBOM

try {
    if (-not $SkipVerification) {
        Push-Location $projectRoot
        try {
            npm run typecheck
            if ($LASTEXITCODE -ne 0) { throw "typecheck failed with exit code $LASTEXITCODE" }
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "build failed with exit code $LASTEXITCODE" }
        } finally {
            Pop-Location
        }
    }
} catch {
    Copy-Item -LiteralPath (Join-Path $backupRoot 'index.ts') -Destination $indexPath -Force
    Copy-Item -LiteralPath (Join-Path $backupRoot 'agentWriteSchema.ts') -Destination $schemaPath -Force
    throw "Verification failed and source files were restored from $backupRoot. $($_.Exception.Message)"
}

Write-Host "Rollback applied. Backup: $backupRoot" -ForegroundColor Green
Write-Host 'Restart ProductDesign before reconnecting the Agent.'
