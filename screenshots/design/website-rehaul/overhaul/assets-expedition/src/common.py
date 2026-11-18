"""Shared Blender helpers: paths, node wiring, Cycles setup."""
import os
import bpy

SCRATCH = os.environ.get('VALLEY_SCRATCH', '/tmp/valley-film')
CACHE = os.path.join(SCRATCH, 'cache')
BLEND = os.path.join(SCRATCH, 'valley.blend')
FPS = 24


class NT:
    """Tiny node-tree builder."""

    def __init__(self, tree, clear=True):
        self.t = tree
        if clear:
            tree.nodes.clear()

    def n(self, kind, name=None, **kw):
        node = self.t.nodes.new(kind)
        if name:
            node.name = name
            node.label = name
        ins = kw.pop('ins', {})
        for k, v in kw.items():
            setattr(node, k, v)
        for k, v in ins.items():
            self.set(node, k, v)
        return node

    def set(self, node, key, v):
        sock = node.inputs[key]
        if isinstance(v, bpy.types.NodeSocket):
            self.t.links.new(v, sock)
        elif isinstance(v, bpy.types.Node):
            self.t.links.new(v.outputs[0], sock)
        else:
            sock.default_value = v

    def math(self, op, a, b=None, c=None, clamp=False):
        node = self.t.nodes.new('ShaderNodeMath')
        node.operation = op
        node.use_clamp = clamp
        for i, v in enumerate((a, b, c)):
            if v is not None:
                self.set(node, i, v)
        return node.outputs[0]

    def vmath(self, op, a, b=None, scale=None):
        node = self.t.nodes.new('ShaderNodeVectorMath')
        node.operation = op
        self.set(node, 0, a)
        if b is not None:
            self.set(node, 1, b)
        if scale is not None:
            self.set(node, 'Scale', scale)
        return node.outputs['Value'] if op in ('LENGTH', 'DISTANCE', 'DOT_PRODUCT') else node.outputs[0]

    def value(self, name, v):
        node = self.t.nodes.new('ShaderNodeValue')
        node.name = name
        node.label = name
        node.outputs[0].default_value = v
        return node.outputs[0]


def build_water(mat, rings=()):
    """rings: iterable of (x, y, t0, amp). Rebuilt per shot by shots.py."""
    nt = NT(mat.node_tree)
    t = nt.value('TIME', 0.0)
    geo = nt.n('ShaderNodeNewGeometry')
    P = geo.outputs['Position']
    flat = nt.vmath('MULTIPLY', P, (1, 1, 0))
    drift = nt.n('ShaderNodeCombineXYZ', ins={'X': nt.math('MULTIPLY', t, 0.05), 'Y': nt.math('MULTIPLY', t, 0.02),
                                              'Z': nt.math('MULTIPLY', t, 0.35)})
    pv = nt.vmath('ADD', flat, drift)
    r1 = nt.n('ShaderNodeTexNoise', ins={'Vector': pv, 'Scale': 1.6, 'Detail': 3.0, 'Roughness': 0.55})
    drift2 = nt.n('ShaderNodeCombineXYZ', ins={'X': nt.math('MULTIPLY', t, -0.12), 'Y': nt.math('MULTIPLY', t, 0.08),
                                               'Z': nt.math('MULTIPLY', t, 0.12)})
    r2 = nt.n('ShaderNodeTexNoise', ins={'Vector': nt.vmath('ADD', flat, drift2), 'Scale': 0.22, 'Detail': 2.0})
    patch = nt.n('ShaderNodeTexNoise', ins={'Vector': nt.vmath('ADD', flat, drift2), 'Scale': 0.012, 'Detail': 2.0})
    pm = nt.n('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP',
              ins={'Value': patch.outputs['Fac'], 'From Min': 0.42, 'From Max': 0.68, 'To Min': 0.12, 'To Max': 1.0})
    ripple = nt.value('RIPPLE', 1.0)
    h = nt.math('MULTIPLY', nt.math('MULTIPLY', r1.outputs['Fac'], 0.006), pm.outputs[0])
    h = nt.math('ADD', h, nt.math('MULTIPLY', r2.outputs['Fac'], 0.012))
    h = nt.math('MULTIPLY', h, ripple)
    for (x, y, t0, amp) in rings:
        d = nt.vmath('DISTANCE', flat, (x, y, 0))
        tau = nt.math('SUBTRACT', t, t0)
        front = nt.math('SUBTRACT', d, nt.math('MULTIPLY', tau, 0.55))      # ring speed m/s
        env = nt.math('POWER', 2.718, nt.math('MULTIPLY', nt.math('MULTIPLY', front, front), -5.0))
        wave = nt.math('MULTIPLY', nt.math('SINE', nt.math('MULTIPLY', front, 9.0)), env)
        life = nt.math('MULTIPLY', nt.math('GREATER_THAN', tau, 0.0),
                       nt.math('DIVIDE', amp, nt.math('ADD', 1.0, nt.math('MULTIPLY', nt.math('MAXIMUM', tau, 0.0), 0.9))))
        grow = nt.math('MINIMUM', nt.math('MULTIPLY', nt.math('MAXIMUM', tau, 0.0), 6.0), 1.0)
        h = nt.math('ADD', h, nt.math('MULTIPLY', nt.math('MULTIPLY', wave, life), grow))
    bump = nt.n('ShaderNodeBump', ins={'Strength': 1.0, 'Distance': 1.0, 'Height': h})
    b = nt.n('ShaderNodeBsdfPrincipled', ins={'Base Color': (0.010, 0.035, 0.040, 1), 'Roughness': 0.015, 'IOR': 1.333,
                                              'Normal': bump})
    nt.n('ShaderNodeOutputMaterial', ins={'Surface': b})
    drive_time(mat.node_tree)


def drive_time(tree):
    node = tree.nodes['TIME']
    tree.animation_data_clear()
    d = node.outputs[0].driver_add('default_value')
    d.driver.type = 'SCRIPTED'
    d.driver.expression = 'frame / 24'



import numpy as np


def mesh_from(name, verts, faces, corners):
    """faces: (m, corners) int array."""
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(verts))
    me.vertices.foreach_set('co', np.asarray(verts, dtype=np.float32).ravel())
    m = len(faces)
    me.loops.add(m * corners)
    me.loops.foreach_set('vertex_index', np.asarray(faces, dtype=np.int32).ravel())
    me.polygons.add(m)
    me.polygons.foreach_set('loop_start', np.arange(0, m * corners, corners, dtype=np.int32))
    me.polygons.foreach_set('loop_total', np.full(m, corners, dtype=np.int32))
    me.update(calc_edges=True)
    return me


def bake(idblock, keys):
    """keys: {(data_path, index): [(frame, value), ...]} -> linear fcurves."""
    import numpy as np
    if idblock.animation_data is None:
        idblock.animation_data_create()
    act = bpy.data.actions.new(idblock.name + '_act')
    idblock.animation_data.action = act
    for (path, idx), pts in keys.items():
        fc = act.fcurve_ensure_for_datablock(idblock, path, index=max(idx, 0))
        fc.keyframe_points.add(len(pts))
        fc.keyframe_points.foreach_set('co', np.asarray(pts, dtype=np.float32).ravel())
        fc.keyframe_points.foreach_set('interpolation', np.full(len(pts), 1, dtype=np.int32))
        fc.update()


def setup_cycles(scene, samples=48, pct=100, width=1920, height=1080):
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'OPTIX'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == 'OPTIX'
    c = scene.cycles
    c.device = 'GPU'
    c.samples = samples
    c.use_adaptive_sampling = False
    c.use_denoising = True
    c.denoiser = 'OPENIMAGEDENOISE'
    c.denoising_use_gpu = True
    c.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
    c.max_bounces = 5
    c.diffuse_bounces = 2
    c.glossy_bounces = 3
    c.transmission_bounces = 2
    c.transparent_max_bounces = 4
    c.volume_bounces = 0
    c.volume_biased = True
    c.volume_step_rate = 1.0
    c.volume_max_steps = 96
    c.caustics_reflective = False
    c.caustics_refractive = False
    c.sample_clamp_indirect = 6.0
    c.sample_clamp_direct = 0.0
    c.use_light_tree = False
    c.seed = 0
    c.use_animated_seed = True
    r = scene.render
    r.resolution_x, r.resolution_y, r.resolution_percentage = width, height, pct
    r.fps = FPS
    r.use_persistent_data = True
    r.use_motion_blur = True
    r.motion_blur_shutter = 0.5
    r.film_transparent = False
    r.image_settings.file_format = 'PNG'
    r.image_settings.color_mode = 'RGB'
    r.image_settings.color_depth = '16'
    r.image_settings.compression = 15
    r.threads_mode = 'FIXED'
    r.threads = 8
    for vt in ('AgX', 'Filmic', 'Standard'):
        try:
            scene.view_settings.view_transform = vt
            break
        except TypeError:
            pass
    try:
        scene.view_settings.look = 'AgX - Medium High Contrast'
    except TypeError:
        pass
