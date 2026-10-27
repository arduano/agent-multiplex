import { CatalogAuthority } from "../src/authority/catalog.js";
import { request, scope, target } from "./fixtures.js";
const authority = await CatalogAuthority.open({ directory: process.argv[2]!, scope, observationMs: 30000 });
authority.register({ target, async create(original) { process.send?.({ state: "effectMayHaveStarted", original }); return new Promise(() => {}); }, async read() { return { state: "unknown" }; } });
void authority.create(request()).catch(() => {});
