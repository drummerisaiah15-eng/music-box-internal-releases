#pragma once

#include "DspUtils.h"

#include <juce_core/juce_core.h>

#include <optional>
#include <vector>

namespace bf
{
/** Audio-thread side of the tuner: low-passes and decimates the input to
    roughly 12 kHz and pushes it into a lock-free FIFO for the editor. If no
    editor is reading, the FIFO simply fills up and new samples are dropped. */
class TunerFeed
{
public:
    void prepare (double sampleRate) noexcept
    {
        decimation = std::max (1, (int) std::round (sampleRate / 12000.0));
        rate = sampleRate / decimation;
        aa1.prepare (sampleRate);
        aa2.prepare (sampleRate);
        aa1.set (Svf::Type::lowpass, 1800.0f, 0.541f);
        aa2.set (Svf::Type::lowpass, 1800.0f, 1.307f);
        counter = 0;
        fifo.reset();
    }

    void push (const float* mono, int numSamples) noexcept
    {
        for (int i = 0; i < numSamples; ++i)
        {
            const float y = aa2.process (0, aa1.process (0, mono[i]));
            if (++counter >= decimation)
            {
                counter = 0;
                pending[(size_t) numPending++] = y;
                if (numPending == (int) pending.size())
                    flush();
            }
        }
        flush();
    }

    /** Message thread: drains everything available into `dest`. */
    void pull (std::vector<float>& dest)
    {
        const auto scope = fifo.read (fifo.getNumReady());
        for (int i = 0; i < scope.blockSize1; ++i) dest.push_back (storage[(size_t) (scope.startIndex1 + i)]);
        for (int i = 0; i < scope.blockSize2; ++i) dest.push_back (storage[(size_t) (scope.startIndex2 + i)]);
    }

    double getRate() const noexcept { return rate; }

private:
    void flush() noexcept
    {
        if (numPending == 0)
            return;
        const auto scope = fifo.write (numPending);
        int n = 0;
        for (int i = 0; i < scope.blockSize1; ++i) storage[(size_t) (scope.startIndex1 + i)] = pending[(size_t) n++];
        for (int i = 0; i < scope.blockSize2; ++i) storage[(size_t) (scope.startIndex2 + i)] = pending[(size_t) n++];
        numPending = 0;
    }

    static constexpr int capacity = 8192;
    juce::AbstractFifo fifo { capacity };
    std::array<float, capacity> storage {};
    std::array<float, 64> pending {};
    int numPending = 0, decimation = 4, counter = 0;
    double rate = 12000.0;
    Svf aa1, aa2;
};

//==============================================================================
/** YIN pitch detector (de Cheveigné & Kawahara, 2002) for 25..500 Hz, which
    covers 5- and 6-string bass with room to spare. */
class PitchDetector
{
public:
    static constexpr int windowSize = 1024;

    /** Returns the detected fundamental in Hz, or nothing if the signal is too
        quiet or not periodic enough. `data` must hold at least
        windowSize + rate / minHz samples. */
    std::optional<float> detect (const float* data, int numSamples, double rate)
    {
        const int maxLag = std::min ((int) (rate / minHz), numSamples - windowSize - 1);
        const int minLag = std::max (2, (int) (rate / maxHz));
        if (maxLag <= minLag)
            return std::nullopt;

        double energy = 0.0;
        for (int j = 0; j < windowSize; ++j)
            energy += (double) data[j] * data[j];
        if (std::sqrt (energy / windowSize) < 0.002)   // about -54 dBFS RMS
            return std::nullopt;

        diff.assign ((size_t) maxLag + 2, 0.0f);
        for (int lag = 1; lag <= maxLag + 1; ++lag)
        {
            double sum = 0.0;
            for (int j = 0; j < windowSize; ++j)
            {
                const double d = (double) data[j] - (double) data[j + lag];
                sum += d * d;
            }
            diff[(size_t) lag] = (float) sum;
        }

        // cumulative mean normalised difference
        diff[0] = 1.0f;
        double running = 0.0;
        for (int lag = 1; lag <= maxLag + 1; ++lag)
        {
            running += diff[(size_t) lag];
            diff[(size_t) lag] = running > 0.0 ? (float) (diff[(size_t) lag] * lag / running) : 1.0f;
        }

        int best = -1;
        for (int lag = minLag; lag <= maxLag; ++lag)
        {
            if (diff[(size_t) lag] < threshold)
            {
                while (lag + 1 <= maxLag && diff[(size_t) lag + 1] < diff[(size_t) lag])
                    ++lag;
                best = lag;
                break;
            }
        }

        if (best < 0)
            return std::nullopt;

        // parabolic interpolation around the minimum
        const float a = diff[(size_t) best - 1], b = diff[(size_t) best], c = diff[(size_t) best + 1];
        const float denom = a - 2.0f * b + c;
        const float offset = std::abs (denom) > 1.0e-9f ? 0.5f * (a - c) / denom : 0.0f;
        return (float) (rate / ((float) best + std::clamp (offset, -1.0f, 1.0f)));
    }

    static constexpr double minHz = 25.0, maxHz = 500.0;

private:
    static constexpr float threshold = 0.15f;
    std::vector<float> diff;
};
} // namespace bf
