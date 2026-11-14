/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, JSX, Show, createResource } from "solid-js";
import type { VisualElementProps } from "./VisualElement";

type DeferredFeatures = typeof import("./deferredFeatures");
type DeferredComponentName = Exclude<keyof DeferredFeatures, "QRCode">;
type AuthFeatures = typeof import("./authFeatures");
type QueryFeatures = typeof import("./items/Query");

let featuresPromise: Promise<DeferredFeatures | null> | null = null;
let authPromise: Promise<AuthFeatures | null> | null = null;
let queryPromise: Promise<QueryFeatures | null> | null = null;

export function loadDeferredFeatures(): Promise<DeferredFeatures | null> {
  return featuresPromise ??= import("./deferredFeatures").catch(() => {
    // A failed preload must not prevent a feature from trying again when it is opened.
    featuresPromise = null;
    return null;
  });
}

export function deferredComponent(
  name: DeferredComponentName,
  wrapStatus: (status: JSX.Element) => JSX.Element = status => status,
): Component {
  return componentFromLoader(async () => (await loadDeferredFeatures())?.[name] ?? null, wrapStatus);
}

export function deferredAuthComponent(name: keyof AuthFeatures): Component {
  return componentFromLoader(async () => {
    const features = await (authPromise ??= import("./authFeatures").catch(() => {
      authPromise = null;
      return null;
    }));
    return features?.[name] ?? null;
  });
}

function loadQueryFeatures(): Promise<QueryFeatures | null> {
  // Queries can be the initial page, so opening one should not also load settings and layout dialogs.
  return queryPromise ??= import("./items/Query").catch(() => {
    queryPromise = null;
    return null;
  });
}

export function deferredQueryComponent(
  wrapStatus: (status: JSX.Element, props: VisualElementProps) => JSX.Element,
): Component<VisualElementProps> {
  return componentFromLoader<VisualElementProps>(
    async () => (await loadQueryFeatures())?.Query_Desktop ?? null,
    wrapStatus,
  );
}

function componentFromLoader<P extends object>(
  load: () => Promise<Component<P> | null>,
  wrapStatus: (status: JSX.Element, props: P) => JSX.Element = status => status,
): Component<P> {
  return props => {
    const [feature, { refetch }] = createResource(load);
    return (
      <Show when={feature()} fallback={wrapStatus(
        <div class="flex items-center justify-center gap-2 p-3 text-sm text-slate-500">
          <Show when={feature.loading} fallback={
            <>
              <span>Could not load.</span>
              <button type="button" class="text-blue-700 cursor-pointer hover:underline"
                onClick={() => { void refetch(); }}>Retry</button>
            </>
          }>
            <span role="status">Loading…</span>
          </Show>
        </div>,
        props,
      )}>{loaded => {
        const Feature = loaded();
        return <Feature {...props} />;
      }}</Show>
    );
  };
}

/** Call after the initial page is arranged. Returns a function that cancels pending preloading. */
export function scheduleDeferredFeaturesPreload(canPreload: () => boolean): () => void {
  // Preloading is optional; browsers without idle callbacks keep loading features on demand.
  if (typeof window.requestIdleCallback !== "function") { return () => {}; }

  // Warm the query workspace first, then the less frequently used dialogs, without overlapping downloads.
  const preloads = [loadQueryFeatures, loadDeferredFeatures];
  let nextPreload = 0;
  let cancelled = false;
  let frameId: number;
  let idleId: number | null = null;
  let retryId: number | null = null;

  const scheduleIdle = () => {
    retryId = null;
    if (cancelled || nextPreload >= preloads.length) { return; }
    idleId = window.requestIdleCallback(() => {
      idleId = null;
      if (cancelled) { return; }
      if (document.hidden || !canPreload()) {
        retryId = window.setTimeout(scheduleIdle, 250);
        return;
      }
      // Advance even if this preload fails; opening the feature can retry it on demand.
      void preloads[nextPreload++]().then(scheduleIdle);
    });
  };

  // Allow the initial page a paint before requesting idle time. Do not force an idle timeout:
  // this optional download should yield to rendering and the page's outstanding requests.
  frameId = window.requestAnimationFrame(() => {
    frameId = window.requestAnimationFrame(scheduleIdle);
  });

  return () => {
    cancelled = true;
    window.cancelAnimationFrame(frameId);
    if (idleId != null) { window.cancelIdleCallback(idleId); }
    if (retryId != null) { window.clearTimeout(retryId); }
  };
}
