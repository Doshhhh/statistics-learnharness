/** Statistics settings page (host settings rows + a small topic manager). */
import type { PluginFrontendContext, PluginModelValue, PluginSettingsRow, PluginSettingsSchema, PluginWidgetHandle } from "learnharness-plugin-api";
import { AI_MODES, LANGUAGES } from "./domain.ts";
import type { Settings } from "./domain.ts";
import { locale, resolveLocale, setLocale, t } from "./i18n.ts";
import type { MessageKey } from "./i18n.ts";

interface TopicRow {
  readonly id: string;
  readonly title: string;
  readonly kind: "roadmap" | "custom";
}

function el<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountSettingsPage(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, onLocaleChange?: () => void): () => void {
  const document = container.ownerDocument;
  const root = el(document, "div", "st-settings");
  container.append(root);
  root.append(el(document, "h1", "st-settings-title", t("s.title")), el(document, "p", "st-muted", t("s.intro")));
  const status = el(document, "p", "st-settings-status");
  status.setAttribute("role", "status");
  root.append(status);

  const section = (title: string, intro?: string): HTMLElement => {
    const node = el(document, "section", "st-settings-section");
    node.append(el(document, "h2", undefined, title));
    if (intro) node.append(el(document, "p", "st-muted", intro));
    root.append(node);
    return node;
  };
  const displayHost = el(document, "div");
  section(t("s.display")).append(displayHost);
  const aiSection = section(t("s.ai"), t("s.aiIntro"));
  const aiHost = el(document, "div");
  const modelHost = el(document, "div", "st-model-host");
  aiSection.append(aiHost, modelHost);
  const topicsSection = section(t("s.topics"), t("s.topicsIntro"));
  const topicsHost = el(document, "div", "st-topic-list");
  const addRow = el(document, "div", "st-topic-add");
  const addInput = el(document, "input", "st-input");
  addInput.placeholder = t("s.newTopic");
  addInput.maxLength = 80;
  const addButton = el(document, "button", "st-btn", t("s.addTopic"));
  addButton.type = "button";
  addRow.append(addInput, addButton);
  topicsSection.append(topicsHost, addRow);

  let settings: Settings | null = null;
  let topics: TopicRow[] = [];
  let displayRows: PluginWidgetHandle<PluginSettingsSchema> | null = null;
  let aiRows: PluginWidgetHandle<PluginSettingsSchema> | null = null;
  let modelPicker: PluginWidgetHandle<unknown> | null = null;
  let disposed = false;
  let token = 0;
  const live = (): boolean => !disposed && !signal.aborted;
  const say = (text: string, error = false): void => {
    status.textContent = text;
    status.dataset.state = error ? "error" : "ok";
  };

  async function call(name: string, input?: unknown): Promise<boolean> {
    try {
      await ctx.call(name, input);
      if (!live()) return false;
      say(t("s.saved"));
      await load();
      return true;
    } catch (problem) {
      if (live()) say(t("s.failed", { message: problem instanceof Error ? problem.message : String(problem) }), true);
      return false;
    }
  }

  const save = (patch: Partial<Settings>): Promise<boolean> => call("settings.save", patch);
  const options = (values: readonly string[], prefix: string) => values.map((value) => ({ value, label: t(`${prefix}${value}` as MessageKey) }));

  function render(): void {
    if (!live() || !settings) return;
    const current = settings;
    const display: PluginSettingsRow[] = [
      { key: "language", type: "dropdown", label: t("s.language"), description: t("s.languageDesc"), value: current.language, options: options(LANGUAGES, "s."), onChange: (value: string) => void save({ language: value as Settings["language"] }) },
      { key: "break", type: "number", label: t("s.break"), description: t("s.breakDesc"), value: current.breakMinutes, min: 1, max: 120, step: 1, onChange: (value: number) => void save({ breakMinutes: Math.round(value) }) },
      { key: "mistracker", type: "toggle", label: t("s.mistracker"), description: t("s.mistrackerDesc"), value: current.useMistracker, onChange: (value: boolean) => void save({ useMistracker: value }) },
    ];
    if (displayRows) displayRows.update({ rows: display });
    else displayRows = ctx.ui.mountSettingsRows(displayHost, { rows: display }, { signal });

    const ai: PluginSettingsRow[] = [
      { key: "ai-mode", type: "dropdown", label: t("s.aiMode"), description: t("s.aiModeDesc"), value: current.aiMode, options: options(AI_MODES, "s.ai."), onChange: (value: string) => void save({ aiMode: value as Settings["aiMode"] }) },
      { key: "ai-follow", type: "toggle", label: t("s.aiFollow"), description: t("s.aiFollowDesc"), value: current.aiModel === null, onChange: (value: boolean) => {
        if (value) void save({ aiModel: null });
        else {
          modelHost.hidden = false;
          renderModel(null);
        }
      } },
    ];
    if (aiRows) aiRows.update({ rows: ai });
    else aiRows = ctx.ui.mountSettingsRows(aiHost, { rows: ai }, { signal });
    modelHost.hidden = current.aiModel === null;
    if (current.aiModel) renderModel(current.aiModel);

    topicsHost.replaceChildren();
    if (topics.length === 0) topicsHost.append(el(document, "p", "st-muted", t("s.noTopics")));
    for (const topic of topics) {
      const row = el(document, "div", "st-topic-row");
      row.dataset.topicId = topic.id;
      row.append(el(document, "span", "st-topic-name", topic.title));
      if (topic.kind === "roadmap") row.append(el(document, "span", "st-tag", t("s.roadmapTopic")));
      else {
        const rename = el(document, "button", "st-link", t("s.rename"));
        rename.type = "button";
        rename.addEventListener("click", () => {
          const input = el(document, "input", "st-input");
          input.value = topic.title;
          input.maxLength = 80;
          const confirm = el(document, "button", "st-btn st-btn-small", t("s.rename"));
          confirm.type = "button";
          confirm.addEventListener("click", () => {
            if (input.value.trim()) void call("topics.rename", { id: topic.id, title: input.value.trim() });
          }, { signal });
          row.replaceChildren(input, confirm);
          input.focus();
        }, { signal });
        const remove = el(document, "button", "st-link st-danger", t("s.delete"));
        remove.type = "button";
        remove.addEventListener("click", () => void call("topics.delete", { id: topic.id }), { signal });
        row.append(el(document, "span", "st-grow"), rename, remove);
      }
      topicsHost.append(row);
    }
  }

  function renderModel(value: { provider: string; id: string } | null): void {
    modelPicker?.dispose();
    modelHost.replaceChildren();
    modelPicker = ctx.ui.mountModelPicker(modelHost, {
      value: value ?? undefined,
      onChange: (next: PluginModelValue) => void save({ aiModel: { provider: next.provider, id: next.id } }),
    }, { signal });
  }

  async function load(): Promise<void> {
    const mine = ++token;
    try {
      const result = await ctx.call<{ settings: Settings; topics: TopicRow[] }>("settings.get");
      if (!live() || mine !== token) return;
      const wanted = resolveLocale(result.settings.language);
      if (wanted !== locale() && onLocaleChange) {
        setLocale(wanted);
        onLocaleChange();
        return;
      }
      settings = result.settings;
      topics = result.topics;
      render();
    } catch (problem) {
      if (live() && mine === token) say(t("s.failed", { message: problem instanceof Error ? problem.message : String(problem) }), true);
    }
  }

  const add = (): void => {
    const title = addInput.value.trim();
    if (!title) return;
    void call("topics.add", { title }).then((ok) => {
      if (ok && live()) addInput.value = "";
    });
  };
  addButton.addEventListener("click", add, { signal });
  addInput.addEventListener("change", add, { signal });

  const reset = el(document, "button", "st-link", t("s.aiReset"));
  reset.type = "button";
  reset.title = t("s.aiResetDesc");
  reset.addEventListener("click", () => void call("suggestions.reset"), { signal });
  aiSection.append(reset);

  const off = ctx.onNotification((event) => {
    if (live() && event.topic === "stats-changed") void load();
  });
  void load();
  return () => {
    if (disposed) return;
    disposed = true;
    token += 1;
    off();
    displayRows?.dispose();
    aiRows?.dispose();
    modelPicker?.dispose();
    root.remove();
  };
}
