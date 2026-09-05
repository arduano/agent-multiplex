import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  newRuntimeNodeId, newRuntimeNodeBootId, newSessionId, newRuntimeEpoch,
  newCommandId, newArchiveOperationId, newAuthorityEpochId, newControlNodeId, newRealmId, emptyMetadataSnapshot,
  type ImageTarget, type AdapterScopeId,
} from "@arduano/agent-multiplex-protocol";
import { RuntimeImages, readConfinedImage } from "../packages/runtime-node-core/src/images.js";
import { RuntimeNodeStore } from "../packages/runtime-node-core/src/store.js";
import { RuntimeNodeService } from "../packages/runtime-node-core/src/service.js";
import type { AgentAdapter, AdapterSession, AdapterEvent, NativeImageCodec } from "../packages/runtime-node-core/src/adapter.js";

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC2cAAAAASUVORK5CYII=', 'base64');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const releases: (() => Promise<void>)[] = [];
afterEach(async () => { for (const release of releases.splice(0)) await release(); });
function fixture(maximumSessionBytes?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'multiplex-image-test-'));
  const store = new RuntimeNodeStore(join(directory, 'runtime.sqlite'));
  const target: ImageTarget = { runtimeNodeId: newRuntimeNodeId(), runtimeNodeBootId: newRuntimeNodeBootId(), sessionId: newSessionId(), bindingRevision: 1 };
  const images = new RuntimeImages(store, target.runtimeNodeId, maximumSessionBytes === undefined ? {} : { maximumSessionBytes });
  releases.push(async () => { await images.close(); store.close(); rmSync(directory, { recursive:true, force:true }); });
  const input = { ...target, imageId: randomUUID(), byteLength: png.length, sha256: sha(png), mediaType: 'image/png' as const };
  return { directory, store, target, images, input };
}

describe('runtime-owned images', () => {
  it('uploads with retry-stable chunks, checksum validation, ownership fencing and private permissions', async () => {
    const { images, input, target, directory } = fixture();
    await images.begin(input);
    expect(await images.begin(input)).toMatchObject({ receivedBytes: 0 });
    const chunk = { ...input, offset: 0, dataBase64: png.toString('base64') };
    await images.write(chunk);
    await images.write(chunk);
    await expect(images.write({ ...chunk, dataBase64: Buffer.alloc(png.length, 1).toString('base64') })).rejects.toThrow('differs');
    const descriptor = await images.commit(input);
    expect(await images.commit(input)).toEqual(descriptor);
    expect((await images.read({ ...input, offset: 0, length: 12 })).dataBase64).toBe(png.subarray(0, 12).toString('base64'));
    expect(statSync(join(directory, 'runtime.sqlite.images', `${input.imageId}.blob`)).mode & 0o777).toBe(0o600);
    await expect(images.read({ ...input, sessionId: newSessionId(), offset: 0, length: 10 })).rejects.toMatchObject({ code:'FENCED' });
    await expect(images.abort(input)).rejects.toThrow('remain until session archive');
    await images.releaseSession(target.sessionId);
    await images.releaseSession(target.sessionId);
    await expect(images.read({ ...input, offset:0, length: 10 })).rejects.toMatchObject({ code:'NOT_FOUND' });
  });

  it('reserves quota for unfinished bytes and validates canonical base64 and hashes', async () => {
    const { images, input } = fixture(png.length);
    await images.begin(input);
    await expect(images.begin({ ...input, imageId: randomUUID() })).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
    await expect(images.write({ ...input, offset: 0, dataBase64: 'AB==' })).rejects.toThrow();
    await images.write({ ...input, offset: 0, dataBase64: Buffer.alloc(png.length).toString('base64') });
    await expect(images.commit(input)).rejects.toThrow('checksum');
    await images.abort(input);
    await images.begin({ ...input, imageId: randomUUID() });
  });

  it('uses bounded chunks for images larger than the native envelope', async () => {
    const { images, input } = fixture();
    const bytes = Buffer.concat([png, Buffer.alloc(2 * 1_024 * 1_024)]);
    const upload = { ...input, byteLength: bytes.length, sha256: sha(bytes) };
    await images.begin(upload);
    for (let offset = 0; offset < bytes.length; offset += 256 * 1_024) {
      await images.write({ ...upload, offset, dataBase64: bytes.subarray(offset, offset + 256 * 1_024).toString('base64') });
    }
    const image = await images.commit(upload);
    expect(JSON.stringify(image).length).toBeLessThan(512);
    await expect(images.begin({ ...upload, imageId:randomUUID(), byteLength:10 * 1_024 * 1_024 + 1 })).rejects.toThrow();
  });

  it('expires unfinished uploads without deleting committed image bytes', async () => {
    const { images, store, input } = fixture();
    await images.begin(input);
    const expired = store.getImage(input.imageId)!;
    store.putImage({ ...expired, updatedAt:Date.now() - 86_400_001 });
    await images.begin({ ...input, imageId:randomUUID() });
    expect(store.getImage(input.imageId)).toBeUndefined();
  });

  it('rolls back the image migration when an old native journal payload exceeds the new bound', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'multiplex-image-migration-'));
    const filename = join(directory, 'runtime.sqlite');
    const initial = new RuntimeNodeStore(filename); initial.close();
    const old = new DatabaseSync(filename);
    const large = JSON.stringify({ result:'x'.repeat(1_024 * 1_024) });
    old.exec("DROP TABLE images; DELETE FROM schema_migrations WHERE version=5; PRAGMA user_version=4;");
    old.prepare("INSERT INTO command_journal(command_id,payload_hash,record_json,updated_at) VALUES (?,?,?,?)")
      .run(newCommandId(), 'migration-payload-hash', large, new Date().toISOString());
    old.close();
    try {
      expect(() => new RuntimeNodeStore(filename)).toThrow('protocol-v5 migration refused');
      const preserved = new DatabaseSync(filename);
      try {
        expect(preserved.prepare('PRAGMA user_version').get()).toEqual({ user_version:4 });
        expect(preserved.prepare('SELECT record_json FROM command_journal').get()).toEqual({ record_json:large });
        expect(preserved.prepare("SELECT name FROM sqlite_schema WHERE name='images'").get()).toBeUndefined();
      } finally { preserved.close(); }
    } finally { rmSync(directory, { recursive:true, force:true }); }
  });

  it('retains committed image bytes across runtime store restarts', async () => {
    const { directory, store, images, input } = fixture();
    await images.begin(input);
    await images.write({ ...input, offset: 0, dataBase64: png.toString('base64') });
    const descriptor = await images.commit(input);
    await images.close(); store.close();
    const reopened = new RuntimeNodeStore(join(directory, 'runtime.sqlite'));
    const second = new RuntimeImages(reopened, input.runtimeNodeId);
    try {
      expect((await second.read({ ...input, offset: 0, length: png.length })).image).toEqual(descriptor);
    } finally { await second.close(); reopened.close(); }
  });

  it('uses the opened file identity, excludes symlink escapes and special files', async () => {
    const { directory } = fixture();
    const workspace = join(directory, 'workspace'); mkdirSync(workspace);
    const outside = join(directory, 'outside.png'); writeFileSync(outside, png);
    const inside = join(workspace, 'inside.png'); writeFileSync(inside, png);
    symlinkSync(outside, join(workspace, 'escape.png'));
    expect(await readConfinedImage(inside, [workspace])).toEqual(png);
    await expect(readConfinedImage(join(workspace, 'escape.png'), [workspace])).rejects.toMatchObject({ code: 'FENCED' });
    await expect(readConfinedImage('/dev/null', ['/dev'])).rejects.toMatchObject({ code: 'FENCED' });
  });

  it('snapshots a native source once and forbids custom backend host fallback', async () => {
    const { directory, images, target } = fixture();
    const imagePath = join(directory, 'native.png'); writeFileSync(imagePath, png);
    const session = storedSession(target, directory);
    const backend = { backendId: 'custom' as any, adapter: { harness:'codex', adapterScopeId: session.adapterScopeId } as AgentAdapter };
    await expect(images.snapshot(target, 'source', imagePath, session, backend, false)).rejects.toMatchObject({ code:'UNSUPPORTED' });
    const first = await images.snapshot(target, 'source', imagePath, session, backend, true);
    writeFileSync(imagePath, 'replaced');
    expect(await images.snapshot(target, 'source', imagePath, session, backend, true)).toEqual(first);
    expect((await images.read({ ...target, imageId:first.imageId, offset:0, length:png.length })).dataBase64).toBe(png.toString('base64'));
  });

  it('resolves relative image paths under the workspace and rejects escapes and URLs', async () => {
    const { directory, images, target, input } = fixture();
    const workspace = join(directory, 'workspace'); mkdirSync(workspace);
    writeFileSync(join(workspace, 'native.png'), png);
    writeFileSync(join(directory, 'outside.png'), png);
    symlinkSync(join(directory, 'outside.png'), join(workspace, 'escape.png'));
    const session = storedSession(target, workspace);
    const backend = { backendId: 'direct' as any, adapter: { harness:'codex', adapterScopeId:session.adapterScopeId } as AgentAdapter };
    const relative = await images.snapshot(target, 'relative', './native.png', session, backend, true);
    expect(relative.sha256).toBe(sha(png));
    for (const path of ['../outside.png', 'escape.png', 'https://example.com/native.png', 'file:///tmp/native.png', '//example.com/native.png', 'folder\\native.png', 'native\n.png']) {
      await expect(images.snapshot(target, path, path, session, backend, true)).rejects.toMatchObject({ code:'FENCED' });
    }
    await images.begin(input);
    await images.write({ ...input, offset:0, dataBase64:png.toString('base64') });
    await images.commit(input);
    await expect(images.snapshot(target, 'private-store', join(directory, 'runtime.sqlite.images', `${input.imageId}.blob`), storedSession(target, directory), backend, true)).rejects.toMatchObject({ code:'FENCED' });

    const readImageFile = vi.fn(async () => png);
    await expect(images.snapshot(target, 'custom-url', 'https://example.com/native.png', session, { ...backend, readImageFile }, false)).rejects.toMatchObject({ code:'FENCED' });
    expect(readImageFile).not.toHaveBeenCalled();
    await images.snapshot(target, 'custom-relative', 'native.png', session, { ...backend, readImageFile }, false);
    expect(readImageFile).toHaveBeenCalledWith({ session, path:join(workspace, 'native.png'), maximumBytes:10 * 1_024 * 1_024 });
  });

  it('reconstructs command images only at adapter dispatch and externalizes history before it reaches the wire', async () => {
    const { directory, store, target, input } = fixture();
    const executed = vi.fn(async () => ({ result:png.toString('base64') }));
    let emit!: (event: AdapterEvent) => void;
    const native: AdapterSession = { harness:'codex', adapterScopeId:'images:fake' as AdapterScopeId, vendorSessionId:'native-images', cwd:directory, runtimeEpoch:newRuntimeEpoch(), status:()=> 'idle', subscribe:(listener)=>{ emit=listener; return ()=>{}; }, execute:executed, stop:async()=>{}, readNativeHistory:async()=>({ harness:'codex', vendorSessionId:'native-images', payload:{ result:png.toString('base64') }, complete:true }) };
    let extractionGate: Promise<void> | undefined;
    let extractionStarted: (() => void) | undefined;
    const codec: NativeImageCodec = { acceptsCommandImage: (_request, slot) => slot.pointer === '/command/input/0/image_url', externalize: async (payload, sink) => {
      if (payload && !Array.isArray(payload) && typeof payload === 'object' && typeof payload.result === 'string') {
        extractionStarted?.();
        await extractionGate;
        return { encoding:'native-json-images-v1', json:{ result:null }, images:[{ pointer:'/result', representation:'base64', image:await sink.storeBase64({ dataBase64:payload.result, mediaType:'image/png' }) }] };
      }
      return { encoding:'native-json-images-v1', json:payload, images:[] };
    } };
    const adapter: AgentAdapter = { harness:'codex', adapterScopeId:native.adapterScopeId, imageCodec:codec, describe:async()=>({ harness:'codex', adapterScopeId:native.adapterScopeId, available:true, capabilities:[] }), listModels:async()=>[], listSessions:async()=>[], spawn:async()=>native, resume:async()=>native, close:async()=>{} };
    store.putSession(storedSession(target, directory));
    const service = new RuntimeNodeService({ store, runtimeNodeId:target.runtimeNodeId, runtimeNodeBootId:target.runtimeNodeBootId, allowedRoots:[directory], name:'images', adapters:[adapter] });
    try {
      await service.beginImageUpload(input); await service.writeImageUpload({ ...input, offset:0, dataBase64:png.toString('base64') });
      const image = await service.commitImageUpload(input);
      await expect(service.readImage({ ...input, runtimeNodeBootId:newRuntimeNodeBootId(), offset:0, length:10 })).rejects.toMatchObject({ code:'FENCED' });
      await service.resume({ operation:'resume', commandId:newCommandId(), payloadHash:'images-resume-command', ...target });
      const command = { commandId:newCommandId(), payloadHash:'images-send-command', ...target, request:{ harness:'codex' as const, command:{ type:'send' as const, input:[{ type:'image', image_url:null }] } }, images:[{ pointer:'/command/input/0/image_url', representation:'dataUrl' as const, image }] };
      const result = await service.execute(command);
      expect(result.state).toBe('succeeded');
      expect(result.result?.images).toHaveLength(1);
      expect(executed).toHaveBeenCalledWith(expect.objectContaining({ command:expect.objectContaining({ input:[{ type:'image', image_url:`data:image/png;base64,${png.toString('base64')}` }] }) }));
      expect(JSON.stringify(store.getCommand(command.commandId))).not.toContain(png.toString('base64'));
      const disallowed = await service.execute({ ...command, commandId:newCommandId(), payloadHash:'images-disallowed-pointer', request:{ harness:'codex', command:{ type:'send', input:[{ type:'text', text:null }] } }, images:[{ ...command.images[0]!, pointer:'/command/input/0/text' }] });
      expect(disallowed).toMatchObject({ state:'failed', error:expect.stringContaining('allowlist') });
      const oversized = await service.execute({ ...command, commandId:newCommandId(), payloadHash:'images-oversized-total', images:Array.from({ length:6 }, (_, index) => ({ ...command.images[0]!, pointer:`/command/input/${index}/image_url`, image:{ ...image, byteLength:10 * 1_024 * 1_024 } })) });
      expect(oversized).toMatchObject({ state:'failed', error:expect.stringContaining('50 MiB') });
      expect(executed).toHaveBeenCalledTimes(1);
      const inherited = { image:null };
      const marker = 'multiplexImageCommandPrototypeSentinel';
      Object.defineProperty(Object.prototype, marker, { value:inherited, configurable:true });
      const changedSlot = { ...command.images[0]! };
      const getBytes = RuntimeImages.prototype.getBytes;
      const read = vi.spyOn(RuntimeImages.prototype, 'getBytes').mockImplementationOnce(async function (target, descriptor) {
        const bytes = await getBytes.call(this, target, descriptor);
        changedSlot.pointer = `/command/input/0/${marker}/image`;
        return bytes;
      });
      try {
        const rejected = await service.execute({ ...command, commandId:newCommandId(), payloadHash:'images-inherited-parent', images:[changedSlot] });
        expect(rejected).toMatchObject({ state:'failed', error:expect.stringContaining('pointer is unsafe') });
        expect(inherited.image).toBeNull();
        expect(executed).toHaveBeenCalledTimes(1);
      } finally { read.mockRestore(); Reflect.deleteProperty(Object.prototype, marker); }
      const history = await service.readNativeHistory(target.sessionId, { harness:'codex', includeTurns:true, limit:100 });
      expect(history.payload.json).toEqual({ result:null }); expect(history.payload.images).toHaveLength(1);
      expect(JSON.stringify(history)).not.toContain(png.toString('base64'));
      const started = new Promise<void>((done) => { extractionStarted=done; });
      let unblock!: () => void;
      extractionGate = new Promise<void>((done) => { unblock=done; });
      emit({ kind:'native', nativeType:'image-output', payload:{ result:png.toString('base64') }, ephemeral:false });
      emit({ kind:'interaction', requestType:'approval', payload:{ result:png.toString('base64') }, ephemeral:false, resolve:async()=>{} });
      await started;
      let closed=false;
      const closing=service.close().then(()=>{ closed=true; });
      await Promise.resolve(); expect(closed).toBe(false);
      unblock(); await closing;
      const cancellation=new AbortController();
      const events=service.events({ native:{} }, cancellation.signal)[Symbol.asyncIterator]();
      try {
        let observed=false;
        for (let index=0;index<5;index++) {
          const event=await events.next();
          if (event.value?.kind==='native') {
            expect(event.value.payload.images).toHaveLength(1);
            expect(JSON.stringify(event.value)).not.toContain(png.toString('base64'));
            observed=true; break;
          }
        }
        expect(observed).toBe(true);
      } finally { cancellation.abort(); }
      await expect(service.readImage({ ...input, offset:0, length:png.length })).rejects.toMatchObject({ code:'FENCED' });
    } finally { await service.close(); }
  });

  it('drains a stopped session image extraction before archive without waiting for another session', async () => {
    const { directory, store, target } = fixture();
    const otherTarget = { ...target, sessionId:newSessionId() };
    const authority = { realmId:newRealmId(), controlNodeId:newControlNodeId(), epochId:newAuthorityEpochId() };
    const first = { ...storedSession(target, directory), metadataAuthority:authority };
    const other = { ...storedSession(otherTarget, directory), vendorSessionId:'native-images-other', metadataAuthority:authority };
    const emitters = new Map<string, (event:AdapterEvent) => void>();
    const native = (record:typeof first): AdapterSession => ({ harness:'codex', adapterScopeId:record.adapterScopeId, vendorSessionId:record.vendorSessionId, cwd:directory, runtimeEpoch:newRuntimeEpoch(), status:()=> 'idle', subscribe:(listener)=>{ emitters.set(record.vendorSessionId, listener); return ()=>{}; }, execute:async()=>null, stop:async()=>{}, readNativeHistory:async()=>({ harness:'codex', vendorSessionId:record.vendorSessionId, payload:null }) });
    let releaseFirst!: () => void; let releaseOther!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst=resolve; });
    const otherGate = new Promise<void>((resolve) => { releaseOther=resolve; });
    const started = new Set<string>();
    const imageCodec:NativeImageCodec = { externalize:async (payload, sink) => {
      if (payload === 'first' || payload === 'other') {
        started.add(payload);
        await (payload === 'first' ? firstGate : otherGate);
        return { encoding:'native-json-images-v1', json:{ image:null }, images:[{ pointer:'/image', representation:'base64', image:await sink.storeBase64({ dataBase64:png.toString('base64'), mediaType:'image/png' }) }] };
      }
      return { encoding:'native-json-images-v1', json:payload, images:[] };
    } };
    const adapter:AgentAdapter = { harness:'codex', adapterScopeId:first.adapterScopeId, imageCodec, describe:async()=>({ harness:'codex', adapterScopeId:first.adapterScopeId, available:true, capabilities:[] }), listModels:async()=>[], listSessions:async()=>[], spawn:async()=>native(first), resume:async (request)=>native(request.vendorSessionId === first.vendorSessionId ? first : other), close:async()=>{} };
    store.putSession(first); store.putSession(other);
    const service = new RuntimeNodeService({ store, runtimeNodeId:target.runtimeNodeId, runtimeNodeBootId:target.runtimeNodeBootId, allowedRoots:[directory], name:'archive images', adapters:[adapter] });
    try {
      await service.resume({ operation:'resume', commandId:newCommandId(), payloadHash:'archive-images-first-resume', ...target });
      await service.resume({ operation:'resume', commandId:newCommandId(), payloadHash:'archive-images-other-resume', ...otherTarget });
      emitters.get(first.vendorSessionId)!({ kind:'native', nativeType:'image-output', payload:'first', ephemeral:false });
      emitters.get(other.vendorSessionId)!({ kind:'native', nativeType:'image-output', payload:'other', ephemeral:false });
      await vi.waitFor(() => expect(started.size).toBe(2));
      await service.stop({ operation:'stop', commandId:newCommandId(), payloadHash:'archive-images-first-stop', ...target });
      const archiveOperationId = newArchiveOperationId();
      service.archive({ archiveOperationId, payloadHash:'archive-images-first-archive', sessionId:target.sessionId, runtimeNodeId:target.runtimeNodeId, bindingRevision:target.bindingRevision, expectedAuthority:authority });
      await vi.waitFor(() => expect(service.getArchive(archiveOperationId)?.state).toBe('releasing'));
      const lateResolve = service.resolveImagePath({ ...target, sourceKey:'after-archive', path:'native.png' });
      void lateResolve.catch(() => undefined);
      releaseFirst();
      await vi.waitFor(() => expect(service.getArchive(archiveOperationId)?.state).toBe('succeeded'));
      await expect(lateResolve).rejects.toMatchObject({ code:'NOT_FOUND' });
      expect(store.listImages(target.sessionId)).toEqual([]);
      expect(store.getSession(target.sessionId)).toBeUndefined();
      await expect(service.beginImageUpload({ ...target, imageId:randomUUID(), mediaType:'image/png', sha256:sha(png), byteLength:png.length })).rejects.toMatchObject({ code:'NOT_FOUND' });
      releaseOther();
      await vi.waitFor(() => expect(store.listImages(otherTarget.sessionId).filter((entry) => entry.committed)).toHaveLength(1));
    } finally { releaseFirst(); releaseOther(); await service.close(); }
  });

  it('preserves the latest settings and terminal status after a full image queue drains', async () => {
    const queue = eventQueueFixture();
    const { service, store, target, emit, extracted, started, release } = queue;
    await service.resume({ operation:'resume', commandId:newCommandId(), payloadHash:'overflow-status-resume', ...target });
    emit({ kind:'native', nativeType:'slow-image', payload:'slow', ephemeral:false });
    await started;
    emit({ kind:'native', nativeType:'admitted-image', payload:'admitted', ephemeral:false });
    for (let index=0;index<1_000;index++) {
      emit({ kind:'native', nativeType:'discarded-image', payload:`discarded-${index}`, ephemeral:false });
      emit({ kind:'settings', settings:{ model:`model-${index}` } });
      emit({ kind:'status', status:'running' });
    }
    emit({ kind:'status', status:'stopped' });
    // A terminated native binding cannot be resurrected by a later callback.
    emit({ kind:'status', status:'idle' });
    expect(store.getSession(target.sessionId)?.runtimeStatus).toBe('idle');
    release();
    await vi.waitFor(() => expect(store.getSession(target.sessionId)).toMatchObject({ availability:'resumable', runtimeStatus:'stopped', runtimeEpoch:null, harnessSettings:{ model:'model-999' } }));
    expect(extracted).toEqual(['slow', 'admitted']);
    expect((await service.execute({ commandId:newCommandId(), payloadHash:'overflow-stopped-command', ...target, request:{ harness:'codex', command:{ type:'send', input:'stale command' } } })).state).toBe('failed');
  });

  it('retains settlements for pending and queued interactions while rejecting excess image payloads', async () => {
    const queue = eventQueueFixture();
    const { service, store, target, emit, extracted, started, release } = queue;
    await service.resume({ operation:'resume', commandId:newCommandId(), payloadHash:'overflow-interaction-resume', ...target });
    emit({ kind:'interaction', nativeRequestId:'existing-request', requestType:'approval', payload:'existing', ephemeral:false, resolve:async()=>{} });
    await vi.waitFor(() => expect(service.listInteractions(target.sessionId)).toHaveLength(1));
    emit({ kind:'native', nativeType:'slow-image', payload:'slow', ephemeral:false });
    await started;
    emit({ kind:'interaction', nativeRequestId:'queued-request', requestType:'approval', payload:'queued', ephemeral:false, resolve:async()=>{} });
    emit({ kind:'native', nativeType:'overflow', payload:'discarded', ephemeral:false });
    for (let index=0;index<1_000;index++) {
      emit({ kind:'interactionSettled', nativeRequestId:`unknown-${index}`, state:'stale' });
      emit({ kind:'interactionSettled', nativeRequestId:'existing-request', state:'stale' });
      emit({ kind:'interactionSettled', nativeRequestId:'queued-request', state:'expired' });
    }
    expect(service.listInteractions(target.sessionId)).toHaveLength(1);
    const observed: { id:string | undefined; state:string }[] = [];
    const cancellation = new AbortController();
    const stream = (async () => {
      for await (const event of service.events({ native:{} }, cancellation.signal)) {
        if (event.kind==='control' && event.change.type==='interaction.changed') observed.push({ id:event.change.interaction.nativeRequestId, state:event.change.interaction.state });
      }
    })();
    try {
      release();
      await vi.waitFor(() => expect(observed).toEqual([
        { id:'existing-request', state:'pending' },
        { id:'queued-request', state:'pending' },
        { id:'existing-request', state:'stale' },
        { id:'queued-request', state:'expired' },
      ]));
      expect(service.listInteractions(target.sessionId)).toEqual([]);
      expect(extracted).toEqual(['existing','slow','queued']);
      emit({ kind:'native', nativeType:'after-overflow', payload:'recovered', ephemeral:false });
      emit({ kind:'status', status:'running' });
      await vi.waitFor(() => expect(store.getSession(target.sessionId)?.runtimeStatus).toBe('running'));
      expect(extracted).toEqual(['existing','slow','queued','recovered']);
    } finally { cancellation.abort(); await stream; }
  });
});

function storedSession(target: ImageTarget, cwd: string) {
  const timestamp = new Date().toISOString();
  return { sessionId:target.sessionId, runtimeNodeId:target.runtimeNodeId, bindingRevision:target.bindingRevision, harness:'codex' as const, adapterScopeId:'images:fake' as AdapterScopeId, vendorSessionId:'native-images', runtimeEpoch:null, cwd, availability:'resumable' as const, runtimeStatus:'stopped' as const, launchProvenance:null, metadata:emptyMetadataSnapshot(), createdAt:timestamp, updatedAt:timestamp, lastSeenAt:timestamp, lastActivityAt:timestamp };
}

function eventQueueFixture() {
  const { directory, store, target } = fixture();
  let emit!: (event:AdapterEvent) => void;
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release=resolve; });
  const started = new Promise<void>((resolve) => { markStarted=resolve; });
  const extracted:unknown[] = [];
  const native:AdapterSession = { harness:'codex', adapterScopeId:'images:fake' as AdapterScopeId, vendorSessionId:'native-images', cwd:directory, runtimeEpoch:newRuntimeEpoch(), status:()=> 'idle', subscribe:(listener)=>{ emit=listener; return ()=>{}; }, execute:async()=>null, stop:async()=>{}, readNativeHistory:async()=>({ harness:'codex', vendorSessionId:'native-images', payload:null }) };
  const imageCodec:NativeImageCodec = { externalize:async (payload) => {
    if (typeof payload === 'string') extracted.push(payload);
    if (payload==='slow') { markStarted(); await gate; }
    return { encoding:'native-json-images-v1', json:payload, images:[] };
  } };
  const adapter:AgentAdapter = { harness:'codex', adapterScopeId:native.adapterScopeId, imageCodec, describe:async()=>({ harness:'codex', adapterScopeId:native.adapterScopeId, available:true, capabilities:[] }), listModels:async()=>[], listSessions:async()=>[], spawn:async()=>native, resume:async()=>native, close:async()=>{} };
  store.putSession(storedSession(target,directory));
  const service = new RuntimeNodeService({ store, runtimeNodeId:target.runtimeNodeId, runtimeNodeBootId:target.runtimeNodeBootId, adapters:[adapter], allowedRoots:[directory], name:'image overflow', nativeEventQueueLimit:2 });
  // Close before the fixture-owned SQLite connection and image directory.
  releases.unshift(async () => { release(); await service.close(); });
  return { service, store, target, emit:(event:AdapterEvent)=>emit(event), extracted, started, release };
}
