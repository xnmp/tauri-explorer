"""Synthesises the soundtrack with numpy only: wind in the pines, lake water, a sustained tone under
the reveal, distant crane calls, the patter and wingbeats of the take-off.

    python3 audio.py out.wav
"""
import sys
import wave

import numpy as np

SR = 48000
DUR = 39.85
N = int(SR * DUR)
T = np.arange(N) / SR
rng = np.random.default_rng(1962)


def sm(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def shaped_noise(n, shape):
    """White noise with its spectrum multiplied by shape(freq)."""
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    out = np.fft.irfft(spec * shape(f), n)
    return out / (np.abs(out).max() + 1e-9)


def band(lo, hi, tilt=1.0):
    return lambda f: (1 / (1 + (lo / np.maximum(f, 1)) ** 4)) * (1 / (1 + (f / hi) ** 4)) / np.maximum(f, 20) ** (tilt * 0.5)


def slow(rate, seed):
    """Smooth random modulation in [0, 1] with features about 1/rate seconds long."""
    r = np.random.default_rng(seed)
    k = int(DUR * rate) + 4
    pts = r.uniform(0, 1, k)
    x = T * rate
    i = x.astype(int)
    f = x - i
    f = f * f * (3 - 2 * f)
    return pts[i] * (1 - f) + pts[i + 1] * f


def convolve(x, ir):
    n = len(x) + len(ir) - 1
    m = 1 << (n - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(x, m) * np.fft.rfft(ir, m), m)[:len(x)]


def valley_ir(seed, length=3.2, predelay=0.0):
    """A long, dark tail with two discrete slap echoes off the walls."""
    r = np.random.default_rng(seed)
    n = int(length * SR)
    t = np.arange(n) / SR
    tail = r.standard_normal(n) * np.exp(-t / 0.75)
    spec = np.fft.rfft(tail)
    f = np.fft.rfftfreq(n, 1 / SR)
    tail = np.fft.irfft(spec / (1 + (f / 2600) ** 2), n)
    tail /= np.sqrt((tail ** 2).sum())
    ir = tail * 0.45
    for d, g in ((0.62 + 0.05 * r.uniform(), 0.42), (1.31 + 0.1 * r.uniform(), 0.22), (2.2, 0.09)):
        ir[int(d * SR)] += g
    ir[0] += 1.0
    if predelay:
        ir = np.concatenate([np.zeros(int(predelay * SR)), ir])
    return ir


def crane_note(dur, f_lo, f_peak, seed, trill=34.0):
    """One bugle note: a harmonic stack through fixed formants, with the rattling trill of a crane."""
    r = np.random.default_rng(seed)
    n = int(dur * SR)
    t = np.arange(n) / SR
    u = t / dur
    f0 = f_lo + (f_peak - f_lo) * np.sin(np.pi * np.clip(u * 1.25, 0, 1)) ** 0.7 - 40 * u ** 2
    f0 = f0 * (1 + 0.006 * np.sin(2 * np.pi * 7.3 * t + r.uniform(0, 6)))
    ph = 2 * np.pi * np.cumsum(f0) / SR
    out = np.zeros(n)
    for k in range(1, 14):
        fk = f0 * k
        formant = (0.25 + np.exp(-((fk - 1150) / 420) ** 2) + 0.7 * np.exp(-((fk - 2500) / 600) ** 2)
                   + 0.35 * np.exp(-((fk - 3900) / 800) ** 2))
        out += formant / k ** 0.6 * np.sin(k * ph + r.uniform(0, 6)) * (fk < 9000)
    rattle = 1 - 0.55 * (0.5 + 0.5 * np.sin(2 * np.pi * trill * t + 3 * np.sin(2 * np.pi * 3 * t))) ** 2
    env = sm(0, 0.05, u) * (1 - sm(0.72, 1.0, u)) ** 1.5
    breath = shaped_noise(n, band(1500, 6000, 0.5)) * 0.05
    return (out / np.abs(out).max() * rattle + breath) * env


def place(mix, sig, t0, gain, pan=0.5):
    i = int(t0 * SR)
    j = min(i + len(sig), N)
    if i >= N:
        return
    mix[0, i:j] += sig[:j - i] * gain * np.cos(pan * np.pi / 2)
    mix[1, i:j] += sig[:j - i] * gain * np.sin(pan * np.pi / 2)


mix = np.zeros((2, N))

# --- wind in the pines: band-limited noise breathing slowly, decorrelated left and right
for ch in (0, 1):
    hiss = shaped_noise(N, band(350, 3800, 1.3))
    low = shaped_noise(N, band(60, 420, 1.0))
    gust = 0.25 + 0.75 * slow(0.22, 10 + ch) ** 1.6
    presence = 0.35 + 0.65 * sm(6.5, 9.5, T) * (1 - 0.55 * sm(20.5, 22.5, T))      # we stand among the trees in shot 2-3
    mix[ch] += hiss * gust * presence * 0.050 + low * (0.4 + 0.6 * slow(0.12, 20 + ch)) * 0.030

# --- the lake: small water sounds, close, in the lake shots
for ch in (0, 1):
    lap = shaped_noise(N, band(500, 2600, 1.6))
    mod = np.clip(slow(1.7, 30 + ch) * 1.6 - 0.75, 0, 1) ** 2 * (0.5 + 0.5 * slow(0.35, 40 + ch))
    where = (1 - sm(6.8, 8.6, T)) + sm(20.8, 22.0, T)
    mix[ch] += lap * mod * where * 0.085

# --- a single sustained tone under the reveal (D), with a fifth arriving as the valley opens
def pad(freqs, t_in, t_peak, t_out, gain):
    out = np.zeros((2, N))
    env = sm(t_in, t_peak, T) * (1 - sm(t_out - 5.0, t_out, T))
    for f, a in freqs:
        for ch, det in ((0, -0.0018), (1, 0.0018)):
            vib = 1 + 0.0012 * np.sin(2 * np.pi * 0.19 * T + f)
            ph = 2 * np.pi * np.cumsum(f * (1 + det) * vib) / SR
            out[ch] += a * (np.sin(ph) + 0.22 * np.sin(2 * ph + 1.0) + 0.07 * np.sin(3 * ph + 2.0))
    return out * env * gain


mix += pad([(73.42, 1.0), (146.83, 0.5)], 9.5, 16.5, 31.0, 0.030)
mix += pad([(220.0, 0.35), (293.66, 0.22)], 14.2, 18.5, 28.0, 0.024)
mix += pad([(146.83, 0.6), (220.0, 0.4), (440.0, 0.10)], 30.5, 35.5, DUR + 3.0, 0.028)

# --- crane calls. Far off in the dark first; then the bird we are watching, answered; then the flock leaving.
ir_far = valley_ir(5, predelay=0.0)
ir_near = valley_ir(6)


def call(t0, notes, gain, pan, far):
    for k, (dt, dur, lo, hi) in enumerate(notes):
        note = crane_note(dur, lo, hi, seed=int(t0 * 100) + k)
        wet = convolve(np.concatenate([note, np.zeros(int(3.4 * SR))]), ir_far if far else ir_near)
        if far:     # air absorbs the top end over distance
            spec = np.fft.rfft(wet)
            f = np.fft.rfftfreq(len(wet), 1 / SR)
            wet = np.fft.irfft(spec / (1 + (f / 2200) ** 2), len(wet))
        place(mix, wet / np.abs(wet).max(), t0 + dt, gain, pan)


call(4.3, [(0.0, 0.55, 760, 930)], 0.075, 0.30, True)
call(11.6, [(0.0, 0.5, 780, 950), (0.75, 0.42, 900, 1090)], 0.05, 0.7, True)
call(22.25, [(0.0, 0.62, 800, 1010), (0.78, 0.36, 960, 1180), (1.18, 0.34, 980, 1200)], 0.15, 0.52, False)
call(26.4, [(0.0, 0.5, 820, 1000)], 0.11, 0.35, False)
call(29.3, [(0.0, 0.48, 790, 980), (0.7, 0.4, 930, 1120)], 0.09, 0.3, False)
call(35.2, [(0.0, 0.5, 800, 980)], 0.07, 0.6, True)
call(37.1, [(0.0, 0.45, 830, 1010)], 0.045, 0.65, True)

# --- the take-off: feet pattering on the shallows, then wingbeats, six birds, never in step
patter = np.zeros((2, N))
for b in range(6):
    start = 24.35 + [0.8, 0.45, 1.2, 0.2, 0.0, 1.65][b]
    t, rate = start, 2.8
    while t < start + 1.7:
        n = int(0.11 * SR)
        s = shaped_noise(n, band(900, 5200, 0.8)) * np.exp(-np.arange(n) / (0.022 * SR))
        place(patter, s, t + 0.25, 0.05 * rng.uniform(0.6, 1.0), 0.35 + 0.05 * b)
        t += 1 / (2 * rate)
        rate += 0.12
    t, rate = start + 0.2, 3.3
    while t < 33.5:
        n = int(0.22 * SR)
        e = np.sin(np.pi * np.arange(n) / n) ** 2
        s = shaped_noise(n, band(90, 520, 0.6)) * e
        fade = np.exp(-max(t - start - 2.0, 0) / 3.2)
        place(patter, s, t + 0.25, 0.05 * fade * rng.uniform(0.7, 1.0), 0.6 - 0.07 * b)
        t += 1 / rate * rng.uniform(0.96, 1.04)
        rate = max(rate - 0.035, 2.45)
mix += patter

# --- master: fades to match the picture, gentle high-pass, peak at -3 dBFS
mix *= sm(0.0, 2.2, T) * (1 - sm(DUR - 2.6, DUR - 0.05, T))
spec = np.fft.rfft(mix, axis=1)
f = np.fft.rfftfreq(N, 1 / SR)
mix = np.fft.irfft(spec * (1 / (1 + (35 / np.maximum(f, 1)) ** 4)), N, axis=1)
mix = np.tanh(mix / np.abs(mix).max() * 1.15) / np.tanh(1.15) * 0.708
pcm = (mix.T * 32767 + rng.uniform(-0.5, 0.5, (N, 2))).astype('<i2')
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print('wrote', sys.argv[1], 'rms dBFS %.1f' % (20 * np.log10(np.sqrt((mix ** 2).mean()))))
