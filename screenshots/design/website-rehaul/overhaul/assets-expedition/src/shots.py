"""Configures one shot in valley.blend and renders frames.

    blender -b valley.blend -P shots.py -- --shot 1 [--frames 0,48,96 | --range 0 191] [--pct 50] [--samples 48] [--out DIR]
"""
import argparse
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
import crane
import world
from common import CACHE, FPS

ap = argparse.ArgumentParser()
ap.add_argument('--shot', required=True)
ap.add_argument('--frames', default='')
ap.add_argument('--range', nargs=2, type=int)
ap.add_argument('--step', type=int, default=1)
ap.add_argument('--pct', type=int, default=100)
ap.add_argument('--samples', type=int, default=24)
ap.add_argument('--size', default='1600x900', help='render size before --pct; the edit upscales to 1920x1080')
ap.add_argument('--out', default=os.path.join(common.SCRATCH, 'frames'))
ap.add_argument('--tag', default='')
ap.add_argument('--hook', default='', help='python file to exec after the shot is configured, instead of rendering')
ap.add_argument('--cam', default='', help='x,y,z,tx,ty,tz,focal still-camera override (z<0: metres above ground)')
ap.add_argument('--set', default='', help='k=v,k=v numeric overrides of the shot table')
args = ap.parse_args(sys.argv[sys.argv.index('--') + 1:])

scene = bpy.context.scene
D = bpy.data


def H(x, y):
    return float(world.height(CACHE, x, y))


def ss(a, b, x):
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def v3(*a):
    return np.array(a, dtype=float)


# ---------------------------------------------------------------- shot table
# cam(u) with u in [0,1] returns (position, look-at target, focal mm, focus distance m or None, f-stop, roll deg)
def shot1(u):  # blue hour on the lake, slow push toward the first light on the west wall
    e = ss(0, 1, u) * 0.4 + u * 0.6
    p = v3(lerp(240, 212, e), lerp(-24, -18, e), lerp(1.1, 1.5, e))
    return p, v3(-900, 60, lerp(150, 138, e)), 38.0, None, 8.0, 0.0


def shot2(u):  # through the pines, lateral drift, the sun coming through the gap
    p = v3(lerp(466, 468, u), lerp(-42, -30, u), 0)
    p[2] = H(467, -36) + 1.6
    return p, v3(900, lerp(-36, -28, u), lerp(52, 58, u)), 30.0, None, 8.0, 0.0


def shot3(u):  # the reveal: up and over the snow of the south-west rim
    e = ss(0, 1, u) * 0.7 + u * 0.3
    p = v3(lerp(-872, -815, e), lerp(-832, -752, e), 0)
    p[2] = max(H(-872, -832), H(-860, -815)) + lerp(2.5, 28.0, e)
    return p, v3(lerp(160, 120, e), lerp(240, 130, e), lerp(420, 10, e)), 24.0, None, 11.0, 0.0


_FL = {}


def flock_pos(t):
    """(COUNT, 3) crane body positions at flock-clock time t."""
    if not _FL:
        _FL['cr'] = crane.flock(H)
        _FL['sim'] = [crane.simulate(c, H, -1.0, 40.0, 1.0 / 48) for c in _FL['cr']]
    out = []
    for c, sim in zip(_FL['cr'], _FL['sim']):
        k = int(min(max((t + 1.0) * 48, 0), len(sim['T']) - 1))
        out.append(crane.state_at(c, sim, k, H)[0])
    return np.array(out, dtype=float)


def shot_dbg(u):  # close inspection of the caller
    t = u * 9.0
    c = flock_pos(t)[1]
    return c + v3(9.0, -6.0, 0.6), c + v3(0, 0, 0.1), 85.0, None, 8.0, 0.0


_TR = {}


def track(t, lead=1.0, tau=0.55):
    """Tripod operator: a lagging, smoothed aim point on the flock (flock clock)."""
    if not _TR:
        ts = np.arange(-1.0, 30.0, 1.0 / 48)
        aim = np.zeros(3)
        out = []
        for i, tt in enumerate(ts):
            P = flock_pos(tt)
            c = P.mean(0) * 0.6 + P[np.argsort(P[:, 1])[-2:]].mean(0) * 0.4
            aim = c if i == 0 else aim + (c - aim) * (1 - math.exp(-(1.0 / 48) / tau))
            out.append(aim.copy())
        _TR['t'], _TR['p'] = ts, np.array(out)
    return np.array([np.interp(t, _TR['t'], _TR['p'][:, i]) for i in range(3)])


T4A, T4B, T5 = 0.6, 3.1, 13.0      # flock-clock time at the first frame of each crane shot
CAM4 = (-392.0, 6.0)


def shot4a(u):  # the cranes at the lake edge; one calls
    t = T4A + u * 3.0
    P = flock_pos(1.0)
    aim = P[[0, 1, 2, 3]].mean(0) + v3(0, lerp(-0.4, 0.4, u), 0.85)
    p = v3(CAM4[0], CAM4[1], H(*CAM4) + 0.8)
    return p, aim, 300.0, float(np.linalg.norm(P[1] - p)), 6.3, 0.0


def shot4b(u):  # they run, lift off low across the water; long lens, panning with them
    t = T4B + u * 9.0
    aim = track(t)
    p = v3(CAM4[0], CAM4[1], H(*CAM4) + 1.15)
    aim = aim + v3(0, 0, lerp(1.4, 0.7, ss(0.2, 0.8, u)))
    return p, aim, 220.0, float(np.linalg.norm(aim - p)), 6.3, 0.0


def shot5(u):  # closing wide: they climb into the light pouring through the gap
    t = T5 + u * 7.5
    aim = track(t, tau=1.2)
    p = v3(lerp(-345, -343, u), 100.0, H(-345, 100) + lerp(1.4, 1.6, u))
    el = math.radians(lerp(5.5, 10.5, ss(0, 1, u)))
    az = math.radians(-9.0)
    tgt = p + v3(math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)) * 100
    return p, tgt, 70.0, None, 8.0, 0.0


COMMON = dict(sky=1.0, haze=0.00010, mist_h=22.0, mist_base=0.25, mist_skin=1.5)
SHOTS = {
    'dbg': dict(COMMON, n=217, cam=shot_dbg, sun_el=14.0, sun_az=0.0, sun_str=14.0, sun_col=(1.0, 0.78, 0.55), exposure=-2.3,
                mist_d=0.002, cloud=(0.6, 2.0, (1.0, 0.8, 0.66)), cranes=dict(t0=0.0)),
    '1': dict(COMMON, n=204, cam=shot1, sun_el=(0.25, 1.7), sun_az=3.0, sun_str=(2.0, 6.0), sun_col=(1.0, 0.34, 0.20),
              exposure=-0.2, mist_d=0.006, mist_h=10.0, mist_base=0.03, mist_skin=3.0, sky_tint=(0.72, 0.86, 1.2),
              cloud=(0.9, 0.9, (1.0, 0.40, 0.36))),
    '2': dict(COMMON, n=168, cam=shot2, sun_el=8.5, sun_az=0.0, sun_str=14.0, sun_col=(1.0, 0.72, 0.45), exposure=-2.3,
              mist_d=0.020, mist_base=0.5, mist_skin=0.6, mist_g=0.7, cloud=(0.6, 2.0, (1.0, 0.75, 0.6))),
    '3': dict(COMMON, n=192, cam=shot3, sun_el=20.0, sun_az=0.0, sun_str=18.0, sun_col=(1.0, 0.82, 0.60), exposure=-2.8,
              mist_d=0.007, haze=0.00012, cloud=(0.7, 2.6, (1.0, 0.82, 0.68))),
    '4a': dict(COMMON, n=72, cam=shot4a, sun_el=19.0, sun_az=-32.0, sun_str=15.0, sun_col=(1.0, 0.76, 0.52), exposure=-2.2,
               mist_d=0.0012, mist_base=0.10, mist_skin=0.4, mist_g=0.35, haze=0.00005, sky_tint=(1.1, 0.96, 0.82),
               cloud=(0.6, 2.2, (1.0, 0.8, 0.66)), cranes=dict(t0=T4A)),
    '4b': dict(COMMON, n=216, cam=shot4b, sun_el=19.0, sun_az=-32.0, sun_str=15.0, sun_col=(1.0, 0.76, 0.52), exposure=-2.2,
               mist_d=0.0012, mist_base=0.10, mist_skin=0.4, mist_g=0.35, haze=0.00005, sky_tint=(1.1, 0.96, 0.82),
               cloud=(0.6, 2.2, (1.0, 0.8, 0.66)), cranes=dict(t0=T4B)),
    '5': dict(COMMON, n=180, cam=shot5, sun_el=13.5, sun_az=0.0, sun_str=15.0, sun_col=(1.0, 0.76, 0.52), exposure=-3.3,
              mist_d=0.0022, mist_base=0.12, mist_skin=0.8, mist_g=0.4, haze=0.00006, sky_tint=(1.12, 0.95, 0.78), cloud=(0.6, 2.2, (1.0, 0.8, 0.66)), cranes=dict(t0=T5)),
}


# ---------------------------------------------------------------- apply
S = dict(SHOTS[args.shot])
for kv in filter(None, args.set.split(',')):
    k, v = kv.split('=')
    S[k] = float(v)
if args.cam:
    c = [float(x) for x in args.cam.split(',')]
    if c[2] < 0:
        c[2] = H(c[0], c[1]) - c[2]
    S['cam'] = lambda u: (v3(*c[:3]), v3(*c[3:6]), c[6], None, 8.0, 0.0)
n = S['n']
scene.frame_start, scene.frame_end = 0, n - 1
W, Hh = (int(v) for v in args.size.split('x'))
common.setup_cycles(scene, samples=args.samples, pct=args.pct, width=W, height=Hh)
scene.view_settings.exposure = S['exposure']

def pair(v):
    return v if isinstance(v, tuple) else (v, v)


sun = D.objects['Sun']
sun.rotation_mode = 'QUATERNION'
sun.animation_data_clear()
sun.data.animation_data_clear()
sun.data.color = S['sun_col']
az = math.radians(S['sun_az'])
sk = {('rotation_quaternion', i): [] for i in range(4)}
ek = []
for f in (-1, n):
    u = (f + 1) / (n + 1)
    el = math.radians(lerp(*pair(S['sun_el']), u))
    q = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el))).to_track_quat('Z', 'Y')
    for i in range(4):
        sk[('rotation_quaternion', i)].append((f, q[i]))
    ek.append((f, lerp(*pair(S['sun_str']), u)))
common.bake(sun, sk)
common.bake(sun.data, {('energy', -1): ek})
el = math.radians(sum(pair(S['sun_el'])) / 2)
wn = scene.world.node_tree.nodes
sky = wn['SKY']
sky.sun_elevation = max(el, math.radians(0.3))
sky.sun_rotation = math.radians(90) - az
wn['BG'].inputs['Strength'].default_value = S['sky']
wn['CLOUD_AMT'].outputs[0].default_value = S['cloud'][0]
wn['CLOUD_STR'].outputs[0].default_value = S['cloud'][1]
wn['CLOUD_COL'].outputs[0].default_value = (*S['cloud'][2], 1)
mn = D.materials['Mist'].node_tree.nodes
mn['MIST_D'].outputs[0].default_value = S['mist_d']
mn['MIST_H'].outputs[0].default_value = S['mist_h']
mn['MIST_BASE'].outputs[0].default_value = S['mist_base']
mn['MIST_SKIN'].outputs[0].default_value = S['mist_skin']
mn['MIST_G'].outputs[0].default_value = S.get('mist_g', 0.55)
D.materials['Haze'].node_tree.nodes['HAZE_D'].outputs[0].default_value = S['haze']
mn['HAZE_D'].outputs[0].default_value = S['haze']
wn['SKY_TINT'].outputs[0].default_value = (*S.get('sky_tint', (1, 1, 1)), 1)

rings = crane.animate(scene, S.get('cranes'), n, H) if crane.COUNT else []
common.build_water(D.materials['Water'], rings)
D.materials['Water'].node_tree.nodes['RIPPLE'].outputs[0].default_value = S.get('ripple', 1.0)

cam = D.objects['Cam']
cam.rotation_mode = 'QUATERNION'
cam.animation_data_clear()
cam.data.animation_data_clear()
keys = {('location', i): [] for i in range(3)}
keys.update({('rotation_quaternion', i): [] for i in range(4)})
lens, focus = [], []
prev = None
for f in range(-1, n + 1):
    u = min(max(f / (n - 1), -0.02), 1.02)
    p, tgt, focal, fd, fstop, roll = S['cam'](u)
    q = (Vector(tgt) - Vector(p)).to_track_quat('-Z', 'Y')
    if prev is not None and prev.dot(q) < 0:
        q.negate()
    prev = q.copy()
    for i in range(3):
        keys[('location', i)].append((f, p[i]))
    for i in range(4):
        keys[('rotation_quaternion', i)].append((f, q[i]))
    lens.append((f, focal))
    focus.append((f, fd if fd else 100.0))
    cam.data.dof.use_dof = fd is not None
    cam.data.dof.aperture_fstop = fstop
common.bake(cam, keys)
common.bake(cam.data, {('lens', -1): lens, ('dof.focus_distance', -1): focus})

if args.hook:
    scene.frame_set(0)
    exec(open(args.hook).read())
    sys.exit(0)
frames = [int(x) for x in args.frames.split(',')] if args.frames else list(
    range(args.range[0], args.range[1] + 1, args.step)) if args.range else list(range(n))
out = os.path.join(args.out, 's' + args.shot + args.tag)
os.makedirs(out, exist_ok=True)
import re
import subprocess


def temps():
    """(cpu, gpu) in deg C, best effort."""
    cpu = gpu = 0.0
    try:
        out = subprocess.run(['sensors'], capture_output=True, text=True, timeout=5).stdout
        cpu = max([float(m) for m in re.findall(r'(?:Tctl|Tdie|Package id 0):\s+\+([0-9.]+)', out)] or [0.0])
    except Exception:
        pass
    try:
        out = subprocess.run(['nvidia-smi', '--query-gpu=temperature.gpu', '--format=csv,noheader'],
                             capture_output=True, text=True, timeout=5).stdout
        gpu = float(out.strip().splitlines()[0])
    except Exception:
        pass
    return cpu, gpu


def thermal_gate(peak):
    """Pause while anything is above 85 C, until it is back under 70 C."""
    cpu, gpu = temps()
    peak[0], peak[1] = max(peak[0], cpu), max(peak[1], gpu)
    if max(cpu, gpu) > 85:
        print('THERMAL pause at cpu %.0f gpu %.0f' % (cpu, gpu), flush=True)
        while max(temps()) > 70:
            time.sleep(20)
    return cpu, gpu


BURST, REST = 30.0, 5.0      # GPU duty cycle: seconds of rendering, then seconds idle
peak = [0.0, 0.0]
busy = 0.0
last_check = 0.0
t0 = time.time()
for k, f in enumerate(frames):
    path = os.path.join(out, '%04d.png' % f)
    if os.path.exists(path) and not args.frames:
        continue
    if time.time() - last_check > 120:
        thermal_gate(peak)
        last_check = time.time()
    scene.frame_set(f)
    scene.render.filepath = path
    t1 = time.time()
    bpy.ops.render.render(write_still=True)
    busy += time.time() - t1
    print('[shot %s] frame %d  %.1fs  (%d/%d, elapsed %.0fs, peak cpu %.0f gpu %.0f)' % (
        args.shot, f, time.time() - t1, k + 1, len(frames), time.time() - t0, peak[0], peak[1]), flush=True)
    if busy >= BURST:
        time.sleep(REST)
        busy = 0.0
