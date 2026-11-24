import {readJson,sha256} from '../artwork/files.mjs';
import {correctionOperation} from './flash-correction.mjs';

// Return only billing information from this candidate's actual provider jobs.
// A missing value is not a zero, and coins cannot be summed with money.
export async function flashUsage(job) {
  if(job.kind!=='single_image'||!job.source?.inputSha256)return undefined;
  const attempts=[];
  for(const file of ['artwork/operation.json',correctionOperation]) {
    const op=await readJson(job.output,file);
    if(op?.backend?.id!=='runninghub-standard-flash'||op.inputSha256!==job.source.inputSha256||
      !/^\d{8,32}$/.test(op.jobId)||op.operationKey!==sha256([job.id,job.candidateId,job.revision,op.cacheKey].join(':')))continue;
    const receipt=await readJson(job.output,'artwork/backend/'+sha256(op.operationKey)+'.json');
    if(receipt?.jobId!==op.jobId||receipt.operationKey!==op.operationKey||receipt.cacheKey!==op.cacheKey)continue;
    const amounts=Object.fromEntries(['consumeMoney','consumeCoins','thirdPartyConsumeMoney'].map(key=>{
      const value=receipt.usage?.[key];return [key,/^\d{1,16}(?:\.\d{1,16})?$/.test(String(value))?value:null];
    }));
    attempts.push({jobId:op.jobId,status:receipt.providerStatus??null,receivedImages:receipt.downloads?.length??0,
      ...amounts,amountReported:Object.values(amounts).some(v=>v!==null)});
  }
  return attempts.length?{provider:'RunningHub',attempts}:undefined;
}
