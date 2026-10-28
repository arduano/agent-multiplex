import { canonical, check, copy, id } from "../../v8-session/src/contracts/validation.js";
import type { Json } from "../../v8-session/src/contracts/types.js";
import type { CallbackOwner, CodexApproval, Field, Form, NativeAnswer, Prompt, RunRef } from "./contracts.js";

type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue { check(value && typeof value === "object" && !Array.isArray(value)); return value as RecordValue; }
function keys(value: RecordValue, allowed: readonly string[]): void { check(Object.keys(value).every(key => allowed.includes(key)), "Unsupported response field"); }
function text(value: unknown, max = 16384): string { check(typeof value === "string" && value.length <= max); return value; }
function strings(value: unknown, limit = 32): readonly string[] { check(Array.isArray(value) && value.length <= limit); const result = value.map(item => text(item, 4096)); check(new Set(result).size === result.length); return result; }
function optionalText(value: unknown): string | null { return value === undefined || value === null ? null : text(value); }
function numeric(value: unknown): number | undefined { if (value === undefined) return; check(typeof value === "number" && Number.isFinite(value)); return value; }
export function owner(value: CallbackOwner, run: RunRef): CallbackOwner {
  id(value.nativeAgent); check(value.relation === "root" || value.relation === "child");
  check(value.relation === "root" ? value.nativeAgent === run.nativeSession : value.nativeAgent !== run.nativeSession, "Unproved callback owner"); return copy(value);
}
/** Primitive MCP schema subset; future formats/nesting fail closed rather than silently dropping constraints. */
function form(value: unknown): Form {
  const schema = record(value); check(schema.type === "object"); keys(schema, ["type", "properties", "required", "$schema"]);
  const props = record(schema.properties), fields: Record<string, Field> = Object.create(null) as Record<string,Field>; check(Object.keys(props).length <= 32);
  for (const [name, raw] of Object.entries(props)) {
    id(name); const field = record(raw); check(["string", "number", "integer", "boolean", "array"].includes(field.type as string));
    keys(field, ["type", "title", "description", "default", "enum", "oneOf", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "items"]);
    check((field.enum===undefined&&field.oneOf===undefined)||field.type==="string");check((field.minLength===undefined&&field.maxLength===undefined)||field.type==="string");check((field.minimum===undefined&&field.maximum===undefined)||field.type==="number"||field.type==="integer");check((field.minItems===undefined&&field.maxItems===undefined&&field.items===undefined)||field.type==="array");
    let enumeration: readonly string[] | undefined;
    if (field.enum !== undefined) enumeration = strings(field.enum);
    if (field.oneOf !== undefined) { check(Array.isArray(field.oneOf) && field.oneOf.length <= 32 && enumeration === undefined); enumeration = field.oneOf.map(item => { const v = record(item); keys(v, ["const", "title"]); return text(v.const,4096); }); check(new Set(enumeration).size === enumeration.length, "Overlapping oneOf constants are unsupported"); }
    if (field.type === "array") { const items = record(field.items); keys(items, ["type", "enum", "anyOf"]); if (items.enum !== undefined) { check(items.type === "string"); enumeration = strings(items.enum); } else { check(Array.isArray(items.anyOf) && items.anyOf.length <= 32); enumeration = items.anyOf.map(item => {const v=record(item); keys(v,["const","title"]);return text(v.const,4096);}); } }
    const numbers = Object.fromEntries(["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"].flatMap(key => { const n = numeric(field[key]); return n === undefined ? [] : [[key,n]]; }));
    for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) if (numbers[key] !== undefined) check(Number.isSafeInteger(numbers[key]) && numbers[key]! >= 0);
    for (const [min,max] of [["minLength","maxLength"],["minimum","maximum"],["minItems","maxItems"]]) if (numbers[min!] !== undefined && numbers[max!] !== undefined) check(numbers[min!]! <= numbers[max!]!);
    fields[name] = { type: field.type as Field["type"], ...(field.title === undefined ? {} : {title:text(field.title)}), ...(field.description === undefined ? {} : {description:text(field.description)}), ...(enumeration ? { enum: enumeration } : {}), ...numbers };
  }
  const required = schema.required === undefined ? [] : strings(schema.required); check(required.every(key => Object.hasOwn(fields,key))); return copy({fields,required});
}
function elicitation(base: Omit<Prompt,"type">, harness: "codex" | "copilot", raw: RecordValue): Prompt {
  let mode: "form" | "url" | "unsupported" = raw.mode === "url" ? "url" : raw.mode === undefined || raw.mode === "form" ? "form" : "unsupported", parsed: Form | null = null;
  if (mode === "form") { try { parsed = form(raw.requestedSchema); } catch { mode = "unsupported"; } }
  const url = mode === "url" ? text(raw.url) : null;
  if (url !== null) { let u; try { u = new URL(url); } catch { check(false); } check(u.protocol === "https:" || u.protocol === "http:"); }
  return copy({ ...base, harness, type: harness === "codex" ? "codex.elicitation" : "copilot.elicitation", mode, message: text(raw.message ?? raw.description ?? "Native verification"), form: parsed, url, ...(mode === "unsupported" ? { unsupportedReason: "Native form or verification mode requires a dedicated renderer" } : {}) }) as Prompt;
}
export type CodexMethod = "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" | "item/permissions/requestApproval" | "item/tool/requestUserInput" | "mcpServer/elicitation/request";
export type CopilotMethod = "permission" | "userInput" | "elicitation" | "exitPlan";
/** Concrete methods only. No fall-through method-as-generic-approval behavior. */
export function normalizeCodex(run: RunRef, capabilityId: string, nativeRequestId: string, provedOwner: CallbackOwner, method: CodexMethod, payload: unknown): Prompt {
  canonical(payload,65536); id(capabilityId); id(nativeRequestId); const params=record(payload), owned=owner(provedOwner,run); check(params.threadId === owned.nativeAgent);
  const base = { id:capabilityId, run, nativeRequestId, owner:owned, title:"Native request" };
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    id(params.turnId);id(params.itemId);
    const available = method === "item/fileChange/requestApproval" ? ["accept","acceptForSession","decline","cancel"] : params.availableDecisions ?? ["accept","decline","cancel"];
    check(Array.isArray(available) && available.length > 0 && available.length <= 16);
    const decisions = available.map((decision,i) => {
      if (typeof decision === "string") check(["accept","acceptForSession","decline","cancel"].includes(decision));
      else { const d=record(decision); check(method === "item/commandExecution/requestApproval" && Object.keys(d).length === 1);
        if (d.acceptWithExecpolicyAmendment !== undefined) { const amendment=record(d.acceptWithExecpolicyAmendment); keys(amendment,["execpolicy_amendment"]); strings(amendment.execpolicy_amendment); }
        else { const a=record(d.applyNetworkPolicyAmendment),n=record(a.network_policy_amendment);keys(a,["network_policy_amendment"]);keys(n,["host","action"]);text(n.host);check(["allow","deny"].includes(n.action as string)); }
      }
      return {id:`decision:${i}`,label:typeof decision === "string" ? decision : Object.keys(decision)[0]!,decision:decision as Json};
    });
    check(new Set(decisions.map(d=>canonical(d.decision))).size === decisions.length);
    return copy({...base,harness:"codex",type:method === "item/fileChange/requestApproval"?"codex.file":"codex.command",title:method === "item/fileChange/requestApproval"?"Review file changes":"Review command",decisions,detail:params as Json}) as CodexApproval;
  }
  if (method === "item/permissions/requestApproval") {
    id(params.turnId); id(params.itemId); const permissions=record(params.permissions);keys(permissions,["network","fileSystem"]);
    if (permissions.network !== null && permissions.network !== undefined) {const n=record(permissions.network);keys(n,["enabled"]);check(n.enabled===null||typeof n.enabled==="boolean");}
    if (permissions.fileSystem !== null && permissions.fileSystem !== undefined) {
      const f=record(permissions.fileSystem);keys(f,["read","write","entries"]);
      for(const key of ["read","write"])if(f[key]!==null&&f[key]!==undefined)strings(f[key]);
      if(f.entries!==undefined){
        check(Array.isArray(f.entries)&&f.entries.length<=32);
        for(const raw of f.entries){
          const entry=record(raw);keys(entry,["path","access"]);check(["read","write","deny"].includes(entry.access as string));
          const path=record(entry.path);keys(path,["type","path"]);check(path.type==="path");check(text(path.path,4096).length>0&&!String(path.path).includes("\0"));
        }
      }
    }
    return copy({...base,harness:"codex",type:"codex.permission",title:"Review additional permissions",requested:permissions as Json,detail:params as Json});
  }
  if (method === "item/tool/requestUserInput") {
    id(params.turnId);id(params.itemId);check(typeof params.isBlocking === "boolean" && Array.isArray(params.questions) && params.questions.length > 0 && params.questions.length <= 8);
    const questions=params.questions.map(raw=>{
      const q=record(raw);id(q.id);check(typeof q.isOther==="boolean"&&typeof q.isSecret==="boolean");check(q.options===null||Array.isArray(q.options));
      const offered=q.options===null?[]:(q.options as unknown[]).map(raw=>{const option=record(raw);return {label:text(option.label,4096),...(typeof option.description==="string"?{description:text(option.description,4096)}:{})};});
      const options=offered.map(option=>option.label);check(options.length<=16&&new Set(options).size===options.length);
      // Optional presentation only. The original labels remain answer identity;
      // older Hosts truthfully provide no description rather than invented text.
      const descriptions=offered.filter(option=>option.description!==undefined).map(option=>[option.label,option.description!] as const);
      return{id:q.id,header:text(q.header),question:text(q.question),secret:q.isSecret,other:q.isOther,options,...(descriptions.length?{optionDescriptions:Object.fromEntries(descriptions)}:{})};
    });
    check(new Set(questions.map(q=>q.id)).size===questions.length);return copy({...base,harness:"codex",type:"codex.question",title:"Agent questions",questions,blocking:params.isBlocking});
  }
  check(method === "mcpServer/elicitation/request");text(params.serverName); return elicitation(base as Omit<Prompt,"type">,"codex",params);
}
export function normalizeCopilot(run: RunRef, capabilityId: string, nativeRequestId: string | null, provedOwner: CallbackOwner, method: CopilotMethod, payload: unknown): Prompt {
  canonical(payload,65536);id(capabilityId);if(nativeRequestId!==null)id(nativeRequestId);const owned=owner(provedOwner,run),raw=record(payload),base={id:capabilityId,run,nativeRequestId,owner:owned,title:"Native request"};
  if(method==="permission") {check(nativeRequestId!==null,"Permission SDK callback has no exact request identity; use native broadcast plus reply RPC");check(typeof raw.kind==="string");return copy({...base,harness:"copilot",type:"copilot.permission",title:"Review permission",request:raw as Json,managedApprovalRequired:raw.managedApprovalRequired===true});}
  if(method==="userInput") {const options=raw.choices===undefined?[]:strings(raw.choices,16);check(raw.allowFreeform===undefined||typeof raw.allowFreeform==="boolean");return copy({...base,harness:"copilot",type:"copilot.question",title:"Agent question",question:text(raw.question),options,freeform:raw.allowFreeform!==false});}
  if(method==="exitPlan") {const actions=strings(raw.actions,16);check(actions.length>0&&actions.includes(text(raw.recommendedAction)));return copy({...base,harness:"copilot",type:"copilot.plan",title:"Review plan",summary:text(raw.summary),plan:optionalText(raw.planContent),actions,recommendedAction:raw.recommendedAction as string});}
  check(method==="elicitation"); if(raw.sessionId!==undefined)check(raw.sessionId===run.nativeSession);return elicitation(base as Omit<Prompt,"type">,"copilot",raw);
}
/** Field-associated presentation of the same primitive constraints enforced at
 * native dispatch. Messages never contain submitted private values. */
export function formErrors(form: Form, value: unknown): Readonly<Record<string, string>> {
  const content=record(value);check(Object.keys(content).every(key=>Object.hasOwn(form.fields,key)));
  const errors: Record<string,string>=Object.create(null) as Record<string,string>;
  for(const key of form.required)if(!Object.hasOwn(content,key))errors[key]="This field is required.";
  for(const [key,v]of Object.entries(content)){const f=form.fields[key]!;
    if(f.type==="string"){
      if(typeof v!=="string")errors[key]="Enter text.";
      else if(f.minLength!==undefined&&v.length<f.minLength)errors[key]=`Enter at least ${f.minLength} characters.`;
      else if(f.maxLength!==undefined&&v.length>f.maxLength)errors[key]=`Use at most ${f.maxLength} characters.`;
      else if(f.enum&&!f.enum.includes(v))errors[key]="Choose an offered value.";
    }else if(f.type==="boolean"){if(typeof v!=="boolean")errors[key]="Choose true or false.";}
    else if(f.type==="array"){
      if(!Array.isArray(v)||!v.every(x=>typeof x==="string"&&f.enum?.includes(x))||new Set(v).size!==v.length)errors[key]="Choose only the offered values, without duplicates.";
      else if(f.minItems!==undefined&&v.length<f.minItems)errors[key]=`Choose at least ${f.minItems} values.`;
      else if(f.maxItems!==undefined&&v.length>f.maxItems)errors[key]=`Choose at most ${f.maxItems} values.`;
    }else if(typeof v!=="number"||!Number.isFinite(v)||(f.type==="integer"&&!Number.isInteger(v)))errors[key]=f.type==="integer"?"Enter a whole number.":"Enter a number.";
    else if(f.minimum!==undefined&&v<f.minimum)errors[key]=`Enter ${f.minimum} or more.`;
    else if(f.maximum!==undefined&&v>f.maximum)errors[key]=`Enter ${f.maximum} or less.`;
  }
  return Object.freeze(errors);
}
function validateForm(form: Form, value: unknown): Readonly<Record<string, Json>> {
  check(Object.keys(formErrors(form,value)).length===0);
  return value as Record<string,Json>;
}
/** Both UI and native owner run this validation. Caller values never become broad native decisions. */
export function encodeAnswer(prompt: Prompt, value: NativeAnswer): Readonly<{choice:string;value:Json}> {
  canonical(value,16384);const answer=record(value);check(answer.type===prompt.type,"Wrong native interaction response");let result: Json,choice: string;
  switch(prompt.type){
    case "codex.command":case "codex.file":{keys(answer,["type","decisionId"]);const decision=prompt.decisions.find(x=>x.id===answer.decisionId);check(decision);choice=decision.id;result={decision:decision.decision};break;}
    case "codex.permission":{keys(answer,["type","grant"]);check(["deny","turn","session"].includes(answer.grant as string));choice=answer.grant as string;const requested=record(prompt.requested),permissions=Object.fromEntries(Object.entries(requested).filter(([,v])=>v!==null));result={permissions:answer.grant==="deny"?{}:permissions as Json,scope:answer.grant==="session"?"session":"turn"};break;}
    case "codex.question": {
      keys(answer,["type","answers"]); const answers=record(answer.answers);
      check(Object.keys(answers).length===prompt.questions.length&&Object.keys(answers).every(k=>prompt.questions.some(q=>q.id===k)));
      const native:Record<string,Json>=Object.create(null) as Record<string,Json>;
      for (const q of prompt.questions) {
        const raw=answers[q.id]; check(Array.isArray(raw)&&raw.length>0&&raw.length<=16);
        // Answer positions are ordered native values, not a set: the chosen
        // label and its extra context can contain identical strings.
        const values=raw.map(value=>text(value,4096));
        const offered=values.every(value=>q.options.includes(value));
        const withContext=values.length===2&&q.options.includes(values[0]!)&&!!values[1]!.trim();
        check(q.other||q.options.length===0||offered||withContext);
        native[q.id]={answers:values};
      }
      choice="submit"; result={answers:native}; break;
    }
    case "copilot.permission":{keys(answer,["type","kind","feedback"]);check(["approve-once","reject","user-not-available"].includes(answer.kind as string));check(answer.feedback===undefined||answer.kind==="reject");choice=answer.kind as string;result={kind:choice,...(choice==="approve-once"?{approvedInteractively:true}:{}),...(answer.feedback===undefined?{}:{feedback:text(answer.feedback)})};break;}
    case "copilot.question":{keys(answer,["type","answer","wasFreeform"]);const a=text(answer.answer);check(typeof answer.wasFreeform==="boolean"&&(answer.wasFreeform?prompt.freeform:prompt.options.includes(a)));choice="submit";result={answer:a,wasFreeform:answer.wasFreeform};break;}
    case "copilot.plan":{keys(answer,["type","approved","selectedAction","feedback"]);check(typeof answer.approved==="boolean");if(answer.selectedAction!==undefined)check(prompt.actions.includes(text(answer.selectedAction)));check(!answer.approved||answer.selectedAction!==undefined,"Approval needs an offered action");choice=answer.approved?"approve":"reject";result={approved:answer.approved,...(answer.selectedAction===undefined?{}:{selectedAction:answer.selectedAction as string}),...(answer.feedback===undefined?{}:{feedback:text(answer.feedback)})};break;}
    case "codex.elicitation":case "copilot.elicitation":{keys(answer,["type","action","content"]);check(["accept","decline","cancel"].includes(answer.action as string));choice=answer.action as string;check(choice==="accept"||answer.content===undefined,"Decline/cancel cannot carry submitted content");let content:Readonly<Record<string,Json>>|undefined;if(choice==="accept"){check(prompt.mode!=="unsupported","Unsupported native schema cannot accept");if(prompt.mode==="form"){check(prompt.form);content=validateForm(prompt.form,answer.content);}else check(answer.content===undefined);}
      result=prompt.harness==="codex"?{action:choice,content:content??null,_meta:null}:{action:choice,...(content===undefined?{}:{content})};break;}
  }
  return copy({choice,value:result});
}
export function choices(prompt: Prompt): readonly string[] {switch(prompt.type){case"codex.command":case"codex.file":return prompt.decisions.map(d=>d.id);case"codex.permission":return["deny","turn","session"];case"codex.question":case"copilot.question":return["submit"];case"copilot.permission":return["approve-once","reject","user-not-available"];case"copilot.plan":return["approve","reject"];case"codex.elicitation":case"copilot.elicitation":return prompt.mode==="unsupported"?["decline","cancel"]:["accept","decline","cancel"];}}
