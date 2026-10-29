import {
  assetFileReadPort,
  uploadFile,
  type NativeMediaInput,
  type AssetRemote,
} from "../../src/assets/index.js";
void assetFileReadPort;
void uploadFile;
export type BrowserAssetsContract = Readonly<{ port: AssetRemote; media: NativeMediaInput }>;
// @ts-expect-error Host ownership is intentionally absent from browser exports.
import type { HostAssetOwner as _HostAssetOwner } from "../../src/assets/index.js";
// This file also compiles with types:[]; no Node declarations are needed.
