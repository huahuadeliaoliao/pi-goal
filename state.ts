/**
 * Goal state and validation. Pure module: no pi APIs, unit-testable.
 */

export type GoalStatus = "active" | "paused" | "blocked" | "complete";

export interface GoalState {
	objective: string;
	status: GoalStatus;
	turnsUsed: number;
	createdAt: number;
	updatedAt: number;
	reason?: string;
}

/** Same cap as kimi-code: long content belongs in a file the goal references. */
export const MAX_OBJECTIVE_LENGTH = 4000;

export function validateObjective(value: string): string {
	const objective = value.trim();
	if (!objective) throw new Error("Goal objective cannot be empty");
	if (objective.length > MAX_OBJECTIVE_LENGTH) {
		throw new Error(
			`Goal objective cannot exceed ${MAX_OBJECTIVE_LENGTH} characters. Put long content in a file and reference the file path.`,
		);
	}
	return objective;
}

export function createGoalState(objective: string): GoalState {
	const now = Date.now();
	return { objective, status: "active", turnsUsed: 0, createdAt: now, updatedAt: now };
}

/** A goal the user may still act on (vs. a completed one, which is history). */
export function isLiveGoal(goal: GoalState | null): goal is GoalState {
	return goal !== null && goal.status !== "complete";
}
