#pragma once

#include "DspUtils.h"

#include <vector>

namespace bf
{
//==============================================================================
/** Stereo-linked noise gate with hysteresis and hold, tuned for DI bass: it
    closes on string and pickup noise between notes without chopping the
    sustain of a ringing note. */
class NoiseGate
{
public:
    void prepare (double sampleRate) noexcept
    {
        fs = sampleRate;
        detector.prepare (sampleRate);
        detector.setTimes (0.3f, 25.0f);
        openCoeff = timeCoeff (sampleRate, 0.8f);
        holdSamples = (int) (0.025 * sampleRate);
        reset();
    }

    void reset() noexcept
    {
        detector.reset();
        gain = 1.0f;
        open = true;
        holdCounter = holdSamples;
    }

    void setParameters (float thresholdDb, float releaseMs) noexcept
    {
        openThreshold  = dbToGain (thresholdDb);
        closeThreshold = dbToGain (thresholdDb - 6.0f);
        releaseCoeff   = timeCoeff (fs, releaseMs);
    }

    void process (float* const* ch, int numChannels, int numSamples) noexcept
    {
        for (int i = 0; i < numSamples; ++i)
        {
            float peak = 0.0f;
            for (int c = 0; c < numChannels; ++c)
                peak = std::max (peak, std::abs (ch[c][i]));

            const float env = detector.process (peak);

            if (env > openThreshold)
            {
                open = true;
                holdCounter = holdSamples;
            }
            else if (env < closeThreshold)
            {
                if (holdCounter > 0)
                    --holdCounter;
                else
                    open = false;
            }

            const float target = open ? 1.0f : 0.0f;
            const float c = target > gain ? openCoeff : releaseCoeff;
            gain = c * gain + (1.0f - c) * target;

            for (int c2 = 0; c2 < numChannels; ++c2)
                ch[c2][i] *= gain;
        }
    }

private:
    double fs = 44100.0;
    EnvelopeFollower detector;
    float openThreshold = 0.001f, closeThreshold = 0.0005f;
    float openCoeff = 0.0f, releaseCoeff = 0.0f, gain = 1.0f;
    int holdSamples = 0, holdCounter = 0;
    bool open = true;
};

//==============================================================================
/** Feed-forward, stereo-linked compressor with a soft knee, smooth branching
    ballistics in the log domain, makeup gain and a parallel (New York) mix. */
class Compressor
{
public:
    void prepare (double sampleRate) noexcept
    {
        fs = sampleRate;
        detector.prepare (sampleRate);
        detector.setTimes (0.05f, 15.0f);   // short peak hold smooths low-frequency ripple
        makeup.prepare (sampleRate, 30.0f);
        mix.prepare (sampleRate, 30.0f);
        reset();
    }

    void reset() noexcept
    {
        reductionDb = 0.0f;
        detector.reset();
        makeup.snapToTarget();
        mix.snapToTarget();
    }

    void setParameters (float thresholdDb, float ratio, float attackMs, float releaseMs,
                        float makeupDb, float mixAmount) noexcept
    {
        threshold = thresholdDb;
        slope = 1.0f / std::max (1.0f, ratio) - 1.0f;
        attackCoeff  = timeCoeff (fs, attackMs);
        releaseCoeff = timeCoeff (fs, releaseMs);
        makeup.setTarget (dbToGain (makeupDb));
        mix.setTarget (mixAmount);
    }

    void process (float* const* ch, int numChannels, int numSamples) noexcept
    {
        makeup.advance (numSamples);
        mix.advance (numSamples);

        for (int i = 0; i < numSamples; ++i)
        {
            float peak = 0.0f;
            for (int c = 0; c < numChannels; ++c)
                peak = std::max (peak, std::abs (ch[c][i]));

            const float overDb = gainToDb (detector.process (peak)) - threshold;
            float wanted;   // desired gain reduction in dB (positive)

            if (2.0f * overDb < -kneeDb)
                wanted = 0.0f;
            else if (2.0f * std::abs (overDb) <= kneeDb)
            {
                const float t = overDb + kneeDb * 0.5f;
                wanted = -slope * t * t / (2.0f * kneeDb);
            }
            else
                wanted = -slope * overDb;

            const float c = wanted > reductionDb ? attackCoeff : releaseCoeff;
            reductionDb = c * reductionDb + (1.0f - c) * wanted;

            const float wet = dbToGain (-reductionDb) * makeup.at (i, numSamples);
            const float m = mix.at (i, numSamples);
            const float g = (1.0f - m) + m * wet;

            for (int c2 = 0; c2 < numChannels; ++c2)
                ch[c2][i] *= g;

            maxReduction = std::max (maxReduction, reductionDb);
        }
    }

    /** Largest gain reduction since the last call, in dB. */
    float popMaxReductionDb() noexcept
    {
        const float r = maxReduction;
        maxReduction = 0.0f;
        return r;
    }

private:
    static constexpr float kneeDb = 6.0f;
    double fs = 44100.0;
    float threshold = -18.0f, slope = -0.75f;
    float attackCoeff = 0.0f, releaseCoeff = 0.0f;
    float reductionDb = 0.0f, maxReduction = 0.0f;
    EnvelopeFollower detector;
    Smoother makeup, mix;
};

//==============================================================================
/** Look-ahead peak limiter. A sliding-window minimum of the required gain,
    followed by a box filter of the same length, guarantees the delayed output
    never exceeds the ceiling while keeping the gain curve smooth. The
    look-ahead delay is always present (even when switched off) so the
    plug-in's reported latency never changes. */
class Limiter
{
public:
    void prepare (double sampleRate) noexcept
    {
        lookahead = std::max (1, (int) std::round (0.001 * sampleRate));
        window = lookahead + 1;
        releaseCoeff = timeCoeff (sampleRate, 80.0f);
        fade.prepare (sampleRate, 20.0f);

        delayLine.assign ((size_t) (window * maxChannels), 0.0f);
        boxValues.assign ((size_t) window, 1.0f);
        dequeIndex.assign ((size_t) window + 1, 0);
        dequeValue.assign ((size_t) window + 1, 1.0f);
        reset();
    }

    void reset() noexcept
    {
        std::fill (delayLine.begin(), delayLine.end(), 0.0f);
        std::fill (boxValues.begin(), boxValues.end(), 1.0f);
        boxSum = (double) window;
        writePos = 0;
        boxPos = 0;
        sampleCounter = 0;
        dequeHead = dequeSize = 0;
        envelope = 1.0f;
        maxReduction = 0.0f;
    }

    int getLatencySamples() const noexcept { return lookahead; }

    void setParameters (bool enabled, float ceilingDb) noexcept
    {
        fade.setEnabled (enabled);
        ceiling = dbToGain (ceilingDb);
    }

    void snapEnabled (bool enabled) noexcept { fade.snap (enabled); }

    void process (float* const* ch, int numChannels, int numSamples) noexcept
    {
        fade.advance (numSamples);
        const bool fullyOn = fade.isFullyOn();

        for (int i = 0; i < numSamples; ++i)
        {
            float peak = 0.0f;
            for (int c = 0; c < numChannels; ++c)
                peak = std::max (peak, std::abs (ch[c][i]));

            const float required = peak > ceiling ? ceiling / peak : 1.0f;
            const float windowMin = pushWindowMin (required);

            envelope = windowMin < envelope ? windowMin
                                            : windowMin + releaseCoeff * (envelope - windowMin);

            boxSum += (double) envelope - (double) boxValues[(size_t) boxPos];
            boxValues[(size_t) boxPos] = envelope;
            boxPos = (boxPos + 1) % window;

            if (++sampleCounter >= 1 << 16)   // keep the running sum from drifting
            {
                sampleCounter = 0;
                boxSum = 0.0;
                for (auto v : boxValues)
                    boxSum += (double) v;
            }

            const float limiterGain = std::min (1.0f, (float) (boxSum / (double) window));
            const float w = fade.at (i, numSamples);
            const float gain = 1.0f + w * (limiterGain - 1.0f);
            maxReduction = std::max (maxReduction, -gainToDb (gain));

            const int readPos = (writePos + 1) % window;   // oldest sample = lookahead samples ago

            for (int c = 0; c < numChannels; ++c)
            {
                float* line = delayLine.data() + (size_t) (c * window);
                const float delayed = line[readPos];
                line[writePos] = ch[c][i];
                float y = delayed * gain;

                if (fullyOn)
                    y = std::clamp (y, -ceiling, ceiling);

                ch[c][i] = y;
            }

            writePos = readPos;
        }
    }

    float popMaxReductionDb() noexcept
    {
        const float r = maxReduction;
        maxReduction = 0.0f;
        return r;
    }

private:
    /** Monotonic deque: minimum of the last `window` required-gain values. */
    float pushWindowMin (float value) noexcept
    {
        const int cap = window + 1;
        const long long now = totalPushed++;

        while (dequeSize > 0 && dequeValue[(size_t) ((dequeHead + dequeSize - 1) % cap)] >= value)
            --dequeSize;

        const int tail = (dequeHead + dequeSize) % cap;
        dequeIndex[(size_t) tail] = now;
        dequeValue[(size_t) tail] = value;
        ++dequeSize;

        while (dequeIndex[(size_t) dequeHead] <= now - window)
        {
            dequeHead = (dequeHead + 1) % cap;
            --dequeSize;
        }

        return dequeValue[(size_t) dequeHead];
    }

    int lookahead = 1, window = 2;
    float ceiling = 1.0f, releaseCoeff = 0.0f, envelope = 1.0f, maxReduction = 0.0f;
    ModuleFade fade;

    std::vector<float> delayLine, boxValues;
    double boxSum = 0.0;
    int writePos = 0, boxPos = 0, sampleCounter = 0;

    std::vector<long long> dequeIndex;
    std::vector<float> dequeValue;
    int dequeHead = 0, dequeSize = 0;
    long long totalPushed = 0;
};
} // namespace bf
