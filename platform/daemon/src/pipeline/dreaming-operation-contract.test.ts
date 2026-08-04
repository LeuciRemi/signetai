import { expect, test } from "bun:test";
import { DREAMING_ONTOLOGY_OPERATION_SCHEMA } from "./dreaming-operation-contract";

test("Dreaming claim operations expose the shared entity-type vocabulary", () => {
	const input = {
		operation: "set_claim_value" as const,
		payload: {
			entity: "Signet",
			aspect: "product identity",
			claim_key: "purpose",
			value: "Signet preserves durable agent context.",
			entity_type: "system",
		},
	};
	expect(DREAMING_ONTOLOGY_OPERATION_SCHEMA.safeParse(input).success).toBe(true);
	expect(
		DREAMING_ONTOLOGY_OPERATION_SCHEMA.safeParse({
			...input,
			payload: { ...input.payload, entity_type: "made_up_type" },
		}).success,
	).toBe(false);
});
