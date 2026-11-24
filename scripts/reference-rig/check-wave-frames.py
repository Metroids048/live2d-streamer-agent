"""Inspect actual decoded frames in the rest interval after the wave lands."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path
import numpy as np

def check(video, ffmpeg, start, end, region):
    x,y,w,h=region
    # Crop after normalizing resolution: same scale for GIF and MP4 evidence.
    vf=f"scale=556:384,crop={w}:{h}:{x}:{y},showinfo"
    decoded=subprocess.run([ffmpeg,"-nostdin","-hide_banner","-nostats","-loglevel","info",
        "-ignore_loop","1","-i",str(video),"-an","-vf",vf,"-fps_mode","passthrough",
        "-f","rawvideo","-pix_fmt","rgb24","pipe:1"],capture_output=True,check=False)
    if decoded.returncode:
        # ignore_loop is the GIF demuxer's option, not a universal input option.
        if video.suffix.lower()=='.gif':
            raise RuntimeError('GIF frame decode failed')
        decoded=subprocess.run([ffmpeg,"-nostdin","-hide_banner","-nostats","-loglevel","info",
            "-i",str(video),"-an","-vf",vf,"-fps_mode","passthrough",
            "-f","rawvideo","-pix_fmt","rgb24","pipe:1"],capture_output=True,check=True)
    frames=np.frombuffer(decoded.stdout,dtype=np.uint8).reshape(-1,h,w,3)
    times=np.array([float(v) for v in re.findall(rb'\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*([-+.\deE]+)',decoded.stderr)])
    if len(times)!=len(frames) or len(times)<3 or np.any(np.diff(times)<=0):
        raise ValueError('Missing original timestamps or frames')
    indices=np.flatnonzero((times>=start)&(times<=end))
    if len(indices)<5 or times[indices[-1]]<end-.055 or times[indices[0]]>start+.055:
        raise ValueError('Video has no complete post-return interval')
    def difference(i,j):
        return float((np.abs(frames[i].astype(np.int16)-frames[j]).max(axis=-1)>30).mean())
    # Compare every native frame with the settled arm. A smooth background
    # drift may change pixels slowly; the historical flash has both high
    # excursion and high adjacent-frame change during the stationary hold.
    samples=[dict(seconds=float(times[i]),change=difference(i,i-1),distanceFromSettled=difference(i,indices[-1])) for i in indices[1:]]
    bad=[p for p in samples if p['change']>.012 and p['distanceFromSettled']>.010]
    return dict(videoSha256=hashlib.sha256(video.read_bytes()).hexdigest(),region=region,
                decodedFrames=len(frames),interval=[start,end],samples=samples,unexpectedExcursions=bad,passed=not bad)

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('video',type=Path)
    p.add_argument('--ffmpeg',required=True)
    p.add_argument('--start',type=float,required=True)
    p.add_argument('--end',type=float,required=True)
    p.add_argument('--region',type=int,nargs=4,required=True)
    a=p.parse_args()
    print(json.dumps(check(a.video,a.ffmpeg,a.start,a.end,a.region)))
