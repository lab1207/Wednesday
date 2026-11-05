/**
 * Public-benchmark adapter contract (user direction, 2026-09-20).
 *
 * Big models already have published scores on public boards (HumanEval,
 * Aider polyglot, LiveCodeBench, SWE-bench). We never run big models
 * through the Factory. Instead we add one new row per board: the Colab
 * small model through the Factory, graded by the board's own rules —
 * so the equivalence claim ("Factory lifts a small model toward the
 * frontier band") is citable in public units.
 *
 * One adapter per board. The Factory/Hermes execution path and the
 * verification-first rule never change; adapters only translate
 * board problems into objectives and grade workspaces with the
 * board's official test semantics.
 */

export interface PublicProblem {
  /** Board-unique problem id (e.g. HumanEval `task_id`). */
  readonly id: string
  /** Full objective shown to the coder, embedding the board-native prompt. */
  readonly objective: string
  /** Board-native grading payload (test code, expected I/O, patch rules). */
  readonly test: string
  /** Symbol the grader invokes, when the board uses one. */
  readonly entryPoint?: string
}

export interface PublicGrade {
  readonly problemId: string
  readonly passed: boolean
  /** Grader evidence tail (assertion message / stderr excerpt). */
  readonly detail: string
}

export interface PublicBenchAdapter {
  readonly name: string
  listProblems(limit?: number, offset?: number): Promise<PublicProblem[]>
  /** Grade one attempt by inspecting the task workspace. */
  grade(workspace: string, problem: PublicProblem): Promise<PublicGrade>
}
