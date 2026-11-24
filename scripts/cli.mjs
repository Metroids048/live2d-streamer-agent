import {Controller} from '../src/controller.mjs';
import {randomUUID} from 'node:crypto';
const [action='status',json='{}']=process.argv.slice(2);
const result=await new Controller().run(action,JSON.parse(json),{sessionKey:'local-setup',callId:randomUUID()});
console.log(JSON.stringify(result,null,2));
if(!result.ok) process.exitCode=1;
