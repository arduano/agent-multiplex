import { FileError, assertId } from './types.js';
import type { Scope } from '../../../v8-history/src/contracts/types.js';
import { validateScope } from '../../../v8-history/src/contracts/validation.js';

export type FileNavigation = Readonly<{ host: string; session: string; representation?: 'html' }> &
  (Readonly<{ id: string; source?: never }> | Readonly<{ id?: never; source: Readonly<{ path: string; sourceKey: string; historyScope?: Scope }> }>);
/** Public addresses contain references only. The embedding authenticates the
 * account and routes this target through its current Host grants on every read. */
export function fileNavigationQuery(target: FileNavigation): URLSearchParams {
  const params = new URLSearchParams({ host: target.host, session: target.session });
  if (target.id !== undefined) params.set('id', target.id);
  else {
    params.set('path', target.source.path); params.set('sourceKey', target.source.sourceKey);
    if (target.source.historyScope) params.set('history', JSON.stringify(target.source.historyScope));
  }
  if (target.representation) params.set('representation', target.representation);
  return params;
}
export function parseFileNavigation(url: string): FileNavigation {
  if (url.length > 24_000) throw new FileError('INVALID');
  const params = new URL(url, 'http://navigation.invalid').searchParams, keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !['host', 'session', 'id', 'path', 'sourceKey', 'history', 'representation'].includes(key))) throw new FileError('INVALID');
  const host = params.get('host'), session = params.get('session'), representation = params.get('representation');
  if (!host || host.length > 256 || !session || session.length > 256 || /[\x00-\x1f\x7f]/.test(host + session) || representation !== null && representation !== 'html') throw new FileError('INVALID');
  const base = { host, session, ...(representation === 'html' ? { representation: 'html' as const } : {}) } as const;
  if (params.has('id')) {
    if (['path', 'sourceKey', 'history'].some(key => params.has(key))) throw new FileError('INVALID');
    const id = params.get('id')!; assertId(id); return { ...base, id };
  }
  const path = params.get('path'), sourceKey = params.get('sourceKey');
  if (!path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) || !sourceKey || sourceKey.length > 1024 || /[\x00-\x1f\x7f]/.test(sourceKey)) throw new FileError('INVALID');
  let historyScope: Scope | undefined;
  if (params.has('history')) {
    try { historyScope = JSON.parse(params.get('history')!); validateScope(historyScope!); }
    catch { throw new FileError('INVALID'); }
  }
  return { ...base, source: { path, sourceKey, ...(historyScope ? { historyScope } : {}) } };
}
