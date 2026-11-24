import {decodePng,encodePng} from '../artwork/png.mjs';
import {RigError} from './engine.mjs';
import {digest} from './files.mjs';

// PSD2Live renders the poses. These glyphs only label the diagnostic tiles
// when the JVM cannot load its desktop font configuration.
const labels=[
  [14,17,17,31,17,17,17],[30,17,17,30,17,17,30],[14,17,16,16,16,17,14],
  [30,17,17,17,17,17,30],[31,16,16,30,16,16,31],[31,16,16,30,16,16,16],
  [14,17,16,23,17,17,15],[17,17,17,31,17,17,17],[14,4,4,4,4,4,14],
];

export async function renderIndividualPoses(session,{poses,columns,target_long_edge:edge,...view}) {
  const rows=Math.ceil(poses.length/columns),caption=24;
  const target=Math.max(128,Math.floor(edge/Math.max(columns,rows))-caption);
  const sources=[];
  for(const parameters of poses) {
    const {data,images}=await session.query('view_render_model',{...view,parameters,target_long_edge:target});
    if(!data?.revisionId||!data.viewId||images?.length!==1||digest(images[0])!==data.sha256)
      throw new RigError('POSE_RENDER_IDENTITY_MISMATCH');
    const png=decodePng(images[0]),first=sources[0];
    if(png.width!==data.renderedWidth||png.height!==data.renderedHeight||first&&(
      data.revisionId!==first.data.revisionId||JSON.stringify(data.canvasRect)!==JSON.stringify(first.data.canvasRect)||
      JSON.stringify(data.includedLayerIds)!==JSON.stringify(first.data.includedLayerIds)||
      png.width!==first.png.width||png.height!==first.png.height))
      throw new RigError('POSE_RENDER_CAMERA_CHANGED');
    sources.push({png,data});
  }
  const {png:first,data:metadata}=sources[0];
  const width=columns*first.width,height=rows*(first.height+caption);
  if(Math.max(width,height)>edge)throw new RigError('POSE_SHEET_BUDGET_EXCEEDED');
  const pixels=Buffer.alloc(width*height*4);
  const tiles=sources.map(({png,data},i)=>{
    const x=i%columns*png.width,y=Math.floor(i/columns)*(png.height+caption);
    for(let dy=0;dy<caption;dy++) {
      for(let dx=0;dx<png.width;dx++) {
        const glyphY=Math.floor((dy-5)/2),glyphX=Math.floor((dx-6)/2);
        const glyph=glyphX>=0&&glyphX<5&&(labels[i][glyphY]&(16>>glyphX));
        pixels.writeUInt32BE(glyph?0xffffffff:0x20232aff,((y+dy)*width+x+dx)*4);
      }
    }
    for(let row=0;row<png.height;row++)
      png.data.copy(pixels,((y+caption+row)*width+x)*4,row*png.width*4,(row+1)*png.width*4);
    return {id:String.fromCharCode(65+i),viewId:data.viewId,imageRect:[x,y+caption,png.width,png.height],
      parameters:data.appliedParameters,outOfRangeParameters:data.outOfRangeParameters,sha256:data.sha256};
  });
  const {left,top,right,bottom}=metadata.canvasRect;
  return {images:[encodePng({width,height,data:pixels})],data:{revisionId:metadata.revisionId,
    comparison:'poses',physicsSimulated:false,composition:'individual_native_renders',
    width,height,canvasRect:[left,top,right,bottom],tiles}};
}
