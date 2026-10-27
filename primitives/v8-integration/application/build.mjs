import {build} from 'esbuild';
import {readFile,mkdir,copyFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const here=dirname(fileURLToPath(import.meta.url)),framework=resolve(here,'../../..');
/** Documentation/qualification tool resolution only. Browser output bundles the
 * exact published React runtime; public source has ordinary peer imports. */
export async function buildApplicationAssets(output=resolve(here,'../.build/application-web')){
 const react=resolve(framework,'node_modules/react'),dom=resolve(framework,'node_modules/react-dom');
 for(const root of[react,dom])assert.equal(JSON.parse(await readFile(resolve(root,'package.json'),'utf8')).version,'19.2.8');
 await mkdir(output,{recursive:true});
 const result=await build({entryPoints:[resolve(here,'client.ts')],outfile:resolve(output,'client.js'),platform:'browser',format:'esm',target:'es2023',bundle:true,metafile:true,sourcemap:true,
  alias:{react,'react-dom/client':resolve(dom,'client.js')},define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
 for(const input of Object.keys(result.metafile.inputs))if(/\/src\/(?:host|node|authority|gateway|http)\//.test(input)||input.includes('storage-sqlite'))throw Error('Node owner escaped application browser graph');
 for(const file of['index.html','style.css'])await copyFile(resolve(here,file),resolve(output,file));
 return output;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.stdout.write(await buildApplicationAssets()+'\n');
