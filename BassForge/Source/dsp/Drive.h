#pragma once

#include "DspUtils.h"

#include <juce_dsp/juce_dsp.h>

namespace bf
{
/** Bass drive with a clean low band, in the style of modern bass preamps.

    A Linkwitz-Riley crossover splits the signal at X-Over. Only the upper band
    is distorted (so the fundamental stays tight and in tune) and then blended
    against its clean self; the low band passes through clean with its own
    level. Everything runs oversampled to keep the aliasing of hard clipping
    out of the audio band. The oversampler always runs, even with the module
    switched off, so the plug-in's latency is constant. */
class Drive
{
public:
    enum Type { tube = 0, overdrive, distortion, fuzz, fold, numTypes };

    void prepare (double sampleRate, int maxChunkSamples, int numChannels)
    {
        // 4x at base rates, 2x at 88.2/96k, none from 176.4k up.
        const size_t factorLog2 = sampleRate < 80000.0 ? 2 : (sampleRate < 160000.0 ? 1 : 0);
        oversampler = std::make_unique<juce::dsp::Oversampling<float>> (
            (size_t) numChannels, factorLog2,
            juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple, true, false);
        oversampler->initProcessing ((size_t) maxChunkSamples);

        const int factor = (int) oversampler->getOversamplingFactor();
        osRate = sampleRate * (double) factor;

        // The linear-phase FIR stages have a latency that is a whole number of
        // oversampled samples, but not always of base-rate samples. JUCE's own
        // fix is a fractional-delay filter, which is only phase-accurate at low
        // frequencies; an integer delay at the oversampled rate makes the total
        // whole exactly, so the dry path and parallel chains line up perfectly.
        const double rawLatency = (double) oversampler->getLatencyInSamples();
        latency = (int) std::ceil (rawLatency - 1.0e-6);
        const double extra = ((double) latency - rawLatency) * (double) factor;
        alignDelay = (int) std::lround (extra);
        jassert (std::abs (extra - (double) alignDelay) < 1.0e-3);
        alignSize = alignDelay + 1;
        alignBuffer.assign ((size_t) (alignSize * maxChannels), 0.0f);

        crossover.prepare ({ osRate, (juce::uint32) (maxChunkSamples * (int) oversampler->getOversamplingFactor()),
                             (juce::uint32) numChannels });
        crossover.setType (juce::dsp::LinkwitzRileyFilterType::lowpass);
        toneFilter.prepare (osRate);
        dcBlocker.prepare (osRate, 10.0f);

        for (auto* s : { &gain, &makeup, &blend, &lowLevel, &level, &xover, &tone })
            s->prepare (sampleRate, 30.0f);

        fade.prepare (sampleRate, 15.0f);
        reset();
    }

    void reset() noexcept
    {
        if (oversampler != nullptr)
            oversampler->reset();
        std::fill (alignBuffer.begin(), alignBuffer.end(), 0.0f);
        alignPos.fill (0);
        crossover.reset();
        toneFilter.reset();
        dcBlocker.reset();
        lastInput.fill (0.0);
        lastAntiderivative.fill (0.0);
        for (auto* s : { &gain, &makeup, &blend, &lowLevel, &level, &xover, &tone })
            s->snapToTarget();
        updateFilters();
    }

    int getLatencySamples() const noexcept { return latency; }

    void setParameters (bool enabled, int newType, float amount, float toneAmount, float xoverHz,
                        float blendAmount, float lowDb, float levelDb) noexcept
    {
        fade.setEnabled (enabled);
        newType = std::clamp (newType, 0, (int) numTypes - 1);
        if (newType != type)
        {
            type = newType;
            antiderivativeStale = true;
        }

        const float driveDb = amount * maxDriveDb[(size_t) type];
        const float g = dbToGain (driveDb);
        gain.setTarget (g);
        // Normalise so a -12 dBFS note comes out at roughly the same level at
        // any drive setting; the saturated waveform is denser, so trim a little.
        makeup.setTarget (std::max (1.0f / g, 0.25f) * typeTrim[(size_t) type]);

        tone.setTarget (600.0f * std::pow (20.0f, toneAmount));   // 600 Hz .. 12 kHz
        xover.setTarget (xoverHz);
        blend.setTarget (blendAmount);
        lowLevel.setTarget (dbToGain (lowDb));
        level.setTarget (dbToGain (levelDb));
    }

    void snapEnabled (bool enabled) noexcept { fade.snap (enabled); }

    void process (float* const* ch, int numChannels, int numSamples) noexcept
    {
        fade.advance (numSamples);
        for (auto* s : { &gain, &makeup, &blend, &lowLevel, &level, &xover, &tone })
            s->advance (numSamples);

        if (fade.justWokeUp())
        {
            crossover.reset();
            toneFilter.reset();
            dcBlocker.reset();
            lastInput.fill (0.0);
            lastAntiderivative.fill (0.0);
        }

        if (xover.isMoving() || tone.isMoving())
            updateFilters();

        if (antiderivativeStale)
        {
            for (size_t c = 0; c < lastInput.size(); ++c)
                lastAntiderivative[c] = antiderivative (type, lastInput[c]);
            antiderivativeStale = false;
        }

        juce::dsp::AudioBlock<float> block (ch, (size_t) numChannels, (size_t) numSamples);
        auto up = oversampler->processSamplesUp (block);

        const bool active = ! fade.isSilent();
        const int osSamples = (int) up.getNumSamples();
        const int factor = osSamples / std::max (1, numSamples);

        for (int c = 0; c < numChannels; ++c)
        {
            float* x = up.getChannelPointer ((size_t) c);
            float* line = alignBuffer.data() + (size_t) (c * alignSize);
            int pos = alignPos[(size_t) c];

            for (int j = 0; j < osSamples; ++j)
            {
                line[pos] = x[j];
                pos = (pos + 1) % alignSize;
                const float in = line[pos];
                x[j] = in;

                if (active)
                {
                    const int i = j / factor;   // base-rate index for parameter ramps

                    float low, high;
                    crossover.processSample (c, in, low, high);

                    float dirty = shapeAntialiased (c, high * gain.at (i, numSamples)) * makeup.at (i, numSamples);
                    dirty = toneFilter.process (c, dcBlocker.process (c, dirty));

                    const float hi = high + blend.at (i, numSamples) * (dirty - high);
                    const float out = low * lowLevel.at (i, numSamples) + hi * level.at (i, numSamples);

                    x[j] = in + fade.at (i, numSamples) * (out - in);
                }
            }

            alignPos[(size_t) c] = pos;
        }

        oversampler->processSamplesDown (block);
    }

    /** The waveshaper for each drive type. Each is paired with its
        antiderivative below for anti-aliasing. */
    static double shape (int t, double u) noexcept
    {
        switch (t)
        {
            case tube:
                // Biased tanh: asymmetric clipping adds even harmonics; the DC
                // it creates is removed afterwards.
                return std::tanh (u + tubeBias) - std::tanh (tubeBias);

            case overdrive:
            {
                // Cubic soft clipper: transparent until it isn't.
                const double x = std::clamp (u, -1.0, 1.0);
                return 1.5 * (x - x * x * x / 3.0);
            }

            case distortion:
                // Hard clip; the anti-aliasing rounds off its corners.
                return std::clamp (u, -1.0, 1.0);

            case fuzz:
                // Asymmetric exponential clipping, harder on the negative side.
                return u >= 0.0 ? 1.0 - std::exp (-u) : -0.85 * (1.0 - std::exp (1.8 * u));

            case fold:
            default:
                // Sine wavefolder: linear for small signals, folds back on peaks.
                return std::sin (u);
        }
    }

    /** Antiderivative of shape(), with F(0) = 0. */
    static double antiderivative (int t, double u) noexcept
    {
        switch (t)
        {
            case tube:
            {
                // log(cosh(x)) computed without overflow for large |x|
                const double x = std::abs (u + tubeBias);
                const double logCosh = x + std::log1p (std::exp (-2.0 * x)) - 0.69314718055994531;
                return logCosh - std::tanh (tubeBias) * u - logCoshBias;
            }

            case overdrive:
            {
                const double a = std::abs (u);
                return a <= 1.0 ? 1.5 * (0.5 * a * a - a * a * a * a / 12.0) : a - 0.375;
            }

            case distortion:
            {
                const double a = std::abs (u);
                return a <= 1.0 ? 0.5 * a * a : a - 0.5;
            }

            case fuzz:
                return u >= 0.0 ? u + std::exp (-u) - 1.0
                                : -0.85 * (u - (std::exp (1.8 * u) - 1.0) / 1.8);

            case fold:
            default:
                return 1.0 - std::cos (u);
        }
    }

private:
    /** First-order antiderivative anti-aliasing (Parker, Zavalishin & Le
        Bivic, DAFx 2016): the shaper's output is averaged over the segment
        between consecutive input samples, which suppresses the aliasing hard
        clipping creates far more cheaply than more oversampling would. */
    float shapeAntialiased (int channel, float input) noexcept
    {
        const auto c = (size_t) channel;
        const double x1 = input, x0 = lastInput[c];
        const double f1 = antiderivative (type, x1), f0 = lastAntiderivative[c];
        lastInput[c] = x1;
        lastAntiderivative[c] = f1;

        const double dx = x1 - x0;
        if (std::abs (dx) < 1.0e-6)
            return (float) shape (type, 0.5 * (x0 + x1));

        return (float) ((f1 - f0) / dx);
    }

    void updateFilters() noexcept
    {
        crossover.setCutoffFrequency (xover.end());
        toneFilter.set (Svf::Type::lowpass, tone.end(), 0.707f);
    }

    static constexpr double tubeBias = 0.35;
    static inline const double logCoshBias = std::log (std::cosh (tubeBias));
    static constexpr std::array<float, numTypes> maxDriveDb { 36.0f, 40.0f, 46.0f, 52.0f, 24.0f };
    static constexpr std::array<float, numTypes> typeTrim   { 0.85f, 0.8f, 0.75f, 0.8f, 0.85f };

    std::unique_ptr<juce::dsp::Oversampling<float>> oversampler;
    double osRate = 44100.0;
    int latency = 0, alignDelay = 0, alignSize = 1;
    std::vector<float> alignBuffer;
    std::array<int, maxChannels> alignPos {};
    juce::dsp::LinkwitzRileyFilter<float> crossover;
    Svf toneFilter;
    DcBlocker dcBlocker;
    Smoother gain, makeup, blend, lowLevel, level, xover, tone;
    ModuleFade fade;
    std::array<double, maxChannels> lastInput {}, lastAntiderivative {};
    bool antiderivativeStale = false;
    int type = tube;
};
} // namespace bf
