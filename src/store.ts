/** Statistics plugin store: versioned JSON files written atomically under the
 * plugin's own data folder. Corrupt or newer files are refused, never replaced. */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, parseAssignment, parseCustomTopic, parseSettings } from "./domain.ts";
import type { Assignment, CustomTopic, Settings } from "./domain.ts";

export const VERSION = 1;
export const SETTINGS_FILE = "settings.json";
export const TOPICS_FILE = "topics.json";
export const ASSIGNMENTS_FILE = "assignments.json";

export class StoreError extends Error {}

function atomicWrite(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}

function readVersioned(filename: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = fs.readFileSync(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new StoreError(`Cannot read ${path.basename(filename)}: ${(error as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StoreError(`${path.basename(filename)} is not valid JSON. Nothing was changed.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StoreError(`${path.basename(filename)} is corrupt.`);
  const record = value as Record<string, unknown>;
  if (record.version !== VERSION) {
    throw new StoreError(`${path.basename(filename)} has version ${String(record.version)}; this plugin reads version ${VERSION}. Nothing was changed.`);
  }
  return record;
}

export interface StatisticsStore {
  settings(): Settings;
  saveSettings(value: unknown): Settings;
  topics(): readonly CustomTopic[];
  saveTopics(topics: readonly CustomTopic[]): void;
  assignments(): ReadonlyMap<string, Assignment>;
  saveAssignments(next: ReadonlyMap<string, Assignment>): void;
}

export function openStore(directory: string): StatisticsStore {
  const file = (name: string): string => path.join(directory, name);

  const loadSettings = (): Settings => {
    const record = readVersioned(file(SETTINGS_FILE));
    if (!record) return DEFAULT_SETTINGS;
    try {
      return parseSettings(record.settings);
    } catch (error) {
      throw new StoreError(`settings.json is invalid: ${(error as Error).message}. Nothing was changed.`);
    }
  };
  const loadTopics = (): CustomTopic[] => {
    const record = readVersioned(file(TOPICS_FILE));
    if (!record) return [];
    if (!Array.isArray(record.topics)) throw new StoreError("topics.json is corrupt: topics must be a list.");
    return record.topics.map((entry, index) => parseCustomTopic(entry, `topics[${index}]`));
  };
  const loadAssignments = (): Map<string, Assignment> => {
    const record = readVersioned(file(ASSIGNMENTS_FILE));
    const result = new Map<string, Assignment>();
    if (!record) return result;
    const chats = record.chats;
    if (!chats || typeof chats !== "object" || Array.isArray(chats)) throw new StoreError("assignments.json is corrupt.");
    for (const [chatId, value] of Object.entries(chats as Record<string, unknown>)) {
      result.set(chatId, parseAssignment(value, `chats.${chatId}`));
    }
    return result;
  };

  let settings = loadSettings();
  let topics = loadTopics();
  let assignments = loadAssignments();

  return {
    settings: () => settings,
    saveSettings(value) {
      const parsed = parseSettings(value);
      atomicWrite(file(SETTINGS_FILE), { version: VERSION, settings: parsed });
      settings = parsed;
      return parsed;
    },
    topics: () => topics,
    saveTopics(next) {
      const parsed = next.map((entry, index) => parseCustomTopic(entry, `topics[${index}]`));
      atomicWrite(file(TOPICS_FILE), { version: VERSION, topics: parsed });
      topics = parsed;
    },
    assignments: () => assignments,
    saveAssignments(next) {
      const chats: Record<string, Assignment> = {};
      for (const [chatId, value] of next) chats[chatId] = parseAssignment(value, `chats.${chatId}`);
      atomicWrite(file(ASSIGNMENTS_FILE), { version: VERSION, chats });
      assignments = new Map(Object.entries(chats));
    },
  };
}
