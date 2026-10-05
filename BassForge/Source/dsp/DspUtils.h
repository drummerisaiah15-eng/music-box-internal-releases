#pragma once

#include <algorithm>
#include <array>
#include <cmath>

namespace bf
{
constexpr int maxChannels = 2;
constexpr float pi = 3.14159265358979323846f;

inline float dbToGain (float db) noexcept     { return std::pow (10.0f, db * 0.05f); }
inline float gainToDb (float gain) noexcept   { return 20.0f * std::log10 (std::max (gain, 1.0e-9f)); }

/** One-pole coefficient for a time constant in milliseconds. */
inline float timeCoeff (double sampleRate, float ms) noexcept
{
    return std::exp (-1.0f / (std::max (ms, 0.001f) * 0.001f * (float) sampleRate));
}

//==============================================================================
/** Exponential parameter smoother that is advanced once per processing chunk.
    Within a chunk, at() interpolates linearly between the chunk's start and end
    values so gains never step, while filter coefficients can be refreshed once
    per chunk from end(). */
class Smoother
{
public:
    void prepare (double sampleRate, float timeMs) noexcept
    {
        tauSamples = std::max (1.0f, timeMs * 0.001f * (float) sampleRate);
    }

    void setTarget (float newTarget) noexcept   { target = newTarget; }
    void snap (float value) noexcept            { start = current = target = value; }
    void snapToTarget() noexcept                { snap (target); }

    void advance (int numSamples) noexcept
    {
        start = current;
        current += (target - current) * (1.0f - std::exp (-(float) numSamples / tauSamples));

        if (std::abs (target - current) < 1.0e-5f * std::max (1.0f, std::abs (target)))
            current = target;
    }

    float at (int index, int numSamples) const noexcept
    {
        return start + (current - start) * (float) (index + 1) / (float) numSamples;
    }

    float end() const noexcept       { return current; }
    bool isMoving() const noexcept   { return start < current || start > current; }

private:
    float tauSamples = 1.0f, start = 0.0f, current = 0.0f, target = 0.0f;
};

//==============================================================================
/** Linear on/off crossfade used to switch modules in and out without clicks. */
class ModuleFade
{
public:
    void prepare (double sampleRate, float rampMs = 15.0f) noexcept
    {
        rampSamples = std::max (1.0f, rampMs * 0.001f * (float) sampleRate);
    }

    void setEnabled (bool shouldBeOn) noexcept   { target = shouldBeOn ? 1.0f : 0.0f; }
    void snap (bool on) noexcept                 { start = current = target = on ? 1.0f : 0.0f; }

    void advance (int numSamples) noexcept
    {
        wasSilent = current <= 0.0f;
        start = current;
        const float step = (float) numSamples / rampSamples;
        current = target > current ? std::min (target, current + step)
                                   : std::max (target, current - step);
    }

    /** Module contributes nothing this chunk: skip its processing entirely. */
    bool isSilent() const noexcept        { return start <= 0.0f && current <= 0.0f; }
    /** Module is fully in: no dry/wet blend needed. */
    bool isFullyOn() const noexcept       { return start >= 1.0f && current >= 1.0f; }
    /** Module just came back from silence; its state should be cleared first. */
    bool justWokeUp() const noexcept      { return wasSilent && current > 0.0f; }

    float at (int index, int numSamples) const noexcept
    {
        return start + (current - start) * (float) (index + 1) / (float) numSamples;
    }

private:
    float rampSamples = 1.0f, start = 1.0f, current = 1.0f, target = 1.0f;
    bool wasSilent = false;
};

//==============================================================================
/** Peak envelope follower with separate attack and release. */
class EnvelopeFollower
{
public:
    void prepare (double sampleRate) noexcept    { fs = sampleRate; reset(); }
    void reset() noexcept                        { env = 0.0f; }

    void setTimes (float attackMs, float releaseMs) noexcept
    {
        attack  = timeCoeff (fs, attackMs);
        release = timeCoeff (fs, releaseMs);
    }

    float process (float input) noexcept
    {
        const float x = std::abs (input);
        const float c = x > env ? attack : release;
        env = c * env + (1.0f - c) * x;
        return env;
    }

    float get() const noexcept { return env; }

private:
    double fs = 44100.0;
    float attack = 0.0f, release = 0.0f, env = 0.0f;
};

//==============================================================================
/** Topology-preserving state-variable filter (trapezoidal integration, after
    Andrew Simper's "SvfLinearTrapOptimised2"). It stays well behaved at very
    low cutoff-to-sample-rate ratios, which matters inside the oversampled
    drive stage, and it tolerates per-sample coefficient changes. */
class Svf
{
public:
    enum class Type { lowpass, highpass, bandpass, bell, lowShelf, highShelf };

    void prepare (double sampleRate) noexcept   { fs = sampleRate; reset(); }
    void reset() noexcept                       { ic1.fill (0.0f); ic2.fill (0.0f); }

    void set (Type type, float freq, float q, float gainDb = 0.0f) noexcept
    {
        freq = std::clamp (freq, 5.0f, (float) (fs * 0.49));
        q = std::max (q, 0.025f);

        const float w = std::tan (pi * freq / (float) fs);
        float g = w, k = 1.0f / q;

        switch (type)
        {
            case Type::lowpass:   m0 = 0.0f; m1 = 0.0f; m2 = 1.0f; break;
            case Type::highpass:  m0 = 1.0f; m1 = -k;   m2 = -1.0f; break;
            case Type::bandpass:  m0 = 0.0f; m1 = 1.0f; m2 = 0.0f; break;

            case Type::bell:
            {
                const float a = std::pow (10.0f, gainDb / 40.0f);
                k = 1.0f / (q * a);
                m0 = 1.0f; m1 = k * (a * a - 1.0f); m2 = 0.0f;
                break;
            }

            case Type::lowShelf:
            {
                const float a = std::pow (10.0f, gainDb / 40.0f);
                g = w / std::sqrt (a);
                m0 = 1.0f; m1 = k * (a - 1.0f); m2 = a * a - 1.0f;
                break;
            }

            case Type::highShelf:
            {
                const float a = std::pow (10.0f, gainDb / 40.0f);
                g = w * std::sqrt (a);
                m0 = a * a; m1 = k * (1.0f - a) * a; m2 = 1.0f - a * a;
                break;
            }
        }

        setRaw (g, k);
    }

    /** Sets the raw integrator gain (tan(pi*fc/fs)) and damping (1/Q) directly. */
    void setRaw (float g, float k) noexcept
    {
        a1 = 1.0f / (1.0f + g * (g + k));
        a2 = g * a1;
        a3 = g * a2;
        damping = k;
    }

    float process (int ch, float v0) noexcept
    {
        float lp, bp;
        tick (ch, v0, lp, bp);
        return m0 * v0 + m1 * bp + m2 * lp;
    }

    /** Runs one sample and returns the raw lowpass and bandpass outputs. The
        highpass output is v0 - damping * bp - lp. */
    void tick (int ch, float v0, float& lp, float& bp) noexcept
    {
        const float v3 = v0 - ic2[(size_t) ch];
        const float v1 = a1 * ic1[(size_t) ch] + a2 * v3;
        const float v2 = ic2[(size_t) ch] + a2 * ic1[(size_t) ch] + a3 * v3;
        ic1[(size_t) ch] = 2.0f * v1 - ic1[(size_t) ch];
        ic2[(size_t) ch] = 2.0f * v2 - ic2[(size_t) ch];
        bp = v1;
        lp = v2;
    }

    float getDamping() const noexcept { return damping; }

private:
    double fs = 44100.0;
    float a1 = 0.0f, a2 = 0.0f, a3 = 0.0f, damping = 1.0f;
    float m0 = 0.0f, m1 = 0.0f, m2 = 1.0f;
    std::array<float, 8> ic1 {}, ic2 {};
};

//==============================================================================
/** First-order DC blocker. */
class DcBlocker
{
public:
    void prepare (double sampleRate, float cutoffHz = 8.0f) noexcept
    {
        r = std::exp (-2.0f * pi * cutoffHz / (float) sampleRate);
        reset();
    }

    void reset() noexcept { x1.fill (0.0f); y1.fill (0.0f); }

    float process (int ch, float x) noexcept
    {
        const float y = x - x1[(size_t) ch] + r * y1[(size_t) ch];
        x1[(size_t) ch] = x;
        y1[(size_t) ch] = y;
        return y;
    }

private:
    float r = 0.999f;
    std::array<float, 8> x1 {}, y1 {};
};
} // namespace bf
