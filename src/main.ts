/** Statistics — frontend activation: the statistics view, a sidebar entry and the settings page. */
import type { PluginFrontendContext } from "learnharness-plugin-api";
import { resolveLocale, setLocale, t } from "./i18n.ts";
import { mountSettingsPage } from "./settings-page.ts";
import { mountStatsView } from "./view/stats-view.ts";

const ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 13.5h11M4 11V7M7 11V4M10 11V8M13 11V5.5"/></svg>';

/** Mount `build` and rebuild it when the saved language differs from the active one. */
function relocalizing(container: HTMLElement, signal: AbortSignal, build: (scoped: AbortSignal, rebuild: () => void) => () => void): () => void {
  let cleanup: (() => void) | null = null;
  let child: AbortController | null = null;
  const mount = (): void => {
    cleanup?.();
    child?.abort();
    container.replaceChildren();
    if (signal.aborted) return;
    child = new AbortController();
    cleanup = build(AbortSignal.any([signal, child.signal]), () => queueMicrotask(mount));
  };
  mount();
  return () => {
    cleanup?.();
    child?.abort();
  };
}

export function activate(ctx: PluginFrontendContext): () => void {
  setLocale(resolveLocale("auto"));
  const disposers: (() => void)[] = [];
  disposers.push(
    ctx.registerView({
      id: "stats",
      name: t("view.name"),
      mount(container, signal) {
        container.classList.add("statistics-view");
        const cleanup = relocalizing(container, signal, (scoped, rebuild) => mountStatsView(ctx, container, scoped, { onLocaleChange: rebuild }));
        return () => {
          cleanup();
          container.replaceChildren();
          container.classList.remove("statistics-view");
        };
      },
    }),
  );
  disposers.push(ctx.registerAction({ id: "open-stats", name: t("view.name"), icon: ICON, run: () => ctx.app.openView("stats") }));
  disposers.push(ctx.placeAction({ id: "stats-sidebar", actionId: "open-stats", location: "sidebar" }));
  disposers.push(
    ctx.registerSettings((container, signal) => {
      container.classList.add("statistics-settings");
      const cleanup = relocalizing(container, signal, (scoped, rebuild) => mountSettingsPage(ctx, container, scoped, rebuild));
      return () => {
        cleanup();
        container.replaceChildren();
        container.classList.remove("statistics-settings");
      };
    }),
  );
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
