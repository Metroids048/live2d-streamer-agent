// Assemble an isolated descendant's local material through the production 02 stage.
// Does not change the native current pointer, submit externally, or grant visual acceptance.
import fs from 'node:fs/promises';
import path from 'node:path';
import {buildArtwork} from '../src/artwork/index.mjs';
import {loadLocalArtwork,LOCAL_ARTWORK_MANIFEST} from '../src/artwork/local-artwork.mjs';
import {sha256} from '../src/artwork/files.mjs';
const root=await fs.realpath(process.argv[2]),taskRoot=await fs.realpath(process.argv[3]);
if(!taskRoot.startsWith(path.join(root,'openclaw-workspace/outputs')+path.sep)||!/^r[0-9]{4}$/.test(path.basename(taskRoot)))
  throw new Error('Expected isolated candidate revision under project workspace');
const input=JSON.parse(await fs.readFile(path.join(taskRoot,'intake/stage.json')));
const parent=JSON.parse(await fs.readFile(path.join(taskRoot,'../../intake/stage.json')));
for(const key of ['taskId','candidateId','inputSha256','descriptionSha256'])
  if(input[key]!==parent[key])throw new Error('Original intake mismatch: '+key);
if(input.parentRevision!==parent.revision||input.revision<=parent.revision||path.basename(taskRoot)!=='r'+String(input.revision).padStart(4,'0')||
  JSON.stringify(input.brief)!==JSON.stringify(parent.brief))throw new Error('Original brief or ancestry changed');
const start=Date.now();
const manifestSha256=sha256(await fs.readFile(path.join(taskRoot,LOCAL_ARTWORK_MANIFEST)));
const artworkBackend=await loadLocalArtwork(taskRoot,{manifestSha256},input);
const bundle=await buildArtwork(input,{...input,root,taskRoot,artworkBackend});
console.log(JSON.stringify({status:bundle.status,unresolved:bundle.unresolved,
  failed:bundle.checks.filter(c=>c.status==='failed'),elapsedMs:Date.now()-start,manifestSha256}));
