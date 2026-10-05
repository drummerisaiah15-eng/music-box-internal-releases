#pragma once

#include "DspUtils.h"

namespace bf
{
/** Bass-amp style EQ: low cut, bass shelf, two sweepable mids, treble shelf
    and high cut. Coefficients are refreshed once per chunk from smoothed
    parameters, so sweeping a knob doesn't zipper. */
class AmpEq
{
public:
    void prepare (double sampleRate) noexcept
    {
        for (auto* f : filters())
            f->prepare (sampleRate);
        for (auto* s : smoothers())
            s->prepare (sampleRate, 40.0f);
        reset();
    }

    void reset() noexcept
    {
        for (auto* f : filters())
            f->reset();
        for (auto* s : smoothers())
            s->snapToTarget();
        update();
    }

    void setParameters (float lowCutHz, float bassDb, float lowMidDb, float lowMidHz,
                        float highMidDb, float highMidHz, float trebleDb, float highCutHz) noexcept
    {
        lowCut.setTarget (lowCutHz);
        bass.setTarget (bassDb);
        lowMid.setTarget (lowMidDb);
        lowMidFreq.setTarget (lowMidHz);
        highMid.setTarget (highMidDb);
        highMidFreq.setTarget (highMidHz);
        treble.setTarget (trebleDb);
        highCut.setTarget (highCutHz);
    }

    void process (float* const* ch, int numChannels, int numSamples) noexcept
    {
        bool moving = false;
        for (auto* s : smoothers())
        {
            s->advance (numSamples);
            moving = moving || s->isMoving();
        }

        if (moving)
            update();

        for (int c = 0; c < numChannels; ++c)
        {
            float* x = ch[c];
            for (int i = 0; i < numSamples; ++i)
            {
                float y = hpf.process (c, x[i]);
                y = bassShelf.process (c, y);
                y = lowMidBell.process (c, y);
                y = highMidBell.process (c, y);
                y = trebleShelf.process (c, y);
                x[i] = lpf.process (c, y);
            }
        }
    }

private:
    void update() noexcept
    {
        hpf.set         (Svf::Type::highpass,  lowCut.end(), 0.707f);
        bassShelf.set   (Svf::Type::lowShelf,  90.0f, 0.707f, bass.end());
        lowMidBell.set  (Svf::Type::bell,      lowMidFreq.end(), 0.9f, lowMid.end());
        highMidBell.set (Svf::Type::bell,      highMidFreq.end(), 0.9f, highMid.end());
        trebleShelf.set (Svf::Type::highShelf, 4000.0f, 0.707f, treble.end());
        lpf.set         (Svf::Type::lowpass,   highCut.end(), 0.707f);
    }

    std::array<Svf*, 6> filters() noexcept { return { &hpf, &bassShelf, &lowMidBell, &highMidBell, &trebleShelf, &lpf }; }
    std::array<Smoother*, 8> smoothers() noexcept
    {
        return { &lowCut, &bass, &lowMid, &lowMidFreq, &highMid, &highMidFreq, &treble, &highCut };
    }

    Svf hpf, bassShelf, lowMidBell, highMidBell, trebleShelf, lpf;
    Smoother lowCut, bass, lowMid, lowMidFreq, highMid, highMidFreq, treble, highCut;
};

//==============================================================================
/** Speaker cabinet simulation built from a resonant filter network per cab:
    the low-frequency box resonance, the mid-range cone break-up dip, the
    presence region and the steep top-end roll-off of a bass speaker. Mix
    blends the cab against the DI, as engineers do with a DI + mic split. */
class CabSim
{
public:
    enum Type { vintage1x15 = 0, modern4x10, classic8x10, tight2x12, numTypes };

    void prepare (double sampleRate) noexcept
    {
        for (auto& f : stages)
            f.prepare (sampleRate);
        mix.prepare (sampleRate, 30.0f);
        reset();
    }

    void reset() noexcept
    {
        for (auto& f : stages)
            f.reset();
        mix.snapToTarget();
        configure (type);
    }

    void setParameters (int newType, float mixAmount) noexcept
    {
        newType = std::clamp (newType, 0, (int) numTypes - 1);
        if (newType != type)
            configure (newType);
        mix.setTarget (mixAmount);
    }

    void process (float* const* ch, int numChannels, int numSamples) noexcept
    {
        mix.advance (numSamples);

        for (int c = 0; c < numChannels; ++c)
        {
            float* x = ch[c];
            for (int i = 0; i < numSamples; ++i)
            {
                float y = x[i];
                for (auto& f : stages)
                    y = f.process (c, y);
                x[i] += mix.at (i, numSamples) * (y * trim - x[i]);
            }
        }
    }

private:
    struct Band { Svf::Type type; float freq, q, gainDb; };
    using Voicing = std::array<Band, 7>;

    void configure (int newType) noexcept
    {
        type = newType;
        static const std::array<Voicing, numTypes> voicings {{
            // 1x15 vintage: deep, round, early roll-off
            {{ { Svf::Type::highpass, 42.0f, 0.9f, 0.0f },   { Svf::Type::bell, 85.0f, 1.3f, 3.5f },
               { Svf::Type::bell, 450.0f, 0.8f, -3.0f },     { Svf::Type::bell, 1400.0f, 1.2f, 1.5f },
               { Svf::Type::bell, 2200.0f, 2.0f, -2.0f },    { Svf::Type::lowpass, 2700.0f, 0.541f, 0.0f },
               { Svf::Type::lowpass, 2700.0f, 1.307f, 0.0f } }},
            // 4x10 modern: tighter low end, forward upper mids
            {{ { Svf::Type::highpass, 55.0f, 0.8f, 0.0f },   { Svf::Type::bell, 110.0f, 1.2f, 2.5f },
               { Svf::Type::bell, 650.0f, 0.9f, -2.5f },     { Svf::Type::bell, 2400.0f, 1.4f, 4.0f },
               { Svf::Type::bell, 3800.0f, 2.5f, -3.0f },    { Svf::Type::lowpass, 5200.0f, 0.541f, 0.0f },
               { Svf::Type::lowpass, 5200.0f, 1.307f, 0.0f } }},
            // 8x10 classic: huge low mids and a gritty midrange bark
            {{ { Svf::Type::highpass, 50.0f, 0.9f, 0.0f },   { Svf::Type::bell, 80.0f, 1.0f, 3.0f },
               { Svf::Type::bell, 250.0f, 1.1f, 2.0f },      { Svf::Type::bell, 500.0f, 1.0f, -3.5f },
               { Svf::Type::bell, 1200.0f, 1.1f, 3.0f },     { Svf::Type::lowpass, 3500.0f, 0.541f, 0.0f },
               { Svf::Type::lowpass, 3500.0f, 1.307f, 0.0f } }},
            // 2x12 tight: punchy, focused, less sub
            {{ { Svf::Type::highpass, 70.0f, 1.0f, 0.0f },   { Svf::Type::bell, 130.0f, 1.4f, 3.0f },
               { Svf::Type::bell, 600.0f, 1.0f, -2.0f },     { Svf::Type::bell, 1800.0f, 1.2f, 2.5f },
               { Svf::Type::bell, 3000.0f, 2.0f, -1.5f },    { Svf::Type::lowpass, 4200.0f, 0.541f, 0.0f },
               { Svf::Type::lowpass, 4200.0f, 1.307f, 0.0f } }},
        }};
        static constexpr std::array<float, numTypes> trims { 0.85f, 0.85f, 0.8f, 0.9f };

        const auto& v = voicings[(size_t) type];
        for (size_t i = 0; i < stages.size(); ++i)
            stages[i].set (v[i].type, v[i].freq, v[i].q, v[i].gainDb);
        trim = trims[(size_t) type];
    }

    std::array<Svf, 7> stages;
    Smoother mix;
    float trim = 1.0f;
    int type = vintage1x15;
};
} // namespace bf
