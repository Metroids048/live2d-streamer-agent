import {registeredWaveFrames} from './preview-plan.mjs';

export function buildBroadcastPlayback(tested,fps,body,physicsOutputs=[]) {
  const waveFrames=registeredWaveFrames(tested),waveStart=Math.round(6.3*fps);
  // Offset related movements in time, as in an idle camera take.
  const poses=[
    [0,0,0,0],[.55,-1,1,-.5],[1.4,-8,-1,-2.5],[2.3,-10,-2,-3],[3.1,-4,1,-1],
    [4,4,1.5,2],[5.15,10,-.5,3.5],[5.85,8,-2,2.8],[6.6,2,-1,.5],[7.15,0,1,0],
    [8,5,2,-1],[9.3,3,-.5,-1.3],[10.4,-3,0,-2],[11.55,-8,-1,-2.5],
    [12.65,-5,-3,-1],[13.45,3,1.4,2],[14.6,6,0,2.7],[15.7,1,-1,.8],[16.6,0,0,0]
  ];
  // Body shifts start at the hips and can precede or outlast a glance.
  // Use the exported body axes rather than moving the camera or scaling the frame.
  const bodyPoses=[
    [0,0,0,0],[.8,-1,-.5,-.6],[1.65,-4.8,-1.2,-2.4],[2.8,-3,.4,-1.6],
    [4,1.4,1,.9],[5.3,5.1,.3,2.6],[6.3,3.1,-.8,1.7],[7.1,-1,1.1,-.7],
    [8.1,2.9,.9,1.4],[9.3,3.6,-.1,1.8],[10.4,.7,-.8,.4],[11.9,-4.4,-.8,-2.3],
    [13.1,-2.5,.4,-1.3],[14.5,3.9,1.1,1.9],[15.65,1.2,-.4,.7],[16.6,0,0,0]
  ];
  const smooth=u=>u*u*u*(u*(u*6-15)+10);
  function angles(time,track=poses){
    time=Math.max(0,Math.min(16.6,time));
    const end=track.findIndex(key=>key[0]>=time);
    if(end===0)return track[0].slice(1);
    const a=track[end-1],b=track[end],fraction=smooth((time-a[0])/(b[0]-a[0]));
    return a.slice(1).map((v,j)=>v+(b[j+1]-v)*fraction);
  }
  const blink=t=>1-Math.max(...[.74,3.35,5.92,7.71,10.52,13.04,15.43].map(center=>
    smooth(Math.max(0,1-Math.abs(t-center)/(t<center?.11:.17)))));
  const speech=[[1.1,2.85],[4.15,5.6],[7.1,8.18],[9.34,10.09],[12.1,13.1],[14.21,15.25]];
  if(!waveFrames.length)throw Error('Broadcast preview requires a registered greeting');
  // Use only the opening span of the continuous sleeve rig. It precedes the
  // palm replacement, so the arm can settle without flashing alternate art.
  const rest=tested[0].values;
  const continuousArm=rest.ParamWave===0&&Object.hasOwn(rest,'ParamGreetingWrist')&&!Object.hasOwn(rest,'ParamWaveLift')&&
    waveFrames.some(frame=>frame.ParamWave>0&&frame.ParamWave<.03);
  const armSettles=[[1.1,2.05,3.05,.031],[4.08,4.83,5.58,.022],[13.35,14.14,15.41,.026]];
  const waveEnd=waveStart+waveFrames.length;
  const frameCount=Math.max(499,waveEnd+Math.round(3.3*fps));
  return Array.from({length:frameCount},(_,i)=>{
    const t=i/fps,[x,y,z]=angles(t),[bx,by,bz]=angles(t,bodyPoses);
    const values={...tested[0].values};
    const set=(id,value)=>{if(Object.hasOwn(values,id))values[id]=value;};
    const phrase=speech.find(([a,b])=>t>a&&t<b);
    const talk=phrase?smooth(Math.min(1,(t-phrase[0])/.2,(phrase[1]-t)/.24))*
      (.08+.44*Math.abs(Math.sin(t*10+Math.sin(t*3)))**1.7):0;
    Object.assign(values,waveFrames[i-waveStart]);
    if(continuousArm&&(i<waveStart||i>=waveEnd)){
      const settle=armSettles.find(([start,,end])=>t>start&&t<end);
      if(settle){
        const [start,peak,end,lift]=settle;
        values.ParamWave=lift*smooth(t<peak?(t-start)/(peak-start):(end-t)/(end-peak));
      }
    }
    const wave=values.ParamWave??0;
    set('ParamAngleX',x);set('ParamAngleY',y);set('ParamAngleZ',z);
    set(body[0],bx);set(body[1],by);set(body[2],bz);
    set('ParamEyeBallX',Math.max(-.35,Math.min(.35,(angles(t+.12)[0]-x)*.28+x*.018)));
    set('ParamEyeBallY',y*.04);set('ParamEyeLOpen',blink(t));set('ParamEyeROpen',blink(t-.012));
    set('ParamMouthOpenY',talk);set('ParamMouthForm',.16+wave*.24);set('ParamEyeSmile',wave*.2);
    set('ParamBreath',.18+.15*Math.sin(t*1.46-.4));
    for(const id of physicsOutputs)delete values[id];
    const phase=i<waveStart?'conversation':i<waveEnd?'greeting':'return-to-conversation';
    return {time:t,phase,values};
  });
}

export function buildVideoOnlyPlayback(tested,fps,body,physicsOutputs=[],profile='balanced') {
  const capturedWave=registeredWaveFrames(tested);
  if(!capturedWave.length)throw Error('Video-only preview requires a registered greeting');
  const defaults=tested[0].values;
  const gestureIds=[...new Set(capturedWave.flatMap(frame=>Object.keys(frame)))];
  const profileCaps={
    teal:{ParamWave:.38,ParamWaveLift:.3,ParamGreetingWrist:.18,ParamGreetingBalance:.08},
    'teal-cut-safe':{ParamWave:.69,ParamWaveLift:0,ParamGreetingWrist:0,ParamGreetingBalance:0},
    silver:{ParamWave:.63,ParamWaveLift:.56,ParamGreetingWrist:.68,ParamGreetingBalance:.24},
    chestnut:{ParamWave:.63,ParamWaveLift:.56,ParamGreetingWrist:.62,ParamGreetingBalance:.22},
    balanced:{ParamWave:.58,ParamWaveLift:.5,ParamGreetingWrist:.56,ParamGreetingBalance:.2}
  };
  const caps={
    ...profileCaps.balanced,...profileCaps[profile],
    ParamGreetingFinger1:.62,ParamGreetingFinger2:.62,ParamGreetingFinger3:.58,
    ParamGreetingFinger4:.58,ParamGreetingFinger5:.58
  };
  const targets=Object.fromEntries(gestureIds.map(id=>{
    const base=defaults[id]??0;
    const values=capturedWave.map(frame=>frame[id]??base);
    const furthest=values.reduce((best,value)=>Math.abs(value-base)>Math.abs(best-base)?value:best,base);
    const cap=caps[id]??.42;
    return [id,base+Math.sign(furthest-base)*Math.min(cap,Math.abs(furthest-base))];
  }));
  const smooth=u=>{
    u=Math.max(0,Math.min(1,u));
    return u*u*u*(u*(u*6-15)+10);
  };
  const interpolate=(time,track)=>{
    const end=track.findIndex(key=>key[0]>=time);
    if(end===0)return track[0].slice(1);
    if(end<0)return track.at(-1).slice(1);
    const a=track[end-1],b=track[end],fraction=smooth((time-a[0])/(b[0]-a[0]));
    return a.slice(1).map((value,j)=>value+(b[j+1]-value)*fraction);
  };
  const head=[
    [0,0,0,0],[1.15,-6.4,-1.1,-1.8],[2.35,-8.2,-.4,-2.6],[3.65,-2.6,.9,-.6],
    [4.95,7.4,1.2,2.3],[6.15,2.7,-.5,.5],[7.25,-4.3,.5,-1.3],[8.55,6.2,1.1,2],
    [9.8,8.6,.2,2.8],[10.95,3.2,-1,.6],[12.05,0,0,0],[13.25,-8,-1,-2.5],
    [14.55,-2.8,1.1,-.4],[16.05,7.2,.7,2.2],[17.1,2.7,-.4,.5],[18,0,0,0]
  ];
  const torso=[
    [0,0,0,0],[1.45,-2.5,-.5,-1.2],[2.7,-3.7,-.25,-1.9],[4.25,1.8,.7,.9],
    [5.55,4,.4,2],[6.75,.2,-.2,.1],[7.7,-2.8,.7,-1.4],[9.05,-4.5,.2,-2.2],
    [10.5,-1.1,-.4,-.5],[12,0,0,0],[13.4,-3,-.4,-1.5],[14.9,1.5,.5,.8],
    [16.15,3.7,.35,1.8],[18,0,0,0]
  ];
  const envelope=(time,start,peak,hold,end)=>time<=start||time>=end?0:
    time<peak?smooth((time-start)/(peak-start)):time<=hold?1:smooth((end-time)/(end-hold));
  const safeTealWave=time=>{
    const keys=[[5.55,.45],[6.5,.45],[7.6,.53],[8.7,.69],[9.8,.53],[10.9,.69],[11.75,.53],[12.45,.45]];
    if(time<keys[0][0]||time>=12.45)return 0;
    const end=keys.findIndex(([at])=>at>=time);
    if(end===0)return keys[0][1];
    const [aTime,aValue]=keys[end-1],[bTime,bValue]=keys[end];
    return aValue+(bValue-aValue)*smooth((time-aTime)/(bTime-aTime));
  };
  const blinkCenters=[1.02,3.72,5.78,8.38,11.95,14.08,16.72].map(time=>Math.round(time*fps));
  const blinkValues=[1,.58,0,.58,1];
  const blink=index=>{
    for(const center of blinkCenters){
      const offset=index-center;
      if(offset>=-2&&offset<=2)return blinkValues[offset+2];
    }
    return 1;
  };
  const speech=[[.45,2.45],[3.2,5.35],[6.05,7.35],[9.45,10.65],[12.35,14.05],[15.05,17.25]];
  const frameCount=18*fps+1;
  return Array.from({length:frameCount},(_,index)=>{
    const time=index/fps,[x,y,z]=interpolate(time,head),[bx,by,bz]=interpolate(time,torso);
    const values={...defaults};
    const set=(id,value)=>{if(Object.hasOwn(values,id))values[id]=value;};
    const arm=envelope(time,5,6.9,10.8,13.2);
    const wrist=envelope(time,5.35,7.15,10.55,12.85);
    const fingers=envelope(time,5.7,7.4,10.25,12.5);
    for(const id of gestureIds){
      const base=defaults[id]??0,target=targets[id]??base;
      if(profile==='teal-cut-safe'){
        values[id]=id==='ParamWave'?safeTealWave(time):base;
        continue;
      }
      const factor=id==='ParamGreetingWrist'?wrist:id.startsWith('ParamGreetingFinger')?fingers:arm;
      const wave=id==='ParamGreetingWrist'&&profile!=='teal'&&time>7.15&&time<11.2?
        Math.sin((time-7.15)*Math.PI*1.35)*.075*arm:0;
      values[id]=base+(target-base)*factor+Math.sign(target-base)*wave;
    }
    const phrase=speech.find(([start,end])=>time>start&&time<end);
    const talk=phrase?smooth(Math.min(1,(time-phrase[0])/.22,(phrase[1]-time)/.25))*
      (.06+.46*Math.abs(Math.sin(time*8.8+Math.sin(time*2.1)))**1.55):0;
    set('ParamAngleX',x);set('ParamAngleY',y);set('ParamAngleZ',z);
    set(body[0],bx);set(body[1],by);set(body[2],bz);
    set('ParamEyeBallX',Math.max(-.24,Math.min(.24,x*.026)));
    set('ParamEyeBallY',Math.max(-.12,Math.min(.12,y*.035)));
    set('ParamEyeLOpen',blink(index));set('ParamEyeROpen',blink(index));
    set('ParamMouthOpenY',talk);set('ParamMouthForm',.1+arm*.11);set('ParamEyeSmile',arm*.08);
    set('ParamBreath',0);
    for(const id of physicsOutputs)delete values[id];
    const phase=time<5?'conversation':time<13.2?'greeting':'return-to-conversation';
    return {time,phase,values};
  });
}
