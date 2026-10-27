import { useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, IconButton, Input, Textarea, Select, type SelectOption, Field, Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription, DialogClose, Popover, PopoverTrigger, PopoverContent, Tabs, TabsList, TabsTrigger, TabsContent } from '../src/ui/index.js';

function Choice({label, options, initial = '', disabled = false}: {label: string; options: readonly SelectOption[]; initial?: string; disabled?: boolean}) {
  const [value,setValue] = useState(initial), [changes,setChanges] = useState<readonly string[]>([]);
  const trigger = useRef<HTMLButtonElement>(null);
  return <Field label={label}><Select aria-label={label} value={value} options={options} disabled={disabled} ref={trigger} onValueChange={next => {setValue(next);setChanges(values => [...values,next]);}} />
    <output data-choice={label} data-changes={JSON.stringify(changes)} data-button-ref={trigger.current?.tagName ?? ''}>{value || '(keep)'}</output></Field>;
}
const modelOptions = [{value:'',label:'Keep native choice'},{value:'luna',label:'GPT-6-Luna'},{value:'value:',label:'Value prefix'},{value:'sol',label:'GPT-6.1-Sol'},{value:'disabled',label:'Not offered',disabled:true}];
const effortOptions = [{value:'',label:'Native default'},{value:'high',label:'High'},{value:'low',label:'Low'}];
function Gallery({light = false}: {light?: boolean}) {
  const [container, setContainer] = useState<HTMLElement|null>(null), nativeDialog = useRef<HTMLDialogElement>(null), nativeTitle = useId();
  return <section ref={setContainer} className={`mpx-ui gallery${light?' gallery-light':''}`} aria-label={light?'Light design library':'Dark design library'}>
    <h1>{light?'Light':'Sage / charcoal'} component library</h1><p>One token contract and scoped portals. These controls have no agent effects.</p>
    <div className="gallery-row"><Button>Primary action</Button><Button variant="secondary">Secondary</Button><Button variant="outline">Outline</Button><Button variant="ghost">Quiet</Button><Button variant="destructive">Destructive</Button><Button disabled>Unavailable</Button><IconButton label="More options">⋯</IconButton></div>
    <div className="gallery-fields"><Field label="Name" hint="Optional descriptive name"><Input placeholder="Untitled conversation" /></Field><form onSubmit={event=>event.preventDefault()}><Choice label="Model" initial="luna" options={modelOptions} /></form><Choice label="Unavailable choice" options={effortOptions} disabled /><Field label="Feedback" error="Example field-specific error"><Textarea defaultValue="A multiline note" aria-invalid /></Field></div>
    <div className="gallery-row"><label className="mpx-ui-choice"><input type="radio" name={light?'light-choice':'dark-choice'} defaultChecked />Recommended route</label><label className="mpx-ui-choice"><input type="radio" name={light?'light-choice':'dark-choice'} />Alternative route</label><label className="mpx-ui-choice"><input type="checkbox" />Optional detail</label></div>
    <div className="gallery-row"><Popover><PopoverTrigger asChild><Button variant="outline">Open settings</Button></PopoverTrigger><PopoverContent container={container}><Choice label="Reasoning" options={effortOptions}/></PopoverContent></Popover>
    <Dialog><DialogTrigger asChild><Button variant="outline">Review permission</Button></DialogTrigger><DialogContent container={container}><DialogTitle>Review one action</DialogTitle><DialogDescription>The requested scope belongs to this themed surface.</DialogDescription><Choice label="Permission scope" options={effortOptions}/><div className="gallery-row"><DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose><DialogClose asChild><Button>Confirm once</Button></DialogClose></div></DialogContent></Dialog></div>
    <Button variant="outline" onClick={() => nativeDialog.current?.showModal()}>Open native form</Button>
    <dialog ref={nativeDialog} className="mpx-ui-dialog" aria-labelledby={nativeTitle}><h2 id={nativeTitle}>Native form</h2><Choice label="Native placement" options={modelOptions}/><Button onClick={() => nativeDialog.current?.close()}>Close native form</Button></dialog>
    <Tabs defaultValue="summary"><TabsList aria-label="Library sections"><TabsTrigger value="summary">Summary</TabsTrigger><TabsTrigger value="details">Details</TabsTrigger></TabsList><TabsContent value="summary"><p>Primary content uses space and type hierarchy.</p></TabsContent><TabsContent value="details"><p>Secondary information appears on demand.</p></TabsContent></Tabs>
  </section>;
}
createRoot(document.getElementById('gallery-root')!).render(<><Gallery/><Gallery light/></>);
