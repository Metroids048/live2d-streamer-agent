import {Maker} from '../src/maker.mjs';
import {randomUUID} from 'node:crypto';
const [action='materials',json='{}']=process.argv.slice(2);
const result=await new Maker().run(action,JSON.parse(json),{sessionKey:'local-setup',sessionId:'maker-cli',callId:randomUUID()});
console.log(JSON.stringify(result,null,2));if(!result.ok) process.exitCode=1;
