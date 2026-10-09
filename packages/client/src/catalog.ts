import { canonicalJson, GATEWAY_CATALOG_LIMITS, type AccessStreamItem, type GatewayCatalogView } from "@arduano/agent-multiplex-protocol";

export type GatewayCatalogObservation = { state: "empty"; view: undefined } | { state: "current" | "stale"; view: GatewayCatalogView };

/** Retained authority-neutral observation. A read has an explicit caller token;
 * a delta needs the exact committed feed/revision/cursor. Neither HTTP arrival
 * nor a source-read's unversioned contents can certify a newer catalog. */
export class GatewayCatalogController {
  #read = 0;
  #observation: GatewayCatalogObservation = { state: "empty", view: undefined };
  readonly #listeners = new Set<() => void>();
  snapshot = (): GatewayCatalogObservation => this.#observation;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  beginRead(): number { return ++this.#read; }
  retireRead(token: number): void { if (token === this.#read) this.#read++; }
  failRead(token: number): void { if (token === this.#read) this.invalidate(); }
  accept(token: number, view: GatewayCatalogView): boolean {
    if (token !== this.#read) return false;
    const current = this.#observation.view;
    if (current?.stamp.viewId === view.stamp.viewId && current.stamp.revision > view.stamp.revision) return false;
    this.#publish({ state: "current", view: structuredClone(view) }); return true;
  }
  invalidate(): void {
    this.#read++;
    if (this.#observation.view) this.#publish({ state: "stale", view: this.#observation.view });
  }
  apply(item: AccessStreamItem): boolean {
    if (item.kind === "streamReset") { this.invalidate(); return false; }
    if (item.kind !== "control" && item.kind !== "catalog") return true;
    const current = this.#observation;
    if (current.state !== "current") return false;
    const view = current.view;
    if (item.kind === "catalog") {
      if (item.feedId !== view.stamp.feedId) { this.invalidate(); return false; }
      if (item.cursor <= view.stamp.controlCursor) return true;
      if (item.cursor !== view.stamp.controlCursor + 1 || item.stamp.viewId !== view.stamp.viewId ||
          item.stamp.revision !== view.stamp.revision + 1 || item.stamp.feedId !== item.feedId ||
          item.stamp.controlCursor !== item.cursor ||
          new Set(item.sources.map(source => source.sourceId)).size !== item.sources.length ||
          item.sources.length !== view.sources.length || item.sources.some(source => {
            const previous = view.sources.find(value => value.sourceId === source.sourceId);
            return !previous || previous.endpointId !== source.endpointId || previous.displayName !== source.displayName;
          }) ||
          item.coverage.length !== view.coverage.length ||
          new Set(item.coverage.map(source => source.sourceId)).size !== item.coverage.length ||
          view.coverage.some(covered => {
            const manifest = item.coverage.find(source => source.sourceId === covered.sourceId)?.manifest;
            return !manifest || canonicalJson({ ...manifest, generatedAt: null }) !== canonicalJson({ ...covered.manifest, generatedAt: null });
          }) ||
          item.coverage.some(covered => {
            const manifest = item.sources.find(source => source.sourceId === covered.sourceId)?.manifest;
            return manifest !== undefined && canonicalJson(manifest) !== canonicalJson(covered.manifest);
          }) ||
          (view.coverage.length < GATEWAY_CATALOG_LIMITS.sources &&
            item.sources.some(source => source.state === "selected" && !view.coverage.some(covered => covered.sourceId === source.sourceId)))) {
        this.invalidate(); return false;
      }
      const next = structuredClone(view);
      next.stamp = item.stamp;
      next.sources = structuredClone(item.sources);
      next.coverage = structuredClone(item.coverage);
      next.complete.sources = item.complete;
      this.#publish({ state: "current", view: next }); return true;
    }
    if (item.feedId !== view.stamp.feedId || item.catalog === undefined) { this.invalidate(); return false; }
    if (item.cursor <= view.stamp.controlCursor) return true;
    if (item.cursor !== view.stamp.controlCursor + 1 || item.catalog!.stamp.viewId !== view.stamp.viewId || item.catalog!.stamp.revision !== view.stamp.revision + 1) { this.invalidate(); return false; }
    const delta = item.catalog!;
    if (delta.stamp.feedId !== item.feedId || delta.stamp.controlCursor !== item.cursor) { this.invalidate(); return false; }
    const coverage = view.coverage.find(source => source.sourceId === delta.source.sourceId);
    if (!coverage || coverage.manifest.sourceControlNodeBootId !== delta.source.position.sourceControlNodeBootId ||
        coverage.manifest.feedId !== delta.source.position.feedId || delta.source.position.controlCursor <= coverage.manifest.controlCursor) { this.invalidate(); return false; }
    const next = structuredClone(view), change = item.change;
    const covered = next.coverage.find(source => source.sourceId === delta.source.sourceId)!;
    covered.manifest.controlCursor = delta.source.position.controlCursor;
    covered.manifest.generatedAt = delta.source.position.generatedAt;
    const diagnostic = next.sources.find(source => source.sourceId === delta.source.sourceId);
    if (diagnostic?.manifest) {
      diagnostic.manifest.controlCursor = delta.source.position.controlCursor;
      diagnostic.manifest.generatedAt = delta.source.position.generatedAt;
    }
    const upsert = <T>(items: T[], value: T, matches: (item: T) => boolean, maximum: number): boolean => {
      const index = items.findIndex(matches);
      if (index >= 0) { items[index] = value; return true; }
      if (items.length >= maximum) return false;
      items.push(value); return true;
    };
    if (change.type === "session.upsert") {
      if (change.session.catalogState === "archived") {
        next.sessions = next.sessions.filter(record => record.sessionId !== change.session.sessionId);
        next.pinnedSessions = next.pinnedSessions.filter(record => record.sessionId !== change.session.sessionId);
        next.stamp = delta.stamp;
        this.#publish({ state: "current", view: next }); return true;
      }
      const existing = next.sessions.some(record => record.sessionId === change.session.sessionId);
      const pin = next.pinnedSessions.findIndex(record => record.sessionId === change.session.sessionId);
      if (!existing && pin < 0 && !next.complete.sessions) { this.invalidate(); return false; }
      if ((existing || next.complete.sessions) && !upsert(next.sessions, change.session, record => record.sessionId === change.session.sessionId, GATEWAY_CATALOG_LIMITS.sessions)) { this.invalidate(); return false; }
      if (pin >= 0) next.pinnedSessions[pin] = change.session;
    } else if (change.type === "runtimeNode.upsert") {
      if (!next.complete.runtimes && !next.runtimeNodes.some(record => record.runtimeNodeId === change.runtimeNode.runtimeNodeId)) { this.invalidate(); return false; }
      if (!upsert(next.runtimeNodes, change.runtimeNode, record => record.runtimeNodeId === change.runtimeNode.runtimeNodeId, GATEWAY_CATALOG_LIMITS.runtimes)) { this.invalidate(); return false; }
    } else if (change.type === "runtimeNode.presence") {
      const runtime = next.runtimeNodes.find(record => record.runtimeNodeId === change.runtimeNodeId);
      if (!runtime) { this.invalidate(); return false; }
      runtime.presence = change.presence;
    } else if (change.type === "metadata.changed") {
      for (const session of [...next.sessions, ...next.pinnedSessions]) if (session.sessionId === change.sessionId) session.metadata = change.metadata;
    } else if (change.type === "session.unavailable") {
      for (const session of [...next.sessions, ...next.pinnedSessions]) if (session.sessionId === change.sessionId) session.availability = "unavailable";
    } else if (change.type === "interaction.changed") {
      if (!next.complete.interactions && !next.interactions.some(record => record.interactionId === change.interaction.interactionId)) { this.invalidate(); return false; }
      if (!upsert(next.interactions, change.interaction, record => record.interactionId === change.interaction.interactionId, GATEWAY_CATALOG_LIMITS.interactions)) { this.invalidate(); return false; }
    } else if (change.type.startsWith("controlNode.") || change.type.startsWith("authority.")) {
      this.invalidate(); return false;
    }
    next.stamp = delta.stamp;
    this.#publish({ state: "current", view: next }); return true;
  }
  #publish(observation: GatewayCatalogObservation): void { this.#observation = observation; for (const listener of this.#listeners) listener(); }
}
