import {parseArgs} from 'node:util';
import {exportSourcePsd} from '../src/artwork/source-psd.mjs';

const {values}=parseArgs({options:{layout:{type:'string'},output:{type:'string'},'runtime-manifest':{type:'string'},report:{type:'string'},java:{type:'string'},help:{type:'boolean'}}});
if(values.help) {
  console.log('Usage: ./scripts/node.sh scripts/export-source-psd.mjs --layout /path/layout.json --output /path/new-source.psd --runtime-manifest /path/verified-runtime.json [--report /path/new-readback.json] [--java /path/java]');
} else {
  if(!values.layout||!values.output||!values['runtime-manifest'])throw new Error('--layout, --output and --runtime-manifest are required');
  console.log(JSON.stringify(await exportSourcePsd({layoutPath:values.layout,outputPath:values.output,
    runtimeManifest:values['runtime-manifest'],reportPath:values.report,javaPath:values.java}),null,2));
}
