/** Statistics plugin tests: pure helpers and the real backend against an in-process host double. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buckets, calendar, correctShare, level, levelSteps, periodRange, totals } from "../src/aggregate.ts";
import { activate, rankWeakSpots, readableModelError, roadmapLinks } from "../src/backend.ts";
import type { SessionModel, StatsModel, WeakSpot } from "../src/backend.ts";
import { buildUserPrompt, learnerExcerpt, matchingTopic, parseClassification } from "../src/classify.ts";
import { parseSettings } from "../src/domain.ts";
import { resolveLocale, setLocale, t } from "../src/i18n.ts";
import { actionRows, focusedMs } from "../src/metrics.ts";
import { readMistakes, readRoadmaps, roadmapProgress } from "../src/sources.ts";

const MIN = 60_000;
const base = new Date(2026, 10, 12, 18, 0).getTime();
const at = (minutes: number) => base + minutes * MIN;

function directory(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statistics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function session(id: string, title: string, minutes: number[], answers: Record<number, Record<string, unknown>> = {}, kind = "teach") {
  return {
    id,
    title,
    kind,
    createdAt: new Date(at(minutes[0] ?? 0)).toISOString(),
    updatedAt: new Date(at(minutes.at(-1) ?? 0)).toISOString(),
    messages: minutes.map((minute, index) =>
      answers[index]
        ? { role: "toolResult", timestamp: at(minute), details: { answeredAt: new Date(at(minute)).toISOString(), ...answers[index] } }
        : { role: "user", content: `${title} message ${index}`, timestamp: at(minute) },
    ),
  };
}

test("action rows carry the focused gap that ended at each learner action", () => {
  const rows = actionRows(session("c", "x", [0, 5, 10, 60, 62], { 2: { correct: true }, 4: { dontKnow: true } }).messages, 15 * MIN);
  assert.deepEqual(rows.map((row) => row[1] / MIN), [0, 5, 5, 0, 2]);
  assert.deepEqual(rows.map((row) => row[2]), [0, 0, 1, 0, 3]);
  assert.equal(focusedMs(rows), 12 * MIN);
});

test("AI answers are parsed strictly: known ids only, a new topic only when nothing fits", () => {
  const topics = new Set(["roadmap:c", "custom:fr"]);
  const chats = new Set(["a", "b", "c", "d"]);
  const text = "Here you go:\n```json\n" + JSON.stringify({
    sessions: [
      { chatId: "a", topicId: "roadmap:c", newTopic: "ignored" },
      { chatId: "b", topicId: "custom:missing", newTopic: "  Calculus   basics " },
      { chatId: "c", topicId: null, newTopic: null },
      { chatId: "zzz", topicId: "roadmap:c" },
      { chatId: "a", topicId: "custom:fr" },
      { chatId: "d", newTopic: "x" },
    ],
  }) + "\n```";
  assert.deepEqual(parseClassification(text, topics, chats), [
    { chatId: "a", topicId: "roadmap:c", newTopic: null },
    { chatId: "b", topicId: null, newTopic: "Calculus basics" },
    { chatId: "c", topicId: null, newTopic: null },
    { chatId: "d", topicId: null, newTopic: null },
  ]);
  assert.deepEqual(parseClassification("not json", topics, chats), []);
  assert.match(buildUserPrompt([{ id: "roadmap:c", title: "C" }], [{ chatId: "a", title: "Pointers", excerpt: "help", concepts: ["Memory"] }]), /roadmap:c: C[\s\S]*"concepts":\["Memory"\]/);
  assert.equal(learnerExcerpt([{ role: "assistant", content: "no" }, { role: "user", content: [{ type: "text", text: " Teach   me C " }] }, { role: "user", content: "pointers" }]), "Teach me C / pointers");
});

test("aggregation buckets by local day, week and topic", () => {
  const sessions: SessionModel[] = [
    { id: "a", title: "A", kind: "teach", topicId: "t1", topicSource: "ai", moduleId: null, rows: actionRows(session("a", "A", [0, 10, 20], { 1: { correct: true }, 2: { correct: false } }).messages, 15 * MIN) },
    { id: "b", title: "B", kind: "practice", topicId: null, topicSource: null, moduleId: null, rows: actionRows(session("b", "B", [24 * 60, 24 * 60 + 5]).messages, 15 * MIN) },
  ];
  const range = periodRange("week", at(24 * 60), null);
  const sum = totals(sessions, range.from, range.to);
  assert.equal(sum.focusMs, 25 * MIN);
  assert.deepEqual([sum.teach, sum.practice, sum.correct, sum.wrong], [1, 1, 1, 1]);
  assert.equal(correctShare(sum), 50);
  const days = calendar(sessions, 2026, "focus");
  assert.equal(days.size, 2);
  assert.equal(days.get("2026-11-12")!.byTopic.get("t1"), 20 * MIN);
  assert.equal(calendar(sessions, 2026, "sessions").get("2026-11-13")!.total, 1);
  // One short day stays light: the absolute floor wins while history is thin.
  const early = levelSteps([3 * MIN], "focus");
  assert.equal(level(3 * MIN, early), 1);
  assert.deepEqual([0, 14, 15, 30, 60].map((minutes) => level(minutes * MIN, early)), [0, 1, 2, 3, 4]);
  // With a long history the scale follows your usual day.
  const busy = levelSteps([40, 60, 80, 90, 100, 120, 150, 180].map((minutes) => minutes * MIN), "focus");
  assert.equal(level(60 * MIN, busy), 1, "an hour is a light day for someone who usually studies two");
  assert.equal(level(180 * MIN, busy), 4);
  assert.deepEqual([1, 2, 4, 9].map((count) => level(count, levelSteps([1], "sessions"))), [1, 2, 4, 4]);
  const daily = buckets(sessions, "week", range.from, range.to);
  assert.equal(daily.unit, "day");
  assert.equal(daily.items.length, 7);
  assert.equal(daily.items.reduce((total, item) => total + item.total, 0), 25 * MIN);
  const year = periodRange("year", at(0), null);
  assert.equal(buckets(sessions, "year", year.from, year.to).unit, "week");
});

test("sibling data is read-only and optional; Learning Paths fills in only without Roadmap", (t) => {
  const plugins = directory(t);
  const own = path.join(plugins, "statistics", "data");
  fs.mkdirSync(own, { recursive: true });
  assert.deepEqual(readRoadmaps(own), []);
  assert.deepEqual(readMistakes(own), []);
  const legacy = path.join(plugins, "learning-path", "data");
  fs.mkdirSync(legacy, { recursive: true });
  const pathRecord = (id: string) => ({ id, title: id, modules: [{ id: "m", title: "M", nodes: [
    { id: "n1", title: "N1", progression: "consolidated", childSessions: [{ chatId: "chat-1" }], errors: [] },
    { id: "n2", title: "N2", progression: "unstarted", optional: true, childSessions: [], errors: [] },
    { id: "g1", title: "GCC", progression: "skipped", alternativeGroup: "cc", childSessions: [], errors: [] },
    { id: "g2", title: "Clang", progression: "consolidated", alternativeGroup: "cc", childSessions: [], errors: [] },
  ] }] });
  fs.writeFileSync(path.join(legacy, "learning-paths.json"), JSON.stringify({ paths: [pathRecord("old")] }));
  assert.equal(readRoadmaps(own)[0]!.source, "learning-path");
  fs.mkdirSync(path.join(plugins, "roadmap", "data"), { recursive: true });
  fs.writeFileSync(path.join(plugins, "roadmap", "data", "learning-paths.json"), JSON.stringify({ paths: [pathRecord("new")] }));
  const [roadmap] = readRoadmaps(own);
  assert.equal(roadmap!.id, "new");
  assert.deepEqual(roadmapProgress(roadmap!.modules[0]!.nodes), { done: 2, total: 2 });
  assert.equal(roadmapLinks([roadmap!]).get("chat-1")!.topicId, "roadmap:new");
  fs.mkdirSync(path.join(plugins, "mistracker", "data"), { recursive: true });
  fs.writeFileSync(path.join(plugins, "mistracker", "data", "mistracker.json"), JSON.stringify({ entries: {
    a: { id: "a", status: "saved", subject: "French", concept: "être", whyHappened: "w", chatId: "chat-9", createdAt: "2026-11-01" },
    b: { id: "b", status: "pending", subject: "French", concept: "x", whyHappened: "w", createdAt: "2026-11-02" },
  } }));
  assert.deepEqual(readMistakes(own).map((entry) => entry.id), ["a"]);
  fs.writeFileSync(path.join(plugins, "mistracker", "data", "mistracker.json"), "{broken");
  assert.deepEqual(readMistakes(own), [], "a broken neighbour contributes nothing");
});

test("weak spots group repeats and rank them first", () => {
  const spot = (title: string, createdAt: string): WeakSpot => ({ source: "mistracker", topicId: "t", title, detail: "", category: null, count: 1, createdAt, chatId: null });
  const ranked = rankWeakSpots([spot("être ou avoir", "2026-11-01"), spot("Signs", "2026-11-10"), spot("Être  ou avoir!", "2026-11-05")]);
  assert.deepEqual(ranked.map((entry) => [entry.title, entry.count]), [["Être  ou avoir!", 2], ["Signs", 1]]);
});

test("settings validate and default sensibly", () => {
  assert.deepEqual(parseSettings(undefined), { language: "auto", breakMinutes: 15, aiMode: "suggest", aiModel: null, useMistracker: true, hiddenBlocks: [] });
  assert.throws(() => parseSettings({ breakMinutes: 0 }), /1 to 120/);
  assert.throws(() => parseSettings({ aiMode: "always" }), /aiMode/);
  assert.deepEqual(parseSettings({ hiddenBlocks: ["weak", "weak"] }).hiddenBlocks, ["weak"]);
});

// ── Backend against an in-process host double ─────────────────────────

interface Host {
  call<T>(name: string, input?: unknown): Promise<T>;
  emitted: string[];
  inferences: { model: unknown; prompt: string }[];
  respond: (prompt: string) => string;
  slots: { cheap: { model: { provider: string; id: string } } | null };
  dispose(): void;
  data: string;
}

function host(t: { after(fn: () => void): void }, chats: ReturnType<typeof session>[], plugins = directory(t)): Host {
  const data = path.join(plugins, "statistics", "data");
  fs.mkdirSync(data, { recursive: true });
  const handlers = new Map<string, (input: unknown) => unknown>();
  const controller = new AbortController();
  const result: Host = {
    emitted: [],
    inferences: [],
    respond: () => "{}",
    slots: { cheap: { model: { provider: "test", id: "cheap" } } },
    data,
    async call<T>(name: string, input?: unknown): Promise<T> {
      const handler = handlers.get(name);
      assert.ok(handler, `no handler ${name}`);
      return (await handler(input)) as T;
    },
    dispose: () => controller.abort(),
  };
  const ctx = {
    dataDirectory: data,
    signal: controller.signal,
    handle(name: string, handler: (input: unknown) => unknown) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    events: {
      on: () => () => {},
      emit: (topic: string) => result.emitted.push(topic),
    },
    learning: {
      directory: plugins,
      listSessions: () => chats.map((chat) => ({ id: chat.id, title: chat.title, kind: chat.kind, updatedAt: chat.updatedAt })),
      getSession: (id: string) => chats.find((chat) => chat.id === id) ?? null,
      graph: () => ({ propositions: [{ id: "p1", provenance: [] }, { id: "p2", provenance: [] }], nodeSessions: { p1: ["c1"], p2: ["fr1"] }, clusters: [{ id: "k", label: "Pointers", members: ["p1"] }] }),
    },
    inference: {
      catalog: async () => ({ slots: result.slots }),
      complete: async (request: { model: unknown; context: { messages: { content: string }[] } }) => {
        const prompt = request.context.messages[0]!.content;
        result.inferences.push({ model: request.model, prompt });
        return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: result.respond(prompt) }] };
      },
    },
  };
  const cleanup = activate(ctx as never);
  t.after(() => {
    cleanup();
    controller.abort();
  });
  return result;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("roadmap sessions get their roadmap topic; the AI suggests for the rest and nothing counts until accepted", async (t) => {
  const plugins = directory(t);
  fs.mkdirSync(path.join(plugins, "roadmap", "data"), { recursive: true });
  fs.writeFileSync(path.join(plugins, "roadmap", "data", "learning-paths.json"), JSON.stringify({ paths: [{ id: "c", title: "C language", modules: [{ id: "m", title: "Pointers", nodes: [
    { id: "n", title: "Addresses", progression: "in_progress", childSessions: [{ chatId: "c1" }], errors: [{ id: "e", category: "misconception", summary: "Confuses *p++", resolved: false, createdAt: "2026-11-12T00:00:00Z" }] },
  ] }] }] }));
  const chats = [
    session("c1", "Pointers", [0, 4, 9], { 2: { correct: true } }),
    session("fr1", "Passé composé", [100, 105]),
    session("fr2", "Imparfait", [200, 203]),
    session("vague", "Hello", [300, 301]),
  ];
  const h = host(t, chats, plugins);
  h.respond = (prompt) => {
    assert.match(prompt, /roadmap:c: C language/);
    assert.doesNotMatch(prompt, /"chatId":"c1"/, "roadmap sessions are never sent to the model");
    return JSON.stringify({ sessions: [
      { chatId: "fr1", topicId: null, newTopic: "French" },
      { chatId: "fr2", topicId: null, newTopic: "French" },
      { chatId: "vague", topicId: null, newTopic: null },
    ] });
  };

  let model = await h.call<StatsModel>("stats.get");
  assert.equal(model.sessions.find((entry) => entry.id === "c1")!.topicId, "roadmap:c");
  assert.equal(model.topics[0]!.roadmap!.current, "Pointers");
  await settle();
  assert.equal(h.inferences.length, 1);
  assert.deepEqual(h.inferences[0]!.model, { provider: "test", id: "cheap" });
  model = await h.call<StatsModel>("stats.get");
  assert.deepEqual(model.suggestions.map((entry) => [entry.chatId, entry.newTopic]), [["fr1", "French"], ["fr2", "French"]]);
  assert.equal(model.sessions.find((entry) => entry.id === "fr1")!.topicId, null, "suggestions do not count yet");
  assert.equal(model.weak[0]!.title, "Confuses *p++");
  assert.deepEqual(model.graph, { "roadmap:c": 1, none: 1 });
  assert.equal(h.inferences.length, 1, "classified sessions are not sent again");

  await h.call("suggestions.accept", { chatId: "fr1" });
  model = await h.call<StatsModel>("stats.get");
  const french = model.topics.find((topic) => topic.title === "French")!;
  assert.equal(french.kind, "custom", "accepting a new topic creates it");
  assert.equal(model.sessions.find((entry) => entry.id === "fr1")!.topicId, french.id);
  await h.call("suggestions.accept", { all: true });
  model = await h.call<StatsModel>("stats.get");
  assert.equal(model.topics.filter((topic) => topic.title === "French").length, 1, "the same new topic is reused");
  assert.equal(model.sessions.find((entry) => entry.id === "fr2")!.topicId, french.id);
  assert.equal(model.suggestions.length, 0);

  await h.call("topics.delete", { id: french.id });
  model = await h.call<StatsModel>("stats.get");
  assert.equal(model.sessions.find((entry) => entry.id === "fr1")!.topicId, null, "a deleted topic frees its sessions");
});

test("automatic mode applies existing topics directly; dismissed suggestions stay dismissed", async (t) => {
  const chats = [session("a", "Derivatives", [0, 3]), session("b", "Limits", [10, 12])];
  const h = host(t, chats);
  await h.call("settings.save", { aiMode: "auto" });
  await h.call("topics.add", { title: "Calculus" });
  const topicId = (await h.call<{ topics: { id: string }[] }>("settings.get")).topics[0]!.id;
  h.respond = () => JSON.stringify({ sessions: [{ chatId: "a", topicId }, { chatId: "b", topicId: null, newTopic: "Analysis" }] });
  await h.call("suggestions.run");
  await settle();
  let model = await h.call<StatsModel>("stats.get");
  assert.equal(model.sessions.find((entry) => entry.id === "a")!.topicId, topicId);
  assert.equal(model.suggestions.length, 1, "new topics still wait for the learner");
  await h.call("suggestions.dismiss", { chatId: "b" });
  model = await h.call<StatsModel>("stats.get");
  assert.equal(model.suggestions.length, 0);
  assert.equal(model.ai.pending, 0, "a dismissed session is not looked at again");
});

test("without a cheap model the AI reports it instead of guessing; off mode never calls a model", async (t) => {
  const h = host(t, [session("a", "Something", [0, 1])]);
  h.slots.cheap = null;
  await h.call("suggestions.run");
  await settle();
  let model = await h.call<StatsModel>("stats.get");
  assert.equal(model.ai.error, "no-model");
  assert.equal(h.inferences.length, 0);
  await h.call("settings.save", { aiMode: "off" });
  assert.deepEqual(await h.call("suggestions.run"), { started: false });
  model = await h.call<StatsModel>("stats.get");
  assert.equal(model.ai.pending, 0);
});

test("every interface string exists in both languages", () => {
  const source = fs.readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
  const block = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end));
  const keys = (text: string) => [...text.matchAll(/^\s+"([\w.]+)":/gm)].map((match) => match[1]).sort();
  assert.deepEqual(keys(block("const ru:", "const tables")), keys(block("const en = {", "export type MessageKey")));
  assert.equal(resolveLocale("auto", "ru-RU"), "ru");
  setLocale("ru");
  assert.equal(t("hidden", { n: 2 }), "Скрытые блоки · 2");
  setLocale("en");
});

test("model errors become one short line without JSON, links or account ids", () => {
  const raw = new Error('402: {"type":"invalid_request_error","message":"Insufficient balance. This request is pay-as-you-go, billed to OpenCode Models credits. Top up at https://opencode.ai/console/org_01ABC/billing?credits=1. OpenCode Go covers only requests to the OpenCode Go provider."}');
  const line = readableModelError(raw, "opencode:deepseek-v4.1-flash");
  assert.equal(line, "opencode:deepseek-v4.1-flash — 402 Insufficient balance.");
  assert.doesNotMatch(line, /org_|https?:/);
  assert.equal(readableModelError(new Error("timeout"), ""), "timeout");
});

test("a proposed topic that restates an existing one is mapped to it", () => {
  const topics = [{ id: "custom:fr", title: "Французский" }, { id: "roadmap:c", title: "Язык C" }, { id: "custom:calc", title: "Математический анализ" }];
  assert.equal(matchingTopic("французский язык", topics)?.id, "custom:fr");
  assert.equal(matchingTopic("Французкий", topics)?.id, "custom:fr", "a typo is the same topic");
  assert.equal(matchingTopic("C", topics)?.id, "roadmap:c");
  assert.equal(matchingTopic("Анализ", topics)?.id, "custom:calc");
  assert.equal(matchingTopic("Химия", topics), null);
  const parsed = parseClassification(JSON.stringify({ sessions: [{ chatId: "a", topicId: null, newTopic: "Французский язык" }, { chatId: "b", newTopic: "Химия" }] }), new Set(topics.map((topic) => topic.id)), new Set(["a", "b"]), topics);
  assert.deepEqual(parsed, [{ chatId: "a", topicId: "custom:fr", newTopic: null }, { chatId: "b", topicId: null, newTopic: "Химия" }]);
});
