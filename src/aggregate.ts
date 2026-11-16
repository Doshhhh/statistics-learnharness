/** Statistics aggregation (pure, local time). The backend sends per-session
 * action rows; everything here buckets them for the chosen slice and period. */
import type { CalendarMetric, Period } from "./domain.ts";
import type { SessionModel, StatsModel, TopicModel } from "./backend.ts";

export type Slice = "all" | "none" | string;

export const DAY_MS = 86_400_000;

export function dayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** [from, to) for a period ending today; `all` starts at the first action. */
export function periodRange(period: Period, now: number, first: number | null): { from: number; to: number } {
  const to = startOfDay(now) + DAY_MS;
  if (period === "week") return { from: to - 7 * DAY_MS, to };
  if (period === "month") return { from: to - 30 * DAY_MS, to };
  if (period === "year") return { from: to - 365 * DAY_MS, to };
  return { from: first === null ? to - 30 * DAY_MS : startOfDay(first), to };
}

export function sliceSessions(model: StatsModel, slice: Slice): SessionModel[] {
  if (slice === "all") return [...model.sessions];
  if (slice === "none") return model.sessions.filter((session) => session.topicId === null);
  return model.sessions.filter((session) => session.topicId === slice);
}

export function firstAction(sessions: readonly SessionModel[]): number | null {
  let first: number | null = null;
  for (const session of sessions) for (const row of session.rows) if (first === null || row[0] < first) first = row[0];
  return first;
}

export interface Totals {
  focusMs: number;
  teach: number;
  practice: number;
  correct: number;
  wrong: number;
  unknown: number;
}

const emptyTotals = (): Totals => ({ focusMs: 0, teach: 0, practice: 0, correct: 0, wrong: 0, unknown: 0 });

/** Totals for actions inside [from, to); a session counts when any of its actions does. */
export function totals(sessions: readonly SessionModel[], from: number, to: number): Totals {
  const result = emptyTotals();
  for (const session of sessions) {
    let touched = false;
    for (const [at, focused, outcome] of session.rows) {
      if (at < from || at >= to) continue;
      touched = true;
      result.focusMs += focused;
      if (outcome === 1) result.correct += 1;
      else if (outcome === 2) result.wrong += 1;
      else if (outcome === 3) result.unknown += 1;
    }
    if (touched) {
      if (session.kind === "practice") result.practice += 1;
      else result.teach += 1;
    }
  }
  return result;
}

export function correctShare(value: Totals): number | null {
  const graded = value.correct + value.wrong + value.unknown;
  return graded === 0 ? null : Math.round((value.correct / graded) * 100);
}

export interface DayValue {
  total: number;
  byTopic: Map<string, number>;
}

/** Calendar values per local day of `year` for one metric. */
export function calendar(sessions: readonly SessionModel[], year: number, metric: CalendarMetric): Map<string, DayValue> {
  const days = new Map<string, DayValue>();
  const add = (key: string, topic: string, value: number): void => {
    const day = days.get(key) ?? { total: 0, byTopic: new Map() };
    day.total += value;
    day.byTopic.set(topic, (day.byTopic.get(topic) ?? 0) + value);
    days.set(key, day);
  };
  for (const session of sessions) {
    const topic = session.topicId ?? "none";
    if (metric === "sessions") {
      const first = session.rows[0];
      if (first && new Date(first[0]).getFullYear() === year) add(dayKey(first[0]), topic, 1);
      continue;
    }
    for (const [at, focused, outcome] of session.rows) {
      if (new Date(at).getFullYear() !== year) continue;
      if (metric === "focus" && focused > 0) add(dayKey(at), topic, focused);
      else if (metric === "answers" && outcome !== 0) add(dayKey(at), topic, 1);
    }
  }
  return days;
}

/** Absolute steps per metric, so one short day never looks like a full one.
 * Focus: 1–14 min, 15–29, 30–59, 60+. Sessions: 1, 2, 3, 4+. Answers: 1–4, 5–9, 10–19, 20+. */
export const LEVEL_STEPS: Record<CalendarMetric, readonly [number, number, number]> = {
  focus: [15 * 60_000, 30 * 60_000, 60 * 60_000],
  sessions: [2, 3, 4],
  answers: [5, 10, 20],
  nodes: [2, 3, 4],
};

/** GitHub-style steps from your own active days (quartiles), never below the
 * absolute floor: early short days stay light, and as history grows the scale
 * follows what a normal day of yours looks like. */
export function levelSteps(values: Iterable<number>, metric: CalendarMetric): readonly [number, number, number] {
  const active = [...values].filter((value) => value > 0).sort((a, b) => a - b);
  const floor = LEVEL_STEPS[metric];
  if (active.length === 0) return floor;
  const quantile = (q: number): number => active[Math.min(active.length - 1, Math.floor(q * active.length))]!;
  return [Math.max(floor[0], quantile(0.25)), Math.max(floor[1], quantile(0.5)), Math.max(floor[2], quantile(0.75))];
}

export function level(value: number, steps: readonly [number, number, number]): number {
  if (value <= 0) return 0;
  const [two, three, four] = steps;
  return value >= four ? 4 : value >= three ? 3 : value >= two ? 2 : 1;
}

export interface Bucket {
  start: number;
  end: number;
  byTopic: Map<string, number>;
  total: number;
}

/** Focused time buckets: days for week/month, weeks for a year, months for all time. */
export function buckets(sessions: readonly SessionModel[], period: Period, from: number, to: number): { unit: "day" | "week" | "month"; items: Bucket[] } {
  const unit: "day" | "week" | "month" = period === "week" || period === "month" ? "day" : period === "year" ? "week" : "month";
  const items: Bucket[] = [];
  let cursor = from;
  if (unit === "week") {
    const date = new Date(from);
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    cursor = date.getTime();
  } else if (unit === "month") {
    const date = new Date(from);
    date.setDate(1);
    cursor = date.getTime();
  }
  while (cursor < to) {
    const date = new Date(cursor);
    if (unit === "day") date.setDate(date.getDate() + 1);
    else if (unit === "week") date.setDate(date.getDate() + 7);
    else date.setMonth(date.getMonth() + 1);
    items.push({ start: cursor, end: date.getTime(), byTopic: new Map(), total: 0 });
    cursor = date.getTime();
  }
  for (const session of sessions) {
    const topic = session.topicId ?? "none";
    for (const [at, focused] of session.rows) {
      if (focused <= 0 || at < from || at >= to) continue;
      const bucket = items.find((item) => at >= item.start && at < item.end);
      if (!bucket) continue;
      bucket.total += focused;
      bucket.byTopic.set(topic, (bucket.byTopic.get(topic) ?? 0) + focused);
    }
  }
  return { unit, items };
}

/** Focused minutes per local hour 0–23. */
export function hours(sessions: readonly SessionModel[], from: number, to: number): number[] {
  const result = new Array<number>(24).fill(0);
  for (const session of sessions) {
    for (const [at, focused] of session.rows) {
      if (focused <= 0 || at < from || at >= to) continue;
      result[new Date(at).getHours()]! += focused;
    }
  }
  return result;
}

export function topicTitle(topics: readonly TopicModel[], id: string | null): string | null {
  if (id === null) return null;
  return topics.find((topic) => topic.id === id)?.title ?? null;
}
