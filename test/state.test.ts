import { strict as assert } from "node:assert";
import test from "node:test";
import { createGoalState, isLiveGoal, MAX_OBJECTIVE_LENGTH, validateObjective } from "../state.ts";

test("validateObjective trims and returns the objective", () => {
	assert.equal(validateObjective("  fix the failing tests  "), "fix the failing tests");
});

test("validateObjective rejects empty and whitespace-only objectives", () => {
	assert.throws(() => validateObjective(""), /cannot be empty/);
	assert.throws(() => validateObjective("  \n\t  "), /cannot be empty/);
});

test("validateObjective enforces the length cap", () => {
	assert.equal(validateObjective("x".repeat(MAX_OBJECTIVE_LENGTH)).length, MAX_OBJECTIVE_LENGTH);
	assert.throws(() => validateObjective("x".repeat(MAX_OBJECTIVE_LENGTH + 1)), /cannot exceed 4000/);
});

test("createGoalState starts active with zero turns", () => {
	const goal = createGoalState("ship it");
	assert.equal(goal.status, "active");
	assert.equal(goal.turnsUsed, 0);
	assert.ok(goal.createdAt > 0 && goal.createdAt <= Date.now());
});

test("isLiveGoal treats only completed goals as history", () => {
	assert.equal(isLiveGoal(null), false);
	assert.equal(isLiveGoal({ ...createGoalState("o"), status: "complete" }), false);
	for (const status of ["active", "paused", "blocked"] as const) {
		assert.equal(isLiveGoal({ ...createGoalState("o"), status }), true);
	}
});
