/** Read-only views of sibling plugins' data (Roadmap, Learning Paths, Mistracker).
 *
 * Statistics never writes these files. A missing, unreadable or unexpected file
 * simply contributes nothing; the plugin keeps working without its neighbours.
 */
import fs from "node:fs";
import path from "node:path";

export interface RoadmapError {
  readonly id: string;
  readonly category: string;
  readonly summary: string;
  readonly resolved: boolean;
  readonly createdAt: string;
  readonly chatId: string | null;
}

export interface RoadmapNode {
  readonly id: string;
  readonly title: string;
  readonly progression: string;
  readonly optional: boolean;
  readonly alternativeGroup: string | null;
  readonly chatIds: readonly string[];
  readonly errors: readonly RoadmapError[];
}

export interface RoadmapModule {
  readonly id: string;
  readonly title: string;
  readonly nodes: readonly RoadmapNode[];
}

export interface Roadmap {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly modules: readonly RoadmapModule[];
  readonly source: "roadmap" | "learning-path";
}

export interface MistakeEntry {
  readonly id: string;
  readonly subject: string;
  readonly concept: string;
  readonly why: string;
  readonly chatId: string | null;
  readonly createdAt: string;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function readJson(filename: string): unknown {
  try {
    const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > 50 * 1024 * 1024) return undefined;
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    return undefined;
  }
}

/** `<plugins>/<id>/data` for a sibling plugin, given this plugin's data folder. */
export function siblingData(dataDirectory: string, pluginId: string): string {
  return path.join(path.dirname(path.dirname(dataDirectory)), pluginId, "data");
}

function parseRoadmaps(raw: unknown, source: Roadmap["source"]): Roadmap[] {
  return list(rec(raw).paths).flatMap((entry) => {
    const pathRecord = rec(entry);
    const id = str(pathRecord.id);
    if (!id) return [];
    return [{
      id,
      title: str(pathRecord.title) || id,
      goal: str(pathRecord.goal),
      source,
      modules: list(pathRecord.modules).map((moduleEntry) => {
        const moduleRecord = rec(moduleEntry);
        return {
          id: str(moduleRecord.id),
          title: str(moduleRecord.title),
          nodes: list(moduleRecord.nodes).map((nodeEntry) => {
            const node = rec(nodeEntry);
            return {
              id: str(node.id),
              title: str(node.title),
              progression: str(node.progression) || "unstarted",
              optional: node.optional === true,
              alternativeGroup: str(node.alternativeGroup) || null,
              chatIds: list(node.childSessions).map((link) => str(rec(link).chatId)).filter(Boolean),
              errors: list(node.errors).map((errorEntry) => {
                const error = rec(errorEntry);
                return {
                  id: str(error.id),
                  category: str(error.category),
                  summary: str(error.summary),
                  resolved: error.resolved === true,
                  createdAt: str(error.createdAt),
                  chatId: str(error.sessionChatId) || null,
                };
              }),
            };
          }),
        };
      }),
    }];
  });
}

/** Roadmaps from the Roadmap plugin; Learning Paths fills in only when Roadmap has none. */
export function readRoadmaps(dataDirectory: string): Roadmap[] {
  const own = parseRoadmaps(readJson(path.join(siblingData(dataDirectory, "roadmap"), "learning-paths.json")), "roadmap");
  if (own.length > 0) return own;
  return parseRoadmaps(readJson(path.join(siblingData(dataDirectory, "learning-path"), "learning-paths.json")), "learning-path");
}

/** Saved (confirmed) Mistracker entries. */
export function readMistakes(dataDirectory: string): MistakeEntry[] {
  const raw = readJson(path.join(siblingData(dataDirectory, "mistracker"), "mistracker.json"));
  const entries = rec(rec(raw).entries);
  return Object.values(entries).flatMap((value) => {
    const entry = rec(value);
    if (entry.status !== "saved") return [];
    return [{
      id: str(entry.id),
      subject: str(entry.subject),
      concept: str(entry.concept),
      why: str(entry.whyHappened),
      chatId: str(entry.chatId) || null,
      createdAt: str(entry.createdAt),
    }];
  });
}

/** Required-work progress: optional nodes excluded, an alternative group counts once. */
export function roadmapProgress(nodes: readonly RoadmapNode[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const groups = new Map<string, boolean>();
  for (const node of nodes) {
    if (node.alternativeGroup) {
      groups.set(node.alternativeGroup, (groups.get(node.alternativeGroup) ?? false) || node.progression === "consolidated");
      continue;
    }
    if (node.optional) continue;
    total += 1;
    if (node.progression === "consolidated" || node.progression === "skipped") done += 1;
  }
  for (const groupDone of groups.values()) {
    total += 1;
    if (groupDone) done += 1;
  }
  return { done, total };
}
