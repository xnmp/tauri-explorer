"""The valley as pure numpy: noise, heightfield, albedo, tree placement.

Coordinates: x east, y north, z up, metres. Lake surface is z = 0. The sun
rises in the east and enters through the outflow gap in the east rim.
"""
import os
import numpy as np

HALF = 2600.0      # terrain half extent
N = 1500           # grid resolution per side
R_LAKE, R_FLOOR, R_RIM, H_RIM = 250.0, 640.0, 1150.0, 300.0
VERSION = 6


def _hash(ix, iy, seed):
    h = (ix & 0xFFFFFFFF).astype(np.uint32) * np.uint32(374761393)
    h = h + (iy & 0xFFFFFFFF).astype(np.uint32) * np.uint32(668265263)
    h = h + np.uint32((seed * 974711 + 12345) & 0xFFFFFFFF)
    h = (h ^ (h >> np.uint32(13))) * np.uint32(1274126177)
    return h ^ (h >> np.uint32(16))


def perlin(x, y, seed=0):
    ix = np.floor(x).astype(np.int64)
    iy = np.floor(y).astype(np.int64)
    fx = x - ix
    fy = y - iy

    def g(i, j, dx, dy):
        a = _hash(i, j, seed).astype(np.float64) * (2 * np.pi / 4294967296.0)
        return np.cos(a) * dx + np.sin(a) * dy

    u = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
    v = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
    a = g(ix, iy, fx, fy)
    b = g(ix + 1, iy, fx - 1, fy)
    c = g(ix, iy + 1, fx, fy - 1)
    d = g(ix + 1, iy + 1, fx - 1, fy - 1)
    return (a + (b - a) * u + (c - a + (a - b - c + d) * u) * v) * 1.41


def fbm(x, y, octaves=5, seed=0, gain=0.5, lac=2.03):
    s = np.zeros_like(x, dtype=np.float64)
    amp, f = 1.0, 1.0
    for o in range(octaves):
        s += amp * perlin(x * f + 17.3 * o, y * f - 9.1 * o, seed + o)
        amp *= gain
        f *= lac
    return s


def ridged(x, y, octaves=7, seed=0, gain=0.5, lac=2.07):
    s = np.zeros_like(x, dtype=np.float64)
    amp, f, w = 1.0, 1.0, np.ones_like(x, dtype=np.float64)
    for o in range(octaves):
        n = 1.0 - np.abs(perlin(x * f + 31.7 * o, y * f + 5.3 * o, seed + o))
        n = n * n
        s += amp * n * w
        w = np.clip(n * 1.6, 0, 1)
        amp *= gain
        f *= lac
    return s / 1.9


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def axis():
    u = np.linspace(-1, 1, N)
    return HALF * (0.30 * u + 0.70 * u ** 3)


def height_fn(X, Y):
    """Analytic terrain height at arbitrary points (arrays)."""
    X = np.asarray(X, dtype=np.float64)
    Y = np.asarray(Y, dtype=np.float64)
    wx = fbm(X / 800, Y / 800, 3, 11) * 85
    wy = fbm(X / 800, Y / 800, 3, 23) * 85
    re = np.hypot((X + wx) / 1.3, Y + wy)

    s = np.clip(re / R_LAKE, 0, 1)
    lake = -7.0 * (1 - s ** 2) ** 0.9
    sf = np.clip((re - R_LAKE) / (R_FLOOR - R_LAKE), 0, 1)
    floor = 30.0 * sf ** 1.7
    sw = sstep(R_FLOOR, R_RIM, re)
    wall = 30.0 + (H_RIM - 30.0) * sw ** 1.15
    plateau = H_RIM + 25.0 * np.tanh((re - R_RIM) / 500.0)
    base = np.where(re < R_LAKE, lake, np.where(re < R_FLOOR, floor, np.where(re < R_RIM, wall, plateau)))

    rg = ridged(X / 520, Y / 520, 8, 5)
    rgb = ridged(X / 1000, Y / 1000, 7, 61, gain=0.43)
    hum = fbm(X / 60, Y / 60, 4, 41)
    amp_wall = 105.0 * sstep(R_FLOOR - 60, R_RIM - 150, re) * (1 - 0.7 * sstep(R_RIM - 150, R_RIM + 200, re))
    mass = sstep(-0.55, 0.45, fbm(X / 1500, Y / 1500, 2, 77) + 0.30 * sstep(0, -1500, X))
    ring = sstep(R_RIM + 80, R_RIM + 900, re)
    amp_peak = 560.0 * mass * ring
    edge = sstep(HALF * 0.78, HALF, np.maximum(np.abs(X), np.abs(Y))) * 260.0 * sstep(-400, 400, -X + 600)
    z = base + (rg - 0.35) * amp_wall + (0.25 + 0.95 * rgb ** 1.6) * amp_peak + edge * (0.5 + 0.6 * rgb)
    z += hum * (0.8 + 2.2 * sstep(R_LAKE + 20, R_FLOOR, re) + 5 * sw)
    z += fbm(X / 300, Y / 300, 3, 88) * 14 * sstep(R_RIM, R_RIM + 300, re)
    z += (rg - 0.4) * 70 * mass * ring
    # benches and cliff bands on the valley walls
    wob = fbm(X / 230, Y / 230, 3, 91) * 1.7
    tt = z / 64.0 + wob
    fl = np.floor(tt)
    stair = (fl + sstep(0.28, 0.66, tt - fl) - wob) * 64.0
    wt = sstep(45, 100, z) * (1 - sstep(230, 300, z)) * 0.22 * sstep(-0.2, 0.4, fbm(X / 500, Y / 500, 2, 93))
    z = z * (1 - wt) + stair * wt

    # the east gap and the outflow canyon
    my = Y + 60 * np.sin(X / 260.0) + 25 * np.sin(X / 97.0 + 1.3)
    g = np.exp(-np.abs(my / 235.0) ** 3) * sstep(330, 760, X)
    zgap = 2.2 + 1.2 * hum - 0.17 * np.maximum(X - 930, 0) + 30 * (1 - np.exp(-(my / 150.0) ** 2))
    z = z * (1 - g) + zgap * g
    z += ((rg - 0.42) * 150 + (rgb - 0.4) * 90) * 4 * g * (1 - g) * sstep(600, 800, X)
    # river channel from the lake to the lip of the gap
    ch = np.exp(-(my / 9.0) ** 2) * sstep(150, 300, X) * (1 - sstep(900, 930, X))
    z = z * (1 - ch) + np.minimum(z, -0.7) * ch
    return z


_cache = {}


def grid(cache_dir):
    """Heightfield on the warped grid, cached to disk."""
    if 'g' in _cache:
        return _cache['g']
    path = os.path.join(cache_dir, 'height_v%d_%d.npy' % (VERSION, N))
    ax = axis()
    if os.path.exists(path):
        Z = np.load(path)
    else:
        X, Y = np.meshgrid(ax, ax, indexing='xy')
        Z = np.empty_like(X)
        for i in range(0, N, 250):
            Z[i:i + 250] = height_fn(X[i:i + 250], Y[i:i + 250])
        os.makedirs(cache_dir, exist_ok=True)
        np.save(path, Z)
    _cache['g'] = (ax, Z)
    return ax, Z


def height(cache_dir, x, y):
    """Bilinear lookup in the cached grid."""
    ax, Z = grid(cache_dir)
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    idx = np.arange(N, dtype=np.float64)
    fx = np.clip(np.interp(x, ax, idx), 0, N - 1.001)
    fy = np.clip(np.interp(y, ax, idx), 0, N - 1.001)
    ix = fx.astype(int)
    iy = fy.astype(int)
    tx = fx - ix
    ty = fy - iy
    return (Z[iy, ix] * (1 - tx) * (1 - ty) + Z[iy, ix + 1] * tx * (1 - ty)
            + Z[iy + 1, ix] * (1 - tx) * ty + Z[iy + 1, ix + 1] * tx * ty)


def slope_grid(cache_dir):
    ax, Z = grid(cache_dir)
    dzdy, dzdx = np.gradient(Z, ax, ax)
    return np.hypot(dzdx, dzdy)


def albedo(cache_dir):
    """Per-vertex base colour (N, N, 3), linear."""
    ax, Z = grid(cache_dir)
    X, Y = np.meshgrid(ax, ax, indexing='xy')
    sl = slope_grid(cache_dir)
    n1 = fbm(X / 35, Y / 35, 4, 301)
    n2 = fbm(X / 140, Y / 140, 3, 302)
    n3 = fbm(X / 9, Y / 9, 3, 303)
    strata = 0.5 + 0.5 * np.sin(Z / 7.0 + n2 * 4 + n1 * 1.5)

    rock = np.stack([0.115 + 0.05 * strata + 0.03 * n1, 0.10 + 0.042 * strata + 0.025 * n1,
                     0.095 + 0.035 * strata + 0.02 * n1], -1)
    grass_a = np.array([0.045, 0.085, 0.022])
    grass_b = np.array([0.10, 0.115, 0.03])
    gm = np.clip(0.5 + 0.6 * n2 + 0.35 * n3, 0, 1)[..., None]
    grass = grass_a * (1 - gm) + grass_b * gm
    gravel = np.stack([0.09 + 0.03 * n3, 0.085 + 0.03 * n3, 0.075 + 0.025 * n3], -1)
    snow = np.stack([0.80 + 0.04 * n1, 0.83 + 0.04 * n1, 0.88 + 0.03 * n1], -1)
    ice = np.array([0.42, 0.60, 0.70])

    forest = sstep(-0.22, 0.18, fbm(X / 170, Y / 170, 3, 501) + 0.45 * fbm(X / 45, Y / 45, 2, 502))[..., None]
    grass = grass * (1 - 0.6 * forest) + np.array([0.022, 0.034, 0.016]) * 0.6 * forest
    veg = (1 - sstep(0.55, 1.05, sl + 0.15 * n1)) * (1 - sstep(95, 185, Z + 30 * n2))
    col = rock * (1 - veg[..., None]) + grass * veg[..., None]
    shore = (1 - sstep(0.25, 1.1, Z + 0.3 * n3)) * (1 - sstep(0.6, 1.0, sl))
    col = col * (1 - shore[..., None]) + gravel * shore[..., None]
    under = 1 - sstep(-1.5, -0.1, Z)
    col = col * (1 - 0.6 * under[..., None])
    sn = sstep(165, 235, Z + 35 * n2 + 12 * n1) * (1 - sstep(0.95, 1.7, sl + 0.25 * n1))
    crev = sstep(0.35, 0.8, sl) * sn
    snowc = snow * (1 - 0.55 * crev[..., None]) + ice * 0.55 * crev[..., None]
    col = col * (1 - sn[..., None]) + snowc * sn[..., None]
    return np.clip(col, 0, 1), sn


def place_trees(cache_dir, count=60000, seed=7):
    """Returns (x, y, z, height, yaw, variant) arrays."""
    rng = np.random.default_rng(seed)
    out = []
    need = count
    while need > 0:
        n = need * 6
        x = rng.uniform(-1250, 1300, n)
        y = rng.uniform(-1150, 1150, n)
        z = height(cache_dir, x, y)
        e = 0.5
        sl = np.hypot(height(cache_dir, x + e, y) - height(cache_dir, x - e, y),
                      height(cache_dir, x, y + e) - height(cache_dir, x, y - e)) / (2 * e)
        clump = fbm(x / 170, y / 170, 3, 501)
        fine = fbm(x / 45, y / 45, 2, 502)
        p = sstep(-0.22, 0.18, clump + 0.45 * fine)
        p *= sstep(0.6, 3.0, z) * (1 - sstep(60, 200, z + 50 * clump)) * (1 - sstep(0.55, 1.15, sl))
        # keep the outflow meadow and the river open so the sun gets in
        my = y + 60 * np.sin(x / 260.0) + 25 * np.sin(x / 97.0 + 1.3)
        p *= 1 - 0.93 * np.exp(-(my / 55.0) ** 2) * sstep(200, 320, x)
        keep = rng.uniform(0, 1, n) < p
        k = np.flatnonzero(keep)[:need]
        hz = 6 + 19 * rng.beta(2.0, 2.2, k.size) * (1 - 0.45 * sstep(60, 180, z[k]))
        out.append(np.stack([x[k], y[k], z[k], hz, rng.uniform(0, 2 * np.pi, k.size),
                             rng.integers(0, 4, k.size).astype(float)], 1))
        need -= k.size
    a = np.concatenate(out, 0)
    # saplings and shore scrub: small trees crowd the forest edge and the waterline
    n = 400000
    x = rng.uniform(-700, 900, n)
    y = rng.uniform(-650, 650, n)
    z = height(cache_dir, x, y)
    clump = fbm(x / 170, y / 170, 3, 501) + 0.45 * fbm(x / 45, y / 45, 2, 502)
    edge = np.exp(-((clump + 0.05) / 0.16) ** 2)
    shore = np.exp(-((z - 1.2) / 1.0) ** 2) * (0.35 + 0.65 * sstep(-0.2, 0.3, fbm(x / 25, y / 25, 2, 503)))
    my = y + 60 * np.sin(x / 260.0) + 25 * np.sin(x / 97.0 + 1.3)
    open_ = 1 - 0.9 * np.exp(-(my / 30.0) ** 2) * sstep(200, 320, x)
    p = np.clip(0.5 * edge + 0.55 * shore, 0, 1) * (z > 0.35) * (z < 120) * open_
    k = np.flatnonzero(rng.uniform(0, 1, n) < p * 0.16)
    b = np.stack([x[k], y[k], z[k], 1.6 + 5.5 * rng.beta(1.5, 3.0, k.size), rng.uniform(0, 2 * np.pi, k.size),
                  rng.integers(0, 4, k.size).astype(float)], 1)
    a = np.concatenate([a, b], 0)
    keep = np.ones(len(a), bool)
    for (cx, cy, r) in CLEAR_CIRCLES:
        keep &= np.hypot(a[:, 0] - cx, a[:, 1] - cy) > r
    for (cx, cy, az0, az1, dist) in CLEAR_WEDGES:
        dx, dy = a[:, 0] - cx, a[:, 1] - cy
        az = np.degrees(np.arctan2(dy, dx))
        keep &= ~((az > az0) & (az < az1) & (np.hypot(dx, dy) < dist))
    return a[keep]


# camera clearings: circles (x, y, r) and view wedges (x, y, az0 deg, az1 deg, distance)
CLEAR_CIRCLES = [(467.0, -36.0, 19.0), (-392.0, 6.0, 16.0), (-345.0, 100.0, 16.0)]
CLEAR_WEDGES = [(-392.0, 6.0, -42.0, 62.0, 115.0), (-345.0, 100.0, -45.0, 28.0, 130.0)]


def place_tufts(cache_dir, seed=3):
    """Grass tufts near the ground-level cameras: (x, y, z, size, yaw)."""
    rng = np.random.default_rng(seed)
    out = []
    for (cx, cy, r, n, sz) in [(467.0, -36.0, 60.0, 70000, 1.0), (-392.0, 6.0, 45.0, 45000, 0.55), (-345.0, 100.0, 40.0, 35000, 0.55)]:
        rr = r * rng.uniform(0, 1, n) ** 0.85
        th = rng.uniform(0, 2 * np.pi, n)
        x, y = cx + rr * np.cos(th), cy + rr * np.sin(th)
        z = height(cache_dir, x, y)
        k = z > 0.12
        out.append(np.stack([x[k], y[k], z[k], sz * rng.uniform(0.55, 1.5, k.sum()) * (0.6 + 0.6 * sstep(-0.3, 0.3, fbm(x[k] / 6, y[k] / 6, 2, 601))),
                             rng.uniform(0, 2 * np.pi, k.sum())], 1))
    return np.concatenate(out, 0)
