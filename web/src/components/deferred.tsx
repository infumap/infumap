/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, JSX, Show, createResource } from "solid-js";

type DeferredFeatures = typeof import("./deferredFeatures");
type DeferredComponentName = Exclude<keyof DeferredFeatures, "QRCode">;
type AuthFeatures = typeof import("./authFeatures");

let featuresPromise: Promise<DeferredFeatures | null> | null = null;
let authPromise: Promise<AuthFeatures | null> | null = null;

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

function componentFromLoader(
  load: () => Promise<Component | null>,
  wrapStatus: (status: JSX.Element) => JSX.Element = status => status,
): Component {
  return () => {
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
        </div>
      )}>{loaded => {
        const Feature = loaded();
        return <Feature />;
      }}</Show>
    );
  };
}

/** Call after the initial page is arranged. Returns a function that cancels pending preloading. */
export function scheduleDeferredFeaturesPreload(canPreload: () => boolean): () => void {
  // Preloading is optional; browsers without idle callbacks keep loading features on demand.
  if (typeof window.requestIdleCallback !== "function" || featuresPromise != null) { return () => {}; }

  let frameId: number;
  let idleId: number | null = null;
  let retryId: number | null = null;

  const scheduleIdle = () => {
    retryId = null;
    if (featuresPromise != null) { return; }
    idleId = window.requestIdleCallback(() => {
      idleId = null;
      if (featuresPromise != null) { return; }
      if (document.hidden || !canPreload()) {
        retryId = window.setTimeout(scheduleIdle, 250);
        return;
      }
      void loadDeferredFeatures();
    });
  };

  // Allow the initial page a paint before requesting idle time. Do not force an idle timeout:
  // this optional download should yield to rendering and the page's outstanding requests.
  frameId = window.requestAnimationFrame(() => {
    frameId = window.requestAnimationFrame(scheduleIdle);
  });

  return () => {
    window.cancelAnimationFrame(frameId);
    if (idleId != null) { window.cancelIdleCallback(idleId); }
    if (retryId != null) { window.clearTimeout(retryId); }
  };
}
