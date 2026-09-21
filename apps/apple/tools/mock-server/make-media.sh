#!/bin/sh
# Makes the 20 second test video the mock server serves as HLS: five 4 second MPEG-TS pieces,
# H.264 High + AAC stereo, a key frame at every piece boundary, like hlsTranscoder.js produces.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/media"
cd "$here/media"
ffmpeg -y -loglevel error \
  -f lavfi -i "testsrc2=size=1280x720:rate=24:duration=20" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=20" \
  -c:v libx264 -profile:v high -level:v 4.1 -pix_fmt yuv420p -preset veryfast \
  -g 96 -keyint_min 96 -sc_threshold 0 -force_key_frames "expr:gte(t,n_forced*4)" \
  -c:a aac -b:a 128k -ac 2 \
  -f segment -segment_time 4 -segment_format mpegts "seg-%d.ts"
ls -l
