// Read-only account inspection over the installed Codex app-server protocol.
// Never purchase credits, reset an allowance or switch to another provider.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

export function includedWaveQuota(snapshot) {
  if(!['plus','pro','prolite','promax','free','go'].includes(snapshot?.planType)||!snapshot.primary)return 'CODEX_WAVE_INCLUDED_QUOTA_UNKNOWN';
  if(snapshot.rateLimitReachedType||snapshot.spendControlReached===true||
    [snapshot.primary,snapshot.secondary].filter(Boolean).some(w=>!Number.isFinite(w.usedPercent)||w.usedPercent>=100))return 'CODEX_WAVE_QUOTA_EXHAUSTED';
  // The provider consumes purchased credits automatically after included usage.
  // Account state without a verifiable zero-overage arrangement cannot authorize this route.
  if(snapshot.credits?.hasCredits!==false||snapshot.credits?.unlimited!==false)return 'CODEX_WAVE_PAID_FALLBACK_UNVERIFIED';
  return null;
}

export async function checkIncludedWaveQuota(cli) {
  const child=spawn(cli,['app-server'],{stdio:['pipe','pipe','ignore']});
  const lines=createInterface({input:child.stdout});
  const send=v=>child.stdin.write(JSON.stringify(v)+'\n');
  return new Promise(resolve=>{
    let timer;
    const finish=value=>{clearTimeout(timer);lines.close();child.kill();resolve(value);};
    timer=setTimeout(()=>finish('CODEX_WAVE_INCLUDED_QUOTA_UNKNOWN'),15000);
    child.once('error',()=>finish('CODEX_WAVE_INCLUDED_QUOTA_UNKNOWN'));
    child.once('close',()=>finish('CODEX_WAVE_INCLUDED_QUOTA_UNKNOWN'));
    child.stdin.on('error',()=>finish('CODEX_WAVE_INCLUDED_QUOTA_UNKNOWN'));
    lines.on('line',line=>{
      let msg;try{msg=JSON.parse(line);}catch{return;}
      if(msg.id===1&&msg.result){send({method:'initialized'});send({id:2,method:'account/rateLimits/read',params:{}});}
      if(msg.id===2)finish(includedWaveQuota(msg.result?.rateLimits));
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'live2d-artwork',version:'1'},capabilities:{}}});
  });
}
