#!/usr/bin/env python3
"""
make_ludo_audio.py — builds the Ludo game's pre-rendered audio kit, the same
way synthesize_story.py builds story narration: offline, no API keys, no
accounts, $0 forever.

Two kinds of audio come out of this:

  1. ANNOUNCER CALLS ("Double kill!", "Rampage!", "Ransom paid!" ...) —
     spoken by Piper (the same local TTS the stories use), then run through
     a "stadium announcer" effects chain: pitched down a touch, bass-boosted,
     compressed, doubled for thickness, and put in a big reverberant room.

  2. SOUND EFFECTS (dice, impacts, gold ping, fanfare, crowd ...) — rendered
     here with numpy as LAYERED sounds (sub-bass + noise transient + metallic
     partials + room reverb), which is what separates a produced game sound
     from a single synth beep. No samples are downloaded or copied from
     anywhere, so there is nothing to license.

Usage:
    pip install piper-tts numpy scipy
    python make_ludo_audio.py --model /path/to/en-us-ryan-high.onnx \
        --out ../../public/ludo-audio

Needs ffmpeg on the PATH (for MP3 encoding). Piper voice models:
https://rhasspy.github.io/piper-samples/  — the default here is a deep male
voice (ryan-high), which suits an announcer. Any English voice works.

The whole kit is small on purpose (well under 1 MB) so it costs a player
almost nothing to download once; the game caches it on the device after the
first load, same as story audio, and falls back to the built-in synth sounds
if any file is missing.
"""

import argparse
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np
from scipy import signal

SR = 44100
RNG = np.random.default_rng(7)  # fixed seed -> identical output every run


# ----------------------------------------------------------------------------
# DSP building blocks
# ----------------------------------------------------------------------------

def tvec(d):
    return np.linspace(0, d, int(SR * d), endpoint=False)


def exp_env(n, attack=0.002, decay=0.2):
    """Fast attack, exponential decay — the shape of nearly every struck sound."""
    t = np.arange(n) / SR
    a = 1 - np.exp(-t / max(attack, 1e-5))
    return a * np.exp(-t / max(decay, 1e-5))


def sweep(f0, f1, d, curve="exp"):
    """Sine whose frequency glides f0 -> f1 (phase-integrated, so it's clean)."""
    n = int(SR * d)
    t = np.linspace(0, 1, n, endpoint=False)
    if curve == "exp":
        f = f0 * (f1 / f0) ** t
    else:
        f = f0 + (f1 - f0) * t
    phase = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(phase)


def noise(d):
    return RNG.uniform(-1, 1, int(SR * d))


def bandpass(x, lo, hi, order=3):
    sos = signal.butter(order, [lo, hi], btype="band", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def lowpass(x, fc, order=3):
    sos = signal.butter(order, fc, btype="low", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def highpass(x, fc, order=3):
    sos = signal.butter(order, fc, btype="high", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def swept_noise(d, f0, f1, q=1.2):
    """Whoosh: noise through a band-pass whose center glides f0 -> f1."""
    n = int(SR * d)
    x = noise(d)
    out = np.zeros(n)
    steps = 40
    seg = n // steps
    for i in range(steps):
        fc = f0 * (f1 / f0) ** (i / (steps - 1))
        lo, hi = max(40, fc / (1 + 1 / q)), min(SR / 2 - 100, fc * (1 + 1 / q))
        out[i * seg:(i + 1) * seg] = bandpass(x[i * seg:(i + 1) * seg + 400], lo, hi, 2)[:seg]
    return out


def bell(f, d, partials=(1, 2.76, 5.4, 8.93, 11.34), decays=(1, 0.6, 0.35, 0.2, 0.12), bright=1.0):
    """Struck-metal tone: inharmonic partials, each fading at its own rate.
    Inharmonic ratios are what make it sound like metal rather than a synth."""
    n = int(SR * d)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for i, (r, dc) in enumerate(zip(partials, decays)):
        amp = (1.0 / (1 + i * (1.4 - 0.4 * bright)))
        out += amp * np.sin(2 * np.pi * f * r * t + RNG.uniform(0, 6.28)) * np.exp(-t / (d * 0.28 * dc + 1e-3))
    return out * (1 - np.exp(-t / 0.0015))


def make_ir(rt60, damp=6000, predelay=0.0):
    """Synthetic room: decaying noise, darkened over time — a convincing hall
    for zero bytes (no IR file to ship)."""
    n = int(SR * rt60)
    t = np.arange(n) / SR
    ir = RNG.normal(0, 1, n) * np.exp(-6.9 * t / rt60)
    ir = lowpass(ir, damp, 2)
    if predelay:
        ir = np.concatenate([np.zeros(int(SR * predelay)), ir])
    return ir / (np.sqrt(np.sum(ir ** 2)) + 1e-9)


def reverb(x, rt60=1.0, wet=0.25, damp=6000, predelay=0.0):
    ir = make_ir(rt60, damp, predelay)
    w = signal.fftconvolve(x, ir)[: len(x) + int(SR * rt60)]
    dry = np.concatenate([x, np.zeros(len(w) - len(x))])
    # match wet level to dry level so `wet` behaves like a real mix knob
    w = w * (np.sqrt(np.mean(dry ** 2) + 1e-12) / (np.sqrt(np.mean(w ** 2)) + 1e-12))
    return (1 - wet) * dry + wet * w * 1.4


def place(buf, x, start, gain=1.0):
    # Every layer ends on a short fade (15% of its length, 3-60 ms) so no layer
    # can stop abruptly mid-sound and click.
    x = fade_out(x, min(60, max(3, 0.15 * len(x) / SR * 1000)))
    i = int(SR * start)
    need = i + len(x)
    if need > len(buf):
        buf = np.concatenate([buf, np.zeros(need - len(buf))])
    buf[i:i + len(x)] += x * gain
    return buf


def mix(*xs):
    """Sum signals of different lengths (shorter ones are zero-padded)."""
    n = max(len(x) for x in xs)
    out = np.zeros(n)
    for x in xs:
        out[:len(x)] += x
    return out


def fit(x, d):
    n = int(SR * d)
    return np.concatenate([x, np.zeros(max(0, n - len(x)))])[:n]


def fade_out(x, ms=40):
    n = min(len(x), int(SR * ms / 1000))
    x = x.copy()
    x[-n:] *= np.linspace(1, 0, n)
    return x


def trim_silence(x, thresh=0.003):
    idx = np.where(np.abs(x) > thresh)[0]
    return x[idx[0]: idx[-1] + 1] if len(idx) else x


def trim_tail(x, floor_db=-52, fade_ms=90):
    """Cut the inaudible reverb tail: find the last moment louder than
    `floor_db` and fade out just after it. Saves bytes and stops a long
    near-silent tail from overlapping the next sound."""
    w = int(SR * 0.02)
    env = np.array([np.max(np.abs(x[i:i + w])) for i in range(0, max(1, len(x) - w), w)])
    above = np.where(env > 10 ** (floor_db / 20) * max(np.max(np.abs(x)), 1e-9))[0]
    if not len(above):
        return x
    end = min(len(x), (above[-1] + 1) * w + int(SR * fade_ms / 1000))
    return fade_out(x[:end], fade_ms)


def norm(x, peak=0.89):
    m = np.max(np.abs(x)) + 1e-9
    return x / m * peak


def soft_clip(x, drive=1.6):
    return np.tanh(x * drive) / np.tanh(drive)


def sawtooth(f, d):
    n = int(SR * d)
    ph = 2 * np.pi * np.cumsum(np.full(n, f)) / SR
    return signal.sawtooth(ph)


def peaking_eq(x, f0, gain_db, q=1.0):
    """RBJ peaking EQ biquad."""
    A = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f0 / SR
    alpha = np.sin(w0) / (2 * q)
    b = [1 + alpha * A, -2 * np.cos(w0), 1 - alpha * A]
    a = [1 + alpha / A, -2 * np.cos(w0), 1 - alpha / A]
    return signal.lfilter(b, a, x)


def low_shelf(x, f0, gain_db, S=1.0):
    A = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f0 / SR
    alpha = np.sin(w0) / 2 * np.sqrt((A + 1 / A) * (1 / S - 1) + 2)
    cw = np.cos(w0)
    b0 = A * ((A + 1) - (A - 1) * cw + 2 * np.sqrt(A) * alpha)
    b1 = 2 * A * ((A - 1) - (A + 1) * cw)
    b2 = A * ((A + 1) - (A - 1) * cw - 2 * np.sqrt(A) * alpha)
    a0 = (A + 1) + (A - 1) * cw + 2 * np.sqrt(A) * alpha
    a1 = -2 * ((A - 1) + (A + 1) * cw)
    a2 = (A + 1) + (A - 1) * cw - 2 * np.sqrt(A) * alpha
    return signal.lfilter([b0 / a0, b1 / a0, b2 / a0], [1, a1 / a0, a2 / a0], x)


# ----------------------------------------------------------------------------
# Sound effects
# ----------------------------------------------------------------------------

def kick(f0=150, f1=40, d=0.35, decay=0.14):
    n = int(SR * d)
    return sweep(f0, f1, d) * exp_env(n, 0.001, decay)


def crack(d=0.15, lo=900, hi=7000, decay=0.03):
    n = int(SR * d)
    return bandpass(noise(d), lo, hi) * exp_env(n, 0.0005, decay)


def fx_click():
    x = crack(0.05, 1500, 6000, 0.008) + 0.5 * sweep(900, 600, 0.05) * exp_env(int(SR * 0.05), 0.0005, 0.01)
    return norm(x, 0.5)


def fx_step():
    n = int(SR * 0.18)
    thud = sweep(190, 95, 0.18) * exp_env(n, 0.001, 0.05)
    tap = lowpass(noise(0.18), 1400) * exp_env(n, 0.0005, 0.025)
    return norm(thud + 0.6 * tap, 0.55)


def fx_roll():
    """Dice rattling in a cup then settling: 9 wooden clacks, each a different
    pitch, finishing on one heavier knock at ~0.5 s — timed to land exactly as
    the on-screen roll animation ends (8 ticks x 65 ms)."""
    buf = np.zeros(int(SR * 0.8))
    t = 0.0
    for i in range(9):
        f = RNG.uniform(1800, 3600)
        n = int(SR * 0.05)
        clack = bandpass(noise(0.05), f * 0.7, f * 1.5) * exp_env(n, 0.0004, 0.011)
        body = sweep(RNG.uniform(260, 420), 150, 0.05) * exp_env(n, 0.0004, 0.014)
        buf = place(buf, clack + 0.6 * body, t, RNG.uniform(0.6, 1.0))
        t += 0.032 + i * 0.003 + RNG.uniform(0, 0.012)
    n = int(SR * 0.12)
    knock = sweep(210, 110, 0.12) * exp_env(n, 0.0008, 0.04) + 0.7 * crack(0.12, 700, 3500, 0.02)
    buf = place(buf, knock, t + 0.02, 1.0)
    return norm(reverb(buf, 0.35, 0.12), 0.8)


def fx_safe():
    buf = place(np.zeros(int(SR * 0.9)), bell(880, 0.8), 0.0, 0.8)
    buf = place(buf, bell(1318, 0.8), 0.08, 0.7)
    return norm(reverb(buf, 0.8, 0.22), 0.7)


def fx_whoosh(d=0.4):
    x = swept_noise(d, 300, 4200) * np.sin(np.pi * np.linspace(0, 1, int(SR * d))) ** 1.5
    return norm(x, 0.7)


def fx_exit():
    """A token breaks out of the yard: whoosh up into a bright 4-note sparkle."""
    buf = place(np.zeros(int(SR * 0.9)), fx_whoosh(0.32), 0.0, 0.7)
    for i, f in enumerate([523.25, 659.25, 783.99, 1046.5]):
        n = int(SR * 0.4)
        tone = (np.sin(2 * np.pi * f * np.arange(n) / SR) + 0.3 * np.sin(4 * np.pi * f * np.arange(n) / SR)) * exp_env(n, 0.002, 0.14)
        buf = place(buf, tone, 0.2 + i * 0.07, 0.5)
    return norm(reverb(buf, 0.7, 0.2), 0.8)


def fx_home():
    """Gold ping — the bright metallic 'cling' plus a little coin jingle."""
    buf = np.zeros(int(SR * 1.3))
    buf = place(buf, bell(1568, 1.1, partials=(1, 2.01, 3.0, 4.17, 5.43), decays=(1, 0.7, 0.5, 0.3, 0.2), bright=1.2), 0.0, 0.9)
    buf = place(buf, bell(2093, 0.9, partials=(1, 2.01, 3.0, 4.17), decays=(1, 0.6, 0.4, 0.25), bright=1.2), 0.07, 0.6)
    for i in range(7):
        f = RNG.uniform(3200, 5200)
        buf = place(buf, bell(f, 0.18, partials=(1, 1.5, 2.4), decays=(1, 0.5, 0.3), bright=1.2), 0.12 + i * RNG.uniform(0.035, 0.06), RNG.uniform(0.18, 0.4))
    return norm(reverb(buf, 0.9, 0.2), 0.85)


def fx_capture(level=1):
    """The big one. Layers: sub-bass drop, noise crack, low metal clang, and a
    reverb tail. Higher levels stack extra hits, a riser and a cymbal wash."""
    hits = {1: [0.0], 2: [0.0, 0.1], 3: [0.0, 0.1, 0.2]}[level]
    buf = np.zeros(int(SR * (1.8 + 0.3 * level)))
    for i, h in enumerate(hits):
        g = 1.0 - i * 0.12
        sub = kick(170 - i * 14, 36, 0.5, 0.2)
        body = kick(260, 70, 0.25, 0.07) * 0.7
        snap = crack(0.18, 800, 8000, 0.04) * 0.9
        clang = bell(180 + i * 30, 1.3, partials=(1, 2.32, 4.18, 6.7, 9.4), decays=(1, 0.7, 0.5, 0.3, 0.2)) * 0.45
        buf = place(buf, mix(sub, body, snap, clang), h, g)
    if level >= 2:
        riser = swept_noise(0.55, 400, 6500) * np.linspace(0, 1, int(SR * 0.55)) ** 2
        buf = place(buf, riser, 0.0, 0.35)
    if level >= 3:
        wash = fade_out(highpass(noise(1.4), 3500) * exp_env(int(SR * 1.4), 0.01, 0.4), 700)
        buf = place(buf, wash, 0.2, 0.5)
        buf = place(buf, kick(90, 28, 0.9, 0.4), 0.2, 0.8)
    buf = soft_clip(buf, 1.3)
    return norm(reverb(buf, 1.1 + 0.2 * level, 0.22), 0.95)


def fx_imprison():
    """Iron cell door: heavy clang, then a handful of chain rattles."""
    buf = np.zeros(int(SR * 1.4))
    for h, f in [(0.0, 330), (0.11, 290)]:
        buf = place(buf, bell(f, 0.9, partials=(1, 2.1, 3.4, 5.2, 7.9), decays=(1, 0.8, 0.6, 0.4, 0.3), bright=0.8), h, 0.9)
        buf = place(buf, crack(0.1, 1500, 9000, 0.015), h, 0.8)
    buf = place(buf, kick(120, 45, 0.3, 0.1), 0.0, 0.8)
    t = 0.3
    for _ in range(9):
        f = RNG.uniform(2500, 6500)
        buf = place(buf, bell(f, 0.14, partials=(1, 1.7, 2.9), decays=(1, 0.5, 0.3)), t, RNG.uniform(0.2, 0.5))
        t += RNG.uniform(0.04, 0.09)
    return norm(reverb(buf, 0.9, 0.2), 0.9)


def fx_buyback():
    """Lock click, a thunk, then a rising relieved shimmer — 'you're free'."""
    buf = np.zeros(int(SR * 1.5))
    buf = place(buf, crack(0.05, 2000, 7000, 0.008), 0.0, 0.9)
    buf = place(buf, crack(0.06, 1200, 5000, 0.012), 0.07, 0.8)
    buf = place(buf, kick(140, 60, 0.18, 0.06), 0.09, 0.7)
    for i, f in enumerate([523.25, 659.25, 783.99, 1046.5, 1318.5]):
        n = int(SR * 0.7)
        t = np.arange(n) / SR
        tone = (np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * f * 2 * t)) * exp_env(n, 0.003, 0.22)
        buf = place(buf, tone, 0.2 + i * 0.075, 0.45)
    buf = place(buf, bell(2093, 0.9, partials=(1, 2.01, 3.0), decays=(1, 0.6, 0.4), bright=1.2), 0.55, 0.45)
    return norm(reverb(buf, 1.0, 0.25), 0.85)


def fx_ransom_alert():
    buf = np.zeros(int(SR * 0.9))
    buf = place(buf, bell(740, 0.5, partials=(1, 2.0, 3.0), decays=(1, 0.5, 0.3), bright=1.1), 0.0, 0.8)
    buf = place(buf, bell(988, 0.6, partials=(1, 2.0, 3.0), decays=(1, 0.5, 0.3), bright=1.1), 0.12, 0.8)
    buf = place(buf, bell(988, 0.6, partials=(1, 2.0, 3.0), decays=(1, 0.5, 0.3), bright=1.1), 0.42, 0.3)  # echo
    return norm(reverb(buf, 0.6, 0.2), 0.7)


def fx_six_banked():
    """Rising magical glissando — a guaranteed six has been banked for you."""
    buf = np.zeros(int(SR * 1.5))
    for i, f in enumerate([523.25, 659.25, 783.99, 1046.5, 1318.5, 1568.0]):
        buf = place(buf, bell(f, 0.9, partials=(1, 2.0, 3.01, 4.2), decays=(1, 0.6, 0.4, 0.25), bright=1.2), i * 0.085, 0.6)
    buf = place(buf, swept_noise(0.5, 1500, 9000) * np.linspace(0, 1, int(SR * 0.5)), 0.0, 0.18)
    return norm(reverb(buf, 1.2, 0.28), 0.8)


def fx_forfeit():
    buf = np.zeros(int(SR * 0.9))
    for h, (a, b) in [(0.0, (150, 95)), (0.22, (112, 70))]:
        n = int(SR * 0.5)
        tone = lowpass(sawtooth(a, 0.5) * np.linspace(1, 0.7, n), 1100) * exp_env(n, 0.005, 0.25)
        buf = place(buf, tone, h, 0.7)
    buf = place(buf, kick(100, 38, 0.5, 0.2), 0.0, 0.9)
    return norm(reverb(buf, 0.6, 0.15), 0.85)


def fx_pass():
    n = int(SR * 0.35)
    x = sweep(420, 190, 0.35) * exp_env(n, 0.003, 0.14)
    return norm(reverb(x, 0.4, 0.12), 0.6)


def fx_win():
    """Victory fanfare: brass-style stack (detuned saws through a lowpass that
    opens on each note), timpani underneath, a cymbal crash on the last chord,
    all in a big hall."""
    def brass(freqs, d, vol=1.0):
        n = int(SR * d)
        t = np.arange(n) / SR
        out = np.zeros(n)
        for f in freqs:
            for det in (-0.004, 0.0, 0.004):
                out += sawtooth(f * (1 + det), d)
        env = (1 - np.exp(-t / 0.035)) * np.exp(-np.maximum(t - d * 0.75, 0) / (d * 0.12))
        # filter opens with the note (the "blat" of a brass attack)
        bright = lowpass(out, 3200, 2) * np.exp(-t / 0.25) + lowpass(out, 1200, 2) * (1 - np.exp(-t / 0.25))
        return bright * env * vol / (len(freqs) * 3)

    buf = np.zeros(int(SR * 5.0))
    C4, E4, G4, C5, E5, G5, C6 = 261.63, 329.63, 392.0, 523.25, 659.25, 783.99, 1046.5
    # "da da da DAAA" call, then the answering phrase
    notes = [(0.00, 0.18, [G4, C5]), (0.20, 0.18, [G4, C5]), (0.40, 0.18, [G4, C5]),
             (0.62, 0.9, [C5, E5, G5]), (1.62, 0.28, [E5, G5, C6]), (1.92, 0.28, [G5, C6]),
             (2.22, 2.4, [C4, G4, C5, E5, G5, C6])]
    for t, d, fr in notes:
        buf = place(buf, brass(fr, d), t, 0.9)
    for t in (0.0, 0.62, 2.22):
        buf = place(buf, kick(110, 55, 0.7, 0.28) * 0.9, t, 0.9)
    buf = place(buf, fade_out(highpass(noise(2.6), 4500) * exp_env(int(SR * 2.6), 0.005, 0.7), 1200), 2.22, 0.45)
    buf = soft_clip(buf, 1.2)
    return norm(reverb(buf, 1.8, 0.3), 0.92)


def fx_crowd():
    """Applause + cheer: broadband noise swelling in and out, with a dense
    scatter of individual hand-claps on top."""
    d = 3.6
    n = int(SR * d)
    t = np.linspace(0, 1, n)
    swell = np.clip(t / 0.15, 0, 1) * np.clip((1 - t) / 0.3, 0, 1)
    roar = bandpass(noise(d), 500, 3200) * swell * 0.55
    cheer = bandpass(noise(d), 900, 1800, 2) * (0.7 + 0.3 * np.sin(2 * np.pi * 5.5 * np.linspace(0, d, n))) * swell * 0.3
    buf = roar + cheer
    for _ in range(260):
        at = RNG.uniform(0.15, d - 0.5) if RNG.random() < 0.9 else RNG.uniform(0, d - 0.3)
        amp = swell[min(n - 1, int(at / d * n))] * RNG.uniform(0.2, 0.7)
        clap = bandpass(noise(0.06), RNG.uniform(1200, 2200), RNG.uniform(3500, 6000)) * exp_env(int(SR * 0.06), 0.0004, 0.011)
        buf = place(buf, clap, at, amp)
    return norm(reverb(buf, 1.4, 0.25), 0.8)


SFX = {
    "click": (fx_click, 0.55),
    "step": (fx_step, 0.6),
    "roll": (fx_roll, 0.85),
    "safe": (fx_safe, 0.75),
    "whoosh": (fx_whoosh, 0.7),
    "exit": (fx_exit, 0.85),
    "home": (fx_home, 0.9),
    "capture_1": (lambda: fx_capture(1), 1.0),
    "capture_2": (lambda: fx_capture(2), 1.0),
    "capture_3": (lambda: fx_capture(3), 1.0),
    "imprison": (fx_imprison, 0.9),
    "buyback": (fx_buyback, 0.9),
    "ransom_alert": (fx_ransom_alert, 0.75),
    "six_banked": (fx_six_banked, 0.85),
    "forfeit": (fx_forfeit, 0.85),
    "pass": (fx_pass, 0.65),
    "win": (fx_win, 0.95),
    "crowd": (fx_crowd, 0.8),
}


# ----------------------------------------------------------------------------
# Announcer calls (Piper + "stadium announcer" chain)
# ----------------------------------------------------------------------------

# name -> (text, length_scale). length_scale > 1 is slower; the big streak
# calls are given a little extra weight, like a real announcer leaning in.
ANNOUNCER = {
    "first_blood": ("First blood!", 1.12),
    "prisoner_taken": ("Prisoner taken!", 1.05),
    "double_kill": ("Double kill!", 1.1),
    "triple_kill": ("Triple kill!", 1.12),
    "ultra_kill": ("Ultra kill!", 1.15),
    "rampage": ("Rampage!", 1.2),
    "killing_spree": ("Killing spree!", 1.1),
    "dominating": ("Dominating!", 1.15),
    "unstoppable": ("Unstoppable!", 1.15),
    "godlike": ("Godlike!", 1.25),
    "beyond_godlike": ("Beyond godlike!", 1.25),
    "ransom_paid": ("Ransom paid! Prisoner freed!", 1.0),
    "six_to_play": ("You have a six to play!", 1.0),
    "forfeit": ("Too greedy!", 1.05),
    "victory": ("Victory!", 1.3),
}


def piper_say(model_path, text, length_scale):
    from piper import PiperVoice, SynthesisConfig
    voice = PiperVoice.load(model_path)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        path = tmp.name
    with wave.open(path, "wb") as w:
        voice.synthesize_wav(text, w, syn_config=SynthesisConfig(length_scale=length_scale))
    with wave.open(path, "rb") as r:
        rate = r.getframerate()
        data = np.frombuffer(r.readframes(r.getnframes()), dtype=np.int16).astype(np.float64) / 32768
    Path(path).unlink(missing_ok=True)
    return data, rate


def announcer_chain(x, rate):
    """Make a plain TTS clip sound like a big-arena announcer."""
    x = trim_silence(x)
    # 1) a touch lower and weightier: resample down ~7% (pitch AND length drop together)
    x = signal.resample_poly(x, 100, 93)
    # 2) up to 44.1k for the rest of the chain
    x = signal.resample_poly(x, SR, rate)
    # 3) tone: clear the rumble, add chest + presence
    x = highpass(x, 70, 2)
    x = low_shelf(x, 200, 5.0)
    x = peaking_eq(x, 3000, 3.0, 0.9)
    x = peaking_eq(x, 450, -2.0, 1.0)  # a little less boxiness
    # 4) thicken: a second copy, slightly detuned down and slightly late
    dbl = signal.resample_poly(x, 1024, 1000)
    dbl = np.concatenate([np.zeros(int(SR * 0.018)), dbl])
    n = max(len(x), len(dbl))
    x = np.pad(x, (0, n - len(x))) + 0.45 * np.pad(dbl, (0, n - len(dbl)))
    # 5) compress / saturate so every call hits with the same authority
    x = soft_clip(norm(x, 1.0), 2.2)
    # 6) the arena: a short slap-back plus a big hall
    slap = np.concatenate([np.zeros(int(SR * 0.16)), x]) * 0.14
    x = np.pad(x, (0, len(slap) - len(x))) + slap
    x = reverb(x, 1.3, 0.24, damp=5000, predelay=0.025)
    x = trim_silence(x, 0.002)
    return fade_out(norm(trim_tail(x, -48), 0.9), 60)


# ----------------------------------------------------------------------------
# Output
# ----------------------------------------------------------------------------

def write_mp3(x, path, bitrate="80k"):
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name
    with wave.open(wav_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path, "-codec:a", "libmp3lame",
         "-b:a", bitrate, "-ac", "1", str(path)],
        check=True,
    )
    Path(wav_path).unlink(missing_ok=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", help="Path to a Piper .onnx voice (needed for announcer calls)")
    ap.add_argument("--out", default="ludo-audio", help="Output folder")
    ap.add_argument("--sfx-only", action="store_true", help="Skip the Piper announcer calls")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    total = 0

    print(f"Rendering {len(SFX)} sound effects -> {out}")
    for name, (fn, gain) in SFX.items():
        x = norm(trim_tail(fn()), min(gain, 0.88))
        p = out / f"{name}.mp3"
        write_mp3(x, p, "96k" if name in ("win", "crowd") else "80k")
        total += p.stat().st_size
        print(f"  {name:14s} {len(x) / SR:4.1f}s  {p.stat().st_size / 1024:5.1f} KB")

    if not args.sfx_only:
        if not args.model:
            sys.exit("--model is required for announcer calls (or pass --sfx-only)")
        print(f"\nSynthesizing {len(ANNOUNCER)} announcer calls with Piper")
        for name, (text, ls) in ANNOUNCER.items():
            raw, rate = piper_say(args.model, text, ls)
            x = announcer_chain(raw, rate)
            p = out / f"say_{name}.mp3"
            write_mp3(x, p, "80k")
            total += p.stat().st_size
            print(f"  say_{name:16s} {len(x) / SR:4.1f}s  {p.stat().st_size / 1024:5.1f} KB   \"{text}\"")

    print(f"\nDone. Total {total / 1024:.0f} KB in {out}")


if __name__ == "__main__":
    main()
