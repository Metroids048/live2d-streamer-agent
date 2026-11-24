import {fileURLToPath} from 'node:url';
import {prepareFinalPreviewReview} from '../src/packaging/hd-preview.mjs';

const [taskRoot]=process.argv.slice(2);
if(!taskRoot)throw new Error('Usage: prepare-final-preview-review.mjs TASK_ROOT');
const root=fileURLToPath(new URL('../',import.meta.url));
console.log(JSON.stringify(await prepareFinalPreviewReview({root,taskRoot})));
