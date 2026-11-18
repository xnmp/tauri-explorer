"""Conforms the rendered shots into the film: grade, halation, grain, dissolves, fades, audio.

    python3 edit.py --frames DIR --out the-valley.mp4 [--audio the-valley.wav] [--preview]
"""
import argparse
import os
import subprocess

FPS = 24
# (shot, frames, transition INTO the next shot in seconds; 0 = cut)
CUT = [('1', 204, 1.0), ('2', 168, 0.75), ('3', 192, 0.6), ('4a', 72, 0.0), ('4b', 216, 0.8), ('5', 180, 0.0)]
S_CURVE = "curves=all='0/0 0.20/0.135 0.55/0.57 0.85/0.90 1/1'"
GRADE = {
    '1': "eq=saturation=1.12:gamma=0.96,curves=all='0/0 0.25/0.21 0.7/0.74 1/1',colorbalance=bs=0.05:bm=0.02:rh=0.03",
    '2': S_CURVE + ",eq=saturation=1.15,colorbalance=rs=-0.03:bs=0.05:rh=0.05:bh=-0.07:gm=0.01",
    '3': S_CURVE + ",eq=saturation=1.28,colorbalance=bs=0.04:rh=0.03:bh=-0.03",
    '4a': "curves=all='0/0 0.22/0.13 0.5/0.50 0.8/0.89 1/1',eq=saturation=1.22,colorbalance=rs=-0.07:bs=0.09:bm=0.02:rh=0.06:bh=-0.07",
    '4b': "curves=all='0/0 0.22/0.13 0.5/0.50 0.8/0.89 1/1',eq=saturation=1.22,colorbalance=rs=-0.07:bs=0.09:bm=0.02:rh=0.06:bh=-0.07",
    '5': "curves=all='0/0 0.25/0.13 0.55/0.50 0.85/0.88 1/1',eq=saturation=1.25,colorbalance=rs=-0.06:bs=0.08:rm=0.02:rh=0.09:gh=0.01:bh=-0.11",
}

ap = argparse.ArgumentParser()
ap.add_argument('--frames', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--audio', default='')
ap.add_argument('--preview', action='store_true', help='frames are low-res, every 2nd frame')
ap.add_argument('--crf', default='18')
ap.add_argument('--bitrate', default='', help='e.g. 3300k: two-pass average bitrate instead of CRF')
ap.add_argument('--grain', default='2.5')
args = ap.parse_args()

step = 2 if args.preview else 1
fps = FPS // step
cmd = ['taskset', '-c', '0,1', 'nice', '-n', '19', 'ffmpeg', '-v', 'error', '-y', '-threads', '2']
for shot, n, _ in CUT:
    cmd += ['-framerate', str(fps), '-pattern_type', 'glob', '-i', os.path.join(args.frames, 's' + shot, '*.png')]
if args.audio:
    cmd += ['-i', args.audio]
fc = []
for i, (shot, n, _) in enumerate(CUT):
    fc.append('[%d:v]format=gbrp16le,scale=1920:1080:flags=lanczos,%s,setsar=1,fps=%d,settb=AVTB,setpts=PTS-STARTPTS[g%d]'
              % (i, GRADE[shot], fps, i))
cur, t = 'g0', CUT[0][1] / FPS
for i in range(1, len(CUT)):
    d = CUT[i - 1][2]
    if d > 0:
        fc.append('[%s][g%d]xfade=transition=fade:duration=%.3f:offset=%.3f[x%d]' % (cur, i, d, t - d, i))
        t += CUT[i][1] / FPS - d
    else:
        fc.append('[%s][g%d]concat=n=2:v=1:a=0[x%d]' % (cur, i, i))
        t += CUT[i][1] / FPS
    cur = 'x%d' % i
total = t
# halation: a soft warm glow from the highlights, then a touch of vignette and fine grain (which also dithers)
fc.append('[%s]split[m][h]' % cur)
fc.append("[h]curves=all='0/0 0.6/0 1/1',gblur=sigma=28,colorchannelmixer=rr=1.0:gg=0.82:bb=0.62[hb]")
fc.append('[m][hb]blend=all_mode=screen:all_opacity=0.28[bl]')
fc.append('[bl]vignette=angle=PI/8,noise=c0s=%s:c0f=t+u,'
          'fade=t=in:st=0:d=1.6,fade=t=out:st=%.3f:d=2.2,format=yuv420p[v]' % (args.grain, total - 2.2))
cmd += ['-filter_complex', ';'.join(fc), '-map', '[v]']
venc = ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryfast' if args.preview else 'slow', '-pix_fmt', 'yuv420p',
        '-aq-mode', '3', '-x264-params', 'deblock=-1,-1:psy-rd=1.0,0.15', '-r', str(fps), '-t', '%.3f' % total]
print('total %.2fs' % total)
if args.bitrate:
    log = args.out + '.2pass'
    subprocess.run(cmd + venc + ['-b:v', args.bitrate, '-pass', '1', '-passlogfile', log, '-an', '-f', 'null', '/dev/null'], check=True)
    venc += ['-b:v', args.bitrate, '-pass', '2', '-passlogfile', log]
else:
    venc += ['-crf', args.crf]
if args.audio:
    venc += ['-map', '%d:a' % len(CUT), '-c:a', 'aac', '-b:a', '160k']
subprocess.run(cmd + venc + ['-movflags', '+faststart', args.out], check=True)
