"""Red-crowned cranes: procedural mesh parts on a joint hierarchy, and their animation.

Body frame: +x forward, +y left, +z up. Positive rotation about y pitches the nose DOWN
(and swings a hanging leg backward); positive rotation about x lifts the left wing.
"""
import math

import numpy as np

COUNT = 6
NECK_N = 8
NECK_L = 0.085
LA, LF, LH = 0.27, 0.36, 0.13          # wing: arm, forearm, hand spans
NPRIM = 10
THIGH, SHIN = 0.30, 0.36
HIP = (-0.04, 0.06, -0.09)
STAND_H = 0.735                         # body centre above the ground when standing


# ------------------------------------------------------------------ mesh parts (numpy)
def ellipsoid(c, r, nu=14, nv=9):
    vs, fs = [], []
    for j in range(nv + 1):
        th = math.pi * j / nv
        for i in range(nu):
            ph = 2 * math.pi * i / nu
            vs.append((c[0] + r[0] * math.cos(th), c[1] + r[1] * math.sin(th) * math.cos(ph),
                       c[2] + r[2] * math.sin(th) * math.sin(ph)))
    for j in range(nv):
        for i in range(nu):
            a, b = j * nu + i, j * nu + (i + 1) % nu
            fs += [(a, b, b + nu), (a, b + nu, a + nu)]
    return np.array(vs), np.array(fs)


def tube(p0, p1, r0, r1, sides=8, rings=3):
    p0, p1 = np.array(p0, float), np.array(p1, float)
    ax = p1 - p0
    ax /= np.linalg.norm(ax)
    ref = np.array([0, 1.0, 0]) if abs(ax[1]) < 0.9 else np.array([1.0, 0, 0])
    u = np.cross(ax, ref)
    u /= np.linalg.norm(u)
    v = np.cross(ax, u)
    vs, fs = [], []
    for j in range(rings + 1):
        t = j / rings
        c = p0 + (p1 - p0) * t
        r = r0 + (r1 - r0) * t
        for i in range(sides):
            a = 2 * math.pi * i / sides
            vs.append(c + r * (math.cos(a) * u + math.sin(a) * v))
    for j in range(rings):
        for i in range(sides):
            a, b = j * sides + i, j * sides + (i + 1) % sides
            fs += [(a, b, b + sides), (a, b + sides, a + sides)]
    o = len(vs)
    vs += [p0 - ax * r0 * 0.6, p1 + ax * r1 * 0.6]
    for i in range(sides):
        fs += [(o, (i + 1) % sides, i), (o + 1, rings * sides + i, rings * sides + (i + 1) % sides)]
    return np.array(vs), np.array(fs)


def feather(L, w, tipw=0.55, n=7, camber=0.012, sweep=0.0):
    """Blade along +y from the origin, lying in the xy plane; slightly cambered."""
    vs, fs = [], []
    for k in range(n + 1):
        s = k / n
        prof = (0.35 + 0.65 * math.sin(min(s * 1.9, 1.0) * math.pi / 2)) * (1 - (1 - tipw) * s ** 2.2)
        if k == n:
            prof *= 0.45
        half = 0.5 * w * prof
        zc = -camber * (s * s)
        xs = sweep * s * s
        vs += [(xs + half, s * L, zc - 0.25 * half * 0.3), (xs, s * L, zc + 0.004), (xs - half, s * L, zc - 0.3 * half * 0.3)]
    for k in range(n):
        a = k * 3
        fs += [(a, a + 1, a + 4), (a, a + 4, a + 3), (a + 1, a + 2, a + 5), (a + 1, a + 5, a + 4)]
    return np.array(vs), np.array(fs)


def rot_z(vs, ang):
    c, s = math.cos(ang), math.sin(ang)
    out = vs.copy()
    out[:, 0] = vs[:, 0] * c - vs[:, 1] * s
    out[:, 1] = vs[:, 0] * s + vs[:, 1] * c
    return out


def panel(L, lead0, lead1, trail0, trail1, thick, ny=6, nx=6):
    """Wing covert plate spanning y in [0, L]; a thin lens section, closed."""
    vs, fs = [], []
    for j in range(ny + 1):
        t = j / ny
        xl = lead0 + (lead1 - lead0) * t
        xt = trail0 + (trail1 - trail0) * t
        for i in range(nx + 1):
            s = i / nx
            x = xl + (xt - xl) * s
            th = thick * (1 - 0.35 * t) * math.sin(math.pi * min(s * 1.6, 1.0) ** 0.7) * (1 - s) ** 0.5 + 0.002
            cam = 0.018 * math.sin(math.pi * s) - 0.02 * s
            vs.append((x, t * L, cam + th))
        for i in range(nx + 1):
            s = i / nx
            x = xl + (xt - xl) * s
            cam = 0.018 * math.sin(math.pi * s) - 0.02 * s
            vs.append((x, t * L, cam - 0.003))
    row = 2 * (nx + 1)
    for j in range(ny):
        for i in range(nx):
            a = j * row + i
            fs += [(a, a + 1, a + row + 1), (a, a + row + 1, a + row)]
            b = a + nx + 1
            fs += [(b, b + row + 1, b + 1), (b, b + row, b + row + 1)]
    return np.array(vs), np.array(fs)


class Parts:
    def __init__(self):
        self.v, self.f, self.m, self.n = [], [], [], 0

    def add(self, vf, mat):
        v, f = vf
        self.v.append(v)
        self.f.append(f + self.n)
        self.m.append(np.full(len(f), mat))
        self.n += len(v)

    def arrays(self):
        return np.concatenate(self.v), np.concatenate(self.f), np.concatenate(self.m)


WHITE, BLACK, RED, BILL, LEG = range(5)


def wing_segment(kind):
    """Mesh for one wing segment of the LEFT wing (the right wing is a mirrored parent)."""
    P = Parts()
    if kind == 'arm':
        P.add(panel(LA, 0.075, 0.07, -0.13, -0.12, 0.034), WHITE)
        for k in range(7):
            y = 0.015 + k * LA / 7
            L = 0.33 - 0.012 * k
            v, f = feather(L, 0.085, tipw=0.7)
            v = rot_z(v, math.radians(90 + 16 - 3.0 * k))
            v[:, 2] += -0.012 - 0.002 * k
            v[:, 2] -= 0.10 * (np.maximum(-v[:, 0] - 0.1, 0)) * (1 - k / 7)   # tertials droop
            v += (-0.07, y, 0)
            P.add((v, f), BLACK)
    elif kind == 'fore':
        P.add(panel(LF, 0.07, 0.06, -0.12, -0.10, 0.03, ny=7), WHITE)
        for k in range(9):
            y = 0.01 + k * LF / 9
            L = 0.29 - 0.006 * k
            v, f = feather(L, 0.08, tipw=0.7)
            v = rot_z(v, math.radians(90 - 5 - 3.0 * k))
            v[:, 2] += -0.012 - 0.0015 * k
            v += (-0.06, y, 0)
            P.add((v, f), BLACK)
    else:
        P.add(panel(LH, 0.06, 0.035, -0.09, -0.03, 0.022, ny=3, nx=4), WHITE)
    return P.arrays()


def prim_rest(i):
    """Rest fan: (attach y, attach x, length, width, fan angle deg from the span axis toward the tail)."""
    t = i / (NPRIM - 1)
    L = 0.33 + 0.16 * math.sin(min(t * 1.25, 1.0) * math.pi / 2) - 0.05 * max(t - 0.8, 0) / 0.2
    return LH * (0.1 + 0.9 * t), -0.025 + 0.03 * t, L, 0.078 - 0.03 * t, 62.0 - 66.0 * t ** 0.85


# ------------------------------------------------------------------ Blender construction
def _materials():
    import bpy
    from common import NT
    mats = []
    spec = [('CraneWhite', (0.86, 0.85, 0.82), 0.5, 0.35), ('CraneBlack', (0.012, 0.012, 0.014), 0.45, 0.0),
            ('CraneRed', (0.55, 0.02, 0.015), 0.5, 0.0), ('CraneBill', (0.36, 0.33, 0.20), 0.4, 0.0),
            ('CraneLeg', (0.03, 0.03, 0.032), 0.5, 0.0)]
    for name, col, rough, trans in spec:
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = NT(m.node_tree)
        b = nt.n('ShaderNodeBsdfPrincipled', ins={'Base Color': (*col, 1), 'Roughness': rough, 'Specular IOR Level': 0.25})
        if trans:
            tr = nt.n('ShaderNodeBsdfTranslucent', ins={'Color': (0.95, 0.90, 0.82, 1)})
            mx = nt.n('ShaderNodeMixShader', ins={'Fac': trans})
            nt.t.links.new(b.outputs[0], mx.inputs[1])
            nt.t.links.new(tr.outputs[0], mx.inputs[2])
            b = mx
        nt.n('ShaderNodeOutputMaterial', ins={'Surface': b})
        mats.append(m)
    return mats


def build_all(coll, count=COUNT):
    import bpy
    from common import mesh_from
    mats = _materials()
    cache = {}

    def mesh(key, maker):
        if key not in cache:
            v, f, m = maker()
            me = mesh_from('crane_' + key, v, f, 3)
            for mt in mats:
                me.materials.append(mt)
            me.polygons.foreach_set('material_index', m.astype(np.int32))
            me.shade_smooth()
            me.update()
            cache[key] = me
        return cache[key]

    def single(vf, mat):
        P = Parts()
        P.add(vf, mat)
        return P.arrays

    def obj(name, parent, loc, me=None):
        o = bpy.data.objects.new(name, me)
        coll.objects.link(o)
        o.rotation_mode = 'XYZ'
        if parent is not None:
            o.parent = parent
        o.location = loc
        if me is None:
            o.empty_display_size = 0.05
        return o

    def body_mesh():
        P = Parts()
        P.add(ellipsoid((0, 0, 0), (0.30, 0.125, 0.14), 16, 12), WHITE)
        P.add(ellipsoid((0.17, 0, 0.035), (0.14, 0.085, 0.095), 12, 8), WHITE)       # breast into neck
        P.add(ellipsoid((-0.20, 0, 0.0), (0.16, 0.085, 0.075), 12, 8), WHITE)        # rump
        v, f = feather(0.20, 0.16, tipw=0.8)
        P.add((rot_z(v, math.radians(90)) + (-0.27, 0, 0.0), f), WHITE)              # short tail
        return P.arrays()

    def bustle_mesh():
        P = Parts()
        for k in range(9):
            a = (k - 4) * 0.16
            v, f = feather(0.36 - 0.02 * abs(k - 4), 0.10, tipw=0.75, camber=0.11)
            v = rot_z(v, math.radians(90) + a * 0.55)
            v += (-0.10, a * 0.25, 0.085 - 0.01 * abs(k - 4))
            P.add((v, f), BLACK)
        P.add(ellipsoid((-0.02, 0, 0.03), (0.26, 0.135, 0.125), 12, 8), WHITE)       # folded wings over the back
        return P.arrays()

    def neck_mesh(i):
        def mk():
            P = Parts()
            r0 = 0.046 - 0.0030 * i
            r1 = 0.046 - 0.0030 * (i + 1)
            P.add(tube((-0.012, 0, 0), (NECK_L + 0.012, 0, 0), r0, r1, 10, 2), WHITE if i < 2 else BLACK)
            return P.arrays()
        return mk

    def head_mesh():
        P = Parts()
        P.add(ellipsoid((0.045, 0, 0.004), (0.062, 0.031, 0.036), 12, 8), BLACK)
        P.add(ellipsoid((0.012, 0, 0.012), (0.04, 0.034, 0.034), 10, 7), WHITE)
        P.add(ellipsoid((0.048, 0, 0.032), (0.034, 0.022, 0.012), 10, 6), RED)
        P.add(tube((0.09, 0, -0.002), (0.255, 0, -0.012), 0.015, 0.0025, 6, 2), BILL)
        return P.arrays()

    def thigh_mesh():
        P = Parts()
        P.add(tube((0, 0, 0.03), (0, 0, -0.13), 0.042, 0.022, 8, 2), WHITE)
        P.add(tube((0, 0, -0.10), (0, 0, -THIGH), 0.016, 0.011, 6, 2), LEG)
        P.add(ellipsoid((0, 0, -THIGH), (0.016, 0.016, 0.016), 6, 4), LEG)
        return P.arrays()

    def shin_mesh():
        P = Parts()
        P.add(tube((0, 0, 0), (0, 0, -SHIN), 0.011, 0.009, 6, 2), LEG)
        return P.arrays()

    def foot_mesh():
        P = Parts()
        for a in (-28, 0, 28):
            r = math.radians(a)
            P.add(tube((0, 0, 0), (0.115 * math.cos(r), 0.115 * math.sin(r), -0.004), 0.008, 0.004, 5, 1), LEG)
        P.add(tube((0, 0, 0), (-0.03, 0, 0.0), 0.006, 0.003, 5, 1), LEG)
        return P.arrays()

    for c in range(count):
        n = 'C%d_' % c
        root = obj(n + 'root', None, (0, 0, -50))
        root.rotation_mode = 'ZYX'
        torso = obj(n + 'torso', root, (0, 0, 0))
        obj(n + 'body', torso, (0, 0, 0), mesh('body', body_mesh))
        obj(n + 'bustle', torso, (0, 0, 0), mesh('bustle', bustle_mesh))
        prev = torso
        for i in range(NECK_N):
            prev = obj(n + 'neck%d' % i, prev, (0.25, 0, 0.05) if i == 0 else (NECK_L, 0, 0), mesh('neck%d' % i, neck_mesh(i)))
        obj(n + 'head', prev, (NECK_L, 0, 0), mesh('head', head_mesh))
        for side, sy in (('L', 1), ('R', -1)):
            th = obj(n + 'thigh' + side, torso, (HIP[0], HIP[1] * sy, HIP[2]), mesh('thigh', thigh_mesh))
            sh = obj(n + 'shin' + side, th, (0, 0, -THIGH), mesh('shin', shin_mesh))
            obj(n + 'foot' + side, sh, (0, 0, -SHIN), mesh('foot', foot_mesh))
            ws = obj(n + 'sh' + side, torso, (0.09, 0.085 * sy, 0.085))
            ws.scale = (1, sy, 1)
            arm = obj(n + 'arm' + side, ws, (0, 0, 0), mesh('arm', lambda: wing_segment('arm')))
            fore = obj(n + 'fore' + side, arm, (0, LA, 0), mesh('fore', lambda: wing_segment('fore')))
            hand = obj(n + 'hand' + side, fore, (0, LF, 0), mesh('hand', lambda: wing_segment('hand')))
            for i in range(NPRIM):
                y, x, L, w, ang = prim_rest(i)

                def mk(L=L, w=w, i=i):
                    P = Parts()
                    P.add(feather(L, w, tipw=0.42 if i > 5 else 0.6, n=8, camber=0.02), WHITE)
                    return P.arrays()
                obj(n + 'prim%s%d' % (side, i), hand, (x, y, -0.006 - 0.0012 * i), mesh('prim%d' % i, mk))


# ------------------------------------------------------------------ animation
def sm(a, b, x):
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    return a + (b - a) * t


NECK_STAND = np.radians([30, 55, 85, 110, 118, 110, 92, 70, -8.0])     # last entry: head
NECK_CALL = np.radians([70, 86, 96, 101, 100, 97, 93, 88, 62.0])
NECK_FLY = np.radians([-7, -6, -5, -4, -3, -2, -1, 0, -5.0])
NECK_RUN = np.radians([28, 30, 30, 27, 22, 16, 10, 5, -6.0])
NECK_PREEN = np.radians([50, 62, 70, 60, 30, -10, -40, -55, -70.0])


def leg_ik(hip, foot):
    """Planar two-bone IK. Angles are absolute 'swing back' angles from straight down."""
    dx, dz = foot[0] - hip[0], foot[1] - hip[1]
    D = max(min(math.hypot(dx, dz), THIGH + SHIN - 1e-3), 0.12)
    ad = math.atan2(-dx, -dz)
    cb = (THIGH ** 2 + D ** 2 - SHIN ** 2) / (2 * THIGH * D)
    at = ad + math.acos(max(min(cb, 1), -1))
    jx, jz = hip[0] - THIGH * math.sin(at), hip[1] - THIGH * math.cos(at)
    fx, fz = hip[0] - D * math.sin(ad), hip[1] - D * math.cos(ad)
    return at, math.atan2(-(fx - jx), -(fz - jz))


def pose(st):
    """st: dict of scalar state. Returns {part: (rx, ry, rz)} local eulers plus 'scales'."""
    out = {}
    th = st['pitch']                       # torso nose-up, radians
    out['torso'] = (st.get('roll_body', 0.0), -th, 0.0)
    # neck: blend absolute elevations, convert to local
    al = st['neck']
    prev = th
    yaw = st.get('head_yaw', 0.0)
    for i in range(NECK_N):
        out['neck%d' % i] = (0.0, -(al[i] - prev), yaw / NECK_N * (1.4 if i > 3 else 0.6))
        prev = al[i]
    out['head'] = (0.0, -(al[NECK_N] - prev), 0.0)
    # legs
    for side in 'LR':
        at, as_, af = st['leg' + side]
        out['thigh' + side] = (0.0, at + th, 0.0)
        out['shin' + side] = (0.0, as_ - at, 0.0)
        out['foot' + side] = (0.0, af - as_, 0.0)
    # wings
    w = st['wing_open']
    ph = st['phase']
    amp = st['amp'] * w
    glide = st.get('glide', 0.0)
    up = max(0.0, -math.sin(ph)) * (1 - glide)
    dn = max(0.0, math.sin(ph)) * (1 - glide)
    d2r = math.radians
    flap = d2r(9) + d2r(40) * amp * math.cos(ph) * (1 - glide) + d2r(4) * glide
    fold = 1 - w
    arm = (flap, d2r(5) * dn * amp - d2r(4) * up, d2r(-4) * up + d2r(72) * fold)
    fore = (d2r(7) * amp * math.cos(ph - 0.7) - d2r(20) * up * amp, d2r(6) * dn * amp,
            d2r(5) + d2r(15) * up - d2r(150) * fold)
    hand = (d2r(12) * amp * math.cos(ph - 1.3) - d2r(26) * up * amp, d2r(11) * dn * amp - d2r(8) * up,
            d2r(8) + d2r(30) * up + d2r(140) * fold)
    for side in 'LR':
        out['arm' + side], out['fore' + side], out['hand' + side] = arm, fore, hand
        for i in range(NPRIM):
            t = i / (NPRIM - 1)
            _, _, _, _, ang = prim_rest(i)
            spread = 1.0 + 0.16 * dn - 0.30 * up
            a = d2r(ang * spread + 10 * up) * w + d2r(80) * fold
            curl = d2r(16) * dn * amp * t ** 1.5 - d2r(10) * up * t
            twist = d2r(14) * dn * t - d2r(22) * up * t
            out['prim%s%d' % (side, i)] = (curl + d2r(3) * math.sin(i * 2.4 + st['seed']), twist, a)
    s = mix(0.02, 1.0, sm(0.0, 0.5, w))
    out['_wing_scale'] = s
    out['_bustle_scale'] = mix(1.0, 0.02, sm(0.15, 0.7, w))
    return out


# Flock choreography. Times are seconds on the flock clock; shots look at a window of it.
def flock(H):
    """Returns a list of crane dicts with standing position, heading and takeoff time."""
    rng = np.random.default_rng(42)
    base = np.array([-262.0, -6.0])

    def shore_x(y):
        lo, hi = -420.0, -150.0          # dry land .. deep water
        for _ in range(40):
            mid = 0.5 * (lo + hi)
            if H(mid, y) > -0.035:
                lo = mid
            else:
                hi = mid
        return lo
    spots = [(0.0, 0.0), (2.4, 1.7), (-3.0, 6.6), (1.0, 8.1), (5.0, 13.6), (-2.0, 15.4)]
    out = []
    for i, (dx, dy) in enumerate(spots):
        out.append(dict(
            p0=np.array([shore_x(base[1] + dy) + dx * 0.8 + 1.2, base[1] + dy]), yaw0=math.radians(90 + (rng.uniform(-30, 30) if i in (1, 3) else rng.choice([-1, 1]) * rng.uniform(25, 75))),
            T0=[3.9, 3.55, 4.3, 3.3, 3.1, 4.75][i], run_yaw=math.radians(90 + rng.uniform(-7, 7)),
            seed=float(rng.uniform(0, 6.28)), fscale=float(rng.uniform(0.93, 1.07)), caller=(i == 1),
            climb=float(rng.uniform(0.85, 1.2)), turn=float(rng.uniform(0.85, 1.15)),
            side=float(rng.uniform(-1, 1))))
    return out


def simulate(cr, H, t0, t1, dt=1.0 / 96):
    """Integrates one crane over the flock clock. Returns per-step state arrays."""
    n = int(round((t1 - t0) / dt)) + 1
    T = t0 + np.arange(n) * dt
    pos = np.zeros((n, 3))
    yaw = np.zeros(n)
    speed = np.zeros(n)
    phase = np.zeros(n)
    stride = np.zeros(n)
    Tr = 1.45
    # integrate from the takeoff time, so every shot window sees the same trajectory
    tt = np.arange(min(t0, cr['T0'] - 1.0), t1 + dt, dt)
    x, y = cr['p0']
    px, py, ph, st = [], [], [], []
    cph = cst = 0.0
    for t in tt:
        tau = t - cr['T0']
        v = 6.4 * sm(0.0, Tr, tau) ** 1.2 + 4.6 * sm(Tr, Tr + 3.5, tau)
        yw = cr['run_yaw'] - math.radians(86) * cr['turn'] * sm(Tr + 2.2, Tr + 11.0, tau) + math.radians(5) * cr['side'] * sm(Tr, Tr + 4, tau)
        x += v * math.cos(yw) * dt
        y += v * math.sin(yw) * dt
        f = (3.3 - 0.75 * sm(Tr - 0.3, Tr + 3.0, tau) - 0.25 * sm(Tr + 3, Tr + 9, tau)) * cr['fscale'] if tau > -0.3 else 0.0
        cph += 2 * math.pi * f * dt
        cst += (2.6 + 1.6 * sm(0, Tr, tau)) * dt if 0 < tau < Tr + 0.25 else 0.0
        px.append(x); py.append(y); ph.append(cph); st.append(cst)
    px, py, ph, st = map(np.array, (px, py, ph, st))
    out = dict(T=T, x=np.interp(T, tt, px), y=np.interp(T, tt, py), phase=np.interp(T, tt, ph),
               stride=np.interp(T, tt, st))
    out['Tr'] = Tr
    return out


def state_at(cr, sim, k, H):
    """Full pose state for sim step k. Returns (root loc, root euler ZYX (rx, ry, rz), pose dict, foot events)."""
    t = sim['T'][k]
    tau = t - cr['T0']
    Tr = sim['Tr']
    x, y = sim['x'][k], sim['y'][k]
    ground = max(H(x, y), -0.22)
    air = tau - Tr
    ph = sim['phase'][k] + cr['seed']
    # heading
    k2 = min(k + 4, len(sim['T']) - 1)
    k1 = max(k - 4, 0)
    if tau > 0.15 and (sim['x'][k2] != sim['x'][k1] or sim['y'][k2] != sim['y'][k1]):
        path_yaw = math.atan2(sim['y'][k2] - sim['y'][k1], sim['x'][k2] - sim['x'][k1])
    else:
        path_yaw = cr['run_yaw']
    dyaw = (path_yaw - cr['yaw0'] + math.pi) % (2 * math.pi) - math.pi
    yaw = cr['yaw0'] + dyaw * sm(-1.5, 0.05, tau)
    # altitude
    h = 0.0
    if air > 0:
        h = (0.16 * air + 0.11 * cr['climb'] * air * air) if air < 4 else (0.64 + 1.76 * cr['climb'] + (0.16 + 0.88 * cr['climb']) * (air - 4) + 0.16 * (air - 4) ** 2)
    crouch = 0.07 * sm(-0.55, -0.1, tau) * (1 - sm(0.0, 0.4, tau))
    bob = 0.035 * math.sin(2 * math.pi * sim['stride'][k] * 2) * sm(0.05, 0.3, tau) * (1 - sm(Tr - 0.1, Tr + 0.2, tau))
    flapbob = -0.035 * math.cos(ph) * sm(Tr - 0.2, Tr + 0.5, tau)
    idle = 0.006 * math.sin(t * 1.1 + cr['seed'])
    z = ground + STAND_H - crouch + bob + idle + (0.0 - ground) * sm(Tr - 0.5, Tr, tau) * 0 + h + flapbob
    fly = sm(Tr - 0.15, Tr + 0.9, tau)          # legs trail
    # torso pitch
    pitch = math.radians(mix(mix(mix(27, 6, sm(-0.5, 0.5, tau)), 15, sm(Tr - 0.4, Tr + 0.6, tau)), 6, sm(Tr + 2.5, Tr + 6, tau)))
    pitch += math.radians(2.0) * math.sin(ph + 0.6) * sm(0, 0.5, tau)
    # neck
    callw = 0.0
    if cr['caller']:
        callw = sm(0.9, 1.5, t) * (1 - sm(2.6, 3.1, t))
    lookw = 0.5 + 0.5 * math.sin(t * 0.7 + cr['seed'] * 3)
    neck = NECK_STAND * (1 - 0.10 * lookw) + np.radians(2.5) * math.sin(t * 0.9 + cr['seed'])
    if not cr['caller'] and cr['seed'] % 1.0 < 0.34:
        pw = sm(0.3, 1.2, t) * (1 - sm(2.2, 2.9, t))          # one or two are feeding as the shot opens
        neck = mix(neck, NECK_PREEN, pw)
    neck = mix(neck, NECK_CALL, callw)
    alert = sm(2.3, 2.9, t) * (1 - sm(-0.5, 0.0, tau)) * (0 if cr['caller'] else 1)
    neck = mix(neck, NECK_STAND * 1.03, alert)
    neck = mix(neck, NECK_RUN, sm(-0.45, 0.35, tau))
    flight_line = math.atan2(max(h, 0) * 0 + (0.22 + 0.6 * max(air, 0)) * (1 if 0 < air < 3 else 0.3), 9.0)
    neck = mix(neck, NECK_FLY + flight_line * 0.6, sm(Tr - 0.5, Tr + 0.7, tau))
    head_yaw = math.radians(28) * math.sin(t * 0.45 + cr['seed'] * 5) * (1 - sm(-0.8, -0.2, tau)) * (1 - callw)
    # legs
    hipz = HIP[2] * math.cos(pitch)
    legs = {}
    events = []
    for side, off in (('L', 0.0), ('R', 0.5)):
        hip = (HIP[0], HIP[2])
        # rotate hip into root frame by the pitch
        hx = hip[0] * math.cos(pitch) - hip[1] * math.sin(pitch) * -1 * 0 + 0.0
        hx = HIP[0] * math.cos(pitch) + HIP[2] * math.sin(pitch) * -1
        hz = HIP[0] * math.sin(pitch) + HIP[2] * math.cos(pitch)
        stand_foot = (hx + 0.03 + (0.05 if side == 'L' else -0.04), -(z - ground))
        s = (sim['stride'][k] + off) % 1.0
        runw = sm(0.0, 0.2, tau)
        if s < 0.42:   # stance
            fx = mix(0.26, -0.30, s / 0.42)
            fz = 0.0
        else:
            u = (s - 0.42) / 0.58
            fx = mix(-0.30, 0.26, sm(0, 1, u))
            fz = 0.26 * math.sin(math.pi * u) ** 0.8
        run_foot = (hx + fx, -(z - ground) + fz)
        foot = (mix(stand_foot[0], run_foot[0], runw), mix(stand_foot[1], run_foot[1], runw))
        at, as_ = leg_ik((hx, hz), foot)
        af = math.radians(mix(0, 35, runw) * (1 if s > 0.42 else 0.0))
        tb = math.radians(82) + 0.06 * math.sin(ph * 0.5 + off * 6)
        dangle = math.sin(math.pi * fly)       # legs hang for a moment before they tuck back
        at = mix(at, tb - math.radians(38) * dangle, fly)
        as_ = mix(as_, tb + math.radians(6) + math.radians(30) * dangle, fly)
        af = mix(af, tb + math.radians(96), fly)
        legs[side] = (at, as_, af)
    amp = mix(1.28, 1.0, sm(Tr + 1.0, Tr + 5.0, tau))
    st = dict(pitch=pitch, neck=neck, head_yaw=head_yaw, legL=legs['L'], legR=legs['R'],
              wing_open=sm(-0.32, 0.22, tau), phase=ph, amp=amp, seed=cr['seed'])
    p = pose(st)
    bank = -math.radians(16) * cr['turn'] * sm(Tr + 2.2, Tr + 5.0, tau) * (1 - sm(Tr + 8.5, Tr + 11.5, tau))
    return (x, y, z), (bank, 0.0, yaw), p


def animate(scene, spec, nframes, H):
    """Bakes the cranes for a shot. spec: dict(t0=flock-clock time of frame 0) or None (hide). Returns water rings."""
    import bpy
    from common import bake, FPS
    D = bpy.data
    rings = []
    names = ['torso'] + ['neck%d' % i for i in range(NECK_N)] + ['head']
    for side in 'LR':
        names += [p + side for p in ('thigh', 'shin', 'foot', 'arm', 'fore', 'hand')] + ['prim%s%d' % (side, i) for i in range(NPRIM)]
    cranes = flock(H)
    for c, cr in enumerate(cranes):
        n = 'C%d_' % c
        for nm in ['root', 'bustle', 'shL', 'shR'] + names:
            D.objects[n + nm].animation_data_clear()
        root = D.objects[n + 'root']
        if spec is None:
            root.location = (0, 0, -500)
            continue
        t0 = spec['t0']
        sub = 2
        fr = np.arange(-sub, (nframes + 1) * sub + 1) / sub
        sim = simulate(cr, H, t0 + fr[0] / FPS, t0 + fr[-1] / FPS, dt=1.0 / (FPS * sub))
        keys = {nm: {(('rotation_euler', i)): [] for i in range(3)} for nm in names}
        rk = {('location', i): [] for i in range(3)}
        rk.update({('rotation_euler', i): [] for i in range(3)})
        wsk = {'shL': {('scale', i): [] for i in range(3)}, 'shR': {('scale', i): [] for i in range(3)},
               'bustle': {('scale', i): [] for i in range(3)}}
        prev_s = None
        for k, f in enumerate(fr):
            loc, eul, p = state_at(cr, sim, min(k, len(sim['T']) - 1), H)
            for i in range(3):
                rk[('location', i)].append((f, loc[i]))
                rk[('rotation_euler', i)].append((f, eul[i]))
            for nm in names:
                e = p[nm]
                for i in range(3):
                    keys[nm][('rotation_euler', i)].append((f, e[i]))
            s = p['_wing_scale']
            for i in range(3):
                wsk['shL'][('scale', i)].append((f, s))
                wsk['shR'][('scale', i)].append((f, -s if i == 1 else s))
                wsk['bustle'][('scale', i)].append((f, p['_bustle_scale']))
            # footfalls -> rings
            tau = sim['T'][k] - cr['T0']
            sidx = int(math.floor(sim['stride'][k] * 2))
            if prev_s is not None and sidx != prev_s and 0 < tau < sim['Tr'] + 0.2:
                if H(loc[0], loc[1]) < 0.02:
                    rings.append((loc[0], loc[1], sim['T'][k] - t0, 0.012 + 0.006 * (tau / sim['Tr'])))
            prev_s = sidx
        if cr['T0'] - t0 > 0.5:   # a slow ring or two where it stands
            for j in range(2):
                rings.append((cr['p0'][0], cr['p0'][1], cr['T0'] - t0 - 3.4 + 1.9 * j + cr['seed'] * 0.1, 0.004))
        bake(root, rk)
        for nm in names:
            bake(D.objects[n + nm], keys[nm])
        for nm, kk in wsk.items():
            bake(D.objects[n + nm], kk)
    return rings
