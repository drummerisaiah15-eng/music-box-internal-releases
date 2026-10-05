#pragma once

#include "DspUtils.h"

#include <vector>

namespace bf
{
/** Bass chorus. A Linkwitz-Riley crossover keeps everything below X-Over dry
    and centred, so the low end stays solid and mono-compatible; only the
    upper band is chorused. With a stereo output the two sides use LFOs 90
    degrees apart for width. Level 100% is the classic 50/50 chorus blend. */
class Chorus
{
public:
    void prepare (double sampleRate) noexcept
    {
        fs = sampleRate;
        bufferSize = (int) (0.03 * sampleRate) + 4;   // 30 ms covers base delay + modulation
        buffer.assign ((size_t) (bufferSize * maxChannels), 0.0f);

        for (auto* f : { &lp1, &lp2, &hp1, &hp2 })
            f->prepare (sampleRate);
        for (auto* s : { &rate, &depth, &level, &xover })
            s->prepare (sampleRate, 40.0f);
        reset();
    }

    void reset() noexcept
    {
        std::fill (buffer.begin(), buffer.end(), 0.0f);
        writePos = 0;
        samplesSinceReset = 0;
        for (auto* f : { &lp1, &lp2, &hp1, &hp2 })
            f->reset();
        for (auto* s : { &rate, &depth, &level, &xover })
            s->snapToTarget();
        updateCrossover();
    }

    void setParameters (float rateHz, float depthAmount, float levelAmount, float xoverHz) noexcept
    {
        rate.setTarget (rateHz);
        depth.setTarget (depthAmount);
        level.setTarget (levelAmount);
        xover.setTarget (xoverHz);
    }

    void process (float* const* ch, int numChannels, int numSamples) noexcept
    {
        for (auto* s : { &rate, &depth, &level, &xover })
            s->advance (numSamples);

        if (xover.isMoving())
            updateCrossover();

        const float phaseInc = rate.end() / (float) fs;
        const float baseDelay = 0.007f * (float) fs;
        const float modDepth = 0.0035f * (float) fs;

        // After a reset the delay line is empty and the crossover is settling
        // from silence, so its first samples contain a step. Keep the wet voice
        // muted until that has passed through the delay, then fade it in.
        const float warmupStart = baseDelay + modDepth + 2.0f;
        const float warmupLength = 0.01f * (float) fs;

        for (int i = 0; i < numSamples; ++i)
        {
            const float d = depth.at (i, numSamples);
            const float warm = std::clamp (((float) samplesSinceReset - warmupStart) / warmupLength, 0.0f, 1.0f);
            const float l = level.at (i, numSamples) * 0.5f * warm;

            for (int c = 0; c < numChannels; ++c)
            {
                const float x = ch[c][i];
                const float low  = lp2.process (c, lp1.process (c, x));
                const float high = hp2.process (c, hp1.process (c, x));

                float* line = buffer.data() + (size_t) (c * bufferSize);
                line[writePos] = high;

                const float lfo = std::sin (2.0f * pi * (phase + 0.25f * (float) c));
                const float delay = baseDelay + modDepth * d * lfo;
                const float wet = readHermite (line, (float) writePos - delay);

                ch[c][i] = low + high * (1.0f - l) + wet * l;
            }

            writePos = (writePos + 1) % bufferSize;
            samplesSinceReset = std::min (samplesSinceReset + 1, 1 << 30);
            phase += phaseInc;
            if (phase >= 1.0f)
                phase -= 1.0f;
        }
    }

private:
    float readHermite (const float* line, float pos) const noexcept
    {
        while (pos < 0.0f)
            pos += (float) bufferSize;

        const int i1 = (int) pos;
        const float t = pos - (float) i1;
        const int i0 = (i1 - 1 + bufferSize) % bufferSize;
        const int i2 = (i1 + 1) % bufferSize;
        const int i3 = (i1 + 2) % bufferSize;

        const float y0 = line[i0], y1 = line[i1 % bufferSize], y2 = line[i2], y3 = line[i3];
        const float c1 = 0.5f * (y2 - y0);
        const float c2 = y0 - 2.5f * y1 + 2.0f * y2 - 0.5f * y3;
        const float c3 = 0.5f * (y3 - y0) + 1.5f * (y1 - y2);
        return ((c3 * t + c2) * t + c1) * t + y1;
    }

    void updateCrossover() noexcept
    {
        lp1.set (Svf::Type::lowpass,  xover.end(), 0.7071f);
        lp2.set (Svf::Type::lowpass,  xover.end(), 0.7071f);
        hp1.set (Svf::Type::highpass, xover.end(), 0.7071f);
        hp2.set (Svf::Type::highpass, xover.end(), 0.7071f);
    }

    double fs = 44100.0;
    std::vector<float> buffer;
    int bufferSize = 1, writePos = 0, samplesSinceReset = 0;
    float phase = 0.0f;
    Svf lp1, lp2, hp1, hp2;
    Smoother rate, depth, level, xover;
};
} // namespace bf
