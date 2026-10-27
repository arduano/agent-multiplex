import { createContext, createElement, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { PluginWorkspace, type PluginAgentView, type PluginHostSet, type PluginHostView } from "./plugin-client.js";

/** Application binds its known Host contracts once. Hooks never accept a
 * caller-selected contract assertion and render/SSR acquire no stream lease.
 */
export function createMultiplexReact<H extends PluginHostSet>() {
  const Context = createContext<PluginWorkspace<H> | null>(null);
  function Provider({ workspace, children }: { workspace: PluginWorkspace<H>; children?: ReactNode }) {
    return createElement(Context.Provider, { value: workspace }, children);
  }
  function useWorkspace(): PluginWorkspace<H> {
    const workspace = useContext(Context);
    if (!workspace) throw new Error("Multiplex plugin Provider is missing");
    return workspace;
  }
  function useHost<K extends keyof H>(view: PluginHostView<H, K>) {
    useWorkspace().assertView(view);
    const snapshot = useSyncExternalStore(view.projection.subscribe, view.getSnapshot, view.getServerSnapshot);
    useEffect(() => { const lease = view.projection.observe(); return () => lease.release(); }, [view]);
    return snapshot;
  }
  function useAgent<K extends keyof H>(view: PluginAgentView<H, K>) {
    useWorkspace().assertView(view);
    const subscribe = (listener: () => void) => { const base = view.base.subscribe(listener), custom = view.projection.subscribe(listener); return () => { base(); custom(); }; };
    const snapshot = useSyncExternalStore(subscribe, view.getSnapshot, view.getServerSnapshot);
    useEffect(() => { const lease = view.observe(); return () => lease.release(); }, [view]);
    return snapshot;
  }
  return { Provider, useWorkspace, useHost, useAgent };
}
