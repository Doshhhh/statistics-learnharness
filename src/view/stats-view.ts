/** Statistics view, after the Learny statistics and profile mockups. */
import type { PluginFrontendContext } from "learnharness-plugin-api";
import { PERIODS } from "../domain.ts";
import type { BlockId, CalendarMetric, Period, Settings } from "../domain.ts";
import type { SessionModel, StatsModel, TopicModel, WeakSpot } from "../backend.ts";
import { DAY_MS, buckets, calendar, correctShare, dayKey, firstAction, hours, level, levelSteps, periodRange, sliceSessions, topicTitle, totals } from "../aggregate.ts";
import type { Slice } from "../aggregate.ts";
import { duration, locale, resolveLocale, setLocale, t } from "../i18n.ts";
import type { MessageKey } from "../i18n.ts";

const PALETTE = ["#7c9cf5", "#d9a441", "#a7a1d6", "#6fb7a8", "#d98a9a", "#9aa4b5", "#c3b26b", "#8fb4e0"];
const NONE_COLOR = "#6b6b74";
const ICON_EYE =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path d="M2.5 2.5l11 11"/></svg>';
const ICON_CHEVRON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const BLOCK_NAME: Record<BlockId, MessageKey> = {
  calendar: "block.calendar",
  topics: "block.topics",
  weekly: "block.weekly",
  answers: "block.answers",
  hours: "block.hours",
  weak: "block.weak",
};

export interface StatsViewOptions {
  readonly onLocaleChange?: () => void;
  readonly now?: () => number;
}

export function mountStatsView(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, options: StatsViewOptions = {}): () => void {
  const document = container.ownerDocument;
  const now = options.now ?? (() => Date.now());
  const root = el(document, "div", "st-root");
  container.append(root);
  const tooltip = el(document, "div", "st-tip");
  tooltip.hidden = true;

  let model: StatsModel | null = null;
  let slice: Slice = "all";
  let period: Period = "month";
  let metric: CalendarMetric = "focus";
  let year = new Date(now()).getFullYear();
  let error: string | null = null;
  let disposed = false;
  let token = 0;
  let render$ = new AbortController();
  let menu: { dispose(): void } | null = null;

  const live = (): boolean => !disposed && !signal.aborted;
  const scoped = (): AbortSignal => AbortSignal.any([signal, render$.signal]);
  const localeTag = (): string => (locale() === "ru" ? "ru-RU" : "en-US");
  const problem = (value: unknown): string => (value instanceof Error ? value.message : String(value));

  const colorOf = (topicId: string | null): string => {
    if (topicId === null || topicId === "none") return NONE_COLOR;
    const index = model?.topics.findIndex((topic) => topic.id === topicId) ?? -1;
    return index < 0 ? NONE_COLOR : PALETTE[index % PALETTE.length]!;
  };
  const nameOf = (topicId: string | null): string =>
    topicId === null || topicId === "none" ? t("row.noTopic") : (topicTitle(model?.topics ?? [], topicId) ?? t("row.noTopic"));

  async function load(): Promise<void> {
    const mine = ++token;
    try {
      const next = await ctx.call<StatsModel>("stats.get");
      if (!live() || mine !== token) return;
      const wanted = resolveLocale(next.settings.language);
      if (wanted !== locale()) {
        setLocale(wanted);
        if (options.onLocaleChange) {
          options.onLocaleChange();
          return;
        }
      }
      model = next;
      if (slice !== "all" && slice !== "none" && !next.topics.some((topic) => topic.id === slice)) slice = "all";
      error = null;
    } catch (failure) {
      if (!live() || mine !== token) return;
      error = t("error.load", { message: problem(failure) });
    }
    render();
  }

  async function act(name: string, input?: unknown): Promise<void> {
    try {
      await ctx.call(name, input);
      if (live()) await load();
    } catch (failure) {
      if (!live()) return;
      error = t("error.action", { message: problem(failure) });
      render();
    }
  }

  const saveSettings = (patch: Partial<Settings>): Promise<void> => act("settings.save", patch);

  // ── Pieces ───────────────────────────────────────────────────────────

  function card(id: BlockId, title: string, subtitle: string | null, extra?: HTMLElement): HTMLElement {
    const node = el(document, "section", `st-card st-card-${id}`);
    node.dataset.block = id;
    const head = el(document, "div", "st-card-head");
    const titles = el(document, "div", "st-card-titles");
    titles.append(el(document, "h3", "st-card-title", title));
    if (subtitle) titles.append(el(document, "div", "st-sub", subtitle));
    head.append(titles);
    if (extra) head.append(extra);
    const hide = el(document, "button", "st-icon-btn");
    hide.type = "button";
    hide.title = t("hide");
    hide.setAttribute("aria-label", t("hide"));
    hide.innerHTML = ICON_EYE;
    hide.addEventListener("click", () => {
      if (!model) return;
      void saveSettings({ hiddenBlocks: [...model.settings.hiddenBlocks, id] });
    }, { signal: scoped() });
    head.append(hide);
    node.append(head);
    return node;
  }

  function segmented<T extends string>(values: readonly T[], current: T, label: (value: T) => string, onPick: (value: T) => void): HTMLElement {
    const node = el(document, "div", "st-seg");
    for (const value of values) {
      const button = el(document, "button", value === current ? "st-on" : undefined, label(value));
      button.type = "button";
      button.addEventListener("click", () => onPick(value), { signal: scoped() });
      node.append(button);
    }
    return node;
  }

  function showTip(target: HTMLElement, text: string): void {
    tooltip.textContent = text;
    tooltip.hidden = false;
    const box = root.getBoundingClientRect();
    const cell = target.getBoundingClientRect();
    const width = tooltip.offsetWidth || 200;
    tooltip.style.left = `${Math.max(8, Math.min(box.width - width - 8, cell.left - box.left + cell.width / 2 - width / 2))}px`;
    tooltip.style.top = `${cell.top - box.top + root.scrollTop - 34}px`;
  }

  // ── Blocks ───────────────────────────────────────────────────────────

  function toolbar(): HTMLElement {
    const bar = el(document, "div", "st-top");
    bar.append(el(document, "span", "st-muted", t("slice")));
    const select = el(document, "select", "st-select");
    select.setAttribute("aria-label", t("slice"));
    const options: [string, string][] = [["all", t("slice.all")], ...(model?.topics ?? []).map((topic): [string, string] => [topic.id, topic.title])];
    if (model?.sessions.some((session) => session.topicId === null)) options.push(["none", t("slice.none")]);
    for (const [value, label] of options) {
      const option = el(document, "option", undefined, label);
      option.value = value;
      if (value === slice) option.selected = true;
      select.append(option);
    }
    select.addEventListener("change", () => {
      slice = select.value;
      render();
    }, { signal: scoped() });
    const selectWrap = el(document, "span", "st-select-wrap");
    const chevron = el(document, "span", "st-select-chevron");
    chevron.innerHTML = ICON_CHEVRON;
    selectWrap.append(select, chevron);
    bar.append(selectWrap);
    bar.append(segmented(PERIODS, period, (value) => t(`period.${value}` as MessageKey), (value) => {
      period = value;
      render();
    }));
    if (model) {
      const { from, to } = periodRange(period, now(), firstAction(sliceSessions(model, slice)));
      const last = new Date(to - DAY_MS);
      const format = (ms: number) => new Date(ms).toLocaleDateString(localeTag(), { day: "numeric", month: "long", ...(new Date(ms).getFullYear() !== last.getFullYear() || period === "all" ? { year: "numeric" } : {}) });
      bar.append(el(document, "span", "st-muted st-range", `${format(from)} — ${format(to - DAY_MS)}`));
    }
    bar.append(el(document, "span", "st-grow"));
    const hidden = model?.settings.hiddenBlocks ?? [];
    if (hidden.length > 0) {
      const button = el(document, "button", "st-link", t("hidden", { n: hidden.length }));
      button.type = "button";
      button.addEventListener("click", () => {
        menu?.dispose();
        menu = ctx.ui.openMenu(button, {
          label: t("hidden", { n: hidden.length }),
          preferredSide: "down",
          items: [
            ...hidden.map((id) => ({
              key: id,
              label: t("show", { name: t(BLOCK_NAME[id]) }),
              onSelect: () => void saveSettings({ hiddenBlocks: hidden.filter((entry) => entry !== id) }),
            })),
            { key: "all", label: t("showAll"), onSelect: () => void saveSettings({ hiddenBlocks: [] }) },
          ],
        }, { signal: scoped() });
      }, { signal: scoped() });
      bar.append(button);
    }
    return bar;
  }

  function suggestionsBlock(current: StatsModel): HTMLElement | null {
    const notes: HTMLElement[] = [];
    if (current.ai.running) notes.push(el(document, "div", "st-note", t("ai.running")));
    if (current.ai.error) notes.push(el(document, "div", "st-note st-note-warn", current.ai.error === "no-model" ? t("ai.noModel") : t("ai.error", { message: current.ai.error })));
    if (current.suggestions.length === 0) {
      if (notes.length === 0) return null;
      const box = el(document, "div", "st-notes");
      box.append(...notes);
      return box;
    }
    const node = el(document, "section", "st-card st-sugg");
    const head = el(document, "div", "st-card-head");
    const titles = el(document, "div", "st-card-titles");
    titles.append(el(document, "h3", "st-card-title", t("sugg.title", { n: current.suggestions.length })), el(document, "div", "st-sub", t("sugg.hint")));
    const all = el(document, "button", "st-btn", t("sugg.acceptAll"));
    all.type = "button";
    all.addEventListener("click", () => void act("suggestions.accept", { all: true }), { signal: scoped() });
    head.append(titles, all);
    node.append(head, ...notes);
    for (const suggestion of current.suggestions.slice(0, 8)) {
      const row = el(document, "div", "st-sugg-row");
      row.dataset.chatId = suggestion.chatId;
      const title = el(document, "button", "st-sugg-title", suggestion.title || suggestion.chatId);
      title.type = "button";
      title.addEventListener("click", () => ctx.app.openSession(suggestion.chatId), { signal: scoped() });
      const target = el(document, "span", "st-sugg-topic");
      const dot = el(document, "i", "st-dot");
      dot.style.background = suggestion.topicId ? colorOf(suggestion.topicId) : NONE_COLOR;
      target.append(dot, el(document, "span", undefined, suggestion.topicId ? nameOf(suggestion.topicId) : t("sugg.newTopic", { title: suggestion.newTopic ?? "" })));
      const accept = el(document, "button", "st-btn st-btn-small", t("sugg.accept"));
      accept.type = "button";
      accept.addEventListener("click", () => void act("suggestions.accept", { chatId: suggestion.chatId }), { signal: scoped() });
      const dismiss = el(document, "button", "st-btn st-btn-small st-btn-ghost", t("sugg.dismiss"));
      dismiss.type = "button";
      dismiss.addEventListener("click", () => void act("suggestions.dismiss", { chatId: suggestion.chatId }), { signal: scoped() });
      row.append(title, el(document, "span", "st-arrow", "→"), target, el(document, "span", "st-grow"), accept, dismiss);
      node.append(row);
    }
    return node;
  }

  function calendarBlock(sessions: readonly SessionModel[]): HTMLElement {
    const values = calendar(sessions, year, metric);
    let totalFocus = 0;
    for (const value of calendar(sessions, year, "focus").values()) totalFocus += value.total;
    const daysWith = calendar(sessions, year, "focus").size;
    const controls = el(document, "div", "st-cal-controls");
    controls.append(segmented(["focus", "sessions", "answers"] as const, metric === "nodes" ? "focus" : metric, (value) => t(`cal.${value}` as MessageKey), (value) => {
      metric = value;
      render();
    }));
    const yearNav = el(document, "div", "st-year");
    const prev = el(document, "button", "st-icon-btn", "‹");
    const next = el(document, "button", "st-icon-btn", "›");
    prev.type = next.type = "button";
    next.disabled = year >= new Date(now()).getFullYear();
    prev.addEventListener("click", () => {
      year -= 1;
      render();
    }, { signal: scoped() });
    next.addEventListener("click", () => {
      year += 1;
      render();
    }, { signal: scoped() });
    yearNav.append(prev, el(document, "span", undefined, String(year)), next);
    controls.append(yearNav);
    const node = card("calendar", t("block.calendar"), t("cal.summary", { time: duration(totalFocus), year, days: daysWith }), controls);

    const grid = el(document, "div", "st-cal");
    const dows = el(document, "div", "st-cal-dows");
    dows.append(el(document, "span"), el(document, "span", undefined, t("dow.mon")), el(document, "span"), el(document, "span", undefined, t("dow.wed")), el(document, "span"), el(document, "span", undefined, t("dow.fri")), el(document, "span"), el(document, "span"));
    const body = el(document, "div", "st-cal-body");
    const months = el(document, "div", "st-cal-months");
    const cells = el(document, "div", "st-cal-cells");
    const steps = levelSteps([...values.values()].map((value) => value.total), metric === "nodes" ? "focus" : metric);
    const first = new Date(year, 0, 1);
    const start = new Date(first);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const today = dayKey(now());
    let column = 0;
    let lastMonth = -1;
    const monthNames = Array.from({ length: 12 }, (_, month) => new Date(2026, month, 1).toLocaleDateString(localeTag(), { month: "short" }).replace(".", ""));
    for (const date = new Date(start); date.getFullYear() <= year; date.setDate(date.getDate() + 1)) {
      const row = (date.getDay() + 6) % 7;
      if (row === 0 && date > start) column += 1;
      const key = dayKey(date.getTime());
      const inYear = date.getFullYear() === year;
      const value = values.get(key);
      const cell = el(document, "i", `st-c st-l${inYear ? level(value?.total ?? 0, steps) : 0}${inYear ? "" : " st-out"}${key === today ? " st-today" : ""}`);
      cell.style.gridColumn = String(column + 1);
      cell.style.gridRow = String(row + 1);
      if (inYear) {
        cell.dataset.day = key;
        const label = date.toLocaleDateString(localeTag(), { day: "numeric", month: "long" });
        let text: string;
        if (!value) text = t("cal.dayNone", { date: label });
        else {
          const amount = metric === "focus" ? duration(value.total) : String(value.total);
          const base = metric === "focus" ? t("cal.dayFocus", { date: label, time: amount }) : metric === "sessions" ? t("cal.daySessions", { date: label, n: amount }) : t("cal.dayAnswers", { date: label, n: amount });
          const parts = slice === "all" && value.byTopic.size > 1
            ? [...value.byTopic.entries()].sort((a, b) => b[1] - a[1]).map(([topic, amountByTopic]) => `${nameOf(topic)} ${metric === "focus" ? duration(amountByTopic) : amountByTopic}`)
            : [];
          text = parts.length ? `${base} · ${parts.join(", ")}` : base;
        }
        cell.addEventListener("mouseenter", () => showTip(cell, text), { signal: scoped() });
        cell.addEventListener("mouseleave", () => {
          tooltip.hidden = true;
        }, { signal: scoped() });
      }
      cells.append(cell);
      if (row === 0 && inYear && date.getMonth() !== lastMonth) {
        lastMonth = date.getMonth();
        const month = el(document, "span", undefined, monthNames[lastMonth]);
        month.style.gridColumn = String(column + 1);
        months.append(month);
      }
    }
    body.append(months, cells);
    grid.append(dows, body);
    node.append(grid);
    const foot = el(document, "div", "st-cal-foot");
    const legend = el(document, "span", "st-cal-legend");
    legend.append(el(document, "span", undefined, t("cal.less")));
    for (let index = 0; index <= 4; index += 1) legend.append(el(document, "i", `st-c st-l${index}`));
    legend.append(el(document, "span", undefined, t("cal.more")));
    foot.append(el(document, "span", undefined, t("cal.empty")), legend);
    node.append(foot);
    return node;
  }

  function progressCell(done: number, total: number, extra: string | null): HTMLElement {
    const cell = el(document, "td");
    const bar = el(document, "span", "st-bar");
    const fill = el(document, "b");
    fill.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : "0";
    bar.append(fill);
    cell.append(bar, el(document, "span", undefined, `${done} / ${total}`));
    if (extra) {
      const note = el(document, "span", "st-muted st-current", ` · ${extra}`);
      note.title = extra;
      cell.append(note);
    }
    return cell;
  }

  function weakFor(topicId: string | null): WeakSpot | undefined {
    return model?.weak.find((spot) => spot.topicId === topicId);
  }

  function topicsBlock(from: number, to: number): HTMLElement {
    const current = model!;
    const topic = slice !== "all" && slice !== "none" ? current.topics.find((entry) => entry.id === slice) : undefined;
    const byModule = topic?.kind === "roadmap" && topic.roadmap;
    const node = card("topics", t(byModule ? "block.modules" : "block.topics"), t("topics.hint", { n: current.settings.breakMinutes }));
    const table = el(document, "table", "st-table");
    const head = el(document, "tr");
    // The graph column only earns its width once the Knowledge Graph has propositions.
    const showGraph = Object.values(current.graph).some((count) => count > 0);
    // Without any roadmap the roadmap column would only say "no roadmap" on every row.
    const hasRoadmaps = current.topics.some((entry) => entry.kind === "roadmap");
    const headers: [MessageKey, boolean][] = byModule
      ? [["col.module", false], ["col.path", false], ["col.focus", true], ["col.sessions", true], ["col.correct", true]]
      : [["col.topic", false], ...(hasRoadmaps ? [["col.path", false] as [MessageKey, boolean]] : []), ["col.focus", true], ["col.sessions", true], ["col.correct", true], ...(showGraph ? [["col.graph", true] as [MessageKey, boolean]] : []), ["col.weak", false]];
    for (const [key, numeric] of headers) head.append(el(document, "th", numeric ? "st-num" : undefined, t(key)));
    table.append(head);
    const numberCell = (value: string): HTMLElement => el(document, "td", "st-num", value);
    if (byModule && topic.roadmap) {
      for (const module of topic.roadmap.modules) {
        const sessions = current.sessions.filter((session) => session.topicId === topic.id && session.moduleId === module.id);
        const sum = totals(sessions, from, to);
        const share = correctShare(sum);
        const row = el(document, "tr");
        row.append(el(document, "td", undefined, module.title), progressCell(module.done, module.total, null), numberCell(duration(sum.focusMs)), numberCell(`${sum.teach} / ${sum.practice}`), numberCell(share === null ? "—" : `${share} %`));
        table.append(row);
      }
    } else {
      const ids: (string | null)[] = slice === "all" ? [...current.topics.map((entry) => entry.id), null] : slice === "none" ? [null] : [slice];
      for (const id of ids) {
        const sessions = current.sessions.filter((session) => session.topicId === id);
        const sum = totals(sessions, from, to);
        const entry: TopicModel | undefined = id === null ? undefined : current.topics.find((candidate) => candidate.id === id);
        if (id === null && sessions.length === 0) continue;
        const row = el(document, "tr");
        const name = el(document, "td", "st-topic");
        const dot = el(document, "i", "st-dot");
        dot.style.background = colorOf(id);
        name.append(dot, el(document, "span", undefined, entry?.title ?? t("row.noTopic")));
        if (id !== null) {
          name.classList.add("st-clickable");
          name.addEventListener("click", () => {
            slice = id;
            render();
          }, { signal: scoped() });
        }
        row.append(name);
        if (hasRoadmaps) {
          if (entry?.roadmap) row.append(progressCell(entry.roadmap.done, entry.roadmap.total, entry.roadmap.current ? t("row.current", { title: entry.roadmap.current }) : null));
          else row.append(el(document, "td", "st-muted", id === null ? "" : t("row.noRoadmap")));
        }
        const share = correctShare(sum);
        const weak = weakFor(id);
        const weakCell = el(document, "td", "st-weak-cell");
        const weakText = el(document, "span", "st-ellipsis", weak?.title ?? "—");
        if (weak) weakText.title = weak.title;
        weakCell.append(weakText);
        row.append(numberCell(duration(sum.focusMs)), numberCell(`${sum.teach} / ${sum.practice}`), numberCell(share === null ? "—" : `${share} %`));
        if (showGraph) row.append(numberCell(String(current.graph[id ?? "none"] ?? 0)));
        row.append(weakCell);
        table.append(row);
      }
    }
    node.append(table);
    return node;
  }

  function weeklyBlock(sessions: readonly SessionModel[], from: number, to: number): HTMLElement {
    const { unit, items } = buckets(sessions, period, from, to);
    const total = items.reduce((sum, item) => sum + item.total, 0);
    const node = card("weekly", t("block.weekly"), `${t(unit === "day" ? "weekly.byDay" : unit === "week" ? "weekly.byWeek" : "weekly.byMonth")} · ${t("weekly.total", { time: duration(total) })}`);
    const max = Math.max(1, ...items.map((item) => item.total));
    const chart = el(document, "div", "st-bars");
    const order = [...(model?.topics ?? []).map((topic) => topic.id), "none"];
    for (const item of items) {
      const column = el(document, "div", "st-bar-col");
      const label = new Date(item.start).toLocaleDateString(localeTag(), unit === "month" ? { month: "short", year: "2-digit" } : { day: "numeric", month: "short" });
      column.title = `${label}: ${duration(item.total)}`;
      for (const topic of order) {
        const value = item.byTopic.get(topic);
        if (!value) continue;
        const piece = el(document, "span");
        piece.style.height = `${(value / max) * 100}%`;
        piece.style.background = colorOf(topic);
        column.append(piece);
      }
      chart.append(column);
    }
    node.append(chart);
    const axis = el(document, "div", "st-axis");
    const pick = [items[0], items[Math.floor(items.length / 2)], items[items.length - 1]].filter(Boolean);
    for (const item of pick) axis.append(el(document, "span", undefined, new Date(item!.start).toLocaleDateString(localeTag(), unit === "month" ? { month: "short", year: "2-digit" } : { day: "numeric", month: "short" })));
    node.append(axis);
    if (slice === "all") {
      const legend = el(document, "div", "st-legend");
      for (const topic of order) {
        if (!items.some((item) => item.byTopic.has(topic))) continue;
        const entry = el(document, "span");
        const dot = el(document, "i", "st-dot");
        dot.style.background = colorOf(topic);
        entry.append(dot, el(document, "span", undefined, nameOf(topic)));
        legend.append(entry);
      }
      node.append(legend);
    }
    return node;
  }

  function answersBlock(from: number, to: number): HTMLElement {
    const current = model!;
    const node = card("answers", t("block.answers"), t("answers.legend"));
    const topic = slice !== "all" && slice !== "none" ? current.topics.find((entry) => entry.id === slice) : undefined;
    const groups: { name: string; sessions: SessionModel[] }[] = topic?.roadmap
      ? topic.roadmap.modules.map((module) => ({ name: module.title, sessions: current.sessions.filter((session) => session.topicId === topic.id && session.moduleId === module.id) }))
      : (slice === "all" ? [...current.topics.map((entry) => entry.id), null] : slice === "none" ? [null] : [slice]).map((id) => ({
          name: nameOf(id),
          sessions: current.sessions.filter((session) => session.topicId === id),
        }));
    let shown = 0;
    for (const group of groups) {
      const sum = totals(group.sessions, from, to);
      const graded = sum.correct + sum.wrong + sum.unknown;
      if (graded === 0) continue;
      shown += 1;
      const row = el(document, "div", "st-ans");
      const head = el(document, "div", "st-ans-head");
      head.append(el(document, "span", undefined, group.name), el(document, "span", "st-muted", t("answers.count", { n: graded })));
      const bar = el(document, "div", "st-ans-bar");
      for (const [value, className] of [[sum.correct, "ok"], [sum.wrong, "bad"], [sum.unknown, "dk"]] as const) {
        const piece = el(document, "span", `st-ans-${className}`);
        piece.style.width = `${(value / graded) * 100}%`;
        bar.append(piece);
      }
      row.append(head, bar);
      node.append(row);
    }
    if (shown === 0) node.append(el(document, "p", "st-muted", t("hours.none")));
    return node;
  }

  function hoursBlock(sessions: readonly SessionModel[], from: number, to: number): HTMLElement {
    const values = hours(sessions, from, to);
    const max = Math.max(...values);
    const peak = values.indexOf(max);
    const node = card("hours", t("block.hours"), max > 0 ? t("hours.peak", { from: peak, to: (peak + 1) % 24 }) : t("hours.none"));
    const chart = el(document, "div", "st-hours");
    values.forEach((value, hour) => {
      const column = el(document, "div", "st-hour");
      const bar = el(document, "span", hour === peak && max > 0 ? "st-peak" : undefined);
      bar.style.height = `${max > 0 ? Math.max(2, (value / max) * 100) : 2}%`;
      column.title = `${hour}:00 · ${duration(value)}`;
      column.append(bar, el(document, "small", undefined, hour % 3 === 0 ? String(hour) : ""));
      chart.append(column);
    });
    node.append(chart);
    return node;
  }

  function weakBlock(): HTMLElement {
    const current = model!;
    const node = card("weak", t("block.weak"), t("weak.hint"));
    const spots = current.weak.filter((spot) => (slice === "all" ? true : slice === "none" ? spot.topicId === null : spot.topicId === slice)).slice(0, 6);
    if (spots.length === 0) node.append(el(document, "p", "st-muted", t("weak.empty")));
    for (const spot of spots) {
      const row = el(document, "div", "st-weak");
      const text = el(document, "div", "st-weak-text");
      text.append(el(document, "div", "st-ellipsis", spot.title));
      const meta = [nameOf(spot.topicId), spot.source === "mistracker" ? t("weak.mistracker") : spot.detail, spot.count > 1 ? t("weak.times", { n: spot.count }) : null]
        .filter(Boolean)
        .join(" · ");
      text.append(el(document, "div", "st-sub st-ellipsis", meta));
      row.append(text);
      if (spot.chatId) {
        const open = el(document, "button", "st-link", t("weak.open"));
        open.type = "button";
        const chatId = spot.chatId;
        open.addEventListener("click", () => ctx.app.openSession(chatId), { signal: scoped() });
        row.append(open);
      }
      node.append(row);
    }
    return node;
  }

  // ── Render ───────────────────────────────────────────────────────────

  function render(): void {
    if (!live()) return;
    render$.abort();
    render$ = new AbortController();
    menu = null;
    const children: HTMLElement[] = [toolbar()];
    if (error) children.push(el(document, "p", "st-error", error));
    if (!model) {
      root.replaceChildren(...children, tooltip);
      return;
    }
    const sessions = sliceSessions(model, slice);
    const suggestions = suggestionsBlock(model);
    if (suggestions) children.push(suggestions);
    if (model.sessions.length === 0) {
      const empty = el(document, "div", "st-empty");
      empty.append(el(document, "h2", undefined, t("empty.title")), el(document, "p", "st-muted", t("empty.text")));
      children.push(empty);
      root.replaceChildren(...children, tooltip);
      return;
    }
    const { from, to } = periodRange(period, now(), firstAction(sessions));
    const hidden = new Set(model.settings.hiddenBlocks);
    if (!hidden.has("calendar")) children.push(calendarBlock(sessions));
    const middle = el(document, "div", "st-row st-row-2");
    if (!hidden.has("topics")) middle.append(topicsBlock(from, to));
    if (!hidden.has("weekly")) middle.append(weeklyBlock(sessions, from, to));
    if (middle.childElementCount === 1) middle.classList.add("st-row-single");
    if (middle.childElementCount) children.push(middle);
    const bottom = el(document, "div", "st-row st-row-3");
    if (!hidden.has("answers")) bottom.append(answersBlock(from, to));
    if (!hidden.has("hours")) bottom.append(hoursBlock(sessions, from, to));
    if (!hidden.has("weak")) bottom.append(weakBlock());
    bottom.style.setProperty("--cols", String(Math.max(1, bottom.childElementCount)));
    if (bottom.childElementCount) children.push(bottom);
    root.replaceChildren(...children, tooltip);
  }

  const offNotification = ctx.onNotification((event) => {
    if (live() && event.topic === "stats-changed") void load();
  });
  const offResync = ctx.onResync(() => {
    if (live()) void load();
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    token += 1;
    render$.abort();
    offNotification();
    offResync();
    root.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  render();
  void load();
  return () => {
    signal.removeEventListener("abort", dispose);
    dispose();
  };
}
