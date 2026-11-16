/** Learner-activity events for one native session (pure).
 *
 * "Focused time" follows the Activity Heatmap convention: the sum of gaps between
 * consecutive learner actions, skipping any gap longer than the break threshold.
 * Learner actions are the learner's own messages, answered questions and
 * practice submissions. Each action carries the focused gap that ended at it, so
 * the frontend can bucket focused time by local day and hour.
 */
export type Outcome = "correct" | "wrong" | "unknown" | null;

/** [timestampMs, focusedGapMs, outcome code] — 0 none, 1 correct, 2 wrong, 3 "I don't know". */
export type ActionRow = readonly [number, number, 0 | 1 | 2 | 3];

interface MessageLike {
  readonly role?: unknown;
  readonly timestamp?: unknown;
  readonly details?: unknown;
  readonly customType?: unknown;
}

const OUTCOME_CODE: Record<Exclude<Outcome, null> | "none", 0 | 1 | 2 | 3> = { none: 0, correct: 1, wrong: 2, unknown: 3 };

export function learnerActions(messages: readonly unknown[]): { at: number; outcome: Outcome }[] {
  const actions: { at: number; outcome: Outcome }[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as MessageLike;
    let at = typeof message.timestamp === "number" ? message.timestamp : Number.NaN;
    let outcome: Outcome = null;
    if (message.role === "user") {
      // a learner message
    } else if (message.role === "toolResult") {
      const details = message.details as Record<string, unknown> | null;
      if (!details || typeof details !== "object" || typeof details.answeredAt !== "string" || details.dismissed) continue;
      const answered = Date.parse(details.answeredAt);
      if (Number.isFinite(answered)) at = answered;
      outcome = details.dontKnow ? "unknown" : details.correct === true ? "correct" : details.correct === false ? "wrong" : null;
    } else if (message.role === "custom" && message.customType === "practice-thinking") {
      // a practice submission
    } else {
      continue;
    }
    if (!Number.isFinite(at) || Math.abs(at) > 8.64e15) continue;
    actions.push({ at, outcome });
  }
  return actions.sort((a, b) => a.at - b.at);
}

export function actionRows(messages: readonly unknown[], breakMs: number): ActionRow[] {
  const actions = learnerActions(messages);
  return actions.map((action, index) => {
    const gap = index === 0 ? 0 : action.at - actions[index - 1]!.at;
    const focused = gap > 0 && gap <= breakMs ? gap : 0;
    return [action.at, focused, OUTCOME_CODE[action.outcome ?? "none"]] as const;
  });
}

export function focusedMs(rows: readonly ActionRow[]): number {
  return rows.reduce((sum, row) => sum + row[1], 0);
}
