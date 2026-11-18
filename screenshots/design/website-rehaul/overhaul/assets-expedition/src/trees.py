"""Procedural spruce meshes (unit height), pure numpy."""
import numpy as np


def spruce(seed, detail=1.0):
    """Returns (verts (n,3), tris (m,3), mat (m,)) with mat 0 = bark, 1 = needles."""
    rng = np.random.default_rng(seed)
    V, F, M = [], [], []

    def add(vs, fs, m):
        base = sum(len(v) for v in V)
        V.append(np.asarray(vs, dtype=np.float64))
        fs = np.asarray(fs, dtype=np.int64) + base
        F.append(fs)
        M.append(np.full(len(fs), m))

    # trunk
    rings, sides = 9, 7
    r0 = 0.0145 * rng.uniform(0.9, 1.15)
    hs = np.linspace(-0.03, 1.0, rings)
    ang = np.linspace(0, 2 * np.pi, sides, endpoint=False)
    vs, fs = [], []
    lean = rng.normal(0, 0.012, 2)
    for i, h in enumerate(hs):
        r = r0 * (1 - max(h, 0)) ** 0.85 + 0.0012 + (0.006 if i == 0 else 0)
        cx, cy = lean * max(h, 0) ** 2
        for a in ang:
            vs.append((cx + r * np.cos(a), cy + r * np.sin(a), h))
    for i in range(rings - 1):
        for j in range(sides):
            a, b = i * sides + j, i * sides + (j + 1) % sides
            fs += [(a, b, b + sides), (a, b + sides, a + sides)]
    add(vs, fs, 0)

    crown = rng.uniform(0.02, 0.2)       # where live branches start
    width = rng.uniform(0.85, 1.15)
    z = 0.05
    nv, nf = [], []
    bv, bf = [], []
    while z < 0.99:
        live = z > crown
        nb = int(rng.integers(5, 8)) if live else int(rng.integers(1, 4))
        Lmax = (0.185 * (1 - z) ** 0.8 + 0.010) * width
        if not live:
            Lmax *= 0.45
        elif z < crown + 0.12:
            Lmax *= 0.75 + 2.0 * (z - crown)
        az0 = rng.uniform(0, 2 * np.pi)
        for b in range(nb):
            az = az0 + 2 * np.pi * b / nb + rng.normal(0, 0.28)
            L = Lmax * rng.uniform(0.62, 1.12)
            droop = (0.25 + 0.55 * (1 - z)) * rng.uniform(0.7, 1.3)
            d = np.array([np.cos(az), np.sin(az), 0.0])
            p = np.array([-d[1], d[0], 0.0])
            k = max(3, int(L / 0.010 * detail))
            zb = z + rng.normal(0, 0.004)
            cx, cy = lean * max(zb, 0) ** 2
            s = np.linspace(0.04, 1.0, k)
            pts = (np.array([cx, cy, zb])[None, :] + d[None, :] * (L * s)[:, None]
                   + np.array([0, 0, 1.0])[None, :] * (L * (-droop * s + 0.62 * droop * s * s))[:, None])
            # the bough itself: a thin vertical ribbon
            for i in range(k - 1):
                o = len(bv)
                w = 0.0035 * (1 - s[i]) + 0.0008
                bv += [pts[i] + (0, 0, w), pts[i] - (0, 0, w), pts[i + 1]]
                bf.append((o, o + 1, o + 2))
            if not live and rng.uniform() < 0.7:
                continue
            for i in range(k):
                fwd = pts[min(i + 1, k - 1)] - pts[max(i - 1, 0)]
                fwd = fwd / (np.linalg.norm(fwd) + 1e-9)
                l = (min(0.036, 0.4 * L) * (1 - 0.6 * s[i]) + 0.005)
                for side, dz in ((-1.0, -0.25), (1.0, -0.25), (-0.6, 0.35), (0.6, 0.35), (0.0, -1.0), (-0.9, -0.75), (0.9, -0.75)):
                    if rng.uniform() < 0.12:
                        continue
                    dirv = p * side * 0.85 + fwd * rng.uniform(0.35, 0.75) + np.array([0, 0, dz + rng.normal(0, 0.15)])
                    dirv = dirv / np.linalg.norm(dirv)
                    ll = l * rng.uniform(0.6, 1.2)
                    wv = np.cross(dirv, np.array([0, 0, 1.0]))
                    wv = wv / (np.linalg.norm(wv) + 1e-9) * 0.0042
                    o = len(nv)
                    nv += [pts[i] - wv, pts[i] + wv, pts[i] + dirv * ll]
                    nf.append((o, o + 1, o + 2))
        z += 0.017 + 0.022 * (1 - z) + rng.uniform(0, 0.007)
    # leader
    o = len(nv)
    nv += [(0.006, 0, 0.955), (-0.006, 0, 0.955), (0, 0, 1.03), (0, 0.006, 0.955), (0, -0.006, 0.955), (0, 0, 1.03)]
    nf += [(o, o + 1, o + 2), (o + 3, o + 4, o + 5)]
    add(bv, bf, 0)
    add(nv, nf, 1)
    return np.concatenate(V), np.concatenate(F), np.concatenate(M)


def tuft(seed=0, blades=16):
    """A clump of grass blades, about 0.45 m tall at unit scale."""
    rng = np.random.default_rng(seed)
    vs, fs = [], []
    for b in range(blades):
        az = rng.uniform(0, 2 * np.pi)
        r = rng.uniform(0, 0.10)
        h = rng.uniform(0.22, 0.52)
        lean = rng.uniform(0.05, 0.42)
        w = rng.uniform(0.010, 0.02)
        d = np.array([np.cos(az), np.sin(az), 0.0])
        p = np.array([-d[1], d[0], 0.0])
        base = d * r
        o = len(vs)
        for s in (0.0, 0.5, 1.0):
            c = base + d * lean * h * s * s + np.array([0, 0, h * s])
            ww = w * (1 - 0.85 * s)
            vs += [c - p * ww, c + p * ww]
        fs += [(o, o + 1, o + 3), (o, o + 3, o + 2), (o + 2, o + 3, o + 5), (o + 2, o + 5, o + 4)]
    return np.array(vs), np.array(fs)
