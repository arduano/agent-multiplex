import type { HistoryRecord } from "../history/index.js";
import { canonicalJson, scopeKey, type Json } from "../protocol/index.js";
import type { AssetOccurrence, AssetProjectionPort, AssetView } from "./contracts.js";
/** Late derived assets can amend only the exact current row's asset metadata. */
export function replaceAsset(
  window: AssetProjectionPort,
  occurrence: AssetOccurrence,
  asset: AssetView,
): boolean {
  const current = window.getSnapshot();
  if (
    canonicalJson(current.scope.run as unknown as Json, 8192).json !==
      canonicalJson(occurrence.run as unknown as Json, 8192).json ||
    current.scope.attachment !== occurrence.attachment ||
    asset.id !== occurrence.assetId
  )
    return false;
  if (asset.state === "ready" && scopeKey(asset.file.scope) !== scopeKey(occurrence.run.scope))
    return false;
  const row = current.rows.find((row) => row.id === occurrence.rowId);
  if (
    !row ||
    !Array.isArray(row.native.assets) ||
    !row.native.assets.some(
      (value) =>
        value && typeof value === "object" && !Array.isArray(value) && value.id === asset.id,
    )
  )
    return false;
  const native = {
    ...row.native,
    assets: row.native.assets.map((value) =>
      value && typeof value === "object" && !Array.isArray(value) && value.id === asset.id
        ? asset
        : value,
    ),
  };
  try {
    canonicalJson(native as unknown as Json, 8192);
  } catch {
    return false;
  }
  window.update({
    rows: [
      {
        id: row.id,
        kind: row.kind,
        lifecycle: row.lifecycle,
        body: row.body,
        native: native as HistoryRecord["native"],
      },
    ],
  });
  return true;
}
