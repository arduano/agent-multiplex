import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { command, option, run, string } from "cmd-ts";

// This is an offline generator over the exact published CLI study output. It
// never executes Codex. Runtime procedure composition stays explicit in router.ts.
const procedures = {
  "thread/read": "ThreadRead",
  "thread/turns/list": "ThreadTurnsList",
  "thread/items/list": "ThreadItemsList",
  "thread/settings/update": "ThreadSettingsUpdate",
  "turn/start": "TurnStart",
  "turn/steer": "TurnSteer",
  "turn/interrupt": "TurnInterrupt",
  "turn/settings/update": "TurnSettingsUpdate",
  "model/list": "ModelList",
  "thread/queue/list": "ThreadQueueList",
  "thread/queue/add": "ThreadQueueAdd",
  "thread/queue/start": "ThreadQueueStart",
  "thread/queue/update": "ThreadQueueUpdate",
  "thread/queue/delete": "ThreadQueueDelete",
  "thread/queue/reorder": "ThreadQueueReorder",
  "thread/goal/get": "ThreadGoalGet",
  "thread/goal/set": "ThreadGoalSet",
  "thread/goal/clear": "ThreadGoalClear",
  "thread/backgroundTerminals/list": "ThreadBackgroundTerminalsList",
  "thread/backgroundTerminals/terminate": "ThreadBackgroundTerminalsTerminate",
  "thread/backgroundTerminals/clean": "ThreadBackgroundTerminalsClean",
  "thread/compact/start": "ThreadCompactStart",
  "mcpServerStatus/list": "ListMcpServerStatus",
} as const;
const notifications = [
  "thread/started",
  "thread/status/changed",
  "thread/closed",
  "thread/reverted",
  "thread/settings/updated",
  "thread/tokenUsage/updated",
  "thread/queue/changed",
  "thread/goal/updated",
  "thread/goal/cleared",
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "turn/diff/updated",
  "turn/moderationMetadata",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "serverRequest/resolved",
  "error",
];
const callbacks = {
  "item/commandExecution/requestApproval": "CommandExecutionRequestApproval",
  "item/fileChange/requestApproval": "FileChangeRequestApproval",
  "item/permissions/requestApproval": "PermissionsRequestApproval",
  "item/tool/requestUserInput": "ToolRequestUserInput",
  "mcpServer/elicitation/request": "McpServerElicitationRequest",
} as const;
type Schema = Record<string, unknown>;

async function generate(source: string): Promise<void> {
  const output = resolve("src/codex/protocol"),
    definitions = new Map<string, Schema>(),
    roots = new Map<string, Schema>(),
    closure = new Set<string>();
  const nativeNotifications = await readFile(join(source, "ts/ServerNotification.ts"), "utf8");
  const selected = [
    ...nativeNotifications.matchAll(/\{ "method": "([^"]+)", "params": (\w+) \}/g),
  ].filter((match) => notifications.includes(match[1]!));
  if (selected.length !== notifications.length) throw Error("Pinned notification subset changed");
  const names = [
    ...new Set([
      ...Object.values(procedures).flatMap((name) => [`${name}Params`, `${name}Response`]),
      ...Object.values(callbacks).flatMap((name) => [`${name}Params`, `${name}Response`]),
      ...selected.map((match) => match[2]!),
    ]),
  ];
  const rootPaths = new Map<string, string>();
  const hashes: Record<string, string> = {};
  for (const name of names) {
    const path = `v2/${name}`;
    let schemaPath = `v2/${name}.json`;
    const raw = await readFile(join(source, "json-schema", schemaPath), "utf8").catch(async () => {
        schemaPath = `${name}.json`;
        return readFile(join(source, "json-schema", schemaPath), "utf8");
      }),
      schema = JSON.parse(raw) as Schema;
    roots.set(name, schema);
    rootPaths.set(name, path);
    hashes[`json-schema/${schemaPath}`] = createHash("sha256").update(raw).digest("hex");
    for (const [key, value] of Object.entries(
      (schema.definitions ?? {}) as Record<string, Schema>,
    )) {
      if (definitions.has(key) && JSON.stringify(definitions.get(key)) !== JSON.stringify(value))
        throw Error(`Conflicting native definition: ${key}`);
      definitions.set(key, value);
    }
  }
  async function copy(path: string): Promise<void> {
    if (closure.has(path)) return;
    closure.add(path);
    const raw = await readFile(join(source, "ts", `${path}.ts`), "utf8");
    hashes[`ts/${path}.ts`] = createHash("sha256").update(raw).digest("hex");
    for (const match of raw.matchAll(/from "([^"]+)"/g)) {
      const dependency = resolve("/", dirname(path), match[1]!).slice(1);
      await copy(dependency);
    }
    const target = join(output, `${path}.ts`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, raw.replace(/from "([^"]+)"/g, 'from "$1.js"'));
  }
  for (const path of rootPaths.values()) await copy(path);
  const all = new Map([...definitions, ...roots]);
  function expression(raw: unknown): string {
    const s = raw as Schema;
    if (raw === true) return "z.json()";
    if (raw === false) return "z.never()";
    if (typeof s.$ref === "string") return `${s.$ref.split("/").at(-1)}Schema`;
    if (Array.isArray(s.enum))
      return s.enum.length === 1
        ? `z.literal(${JSON.stringify(s.enum[0])})`
        : `z.union([${s.enum.map((value) => `z.literal(${JSON.stringify(value)})`).join(",")}])`;
    if ("const" in s) return `z.literal(${JSON.stringify(s.const)})`;
    const alternatives = s.anyOf ?? s.oneOf;
    if (Array.isArray(alternatives))
      return alternatives.length === 1
        ? expression(alternatives[0])
        : `z.union([${alternatives.map(expression).join(",")}])`;
    if (Array.isArray(s.allOf))
      return (s.allOf as unknown[]).map(expression).reduce((a, b) => `z.intersection(${a},${b})`);
    if (Array.isArray(s.type))
      return `z.union([${s.type.map((type) => expression({ ...s, type })).join(",")}])`;
    if (s.type === "null") return "z.null()";
    if (s.type === "boolean") return "z.boolean()";
    if (s.type === "string") return "z.string()";
    if (s.type === "number" || s.type === "integer")
      return `z.number()${s.type === "integer" ? ".int()" : ""}${typeof s.minimum === "number" ? `.min(${s.minimum})` : ""}${typeof s.maximum === "number" ? `.max(${s.maximum})` : ""}`;
    if (s.type === "array") return `z.array(${expression(s.items ?? true)})`;
    if (s.type === "object" || s.properties) {
      const required = new Set((s.required ?? []) as string[]),
        fields = Object.entries((s.properties ?? {}) as Record<string, unknown>).map(
          ([key, value]) =>
            `${JSON.stringify(key)}:${expression(value)}${required.has(key) ? "" : ".optional()"}`,
        );
      const suffix =
        s.additionalProperties === false
          ? ".strict()"
          : s.additionalProperties && typeof s.additionalProperties === "object"
            ? `.catchall(${expression(s.additionalProperties)})`
            : ".catchall(z.json())";
      return `z.object({${fields.join(",")}})${suffix}`;
    }
    if (Object.keys(s).every((key) => ["description", "title", "default"].includes(key)))
      return "z.json()";
    throw Error(`Unsupported native JSON Schema: ${JSON.stringify(s).slice(0, 400)}`);
  }
  const declarations = [...all]
    .map(
      ([name, schema]) =>
        `export const ${name}Schema: z.ZodType = z.lazy(() => ${expression(schema)});`,
    )
    .join("\n");
  await writeFile(
    join(output, "schemas.ts"),
    `// GENERATED from Codex 0.162.1 JSON Schema by test/codex/generate-protocol.ts.\nimport { z } from "zod";\n${declarations}\n`,
  );
  await writeFile(
    join(output, "index.ts"),
    `// GENERATED selected native contract closure; no runtime SDK.\n${names.map((name) => `export type {${name}} from "./${rootPaths.get(name)}.js";`).join("\n")}\n${[
      "Thread",
      "Turn",
      "ThreadItem",
      "ThreadSettings",
    ]
      .filter((name) => closure.has(`v2/${name}`))
      .map((name) => `export type {${name}} from "./v2/${name}.js";`)
      .join(
        "\n",
      )}\n${selected.map((match) => `import type { ${match[2]} } from "./v2/${match[2]}.js";`).join("\n")}\nexport type CodexNotification = ${selected.map((match) => `{method:${JSON.stringify(match[1])};params:${match[2]}}`).join(" | ")};\n`,
  );
  await writeFile(
    join(output, "provenance.json"),
    JSON.stringify(
      {
        nativeVersion: "0.162.1",
        generator: "test/codex/generate-protocol.ts",
        transformations: [
          "ESM .js import suffixes",
          "selected reachable type closure",
          "Zod codecs derived from pinned JSON Schema; descriptions omitted",
        ],
        sourceSha256: hashes,
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(join(output, "LICENSE"), await readFile(join(source, "source/LICENSE")));
  await writeFile(join(output, "NOTICE"), await readFile(join(source, "source/NOTICE")));
  console.log(
    `Generated ${closure.size} native type files and ${all.size} schema codecs for ${Object.keys(procedures).length} explicit procedures.`,
  );
}
await run(
  command({
    name: "codex-protocol",
    args: { source: option({ long: "source", type: string }) },
    handler: ({ source }) => generate(source),
  }),
  process.argv.slice(2),
);
