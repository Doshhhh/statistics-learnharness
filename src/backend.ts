/** Statistics — backend activation.
 *
 * Builds one read-only statistics model from native sessions, the Knowledge
 * Graph and sibling plugins (Roadmap, Mistracker), and owns AI topic
 * suggestions. A session belongs to a topic in exactly two ways:
 *   1. it was started from a Roadmap node (the roadmap is the topic), or
 *   2. an AI suggestion the learner accepted (or, in "auto" mode, applied directly).
 * Nothing in LearnHarness or in other plugins is ever written.
 */
import { randomUUID } from "node:crypto";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { BATCH_SIZE, SYSTEM_PROMPT, buildUserPrompt, learnerExcerpt, matchingTopic, parseClassification } from "./classify.ts";
import type { SessionDigest, TopicOption } from "./classify.ts";
import { roadmapTopicId } from "./domain.ts";
import type { Assignment, CustomTopic, Settings } from "./domain.ts";
import { actionRows } from "./metrics.ts";
import type { ActionRow } from "./metrics.ts";
import { readMistakes, readRoadmaps, roadmapProgress } from "./sources.ts";
import type { Roadmap } from "./sources.ts";
import { openStore } from "./store.ts";

export const EVENT_CHANGED = "stats-changed";
/** At most this many sessions are classified per run, so a large history costs little. */
export const RUN_LIMIT = 40;
const AUTO_RUN_INTERVAL_MS = 10 * 60 * 1000;

export interface TopicModel {
  readonly id: string;
  readonly title: string;
  readonly kind: "roadmap" | "custom";
  readonly roadmap?: {
    readonly done: number;
    readonly total: number;
    readonly current: string | null;
    readonly modules: readonly { readonly id: string; readonly title: string; readonly done: number; readonly total: number }[];
  };
}

export interface SessionModel {
  readonly id: string;
  readonly title: string;
  readonly kind: "teach" | "practice";
  readonly topicId: string | null;
  readonly topicSource: "roadmap" | "ai" | null;
  readonly moduleId: string | null;
  readonly rows: readonly ActionRow[];
}

export interface SuggestionModel {
  readonly chatId: string;
  readonly title: string;
  readonly topicId: string | null;
  readonly newTopic: string | null;
}

export interface WeakSpot {
  readonly source: "roadmap" | "mistracker";
  readonly topicId: string | null;
  readonly title: string;
  readonly detail: string;
  readonly category: string | null;
  readonly count: number;
  readonly createdAt: string;
  readonly chatId: string | null;
}

export interface StatsModel {
  readonly topics: readonly TopicModel[];
  readonly sessions: readonly SessionModel[];
  readonly suggestions: readonly SuggestionModel[];
  readonly graph: Readonly<Record<string, number>>;
  readonly weak: readonly WeakSpot[];
  readonly ai: { readonly mode: Settings["aiMode"]; readonly running: boolean; readonly pending: number; readonly error: string | null };
  readonly settings: Settings;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function input(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Expected an object.");
  return value;
}

function textInput(value: unknown, name: string, max = 80): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be text up to ${max} characters.`);
  return value.trim();
}

const normalize = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** A short, safe error line: the provider's own message without JSON, links or account ids. */
export function readableModelError(error: unknown, model: string): string {
  let text = error instanceof Error ? error.message : String(error);
  const json = text.indexOf("{");
  if (json >= 0) {
    try {
      const parsed = JSON.parse(text.slice(json)) as { message?: unknown; error?: { message?: unknown } };
      const inner = typeof parsed.message === "string" ? parsed.message : typeof parsed.error?.message === "string" ? parsed.error.message : null;
      if (inner) text = `${text.slice(0, json).replace(/[:\s]+$/, "")} ${inner}`.trim();
    } catch {
      // Not JSON after all; keep the text.
    }
  }
  const sentence = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().split(/(?<=\.)\s/)[0] ?? text;
  const short = sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
  return model ? `${model} — ${short}` : short;
}

/** chatId → {topic, module} for every session started from a roadmap node. */
export function roadmapLinks(roadmaps: readonly Roadmap[]): Map<string, { topicId: string; moduleId: string }> {
  const links = new Map<string, { topicId: string; moduleId: string }>();
  for (const roadmap of roadmaps) {
    for (const module of roadmap.modules) {
      for (const node of module.nodes) {
        for (const chatId of node.chatIds) {
          if (!links.has(chatId)) links.set(chatId, { topicId: roadmapTopicId(roadmap.id), moduleId: module.id });
        }
      }
    }
  }
  return links;
}

export function topicModels(roadmaps: readonly Roadmap[], custom: readonly CustomTopic[]): TopicModel[] {
  const fromRoadmaps: TopicModel[] = roadmaps.map((roadmap) => {
    const all = roadmap.modules.flatMap((module) => module.nodes);
    const progress = roadmapProgress(all);
    const current = roadmap.modules.find((module) => {
      const counts = roadmapProgress(module.nodes);
      return counts.done < counts.total;
    });
    return {
      id: roadmapTopicId(roadmap.id),
      title: roadmap.title,
      kind: "roadmap",
      roadmap: {
        ...progress,
        current: current?.title ?? null,
        modules: roadmap.modules.map((module) => ({ id: module.id, title: module.title, ...roadmapProgress(module.nodes) })),
      },
    };
  });
  return [...fromRoadmaps, ...custom.map((topic) => ({ id: topic.id, title: topic.title, kind: "custom" as const }))];
}

/** Rank weak spots: repeated first, then the most recent. */
export function rankWeakSpots(spots: WeakSpot[]): WeakSpot[] {
  const grouped = new Map<string, WeakSpot>();
  for (const spot of spots) {
    const key = `${spot.source}|${spot.topicId ?? ""}|${normalize(spot.title)}`;
    const previous = grouped.get(key);
    if (!previous) grouped.set(key, spot);
    else {
      const newer = spot.createdAt > previous.createdAt ? spot : previous;
      grouped.set(key, { ...newer, count: previous.count + spot.count });
    }
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count || b.createdAt.localeCompare(a.createdAt)).slice(0, 60);
}

export function activate(ctx: PluginBackendContext): () => void {
  const store = openStore(ctx.dataDirectory);
  let running: Promise<void> | null = null;
  let lastRun = 0;
  let lastError: string | null = null;
  let modelLabel = "";
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = (): void => {
    if (ctx.signal.aborted) return;
    try {
      ctx.events.emit(EVENT_CHANGED, {});
    } catch {
      // An expired activation emits nothing.
    }
  };
  const emitSoon = (): void => {
    if (notifyTimer) clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      emit();
    }, 800);
  };

  const sessionsList = () => {
    try {
      return ctx.learning.listSessions();
    } catch {
      return [];
    }
  };
  const session = (id: string) => {
    try {
      return ctx.learning.getSession(id);
    } catch {
      return null;
    }
  };

  /** Sessions the AI may look at: not claimed by a roadmap and never classified. */
  const candidates = (links: ReadonlyMap<string, unknown>): string[] => {
    const assignments = store.assignments();
    return sessionsList()
      .filter((summary) => !links.has(summary.id) && !assignments.has(summary.id))
      .map((summary) => summary.id);
  };

  const topicOptions = (roadmaps: readonly Roadmap[]): TopicOption[] =>
    topicModels(roadmaps, store.topics()).map((topic) => ({ id: topic.id, title: topic.title }));

  /** Knowledge Graph cluster names per session, as extra context for the AI. */
  const conceptsBySession = (): Map<string, string[]> => {
    const result = new Map<string, string[]>();
    try {
      const graph = ctx.learning.graph();
      const labelByNode = new Map<string, string>();
      for (const cluster of graph.clusters ?? []) {
        if (!cluster.label) continue;
        for (const member of cluster.members) labelByNode.set(member, cluster.label);
      }
      for (const [nodeId, chatIds] of Object.entries(graph.nodeSessions ?? {})) {
        const label = labelByNode.get(nodeId);
        if (!label) continue;
        for (const chatId of chatIds) {
          const list = result.get(chatId) ?? [];
          if (!list.includes(label)) list.push(label);
          result.set(chatId, list);
        }
      }
    } catch {
      // The graph is optional context.
    }
    return result;
  };

  async function classify(): Promise<void> {
    const settings = store.settings();
    if (settings.aiMode === "off" || ctx.signal.aborted) return;
    const roadmaps = readRoadmaps(ctx.dataDirectory);
    const pending = candidates(roadmapLinks(roadmaps)).slice(0, RUN_LIMIT);
    if (pending.length === 0) return;
    const catalog = await ctx.inference.catalog();
    const pin = settings.aiModel ? { model: settings.aiModel } : catalog.slots?.cheap;
    if (!pin?.model) throw new Error("no-model");
    const model = { provider: pin.model.provider, id: pin.model.id };
    modelLabel = `${model.provider}:${model.id}`;
    const topics = topicOptions(roadmaps);
    const concepts = conceptsBySession();
    for (let start = 0; start < pending.length; start += BATCH_SIZE) {
      if (ctx.signal.aborted) return;
      const batch: SessionDigest[] = pending.slice(start, start + BATCH_SIZE).flatMap((chatId) => {
        const record = session(chatId);
        if (!record) return [];
        return [{
          chatId,
          title: record.title ?? "",
          excerpt: learnerExcerpt(Array.isArray(record.messages) ? record.messages : []),
          concepts: concepts.get(chatId) ?? [],
        }];
      });
      if (batch.length === 0) continue;
      const message = await ctx.inference.complete({
        model,
        purpose: "background",
        signal: ctx.signal,
        options: { maxTokens: 2000, temperature: 0 },
        context: {
          systemPrompt: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildUserPrompt(topics, batch), timestamp: Date.now() }],
        },
      });
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(message.errorMessage ?? "The model call failed.");
      }
      const answer = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      const parsed = parseClassification(answer, new Set(topics.map((topic) => topic.id)), new Set(batch.map((entry) => entry.chatId)), topics);
      const next = new Map(store.assignments());
      const now = new Date().toISOString();
      for (const entry of batch) {
        const decision = parsed.find((candidate) => candidate.chatId === entry.chatId);
        if (!decision || (!decision.topicId && !decision.newTopic)) {
          next.set(entry.chatId, { status: "unmatched", at: now });
        } else if (decision.topicId) {
          next.set(entry.chatId, { status: settings.aiMode === "auto" ? "auto" : "suggested", topicId: decision.topicId, at: now });
        } else {
          // New topics are only ever created by the learner.
          next.set(entry.chatId, { status: "suggested", newTopic: decision.newTopic!, at: now });
        }
      }
      store.saveAssignments(next);
      emit();
    }
  }

  function startClassification(force: boolean): boolean {
    if (running || ctx.signal.aborted || store.settings().aiMode === "off") return false;
    if (!force && Date.now() - lastRun < AUTO_RUN_INTERVAL_MS) return false;
    lastRun = Date.now();
    running = classify()
      .then(() => {
        lastError = null;
      })
      .catch((error: unknown) => {
        if (ctx.signal.aborted) return;
        lastError = error instanceof Error && error.message === "no-model" ? "no-model" : readableModelError(error, modelLabel);
      })
      .finally(() => {
        running = null;
        emit();
      });
    emit();
    return true;
  }

  function buildModel(): StatsModel {
    const settings = store.settings();
    const breakMs = settings.breakMinutes * 60_000;
    const roadmaps = readRoadmaps(ctx.dataDirectory);
    const links = roadmapLinks(roadmaps);
    const topics = topicModels(roadmaps, store.topics());
    const topicIds = new Set(topics.map((topic) => topic.id));
    const assignments = store.assignments();

    const sessions: SessionModel[] = [];
    const suggestions: SuggestionModel[] = [];
    for (const summary of sessionsList()) {
      const record = session(summary.id);
      if (!record) continue;
      const link = links.get(summary.id);
      const assignment = assignments.get(summary.id);
      let topicId: string | null = null;
      let topicSource: SessionModel["topicSource"] = null;
      if (link) {
        topicId = link.topicId;
        topicSource = "roadmap";
      } else if (assignment && (assignment.status === "accepted" || assignment.status === "auto") && assignment.topicId && topicIds.has(assignment.topicId)) {
        topicId = assignment.topicId;
        topicSource = "ai";
      } else if (assignment?.status === "suggested" && (assignment.newTopic || (assignment.topicId && topicIds.has(assignment.topicId)))) {
        suggestions.push({
          chatId: summary.id,
          title: summary.title || record.title || "",
          topicId: assignment.topicId ?? null,
          newTopic: assignment.newTopic ?? null,
        });
      }
      const rows = actionRows(Array.isArray(record.messages) ? record.messages : [], breakMs);
      if (rows.length === 0) continue;
      sessions.push({
        id: summary.id,
        title: summary.title || record.title || "",
        kind: summary.kind === "practice" ? "practice" : "teach",
        topicId,
        topicSource,
        moduleId: link?.moduleId ?? null,
        rows,
      });
    }

    const topicOf = new Map(sessions.map((entry) => [entry.id, entry.topicId]));
    const graph: Record<string, number> = {};
    try {
      const snapshot = ctx.learning.graph();
      const counted = new Set<string>();
      for (const proposition of snapshot.propositions ?? []) {
        const chats = snapshot.nodeSessions?.[proposition.id] ?? proposition.provenance?.map((point) => point.chatId) ?? [];
        const owner = chats.map((chatId) => topicOf.get(chatId)).find((value) => value);
        const key = owner ?? "none";
        const unique = `${key}|${proposition.id}`;
        if (counted.has(unique)) continue;
        counted.add(unique);
        graph[key] = (graph[key] ?? 0) + 1;
      }
    } catch {
      // No graph yet.
    }

    const weak: WeakSpot[] = [];
    for (const roadmap of roadmaps) {
      for (const module of roadmap.modules) {
        for (const node of module.nodes) {
          for (const error of node.errors) {
            if (error.resolved || !error.summary) continue;
            weak.push({
              source: "roadmap",
              topicId: roadmapTopicId(roadmap.id),
              title: error.summary,
              detail: node.title,
              category: error.category || null,
              count: 1,
              createdAt: error.createdAt,
              chatId: error.chatId ?? node.chatIds.at(-1) ?? null,
            });
          }
        }
      }
    }
    if (settings.useMistracker) {
      for (const entry of readMistakes(ctx.dataDirectory)) {
        const viaSession = entry.chatId ? (topicOf.get(entry.chatId) ?? links.get(entry.chatId)?.topicId ?? null) : null;
        const subject = normalize(entry.subject);
        const viaSubject = subject
          ? topics.find((topic) => {
              const title = normalize(topic.title);
              return title === subject || title.includes(subject) || subject.includes(title);
            })?.id ?? null
          : null;
        weak.push({
          source: "mistracker",
          topicId: viaSession ?? viaSubject,
          title: entry.concept,
          detail: entry.why,
          category: null,
          count: 1,
          createdAt: entry.createdAt,
          chatId: entry.chatId,
        });
      }
    }

    const pendingCount = settings.aiMode === "off" ? 0 : candidates(links).length;
    return {
      topics,
      sessions,
      suggestions,
      graph,
      weak: rankWeakSpots(weak),
      ai: { mode: settings.aiMode, running: running !== null, pending: pendingCount, error: lastError },
      settings,
    };
  }

  const accept = (chatIds: readonly string[]): void => {
    const next = new Map(store.assignments());
    const topics = [...store.topics()];
    const now = new Date().toISOString();
    let topicsChanged = false;
    for (const chatId of chatIds) {
      const assignment = next.get(chatId);
      if (!assignment || assignment.status !== "suggested") continue;
      let topicId = assignment.topicId;
      if (!topicId && assignment.newTopic) {
        // Roadmap topics and topics created since the suggestion count too.
        const known = [...topicModels(readRoadmaps(ctx.dataDirectory), []).map((topic) => ({ id: topic.id, title: topic.title })), ...topics];
        const existing = matchingTopic(assignment.newTopic, known);
        if (existing) topicId = existing.id;
        else {
          const created: CustomTopic = { id: `custom:${randomUUID()}`, title: assignment.newTopic, createdAt: now };
          topics.push(created);
          topicsChanged = true;
          topicId = created.id;
        }
      }
      if (!topicId) continue;
      next.set(chatId, { status: "accepted", topicId, at: now });
    }
    if (topicsChanged) store.saveTopics(topics);
    store.saveAssignments(next);
  };

  const handle = (name: string, handler: (value: Record<string, unknown>) => unknown): void => {
    ctx.handle(name, (value) => {
      if (ctx.signal.aborted) throw new Error("Statistics is shutting down.");
      return handler(input(value));
    });
  };

  handle("stats.get", () => {
    const model = buildModel();
    if (model.ai.pending > 0) startClassification(false);
    return { ...model, ai: { ...model.ai, running: running !== null } };
  });
  handle("settings.get", () => ({
    settings: store.settings(),
    topics: topicModels(readRoadmaps(ctx.dataDirectory), store.topics()).map((topic) => ({ id: topic.id, title: topic.title, kind: topic.kind })),
  }));
  handle("settings.save", (value) => {
    const settings = store.saveSettings({ ...store.settings(), ...value });
    emit();
    return { settings };
  });
  handle("topics.add", (value) => {
    const title = textInput(value.title, "title");
    const known = [...topicModels(readRoadmaps(ctx.dataDirectory), store.topics()).map((topic) => ({ id: topic.id, title: topic.title }))];
    const same = matchingTopic(title, known);
    if (same) throw new Error(`“${same.title}” already covers this topic.`);
    store.saveTopics([...store.topics(), { id: `custom:${randomUUID()}`, title, createdAt: new Date().toISOString() }]);
    emit();
    return { topics: store.topics() };
  });
  handle("topics.rename", (value) => {
    const id = textInput(value.id, "id", 200);
    const title = textInput(value.title, "title");
    if (!store.topics().some((topic) => topic.id === id)) throw new Error("Only your own topics can be renamed; roadmap topics follow the roadmap.");
    store.saveTopics(store.topics().map((topic) => (topic.id === id ? { ...topic, title } : topic)));
    emit();
    return { topics: store.topics() };
  });
  handle("topics.delete", (value) => {
    const id = textInput(value.id, "id", 200);
    store.saveTopics(store.topics().filter((topic) => topic.id !== id));
    // Sessions of a deleted topic become unsorted and may be suggested again.
    const next = new Map<string, Assignment>();
    for (const [chatId, assignment] of store.assignments()) if (assignment.topicId !== id) next.set(chatId, assignment);
    store.saveAssignments(next);
    emit();
    return { topics: store.topics() };
  });
  handle("suggestions.accept", (value) => {
    const all = value.all === true;
    const chatIds = all
      ? [...store.assignments()].filter(([, assignment]) => assignment.status === "suggested").map(([chatId]) => chatId)
      : [textInput(value.chatId, "chatId", 200)];
    accept(chatIds);
    emit();
    return { ok: true };
  });
  handle("suggestions.dismiss", (value) => {
    const chatId = textInput(value.chatId, "chatId", 200);
    const next = new Map(store.assignments());
    const assignment = next.get(chatId);
    if (assignment?.status === "suggested") next.set(chatId, { status: "dismissed", at: new Date().toISOString() });
    store.saveAssignments(next);
    emit();
    return { ok: true };
  });
  handle("suggestions.run", () => ({ started: startClassification(true) }));
  handle("suggestions.reset", () => {
    // Forget AI decisions (not accepted ones) so sessions are looked at again.
    const next = new Map<string, Assignment>();
    for (const [chatId, assignment] of store.assignments()) if (assignment.status === "accepted") next.set(chatId, assignment);
    store.saveAssignments(next);
    emit();
    return { ok: true };
  });

  const offEvents = ctx.events.on((event) => {
    if (ctx.signal.aborted) return;
    if (
      event.type === "turn-settled" ||
      event.type === "chats-changed" ||
      event.type === "record-changed" ||
      (event.type === "plugin-message" && (event.pluginId === "roadmap" || event.pluginId === "learning-path" || event.pluginId === "mistracker"))
    ) {
      emitSoon();
    }
  });

  return () => {
    offEvents();
    if (notifyTimer) clearTimeout(notifyTimer);
  };
}
