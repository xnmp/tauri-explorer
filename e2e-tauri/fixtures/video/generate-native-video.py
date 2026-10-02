"""Create real VP8 fixtures; the large WebM contains encoded packets, never padding."""
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)

def ffmpeg(arguments):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *arguments], check=True)

def colors(output, first, second, first_seconds, second_seconds):
    ffmpeg(['-f', 'lavfi', '-i', f'color=c={first}:s=320x180:r=15:d={first_seconds}',
            '-f', 'lavfi', '-i', f'color=c={second}:s=320x180:r=15:d={second_seconds}',
            '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]', '-map', '[v]',
            '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-threads', '2',
            '-b:v', '300k', '-g', '15', '-an', str(output)])

colors(root / 'colors.webm', 'red', 'blue', 3, 3)
colors(root / 'replacement.webm', 'blue', 'red', 5, 3)
seed = root / 'encoded-noise-seed.webm'
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=12,noise=alls=100:allf=t+u',
        '-t', '12', '-an', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8',
        '-threads', '2', '-b:v', '8M', '-qmin', '4', '-qmax', '20', '-g', '24', str(seed)])
# Re-muxing repeats actual encoded packets and writes usable duration/cue metadata.
loops = math.ceil(1.12 * 1024 ** 3 / seed.stat().st_size)
large = root / 'streaming-noise.webm'
ffmpeg(['-stream_loop', str(loops), '-i', str(seed), '-map', '0:v:0', '-c:v', 'copy', '-an', str(large)])
if large.stat().st_size < 1024 ** 3:
    raise RuntimeError('Representative encoded WebM is smaller than 1 GiB')
records = {}
for file in [root / 'colors.webm', root / 'replacement.webm', seed, large]:
    probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
        'stream=codec_name,width,height:format=duration,size', '-of', 'json', str(file)], text=True))
    with file.open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
    records[file.name] = {'path': str(file), 'bytes': file.stat().st_size,
                         'allocatedBytes': file.stat().st_blocks * 512,
                         'sha256': digest, 'probe': probe}
(root / 'fixtures.json').write_text(json.dumps({'encodedPacketsRepeated': True,
    'sparsePadding': False, 'seedLoops': loops, 'files': records}, indent=2) + '\n')
print(json.dumps({'root': str(root), 'largeBytes': large.stat().st_size,
                  'seedBytes': seed.stat().st_size, 'loops': loops}))
