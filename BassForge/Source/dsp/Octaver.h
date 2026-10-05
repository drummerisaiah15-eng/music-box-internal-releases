#pragma once

#include "DspUtils.h"

namespace bf
{
/** Analog-style octave pedal.

    Sub (-1 oct): the signal is low-passed hard to isolate the fundamental, a
    Schmitt trigger finds its zero crossings and a flip-flop toggles on every
    rising edge, giving a square wave at half the frequency. That square is
    scaled by the fundamental's envelope (so it follows the player's dynamics)
    and smoothed by a 24 dB/oct "Tone" low-pass into a round sub.

    Up (+1 oct): full-wave rectifying a band-limited copy doubles its frequency,
    the classic octave-fuzz trick.

    Tracking runs on the mono sum; the generated voices are added to every
    channel. Like the hardware it is monophonic - chords will glitch. */
class Octaver
{
public:
    void prepare (double sampleRate) noexcept
    {
        for (auto* f : { &trackHp, &trackLp1, &trackLp2, &subLp1, &subLp2, &upHp, &upLp, &upDc })
            f->prepare (sampleRate);

        trackHp.set  (Svf::Type::highpass, 30.0f, 0.707f);
        trackLp1.set (Svf::Type::lowpass, 220.0f, 0.541f);
        trackLp2.set (Svf::Type::lowpass, 220.0f, 1.307f);
        upHp.set     (Svf::Type::highpass, 70.0f, 0.707f);
        upLp.set     (Svf::Type::lowpass, 1600.0f, 0.707f);
        upDc.set     (Svf::Type::highpass, 25.0f, 0.707f);

        envelope.prepare (sampleRate);
        envelope.setTimes (1.0f, 70.0f);

        for (auto* s : { &subLevel, &upLevel, &dryLevel })
            s->prepare (sampleRate, 25.0f);
        tone.prepare (sampleRate, 40.0f);

        reset();
    }

    void reset() noexcept
    {
        for (auto* f : { &trackHp, &trackLp1, &trackLp2, &subLp1, &subLp2, &upHp, &upLp, &upDc })
            f->reset();
        envelope.reset();
        flip = false;
        armed = true;
        for (auto* s : { &subLevel, &upLevel, &dryLevel, &tone })
            s->snapToTarget();
        updateTone();
    }

    void setParameters (float sub, float up, float dry, float toneHz) noexcept
    {
        subLevel.setTarget (sub);
        upLevel.setTarget (up);
        dryLevel.setTarget (dry);
        tone.setTarget (toneHz);
    }

    void process (float* const* ch, int numChannels, int numSamples) noexcept
    {
        for (auto* s : { &subLevel, &upLevel, &dryLevel, &tone })
            s->advance (numSamples);

        if (tone.isMoving())
            updateTone();

        const float monoScale = 1.0f / (float) numChannels;

        for (int i = 0; i < numSamples; ++i)
        {
            float mono = 0.0f;
            for (int c = 0; c < numChannels; ++c)
                mono += ch[c][i];
            mono *= monoScale;

            // --- sub octave
            const float tracked = trackLp2.process (0, trackLp1.process (0, trackHp.process (0, mono)));
            const float env = envelope.process (tracked);
            const float hysteresis = 0.12f * env + 1.0e-5f;

            if (armed && tracked > hysteresis)
            {
                flip = ! flip;
                armed = false;
            }
            else if (! armed && tracked < -hysteresis)
            {
                armed = true;
            }

            const float square = (flip ? env : -env) * 1.25f;
            const float sub = subLp2.process (0, subLp1.process (0, square));

            // --- octave up
            const float band = upLp.process (0, upHp.process (0, mono));
            const float up = upDc.process (0, std::abs (band)) * 2.0f;

            const float added = sub * subLevel.at (i, numSamples) + up * upLevel.at (i, numSamples);
            const float dry = dryLevel.at (i, numSamples);

            for (int c = 0; c < numChannels; ++c)
                ch[c][i] = ch[c][i] * dry + added;
        }
    }

private:
    void updateTone() noexcept
    {
        subLp1.set (Svf::Type::lowpass, tone.end(), 0.541f);
        subLp2.set (Svf::Type::lowpass, tone.end(), 1.307f);
    }

    Svf trackHp, trackLp1, trackLp2, subLp1, subLp2, upHp, upLp, upDc;
    EnvelopeFollower envelope;
    Smoother subLevel, upLevel, dryLevel, tone;
    bool flip = false, armed = true;
};
} // namespace bf
