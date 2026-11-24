import * as fs from 'node:fs/promises';
import {recordFinalPreviewReview} from '../src/packaging/final-preview-review.mjs';

const [taskRoot,observationPath]=process.argv.slice(2);
if(!taskRoot||!observationPath)throw new Error('Usage: review-final-preview.mjs TASK_ROOT OBSERVATION_JSON');
const root=await fs.realpath(taskRoot);
const observation=JSON.parse(await fs.readFile(observationPath,'utf8'));
console.log(JSON.stringify(await recordFinalPreviewReview(root,observation)));
