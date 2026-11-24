// Shared timings and emotion mixes. All pose geometry comes from the current
// character's measured head and from the native rig, not a reference model.
export const gestureAxes=[
  {id:'ParamPresetNod',semantic:'action.preset.nod',min:-1,max:1,default:0,runtimeOwner:'motion'},
  {id:'ParamPresetLean',semantic:'action.preset.lean',min:-1,max:1,default:0,runtimeOwner:'motion'},
].map(p=>({...p,unit:'normalized',owner:'rigging'}));

const clip=(id,name,duration,...tracks)=>({id,name,duration,loop:false,fps:30,
  fade_in:.16,fade_out:.16,curves:tracks.map(([index,...keys])=>({parameter:gestureAxes[index].id,
    keys:[[0,0],...keys,[duration,0]].map(([time,value])=>({time,value,interpolation:'BEZIER'}))}))});
export const gestureClips=[
  clip('preset_nod','点头同意',1.9,[0,[.38,.78],[.67,-.14],[.95,.56],[1.29,-.09]]),
  clip('preset_ponder','歪头思考',2.75,[1,[.64,-.65],[1.78,-.60]],[0,[.7,-.23],[1.62,-.17]]),
  clip('preset_bow','低头致意',2.45,[0,[.68,1],[1.19,.91],[1.87,-.13]]),
  clip('preset_react','惊喜抬头',1.85,[0,[.32,-.72],[.61,-.51],[1.1,.13]],[1,[.35,.32],[.69,.24]]),
  clip('preset_sway','轻快摇摆',3.1,[1,[.53,.61],[1.16,-.72],[1.81,.55],[2.42,-.37]]),
  clip('preset_acknowledge','侧身致意',2.35,[1,[.6,.73],[1.43,.53]],[0,[.64,.52],[1.05,.7],[1.45,.39]]),
];

// Left/right brow, smile lid, angry lid, surprised lid, mouth form.
export const emotionPresets=[
  ['bright','开怀',[.61,.61,.88,0,0,.96]],
  ['warm','温柔笑',[.18,.18,.60,0,0,.40]],
  ['curious','好奇',[.75,.24,0,0,.24,.19]],
  ['skeptical','挑眉疑惑',[.53,-.49,0,.32,0,-.37]],
  ['concerned','担心',[.24,.36,0,0,.38,-.75]],
  ['determined','认真',[-.48,-.41,0,.50,0,.19]],
  ['annoyed','不满',[-.59,-.72,0,.75,0,-.64]],
  ['shy','害羞',[.27,.42,.52,0,0,.24]],
  ['startled','吓一跳',[.97,.91,0,0,.98,-.53]],
].map(([id,label,values])=>({id,label,values}));

export function includeStreamerPresets(requested,enabled,presets) {
  return enabled?[...requested,...presets.filter(p=>!requested.some(r=>(r.id??r)===p.id))]:requested;
}

export async function applyGestureAxes(session,parts,brief) {
  if(!brief.streamerPresets)return;
  const face=parts.find(p=>p.tags.includes('face')&&!p.tags.includes('detail'));
  const [l,t,r,b]=face.geometry.canvasBounds;
  const eyes=parts.filter(p=>p.tags.includes('eye')&&p.tags.includes('white'));
  const eyeY=eyes.reduce((s,p)=>s+(p.geometry.canvasBounds[1]+p.geometry.canvasBounds[3])/2,0)/(eyes.length||1);
  const head=brief.intent.headMotion;
  const definitions=[
    {target:'warp:DeformHeadContainer',keys:[...(head.yawDegrees?[0,-head.yawDegrees,head.yawDegrees]:[0])].flatMap(x=>
      (head.pitchDegrees?[0,-head.pitchDegrees,head.pitchDegrees]:[0]).map(y=>({ParamAngleX:x,ParamAngleY:y}))),
    operations:v=>[
      {type:'scale',factors:[1,1-.105*v],pivot:[.5,.79]},
      {type:'translate',delta:[0,(b-(eyeY||t))/(b-t)*v*.055]},
    ]},
    {target:'warp:DeformBodyLean',keys:[{}],
      operations:v=>[{type:'rotate',degrees:6.6*v,pivot:[.5,.73]}]},
  ];
  for(const [i,p] of gestureAxes.entries()) {
    const {target,keys,operations}=definitions[i];
    const detail=(await session.query('workspace_inspect',{scope:'objects',target})).data;
    const cells=i===0?keys.map(key=>Object.fromEntries(Object.entries(key).filter(([id])=>detail.axes?.[id]))):
      Object.entries(detail.axes??{}).filter(([id])=>id!==p.id)
        .reduce((cells,[id,values])=>cells.flatMap(c=>values.map(v=>({...c,[id]:v}))),[{}]);
    const parameter={id:p.id,min:p.min,max:p.max,default:p.default};
    const shapes=[-1,1].flatMap(value=>cells.map(key=>({target,value,key})));
    await session.step('streamer-presets-seed-'+p.id,'author_axis',{parameter,
      shapes:shapes.map(s=>({...s,operations:[{type:'scale',factors:[1,1]}]}))});
    for(let j=0;j<shapes.length;j+=32)await session.step('streamer-presets-shape-'+p.id+'-'+j,'author_axis',{
      parameter,shapes:shapes.slice(j,j+32).map(s=>({...s,operations:operations(s.value)}))});
  }
}
