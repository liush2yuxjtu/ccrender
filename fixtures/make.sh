#!/usr/bin/env bash
# Regenerate the synthetic test media used by examples/demo.bundle.json (~13 MB, not committed).
# Needs ffmpeg; uses espeak-ng for the voice if installed, otherwise a tone (captions still render).
set -euo pipefail
cd "$(dirname "$0")"
if command -v espeak-ng >/dev/null; then espeak-ng -v en-us -s 150 -w speech.wav -f speech.txt
else ffmpeg -v error -y -f lavfi -i "sine=frequency=180:duration=23.77" speech.wav; fi
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 speech.wav)
ffmpeg -v error -y -f lavfi -i "gradients=s=1920x1080:c0=0x1d2b53:c1=0x7e2553:c2=0x008751:n=3:speed=0.02:r=30" -i speech.wav \
  -filter_complex "[1:a]asplit[a1][a2];[a1]showwaves=s=1920x300:mode=cline:colors=white@0.8:r=30[w];[0:v][w]overlay=0:390[v]" \
  -map "[v]" -map "[a2]" -t "$D" -c:v libx264 -preset veryfast -crf 22 -c:a aac -shortest a_roll.mp4
ffmpeg -v error -y -f lavfi -i "mandelbrot=s=1280x720:r=30" -f lavfi -i "anoisesrc=a=0.3" -t 8 -c:v libx264 -preset veryfast -crf 24 -c:a aac b_roll.mp4
ffmpeg -v error -y -f lavfi -i "aevalsrc='0.15*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.5*t))+0.12*sin(2*PI*277.18*t)+0.1*sin(2*PI*329.63*t)':s=48000:d=40" -c:a aac -b:a 128k music.m4a
ffmpeg -v error -y -f lavfi -i "color=c=0xe2453c:s=360x120" -vf "drawtext=text='ChatCut':fontcolor=white:fontsize=64:x=(w-tw)/2:y=(h-th)/2" -frames:v 1 logo.png
echo "fixtures ready"
