"""Builds the static valley (terrain, lake, sky, mist, pines, crane rigs) and saves valley.blend.

    blender -b --factory-startup -P build.py
"""
import math
import os
import sys
import time

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
import crane
import trees
import world
from common import NT, CACHE

T0 = time.time()


def log(*a):
    print('[build %6.1fs]' % (time.time() - T0), *a, flush=True)


for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
scene = bpy.context.scene
coll = scene.collection


mesh_from = common.mesh_from


# ---------------------------------------------------------------- terrain
ax, Z = world.grid(CACHE)
N = world.N
X, Y = np.meshgrid(ax, ax, indexing='xy')
verts = np.stack([X, Y, Z], -1).reshape(-1, 3)
i = np.arange(N - 1)
I, J = np.meshgrid(i, i, indexing='xy')
a = (J * N + I).ravel()
faces = np.stack([a, a + 1, a + N + 1, a + N], 1)
me = mesh_from('Terrain', verts, faces, 4)
me.shade_smooth()
col, snow = world.albedo(CACHE)
attr = me.color_attributes.new('col', 'FLOAT_COLOR', 'POINT')
rgba = np.concatenate([col, snow[..., None]], -1).astype(np.float32)
attr.data.foreach_set('color', rgba.ravel())
terrain = bpy.data.objects.new('Terrain', me)
coll.objects.link(terrain)
log('terrain', len(verts))

mat = bpy.data.materials.new('Ground')
mat.use_nodes = True
nt = NT(mat.node_tree)
at = nt.n('ShaderNodeAttribute', attribute_name='col')
geo = nt.n('ShaderNodeNewGeometry')
n1 = nt.n('ShaderNodeTexNoise', ins={'Vector': geo.outputs['Position'], 'Scale': 0.35, 'Detail': 6.0, 'Roughness': 0.6})
n2 = nt.n('ShaderNodeTexNoise', ins={'Vector': geo.outputs['Position'], 'Scale': 0.04, 'Detail': 5.0, 'Roughness': 0.55})
var = nt.math('ADD', nt.math('MULTIPLY', n1.outputs['Fac'], 0.5), 0.75)
colv = nt.vmath('SCALE', at.outputs['Color'], scale=var)
hsum = nt.math('ADD', nt.math('MULTIPLY', n1.outputs['Fac'], 0.25), nt.math('MULTIPLY', n2.outputs['Fac'], 2.5))
bump = nt.n('ShaderNodeBump', ins={'Strength': 0.9, 'Distance': 1.0, 'Height': hsum})
rough = nt.math('SUBTRACT', 0.92, nt.math('MULTIPLY', at.outputs['Alpha'], 0.42))
bsdf = nt.n('ShaderNodeBsdfPrincipled', ins={'Base Color': colv, 'Roughness': rough, 'Normal': bump,
                                               'Specular IOR Level': 0.35})
out = nt.n('ShaderNodeOutputMaterial', ins={'Surface': bsdf})
me.materials.append(mat)

# far lowland beyond the gap so the world has no edge
me = mesh_from('Lowland', [(-3000, -30000, -260), (40000, -30000, -260), (40000, 30000, -260), (-3000, 30000, -260)],
               [(0, 1, 2, 3)], 4)
low = bpy.data.objects.new('Lowland', me)
coll.objects.link(low)
lm = bpy.data.materials.new('Lowland')
lm.use_nodes = True
nt = NT(lm.node_tree)
b = nt.n('ShaderNodeBsdfPrincipled', ins={'Base Color': (0.07, 0.085, 0.06, 1), 'Roughness': 0.95})
nt.n('ShaderNodeOutputMaterial', ins={'Surface': b})
me.materials.append(lm)

# ---------------------------------------------------------------- water
me = mesh_from('Water', [(-520, -480, 0), (925, -480, 0), (925, 480, 0), (-520, 480, 0)], [(0, 1, 2, 3)], 4)
water = bpy.data.objects.new('Water', me)
coll.objects.link(water)
wm = bpy.data.materials.new('Water')
wm.use_nodes = True
me.materials.append(wm)


common.build_water(wm)
log('water')

# ---------------------------------------------------------------- world
w = scene.world or bpy.data.worlds.new('World')
scene.world = w
w.use_nodes = True
nt = NT(w.node_tree)
sky = nt.n('ShaderNodeTexSky', name='SKY', sky_type='MULTIPLE_SCATTERING', sun_disc=False)
sky.sun_elevation = math.radians(8)
# thin high cloud, drawn in the sky itself: project the view ray onto a plane
tc = nt.n('ShaderNodeTexCoord')
sep = nt.n('ShaderNodeSeparateXYZ', ins={'Vector': tc.outputs['Generated']})
zc = nt.math('MAXIMUM', sep.outputs['Z'], 0.02)
plane = nt.n('ShaderNodeCombineXYZ', ins={'X': nt.math('DIVIDE', sep.outputs['X'], zc),
                                          'Y': nt.math('DIVIDE', sep.outputs['Y'], zc), 'Z': 0.0})
cl = nt.n('ShaderNodeTexNoise', name='CLOUDN', ins={'Vector': nt.vmath('MULTIPLY', plane, (1.5, 0.3, 1.0)), 'Scale': 0.8,
                                                     'Detail': 7.0, 'Roughness': 0.62, 'Distortion': 0.6})
cm = nt.n('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP',
          ins={'Value': cl.outputs['Fac'], 'From Min': 0.46, 'From Max': 0.68, 'To Min': 0.0, 'To Max': 1.0})
horizon_fade = nt.n('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP',
                    ins={'Value': sep.outputs['Z'], 'From Min': 0.03, 'From Max': 0.22, 'To Min': 0.0, 'To Max': 1.0})
cmask = nt.math('MULTIPLY', nt.math('MULTIPLY', cm.outputs[0], horizon_fade.outputs[0]), nt.value('CLOUD_AMT', 0.8))
ccol = nt.n('ShaderNodeRGB', name='CLOUD_COL')
ccol.outputs[0].default_value = (1.0, 0.55, 0.42, 1)
cstr = nt.vmath('SCALE', ccol.outputs[0], scale=nt.value('CLOUD_STR', 0.6))
mix = nt.n('ShaderNodeMix', data_type='RGBA', ins={'Factor': cmask})
tint = nt.n('ShaderNodeRGB', name='SKY_TINT')
tint.outputs[0].default_value = (1, 1, 1, 1)
nt.t.links.new(nt.vmath('MULTIPLY', sky.outputs[0], tint.outputs[0]), mix.inputs['A'])
nt.t.links.new(cstr, mix.inputs['B'])
bg = nt.n('ShaderNodeBackground', name='BG', ins={'Color': mix.outputs['Result'], 'Strength': 1.0})
nt.n('ShaderNodeOutputWorld', ins={'Surface': bg})

sun_d = bpy.data.lights.new('Sun', 'SUN')
sun_d.angle = math.radians(1.2)
sun = bpy.data.objects.new('Sun', sun_d)
coll.objects.link(sun)

# ---------------------------------------------------------------- mist + haze


def box(name, lo, hi):
    x0, y0, z0 = lo
    x1, y1, z1 = hi
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    o = bpy.data.objects.new(name, mesh_from(name, v, f, 4))
    coll.objects.link(o)
    return o


mist = box('Mist', (-1500, -1400, -300), (3200, 1400, 170))
mm = bpy.data.materials.new('Mist')
mm.use_nodes = True
nt = NT(mm.node_tree)
t = nt.value('TIME', 0.0)
geo = nt.n('ShaderNodeNewGeometry')
P = geo.outputs['Position']
wind = nt.n('ShaderNodeCombineXYZ', ins={'X': nt.math('MULTIPLY', t, 1.6), 'Y': nt.math('MULTIPLY', t, 0.5),
                                         'Z': nt.math('MULTIPLY', t, -0.25)})
pw = nt.vmath('MULTIPLY', nt.vmath('ADD', P, wind), (1.0, 1.0, 2.6))
big = nt.n('ShaderNodeTexNoise', ins={'Vector': nt.vmath('ADD', P, wind), 'Scale': 0.0021, 'Detail': 2.0})
bigm = nt.n('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', ins={'Value': big.outputs['Fac'], 'From Min': 0.36, 'From Max': 0.66, 'To Min': 0.08, 'To Max': 1.0})
nz = nt.n('ShaderNodeTexNoise', ins={'Vector': pw, 'Scale': 0.0075, 'Detail': 5.0, 'Roughness': 0.58, 'Distortion': 0.4})
banks = nt.n('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP',
             ins={'Value': nz.outputs['Fac'], 'From Min': 0.40, 'From Max': 0.70, 'To Min': 0.0, 'To Max': 1.0})
zraw = nt.n('ShaderNodeSeparateXYZ', ins={'Vector': P}).outputs['Z']
zz = nt.math('MAXIMUM', zraw, 0.0)
hgt = nt.value('MIST_H', 24.0)
hf = nt.math('POWER', 2.718, nt.math('DIVIDE', nt.math('MULTIPLY', zz, -1.0), hgt))
skin = nt.math('POWER', 2.718, nt.math('MULTIPLY', zz, -0.22))
bk = nt.math('MULTIPLY', banks.outputs[0], bigm.outputs[0])
body = nt.math('MULTIPLY', hf, nt.math('ADD', nt.value('MIST_BASE', 0.22), bk))
low = nt.math('MULTIPLY', nt.math('MULTIPLY', skin, bk), nt.value('MIST_SKIN', 2.0))
dens = nt.math('MULTIPLY', nt.math('ADD', body, low), nt.value('MIST_D', 0.006))
dens = nt.math('ADD', dens, nt.value('HAZE_D', 0.00009))
vs = nt.n('ShaderNodeVolumeScatter', ins={'Color': (0.92, 0.95, 1.0, 1), 'Density': dens, 'Anisotropy': nt.value('MIST_G', 0.55)})
nt.n('ShaderNodeOutputMaterial', ins={'Volume': vs})
common.drive_time(mm.node_tree)
mist.data.materials.append(mm)

haze = box('Haze', (-9000, -9000, 170), (30000, 9000, 2600))
hm = bpy.data.materials.new('Haze')
hm.use_nodes = True
nt = NT(hm.node_tree)
vs = nt.n('ShaderNodeVolumeScatter', ins={'Color': (0.80, 0.88, 1.0, 1), 'Density': nt.value('HAZE_D', 0.00009),
                                          'Anisotropy': 0.35})
nt.n('ShaderNodeOutputMaterial', ins={'Volume': vs})
haze.data.materials.append(hm)
for o in (mist, haze):
    o.visible_shadow = False
    o.display_type = 'WIRE'
log('volumes')

# ---------------------------------------------------------------- pines
bark = bpy.data.materials.new('Bark')
bark.use_nodes = True
nt = NT(bark.node_tree)
b = nt.n('ShaderNodeBsdfPrincipled', ins={'Base Color': (0.055, 0.04, 0.03, 1), 'Roughness': 0.9})
nt.n('ShaderNodeOutputMaterial', ins={'Surface': b})
needle = bpy.data.materials.new('Needles')
needle.use_nodes = True
nt = NT(needle.node_tree)
oi = nt.n('ShaderNodeObjectInfo')
ramp = nt.n('ShaderNodeMix', data_type='RGBA', ins={'Factor': oi.outputs['Random'], 'A': (0.018, 0.045, 0.022, 1),
                                                   'B': (0.035, 0.065, 0.02, 1)})
b = nt.n('ShaderNodeBsdfPrincipled', ins={'Base Color': ramp.outputs['Result'], 'Roughness': 0.55,
                                          'Specular IOR Level': 0.3})
tr = nt.n('ShaderNodeBsdfTranslucent', ins={'Color': (0.10, 0.20, 0.05, 1)})
mx = nt.n('ShaderNodeMixShader', ins={'Fac': 0.22})
nt.t.links.new(b.outputs[0], mx.inputs[1])
nt.t.links.new(tr.outputs[0], mx.inputs[2])
nt.n('ShaderNodeOutputMaterial', ins={'Surface': mx})

tp = world.place_trees(CACHE)
np.save(os.path.join(CACHE, 'trees.npy'), tp)
NVAR = 4
for v in range(NVAR):
    tv, tf, tm = trees.spruce(100 + v, detail=1.5)
    tme = mesh_from('Spruce%d' % v, tv, tf, 3)
    tme.materials.append(bark)
    tme.materials.append(needle)
    tme.polygons.foreach_set('material_index', tm.astype(np.int32))
    tme.update()
    tob = bpy.data.objects.new('Spruce%d' % v, tme)
    coll.objects.link(tob)
    sel = tp[tp[:, 5] == v]
    n = len(sel)
    h = sel[:, 3]
    yaw = sel[:, 4]
    c, s = np.cos(yaw), np.sin(yaw)
    corners = np.array([(-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)])
    pv = np.empty((n, 4, 3))
    for k, (cx, cy) in enumerate(corners):
        pv[:, k, 0] = sel[:, 0] + (cx * c - cy * s) * h
        pv[:, k, 1] = sel[:, 1] + (cx * s + cy * c) * h
        pv[:, k, 2] = sel[:, 2] - 0.02 * h
    pf = np.arange(n * 4).reshape(n, 4)
    pme = mesh_from('Grove%d' % v, pv.reshape(-1, 3), pf, 4)
    pob = bpy.data.objects.new('Grove%d' % v, pme)
    coll.objects.link(pob)
    pob.instance_type = 'FACES'
    pob.use_instance_faces_scale = True
    pob.instance_faces_scale = 1.0
    pob.show_instancer_for_render = False
    tob.parent = pob
    log('grove', v, n, 'trees of', len(tf), 'tris')

# ---------------------------------------------------------------- grass near the ground-level cameras
gm = bpy.data.materials.new('Grass')
gm.use_nodes = True
nt = NT(gm.node_tree)
oi = nt.n('ShaderNodeObjectInfo')
ramp = nt.n('ShaderNodeMix', data_type='RGBA', ins={'Factor': oi.outputs['Random'], 'A': (0.035, 0.065, 0.02, 1),
                                                   'B': (0.085, 0.10, 0.035, 1)})
bb = nt.n('ShaderNodeBsdfPrincipled', ins={'Base Color': ramp.outputs['Result'], 'Roughness': 0.5})
tr = nt.n('ShaderNodeBsdfTranslucent', ins={'Color': (0.16, 0.22, 0.05, 1)})
mx = nt.n('ShaderNodeMixShader', ins={'Fac': 0.3})
nt.t.links.new(bb.outputs[0], mx.inputs[1])
nt.t.links.new(tr.outputs[0], mx.inputs[2])
nt.n('ShaderNodeOutputMaterial', ins={'Surface': mx})
tf = world.place_tufts(CACHE)
for v in range(3):
    gv, gf = trees.tuft(v)
    gme = mesh_from('Tuft%d' % v, gv, gf, 3)
    gme.materials.append(gm)
    gob = bpy.data.objects.new('Tuft%d' % v, gme)
    coll.objects.link(gob)
    sel = tf[v::3]
    n = len(sel)
    c, s = np.cos(sel[:, 4]), np.sin(sel[:, 4])
    pv = np.empty((n, 4, 3))
    for k, (cx, cy) in enumerate([(-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)]):
        pv[:, k, 0] = sel[:, 0] + (cx * c - cy * s) * sel[:, 3]
        pv[:, k, 1] = sel[:, 1] + (cx * s + cy * c) * sel[:, 3]
        pv[:, k, 2] = sel[:, 2] - 0.02
    pme = mesh_from('Sward%d' % v, pv.reshape(-1, 3), np.arange(n * 4).reshape(n, 4), 4)
    pob = bpy.data.objects.new('Sward%d' % v, pme)
    coll.objects.link(pob)
    pob.instance_type = 'FACES'
    pob.use_instance_faces_scale = True
    pob.show_instancer_for_render = False
    gob.parent = pob
log('tufts', len(tf))

# ---------------------------------------------------------------- cranes + camera
crane.build_all(coll, count=crane.COUNT)
cam_d = bpy.data.cameras.new('Cam')
cam_d.sensor_width = 36.0
cam_d.clip_start = 0.3
cam_d.clip_end = 60000
cam = bpy.data.objects.new('Cam', cam_d)
coll.objects.link(cam)
scene.camera = cam

common.setup_cycles(scene)
os.makedirs(common.SCRATCH, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=common.BLEND, compress=False)
log('saved', common.BLEND)
