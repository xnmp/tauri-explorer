# The Valley: source

Every pixel and every sample of `the-valley.mp4` comes from the code in this folder: a scripted,
headless Blender (Cycles) scene, a numpy soundtrack, and an ffmpeg edit. No footage, textures, models,
image or video generators, or network services.

| File | Role |
| --- | --- |
| `world.py` | The valley as numpy: noise, heightfield, per-vertex albedo, tree/sapling/grass placement, camera clearings |
| `trees.py` | Procedural spruce and grass-tuft meshes |
| `crane.py` | Red-crowned crane: mesh parts on a joint hierarchy, IK legs, wingbeat, take-off choreography |
| `common.py` | Node helpers, water shader (with wake rings), Cycles settings |
| `build.py` | Builds the static scene and saves `valley.blend` |
| `shots.py` | Shot table (cameras, sun, mist, cranes); renders frames with a GPU duty cycle and a thermal gate |
| `audio.py` | Soundtrack synthesis (wind, water, sustained tone, crane calls, take-off) |
| `edit.py` | Conform: per-shot grade, dissolves, halation, grain, fades, mux |

Needs Blender 5.x with Cycles on a GPU (rendered on 5.2.3, OptiX), Python 3 with numpy, ffmpeg with
libx264. Intermediates go to `$VALLEY_SCRATCH` (default `/tmp/valley-film`), never into this folder.

## Re-render

```sh
export VALLEY_SCRATCH=/tmp/valley-film
cd src

# 1. scene (about 20 s; the heightfield is cached in $VALLEY_SCRATCH/cache)
blender -b --factory-startup -P build.py

# 2. frames: one shot at a time, 1600x900, 24 samples + OIDN (about 5 s a frame on an RTX 3070)
for s in 1 2 3 4a 4b 5; do
  taskset -c 0,1 nice -n 19 blender -b -t 2 $VALLEY_SCRATCH/valley.blend -P shots.py -- --shot $s --out $VALLEY_SCRATCH/final
done

# 3. sound
python3 audio.py $VALLEY_SCRATCH/the-valley.wav

# 4. edit (upscales to 1920x1080, grades, two-pass H.264 high / AAC, +faststart; omit --bitrate for CRF 18, about 49 MB)
python3 edit.py --frames $VALLEY_SCRATCH/final --audio $VALLEY_SCRATCH/the-valley.wav --bitrate 3350k --out ../the-valley.mp4
```

Rendering resumes: frames already on disk are skipped. `shots.py` pauses 5 s after every 30 s of
rendering and waits whenever `sensors`/`nvidia-smi` report more than 85 C.

Stills and tests:

```sh
# three frames of a shot at half size
blender -b $VALLEY_SCRATCH/valley.blend -P shots.py -- --shot 4b --frames 30,90,200 --pct 50
# any camera: x,y,z,tx,ty,tz,focal (negative z = metres above the ground); numeric shot overrides
blender -b $VALLEY_SCRATCH/valley.blend -P shots.py -- --shot 3 --frames 0 --cam -820,-760,-25,100,100,-80,24 --set sun_el=17
# low-res animatic: render with --step 2 --pct 34 --samples 12, then edit.py --preview
```

Poster and contact sheet:

```sh
ffmpeg -ss 11.0 -i ../the-valley.mp4 -frames:v 1 -c:v libwebp -quality 88 ../the-valley-poster.webp
ffmpeg -i ../the-valley.mp4 -vf "fps=15/39.85,scale=640:-1,tile=5x3:padding=6:margin=6" -frames:v 1 ../the-valley-contact.png
```

A silent copy: `ffmpeg -i the-valley.mp4 -an -c:v copy the-valley-silent.mp4`.
