import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { initTRPC, type AnyRouter } from '@trpc/server';
import { createP2PNode, createSharedSecretSecurity, verifyPinnedSignedTicket, type P2PNode, type PeerContext } from '@arduano/p2prpc-core';
import { peerFileMetadataSchema, type PeerFileMetadata } from '../src/node/peer-files.js';

/** Exactly two fresh published endpoints. This fixture's own signed loopback
 * locator avoids public discovery, relays and all existing nodes. */
export async function ownedPeerFixture<Router extends AnyRouter>(options: Readonly<{
  router: Router;
  context(context: PeerContext<PeerFileMetadata>, host: P2PNode<Router, PeerFileMetadata>, allowed: ReadonlySet<string>): Promise<unknown>;
}>) {
  const secret = randomBytes(32), keyBytes = randomBytes(32), nodes: P2PNode<any, PeerFileMetadata>[] = [], allowed = new Set<string>();
  const protocol = { applicationId: 'multiplex-v8-direct-host-qualification', contractVersion: '1' };
  const iroh = { bindAddress: '127.0.0.1:0', relay: { mode: 'disabled' as const }, discovery: { dns: false, mdns: false },
    allowAdvertisedAddress: (address: string) => address.startsWith('127.0.0.1:'), allowDirectAddress: (address: string) => address.startsWith('127.0.0.1:'), allowRelayUrl: () => false };
  const close = async () => { const results = await Promise.allSettled(nodes.map(node => node.close())); if (results.some(value => value.status === 'rejected')) throw new AggregateError(results, 'Owned endpoint cleanup failed'); };
  try {
    const reservation = createSocket('udp4');
    await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.bind(0, '127.0.0.1', resolve); });
    const address = `127.0.0.1:${reservation.address().port}`;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const open = async (router: Router) => {
      const node: P2PNode<Router, PeerFileMetadata> = await createP2PNode<Router, PeerFileMetadata>({ router, protocol,
        security: createSharedSecretSecurity(secret, { authorize: () => true }), fileMetadataSchema: peerFileMetadataSchema,
        iroh: { ...iroh, secretKey: keyBytes, bindAddress: address }, createContext: async ctx => options.context(ctx, node, allowed) as any });
      nodes.push(node); return node;
    };
    let host = await open(options.router);
    const router = initTRPC.context<PeerContext<PeerFileMetadata>>().create().router({});
    const client = await createP2PNode<typeof router, PeerFileMetadata>({ router, protocol, security: createSharedSecretSecurity(secret, { authorize: () => true }), fileMetadataSchema: peerFileMetadataSchema, iroh, createContext: ctx => ctx });
    nodes.push(client); allowed.add(client.id);
    const original = await host.createTicket(), payload = JSON.parse(Buffer.from(original.split('.')[1]!, 'base64url').toString('utf8')) as { protocol: string };
    const verified = verifyPinnedSignedTicket(original, { expectedPeerId: host.id, expectedProtocol: payload.protocol });
    const issuedAt = Date.now(), body = Buffer.from(JSON.stringify({ ...verified, directAddresses: [address], issuedAt, expiresAt: issuedAt + 120000 }));
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), keyBytes]), type: 'pkcs8', format: 'der' });
    const ticket = `p2prpc3.${body.toString('base64url')}.${sign(null, Buffer.concat([Buffer.from('p2prpc-signed-ticket-v3\0'), body]), key).toString('base64url')}`;
    return Object.freeze({ get host() { return host; }, client, allowed, close,
      async replaceHost(router: Router) { await host.close(); host = await open(router); },
      get endpointsCreated() { return nodes.length; }, connection: {
      locator: { kind: 'ticket' as const, ticket }, expectedPeerId: host.id,
      expectedPrincipal: { subject: host.id, issuer: null, clientId: null, tenantId: null },
    } });
  } catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Owned endpoint startup and cleanup failed'); } throw error; }
}
