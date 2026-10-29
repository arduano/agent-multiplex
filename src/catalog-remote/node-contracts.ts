import type { CatalogAuthorityPort, CatalogEntry } from "../catalog/contracts.js";
import type { HostRoute, HostManifest } from "../host/contracts.js";
import type { Viewer, HostTarget } from "../gateway/contracts.js";
import type { CatalogActor } from "./contracts.js";
export interface CatalogEndpointOptions {
  catalog: CatalogAuthorityPort;
  route: HostRoute;
  manifest: HostManifest;
  authenticate(
    viewer: Viewer,
    target: HostTarget,
  ): CatalogActor | null | Promise<CatalogActor | null>;
  authorizeCreate(actor: CatalogActor, host: string, target: CatalogEntry["target"]): boolean;
}
