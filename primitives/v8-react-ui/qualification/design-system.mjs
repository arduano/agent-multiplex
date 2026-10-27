import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {buildChatStyles} from '../build/styles.mjs';
import {qualifySelects} from './select-cases.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const out=await mkdtemp(resolve(here,'../.cache/design-system-'));
const built=await build({entryPoints:[resolve(here,'ui-gallery.tsx')],bundle:true,write:false,platform:'browser',format:'esm',metafile:true,define:{'process.env.NODE_ENV':'"production"'},logLevel:'warning'});
await buildChatStyles({outdir:out});const css=await readFile(resolve(out,'chat.css'),'utf8');
const html=`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Multiplex design library</title><link rel="stylesheet" href="/ui.css"><style>body{margin:0;background:#101211}#outside{margin:12px}#gallery-root{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;padding:24px}.gallery{min-width:0;padding:24px;background:var(--mpx-ui-canvas);font:14px/1.5 var(--mpx-ui-font)}.gallery.multiplex-chat{height:auto;container-type:normal;overflow:visible}.gallery h1{font-size:18px}.gallery-row{display:flex;flex-wrap:wrap;gap:8px;margin-block:16px}.gallery-fields{display:grid;gap:16px}.gallery-light{--mpx-chat-canvas:#f7f8f5;--mpx-chat-surface:#fff;--mpx-chat-raised:#eef1eb;--mpx-chat-hover:#e5eae2;--mpx-chat-border:#ccd4c8;--mpx-chat-text:#1e271f;--mpx-chat-secondary:#4a594b;--mpx-chat-muted:#607060;--mpx-chat-accent:#356447;--mpx-chat-accent-ink:#fff;--mpx-chat-error:#a52c38}@media(max-width:700px){#gallery-root{grid-template-columns:1fr;padding:12px;gap:12px}.gallery{padding:16px}}</style><button id="outside">Unrelated page control</button><main id="gallery-root"></main><script type="module" src="/gallery.js"></script></html>`;
await writeFile(resolve(out,'index.html'),html);await writeFile(resolve(out,'gallery.js'),built.outputFiles[0].contents);
const server=createServer((req,res)=>{const [type,body]=req.url==='/ui.css'?['text/css',css]:req.url==='/gallery.js'?['text/javascript',built.outputFiles[0].contents]:['text/html',html];res.writeHead(200,{'content-type':type}).end(body);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;const errors=[];let result;
try{
  browser=await chromium.launch({executablePath:process.env.MULTIPLEX_CHROMIUM??'/run/current-system/sw/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('heading',{name:'Sage / charcoal component library'}).waitFor();
  const outside=await page.locator('#outside').evaluate(e=>({height:e.getBoundingClientRect().height,color:getComputedStyle(e).color}));assert.ok(outside.height<36,'Shared CSS must not resize outside controls');
  const sizes=[];
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);sizes.push({width,overflow:false,layout:await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,bodyHeight:document.body.getBoundingClientRect().height,regions:[...document.querySelectorAll('.gallery')].map(e=>e.getBoundingClientRect().toJSON())}))});await writeFile(resolve(out,'viewport-debug.json'),JSON.stringify(sizes,null,2));await page.screenshot({path:resolve(out,`gallery-${width}.png`),fullPage:true});}
  await page.setViewportSize({width:1440,height:1000});
  for(const name of ['Dark design library','Light design library']){
    const scope=page.getByRole('region',{name});await scope.getByRole('button',{name:'Review permission'}).click();
    const dialog=scope.getByRole('dialog');await dialog.waitFor();const color=await dialog.evaluate(e=>getComputedStyle(e).backgroundColor);assert.equal(color,name.startsWith('Light')?'rgb(255, 255, 255)':'rgb(32, 35, 33)');
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.textContent==='Review permission');
    await scope.getByRole('button',{name:'Open settings'}).click();await scope.getByRole('combobox',{name:'Reasoning'}).waitFor();await page.keyboard.press('Escape');
  }
  const selects=await qualifySelects(page,out);
  const contrast=[];
  for(const name of ['Dark design library','Light design library']){
    const scope=page.getByRole('region',{name}),primary=scope.getByRole('button',{name:'Primary action',exact:true});
    // Exercise the assembled chat reset as well as the standalone UI layer.
    await scope.evaluate(e=>e.classList.add('multiplex-chat'));
    for(const custom of [false,true]){
      if(custom)await scope.evaluate(e=>{e.style.setProperty('--mpx-chat-accent','#1d4ed8');e.style.setProperty('--mpx-chat-accent-ink','#ffffff');});
      await primary.hover();
      const colors=await primary.evaluate(e=>{const c=getComputedStyle(e);return {background:c.backgroundColor,text:c.color};});
      const rgb=color=>{if(color.startsWith('color(srgb '))return color.match(/[\d.]+/g).map(Number).slice(0,3);return color.match(/[\d.]+/g).map(Number).slice(0,3).map(x=>x/255);};
      const luminance=color=>rgb(color).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0);
      const a=luminance(colors.background),b=luminance(colors.text),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      assert.ok(ratio>=4.5,`${name} ${custom?'custom':'default'} primary hover contrast ${ratio}`);contrast.push({name,custom,...colors,ratio});
    }
  }
  assert.deepEqual(errors,[]);await context.close();result={passed:true,cases:['Scoped utilities leave outside controls alone','Two independent themes and explicit portal custody','Dialog Escape and focus restoration','320/390/1440 gallery overflow','Assembled chat primary and custom/light hover contrast' ,'Themed controlled Select values/keyboard/touch/nested overlays/native dialog'],selects,contrast,sizes,errors};
}catch(error){result={passed:false,error:String(error),stack:error.stack,errors};process.exitCode=1;}
finally{await browser?.close();await new Promise(r=>server.close(r));result.cleanup={browser:true,server:true};const files=[...new Set([...Object.keys(built.metafile.inputs).map(p=>resolve(p)),...['src/chat.css','src/composer.css','src/prompts.css','src/ui/styles.css','src/renderers/markdown.css','build/styles.mjs','build/ui-styles.mjs','package.json','package-lock.json'].map(p=>resolve(here,'..',p))])].sort();result.stylesheetSha256=createHash('sha256').update(css).digest('hex');result.inputs=await Promise.all(files.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})));await writeFile(resolve(out,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({out,...result,inputs:result.inputs.length}));}
