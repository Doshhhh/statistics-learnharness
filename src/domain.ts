/** Statistics plugin — data model and validation.
 *
 * Pure module (both bundles import it). Everything persisted under the plugin's
 * data folder is validated on read; unknown or corrupt records are refused
 * rather than silently rewritten.
 */
export const LANGUAGES = ["auto", "ru", "en"] as const;
export type LanguagePreference = (typeof LANGUAGES)[number];

/** How AI topic suggestions are applied: never, after the learner confirms, or directly. */
export const AI_MODES = ["off", "suggest", "auto"] as const;
export type AiMode = (typeof AI_MODES)[number];

export const BLOCKS = ["calendar", "topics", "weekly", "answers", "hours", "weak"] as const;
export type BlockId = (typeof BLOCKS)[number];

export const PERIODS = ["week", "month", "year", "all"] as const;
export type Period = (typeof PERIODS)[number];

export const METRICS = ["focus", "sessions", "answers", "nodes"] as const;
export type CalendarMetric = (typeof METRICS)[number];

export interface ModelChoice {
  readonly provider: string;
  readonly id: string;
}

export interface Settings {
  readonly language: LanguagePreference;
  /** Gaps between learner actions longer than this are breaks, not study. */
  readonly breakMinutes: number;
  readonly aiMode: AiMode;
  /** null follows the host's cheap model slot. */
  readonly aiModel: ModelChoice | null;
  readonly useMistracker: boolean;
  readonly hiddenBlocks: readonly BlockId[];
}

export const DEFAULT_SETTINGS: Settings = {
  language: "auto",
  breakMinutes: 15,
  aiMode: "suggest",
  aiModel: null,
  useMistracker: true,
  hiddenBlocks: [],
};

/** A topic the learner created; roadmap topics come from the Roadmap plugin. */
export interface CustomTopic {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
}

export const ASSIGNMENT_STATUSES = ["suggested", "accepted", "auto", "dismissed", "unmatched"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/** One AI decision about one session. */
export interface Assignment {
  readonly status: AssignmentStatus;
  /** An existing topic id ("roadmap:<id>" or "custom:<id>"). */
  readonly topicId?: string;
  /** A proposed new topic title; only ever applied after the learner confirms. */
  readonly newTopic?: string;
  /** The session's updatedAt when it was classified; a later change does not reclassify. */
  readonly at: string;
}

export class ValidationError extends Error {}

const fail = (path: string, message: string): never => {
  throw new ValidationError(`${path} ${message}`);
};

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string, max = 300): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) fail(path, `must be text up to ${max} characters`);
  return (value as string).trim();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) fail(path, `must be one of: ${allowed.join(", ")}`);
  return value as T;
}

export function parseSettings(value: unknown): Settings {
  const record = value === undefined ? {} : object(value, "settings");
  const breakMinutes = record.breakMinutes ?? DEFAULT_SETTINGS.breakMinutes;
  if (typeof breakMinutes !== "number" || !Number.isInteger(breakMinutes) || breakMinutes < 1 || breakMinutes > 120) {
    fail("settings.breakMinutes", "must be a whole number from 1 to 120");
  }
  let aiModel: ModelChoice | null = null;
  if (record.aiModel !== undefined && record.aiModel !== null) {
    const model = object(record.aiModel, "settings.aiModel");
    aiModel = { provider: text(model.provider, "settings.aiModel.provider", 200), id: text(model.id, "settings.aiModel.id", 200) };
  }
  const hidden = record.hiddenBlocks ?? [];
  if (!Array.isArray(hidden)) fail("settings.hiddenBlocks", "must be a list");
  return {
    language: record.language === undefined ? DEFAULT_SETTINGS.language : oneOf(record.language, LANGUAGES, "settings.language"),
    breakMinutes: breakMinutes as number,
    aiMode: record.aiMode === undefined ? DEFAULT_SETTINGS.aiMode : oneOf(record.aiMode, AI_MODES, "settings.aiMode"),
    aiModel,
    useMistracker: record.useMistracker === undefined ? true : record.useMistracker === true,
    hiddenBlocks: [...new Set((hidden as unknown[]).map((entry, index) => oneOf(entry, BLOCKS, `settings.hiddenBlocks[${index}]`)))],
  };
}

export function parseCustomTopic(value: unknown, path: string): CustomTopic {
  const record = object(value, path);
  const id = text(record.id, `${path}.id`, 80);
  if (!/^custom:[a-z0-9-]+$/.test(id)) fail(`${path}.id`, "must look like custom:<id>");
  return { id, title: text(record.title, `${path}.title`, 80), createdAt: text(record.createdAt, `${path}.createdAt`, 40) };
}

export function parseAssignment(value: unknown, path: string): Assignment {
  const record = object(value, path);
  const status = oneOf(record.status, ASSIGNMENT_STATUSES, `${path}.status`);
  const topicId = record.topicId === undefined ? undefined : text(record.topicId, `${path}.topicId`, 200);
  const newTopic = record.newTopic === undefined ? undefined : text(record.newTopic, `${path}.newTopic`, 80);
  return {
    status,
    ...(topicId === undefined ? {} : { topicId }),
    ...(newTopic === undefined ? {} : { newTopic }),
    at: text(record.at, `${path}.at`, 40),
  };
}

/** Topic ids are namespaced so a roadmap and a custom topic never collide. */
export const roadmapTopicId = (pathId: string): string => `roadmap:${pathId}`;
