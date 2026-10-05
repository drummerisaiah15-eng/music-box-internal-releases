#pragma once

#include "DspUtils.h"

namespace bf
{
/** Envelope-controlled resonant filter ("auto-wah" / Mu-Tron style). The
    playing envelope sweeps the cutoff upwards from Freq by up to Range
    octaves. The state-variable core is updated every sample so fast attacks
    sweep cleanly. */
class EnvelopeFilter
{
public:
    enum Mode { lowpass = 0, bandpass, highpass };

    void prepare (double sampleRate) noexcept
    {
        fs = sampleRate;
        filter.prepare (sampleRate);
        envelope.prepare (sampleRate);
        for (auto* s : { &baseFreq, &rangeOct, &resonance, &sweepStartDb, &mix })
            s->prepare (sampleRate, 30.0f);
        reset();
    }

    void reset() noexcept
    {
        filter.reset();
        envelope.reset();
        for (auto* s : { &baseFreq, &rangeOct, &resonance, &sweepStartDb, &mix })
            s->snapToTarget();
    }

    void setParameters (float sens, float freqHz, float range, float reso, float decayMs,
                        int newMode, float mixAmount) noexcept
    {
        // Sensitivity sets where the sweep starts: from -30 dBFS (0%) down to
        // -60 dBFS (100%). The sweep then spans the next 30 dB of level, so a
        // plucked note opens the filter and it closes again as the note decays.
        sweepStartDb.setTarget (-30.0f - sens * 30.0f);
        baseFreq.setTarget (freqHz);
        rangeOct.setTarget (range * 5.0f);                  // up to 5 octaves of sweep
        resonance.setTarget (reso);
        envelope.setTimes (3.0f, decayMs);
        mode = newMode;
        mix.setTarget (mixAmount);
    }

    void process (float* const* ch, int numChannels, int numSamples) noexcept
    {
        for (auto* s : { &baseFreq, &rangeOct, &resonance, &sweepStartDb, &mix })
            s->advance (numSamples);

        const float q = 0.7f * std::pow (16.0f, resonance.end());   // 0.7 .. 11
        const float k = 1.0f / q;
        const float bandGain = std::sqrt (q);
        const float maxFreq = std::min (16000.0f, (float) fs * 0.45f);

        for (int i = 0; i < numSamples; ++i)
        {
            float peak = 0.0f;
            for (int c = 0; c < numChannels; ++c)
                peak = std::max (peak, std::abs (ch[c][i]));

            const float levelDb = gainToDb (envelope.process (peak) + 1.0e-6f);
            const float amount = std::clamp ((levelDb - sweepStartDb.at (i, numSamples)) / sweepRangeDb, 0.0f, 1.0f);
            const float cutoff = std::min (maxFreq, baseFreq.at (i, numSamples)
                                                     * std::exp2 (rangeOct.at (i, numSamples) * amount));
            filter.setRaw (std::tan (pi * cutoff / (float) fs), k);

            const float m = mix.at (i, numSamples);

            for (int c = 0; c < numChannels; ++c)
            {
                const float x = ch[c][i];
                float lp, bp;
                filter.tick (c, x, lp, bp);

                float y;
                switch (mode)
                {
                    case bandpass: y = bp * bandGain * k * 1.6f; break;
                    case highpass: y = x - k * bp - lp; break;
                    default:       y = lp; break;
                }

                ch[c][i] = x + m * (y - x);
            }
        }
    }

private:
    double fs = 44100.0;
    Svf filter;
    EnvelopeFollower envelope;
    static constexpr float sweepRangeDb = 30.0f;
    Smoother baseFreq, rangeOct, resonance, sweepStartDb, mix;
    int mode = lowpass;
};
} // namespace bf
