import { z } from "zod";

const id = z.string().trim().min(1).max(300);
const text = z.string().trim().min(1).max(2000);
export const documentVersionRefSchema = z.object({ documentId: id, revisionId: id }).strict();
const interfaceFactSchema = z.object({
  key: id,
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  path: z.string().trim().min(1).max(2000).startsWith("/"),
}).strict();

/** This independent inventory must be reviewed as an approved immutable document.
 * It is never reconstructed from the plans it is supposed to assess. */
export const requirementsBaselineSchema = z.object({
  kind: z.literal("productdesign.requirements-baseline"),
  schemaVersion: z.literal(1),
  projectId: id,
  inventoryStatus: z.enum(["partial", "reviewed"]),
  requirements: z.array(z.object({
    id,
    statement: text,
    criteria: z.array(z.object({ key: id, statement: text }).strict()).min(1).max(500),
    interfaces: z.array(interfaceFactSchema).max(100).default([]),
  }).strict()).min(1).max(1000),
}).strict();

export const DESIGN_PHASES = ["design", "build", "verification", "acceptance"] as const;
const phaseRefSchema = z.object({ planId: id, phase: z.enum(DESIGN_PHASES) }).strict();
export const designContractSchema = z.object({
  kind: z.literal("productdesign.design-contract"),
  schemaVersion: z.literal(1),
  projectId: id,
  baseline: documentVersionRefSchema,
  mappings: z.array(z.object({
    requirementId: id,
    planId: id,
    planTitle: text,
    /** Opaque server-generated digest of the plan's scope, not its execution status. */
    planScopeRevision: id,
    diagramId: id,
    nodeId: id,
    nodeLabel: text,
    design: documentVersionRefSchema,
    criterionKeys: z.array(id).min(1).max(500),
    interfaces: z.array(interfaceFactSchema).max(100).default([]),
  }).strict()).max(5000),
  /** waitsFor edges augment, never replace, the existing dependencyIds graph. */
  waits: z.array(z.object({
    from: phaseRefSchema,
    waitsFor: phaseRefSchema,
    reason: text,
  }).strict()).max(5000).default([]),
}).strict();

export type RequirementsBaseline = z.infer<typeof requirementsBaselineSchema>;
export type DesignContract = z.infer<typeof designContractSchema>;
export type DesignDocumentVersionRef = z.infer<typeof documentVersionRefSchema>;
export type DesignContractPhase = typeof DESIGN_PHASES[number];
export interface DesignContractIssue {
  code: string;
  message: string;
  path: string;
  entityIds: string[];
}
export interface DesignContractReport {
  status: "unassessed" | "partial" | "invalid" | "valid";
  /** Valid means explicit structure is consistent, never semantic completeness or acceptance. */
  scope: "declared-structured-requirements-only";
  issues: DesignContractIssue[];
  baselineRef?: DesignDocumentVersionRef;
  contractRef?: DesignDocumentVersionRef;
  coverage: Array<{ requirementId: string; criterionKey: string; planIds: string[]; verifiedPlanIds: string[]; covered: boolean; verified: boolean }>;
  plans: Array<{ id: string; title: string; scopeRevision: string; diagramId: string | null; nodeId: string | null }>;
  cycles: string[][];
}
