"""Pass ordered video slices to MiniCPM's multi-frame frontend, not a contact sheet."""
import argparse
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

def decode(video, window, fps, size, crop):
    start,end=window["from"],window["to"]
    vf=([f"crop={crop}"] if crop else []) + [
        f"trim=start={start}:end={end}",f"fps={fps}:round=near",
        f"scale={size}:{size}:force_original_aspect_ratio=decrease",
        f"pad={size}:{size}:(ow-iw)/2:(oh-ih)/2","showinfo"]
    decoded=subprocess.run([str(Path.home()/".local/bin/ffmpeg"),"-nostdin","-hide_banner","-nostats","-v","info",
        "-i",str(video),"-vf",",".join(vf),"-an","-fps_mode","passthrough","-f","rawvideo","-pix_fmt","rgb24","pipe:1"],
        capture_output=True,check=True)
    frames=np.frombuffer(decoded.stdout,dtype=np.uint8).reshape(-1,size,size,3)
    times=[float(x) for x in re.findall(rb"\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*([-+.\deE]+)",decoded.stderr)]
    if (not len(times)==len(frames)>=2 or any(b<=a for a,b in zip(times,times[1:]))
        or abs(times[0]-start)>1.5/fps or abs(times[-1]-end)>1.5/fps):
        raise ValueError("Incomplete chronological video decode")
    return frames,times

def observe(model,processor,frames,times,question,tokens,overview):
    images=[Image.fromarray(f) for f in frames]
    intro=""
    if overview:
        cols,rows,tile,label=4,2,200,23
        sheet=Image.new("RGB",(cols*tile,rows*(tile+label)),"#171d26")
        draw=ImageDraw.Draw(sheet)
        for slot,index in enumerate(np.rint(np.linspace(0,len(images)-1,cols*rows)).astype(int)):
            x,y=slot%cols*tile,slot//cols*(tile+label)
            draw.text((x+8,y+4),f"{times[index]:.2f}s",fill="white")
            sheet.paste(images[index].resize((tile,tile),Image.Resampling.LANCZOS),(x,y+label))
        images.insert(0,sheet)
        intro="Timestamped overview of selected frames (left to right, top to bottom): <image>\n"
    content=question+"\n"+intro+"".join(f"{t:.3f}s <image>\n" for t in times)
    prompt=processor.apply_chat_template([{"role":"user","content":content}],tokenize=False,
        add_generation_prompt=True,enable_thinking=False)
    prepared=processor(text=prompt,images=[images])
    count=len(prepared["pixel_values"][0])
    if count!=len(images):raise ValueError("Frame count changed")
    features=[]
    for i in range(count):
        f=model.get_vision_embedding([[prepared["pixel_values"][0][i]]],[prepared["tgt_sizes"][0][i:i+1]])[0]
        mx.eval(f);features.append(f);mx.clear_cache()
    features=mx.concatenate(features,axis=0);mx.eval(features)
    expected=sum(int(end-start) for start,end in prepared["image_bound"][0])
    if features.shape[0]*features.shape[1]!=expected:raise ValueError("Image token count mismatch")
    prepared["input_ids"]=mx.array(prepared["input_ids"])
    prepared["mask"]=mx.array(prepared.pop("attention_mask"));prepared["pixel_values"]=None
    result=generate(model,processor,prompt,temperature=0,prefill_step_size=64,max_tokens=tokens,
        **prepared,cached_image_features=[features])
    return dict(response=result.text,finishReason=result.finish_reason,processedFrames=len(frames))

if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("video",type=Path);p.add_argument("output",type=Path)
    p.add_argument("--start",type=float,default=0);p.add_argument("--seconds",type=float)
    p.add_argument("--fps",type=float,default=30);p.add_argument("--crop",default="")
    p.add_argument("--size",type=int,default=448);p.add_argument("--question",type=Path);p.add_argument("--plan",type=Path)
    a=p.parse_args()
    shared=Path.home()/"Desktop/网页教程录制Agent"
    sys.path[:0]=[str(shared/".runtime/vision-review"),str(shared/"scripts")]
    os.environ["HF_HUB_OFFLINE"]="1";os.environ["TRANSFORMERS_OFFLINE"]="1"
    import numpy as np
    import mlx.core as mx
    from PIL import Image,ImageDraw
    from mlx_vlm import load,generate
    from review_mapped_weights import pageable_weights
    model_path=Path.home()/".cache/huggingface/hub/models--mlx-community--MiniCPM-o-4_5-4bit/snapshots/592c09d85e7bffbc8f8e45a417aa8e9a96119814"
    plan={}
    if a.plan:
        plan=json.loads(a.plan.read_text())
        windows=plan["windows"]
    else:
        if not a.seconds:p.error("requires --plan or --seconds")
        question=a.question.read_text() if a.question else "观察实际连续帧，说明手臂动作先后和衣袖轮廓突变。报告可见时间。"
        windows=[dict(id="diagnostic",question=question,**{"from":a.start,"to":a.start+a.seconds})]
    if not windows or len(windows)>12 or len({w["id"] for w in windows})!=len(windows):
        raise ValueError("Invalid video windows")
    digest=hashlib.sha256()
    with a.video.open("rb") as source:
        for chunk in iter(lambda: source.read(1024*1024), b""):
            digest.update(chunk)
    report=dict(sha256=digest.hexdigest(),model=model_path.name,
        fps=a.fps,size=a.size,mode="chronological timestamped video frames",windows=[],stages=[])
    def save(stage):
        report["stages"].append([stage,time.time()])
        tmp=a.output.with_suffix(".tmp")
        tmp.write_text(json.dumps(report,ensure_ascii=False,indent=2));tmp.replace(a.output);print(stage,flush=True)
    with (shared/".local/local-model.lock").open("r+") as lock:
        deadline=time.monotonic()+120
        while True:
            try:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic()>=deadline:
                    raise TimeoutError("Shared local vision model slot remained busy for 120s")
                time.sleep(0.5)
        with pageable_weights():
            if a.output.exists():
                if not a.plan:raise FileExistsError(a.output)
                saved=json.loads(a.output.read_text())
                prior=saved["windows"]
                if (any(saved.get(k)!=report[k] for k in ("sha256","model","fps","size","mode"))
                    or len(prior)>len(windows)
                    or any(any(record.get(k)!=v for k,v in expected.items())
                        or record["processedFrames"]!=len(record["timestamps"]) or record["processedFrames"]<2
                        or record["finishReason"]=="length" for record,expected in zip(prior,windows))):
                    raise ValueError("Cannot resume a video review with different inputs or incomplete saved frames")
                if saved["stages"][-1][0]=="complete":
                    if len(prior)!=len(windows):raise ValueError("Completed review is missing windows")
                    sys.exit(0)
                report=saved
                if len(prior)==len(windows):
                    save("complete")
                    sys.exit(0)
            mx.set_cache_limit(128000000)
            model,processor=load(str(model_path),lazy=True)
            model.audio_tower=None;model.audio_projection_layer=None;model.tts=None
            save("loaded")
            for w in windows[len(report["windows"]):]:
                frames,times=decode(a.video,w,float(w.get("fps",a.fps)),int(w.get("size",a.size)),w.get("crop",a.crop))
                result=observe(model,processor,frames,times,w["question"],int(w.get("maxTokens",650)),w.get("overview",False))
                report["windows"].append({**w,**result,"timestamps":times})
                mx.clear_cache()
                save(w["id"])
                if plan.get("failOnTruncated") and result["finishReason"]=="length":
                    raise ValueError("Video review model truncated its response in "+w["id"])
            save("complete")
