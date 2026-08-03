import { ONTOLOGY_PROPOSAL_OPERATIONS } from "@signet/core";
import type { DbAccessor } from "../db-accessor";
import { readEpisodicSource } from "../episodic-sources";
import { applyOntologyOperationBatchInTx, type OntologyOperationInput } from "../ontology-proposals";
import { createDreamingAgentEvidence, type DreamingAgentEvidence } from "./dreaming-evidence";

export interface DreamingOperationRequest {
	readonly operation: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly reason?: string;
	readonly evidence?: readonly unknown[];
	readonly confidence?: number;
	readonly risk?: string | null;
}

export interface DreamingOperationItem {
	readonly index: number;
	readonly ok: boolean;
	readonly proposal?: unknown;
	readonly result?: unknown;
	readonly error?: string;
}

export interface ApplyDreamingOperationsResult {
	readonly ok: boolean;
	readonly items: readonly DreamingOperationItem[];
	readonly error?: string;
}

function citationRecord(value: unknown): {
	readonly sourceRef: string;
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath: string | null;
	readonly quote: string;
} | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const citation = value as Record<string, unknown>;
	const sourceRef = typeof citation.source_ref === "string" ? citation.source_ref.trim() : "";
	const sourceKind = typeof citation.source_kind === "string" ? citation.source_kind.trim() : "";
	const sourceId = typeof citation.source_id === "string" ? citation.source_id.trim() : "";
	const sourcePath = typeof citation.source_path === "string" ? citation.source_path.trim() : null;
	const quote = typeof citation.quote === "string" ? citation.quote.trim() : "";
	return sourceRef && sourceKind && sourceId && quote ? { sourceRef, sourceKind, sourceId, sourcePath, quote } : null;
}

function citeEvidence(
	accessor: DbAccessor,
	agentId: string,
	citation: unknown,
	allowedEvidence: readonly DreamingAgentEvidence[] | undefined,
): DreamingAgentEvidence | null {
	const requested = citationRecord(citation);
	if (requested === null) return null;
	const evidence =
		allowedEvidence ??
		accessor.withReadDb((db) => {
			const source = readEpisodicSource(db, { agentId, from: requested.sourceRef });
			return source === null ? [] : createDreamingAgentEvidence([source]);
		});
	return (
		evidence.find(
			(record) =>
				record.sourceRef === requested.sourceRef &&
				record.sourceKind === requested.sourceKind &&
				record.sourceId === requested.sourceId &&
				(requested.sourcePath === null || record.sourcePath === requested.sourcePath) &&
				record.content.includes(requested.quote),
		) ?? null
	);
}

function provenanceForEvidence(
	accessor: DbAccessor,
	agentId: string,
	operation: DreamingOperationRequest,
	allowedEvidence: readonly DreamingAgentEvidence[] | undefined,
): {
	readonly evidence: readonly unknown[];
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath: string | null;
	readonly sourceRoot: string;
} | null {
	const citations = operation.evidence ?? [];
	if (citations.length === 0) return null;
	const matched: DreamingAgentEvidence[] = [];
	for (const citation of citations) {
		const record = citeEvidence(accessor, agentId, citation, allowedEvidence);
		if (record === null) return null;
		matched.push(record);
	}
	const provenance = matched.find((source) => source.sourceEntryId !== null) ?? matched[0];
	if (!provenance) return null;
	return {
		evidence: citations,
		sourceKind: provenance.sourceKind,
		sourceId: provenance.sourceEntryId ?? provenance.sourceId,
		sourcePath: provenance.sourcePath,
		sourceRoot: "dreaming",
	};
}

/**
 * The sole daemon-owned apply seam for Dreaming agents. Pi passes the bounded
 * evidence window it gave the session; MCP/CLI callers resolve citations back
 * through the canonical episodic selector. Neither executor writes SQLite.
 */
export function applyDreamingOperations(params: {
	readonly accessor: DbAccessor;
	readonly agentId: string;
	readonly actor: string;
	readonly operations: readonly DreamingOperationRequest[];
	readonly allowedEvidence?: readonly DreamingAgentEvidence[];
}): ApplyDreamingOperationsResult {
	if (params.operations.length === 0) return { ok: false, items: [], error: "operations are required" };
	const allowedOperations = new Set<string>(ONTOLOGY_PROPOSAL_OPERATIONS);
	const validated: OntologyOperationInput[] = [];
	for (const operation of params.operations) {
		if (!allowedOperations.has(operation.operation)) {
			return { ok: false, items: [], error: `Unsupported ontology proposal operation: ${operation.operation}` };
		}
		if (
			operation.confidence !== undefined &&
			(!Number.isFinite(operation.confidence) || operation.confidence < 0 || operation.confidence > 1)
		) {
			return { ok: false, items: [], error: "confidence must be a finite number between 0 and 1" };
		}
		const provenance = provenanceForEvidence(
			params.accessor,
			params.agentId,
			operation,
			params.allowedEvidence,
		);
		if (provenance === null) {
			return {
				ok: false,
				items: [],
				error: "Every operation must cite an exact quote from scoped episodic evidence",
			};
		}
		validated.push({
			operation: operation.operation,
			payload: operation.payload,
			reason: operation.reason,
			evidence: provenance.evidence,
			confidence: operation.confidence,
			risk: operation.risk ?? null,
			sourceKind: provenance.sourceKind,
			sourceId: provenance.sourceId,
			sourcePath: provenance.sourcePath,
			sourceRoot: provenance.sourceRoot,
		});
	}

	const items: DreamingOperationItem[] = [];
	params.accessor.withWriteTx((db) => {
		for (let index = 0; index < validated.length; index += 1) {
			const savepoint = `signet_dream_op_${index}`;
			db.exec(`SAVEPOINT ${savepoint}`);
			try {
				const batch = applyOntologyOperationBatchInTx(db, {
					agentId: params.agentId,
					actor: params.actor,
					operations: [validated[index]!],
				});
				db.exec(`RELEASE SAVEPOINT ${savepoint}`);
				items.push({ index, ok: true, proposal: batch.items[0]?.proposal, result: batch.items[0]?.result });
			} catch (error) {
				db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
				db.exec(`RELEASE SAVEPOINT ${savepoint}`);
				items.push({ index, ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		}
	});
	const ok = items.some((item) => item.ok);
	return { ok, items, ...(ok ? {} : { error: "No ontology operations applied" }) };
}
