// Headless test runner for BassForge.
//
//   BassForgeTests [screenshot-directory]
//
// Exercises the processor the way a host does (prepare, odd block sizes,
// parameter changes, state save/restore), checks the DSP behaves, and renders
// the editor to PNG files. Returns non-zero if any check fails.

#include "PluginEditor.h"
#include "PluginProcessor.h"
#include "Presets.h"

#include <chrono>
#include <iostream>

namespace
{
int failures = 0;

void check (bool ok, const juce::String& what)
{
    std::cout << (ok ? "  pass  " : "  FAIL  ") << what << std::endl;
    if (! ok)
        ++failures;
}

void section (const juce::String& name) { std::cout << "\n" << name << std::endl; }

juce::String db (double gain) { return juce::String (juce::Decibels::gainToDecibels (gain, -200.0), 1) + " dB"; }

//==============================================================================
void set (BassForgeProcessor& p, const char* id, float value)
{
    auto* param = p.getState().getParameter (id);
    jassert (param != nullptr);
    param->setValueNotifyingHost (param->convertTo0to1 (value));
}

void allModulesOff (BassForgeProcessor& p)
{
    using namespace ParamID;
    for (auto* id : { gateOn, compOn, octOn, envOn, driveOn, eqOn, cabOn, chorusOn, limiterOn })
        set (p, id, 0.0f);
}

void allModulesOn (BassForgeProcessor& p)
{
    using namespace ParamID;
    for (auto* id : { gateOn, compOn, octOn, envOn, driveOn, eqOn, cabOn, chorusOn, limiterOn })
        set (p, id, 1.0f);
}

std::unique_ptr<BassForgeProcessor> makeProcessor (double fs, int blockSize, int inputs = 2, int outputs = 2)
{
    auto p = std::make_unique<BassForgeProcessor>();
    BassForgeProcessor::BusesLayout layout;
    layout.inputBuses.add (inputs == 1 ? juce::AudioChannelSet::mono() : juce::AudioChannelSet::stereo());
    layout.outputBuses.add (outputs == 1 ? juce::AudioChannelSet::mono() : juce::AudioChannelSet::stereo());
    p->setBusesLayout (layout);
    p->setRateAndBufferSizeDetails (fs, blockSize);
    p->prepareToPlay (fs, blockSize);
    return p;
}

void prepare (BassForgeProcessor& p, double fs, int blockSize)
{
    p.setRateAndBufferSizeDetails (fs, blockSize);
    p.prepareToPlay (fs, blockSize);
}

/** Plucked bass line: notes with harmonics, a pick attack and a decay. */
juce::AudioBuffer<float> bassLine (double fs, double seconds, int channels, float level = 0.5f)
{
    const float notes[] = { 41.2f, 41.2f, 55.0f, 61.7f, 73.4f, 82.4f, 98.0f, 55.0f, 110.0f, 49.0f, 36.7f, 146.8f };
    const int total = (int) (fs * seconds), noteLength = (int) (fs * 0.25);
    juce::AudioBuffer<float> buffer (channels, total);
    juce::Random random (42);

    for (int i = 0; i < total; ++i)
    {
        const int note = i / noteLength;
        const float f = notes[note % 12];
        const float t = (float) (i % noteLength) / (float) fs;
        const float env = std::exp (-t * 6.0f) * std::min (1.0f, t * 400.0f);
        float x = 0.0f;
        for (int h = 1; h <= 6; ++h)
            x += std::sin (2.0f * bf::pi * f * (float) h * t) * std::exp (-t * (float) h * 3.0f) / (float) h;
        x = x * env * level * 0.8f + (random.nextFloat() - 0.5f) * 0.0004f;
        for (int c = 0; c < channels; ++c)
            buffer.setSample (c, i, x);
    }
    return buffer;
}

juce::AudioBuffer<float> sine (double fs, int samples, float freq, float amp, int channels)
{
    juce::AudioBuffer<float> buffer (channels, samples);
    for (int i = 0; i < samples; ++i)
        for (int c = 0; c < channels; ++c)
            buffer.setSample (c, i, amp * std::sin (2.0f * bf::pi * freq * (float) i / (float) fs));
    return buffer;
}

void run (BassForgeProcessor& p, juce::AudioBuffer<float>& buffer, int blockSize)
{
    juce::MidiBuffer midi;
    for (int start = 0; start < buffer.getNumSamples(); start += blockSize)
    {
        const int n = std::min (blockSize, buffer.getNumSamples() - start);
        juce::AudioBuffer<float> view (buffer.getArrayOfWritePointers(), buffer.getNumChannels(), start, n);
        p.processBlock (view, midi);
    }
}

bool allFinite (const juce::AudioBuffer<float>& b)
{
    for (int c = 0; c < b.getNumChannels(); ++c)
        for (int i = 0; i < b.getNumSamples(); ++i)
            if (! std::isfinite (b.getSample (c, i)))
                return false;
    return true;
}

float peak (const juce::AudioBuffer<float>& b, int start = 0)
{
    float m = 0.0f;
    for (int c = 0; c < b.getNumChannels(); ++c)
        for (int i = start; i < b.getNumSamples(); ++i)
            m = std::max (m, std::abs (b.getSample (c, i)));
    return m;
}

double rms (const juce::AudioBuffer<float>& b, int channel = 0, int start = 0, int end = -1)
{
    end = end < 0 ? b.getNumSamples() : end;
    double sum = 0.0;
    for (int i = start; i < end; ++i)
        sum += (double) b.getSample (channel, i) * b.getSample (channel, i);
    return std::sqrt (sum / std::max (1, end - start));
}

/** Magnitude of one frequency (Goertzel), for checking spectra. */
double toneLevel (const juce::AudioBuffer<float>& b, double fs, double freq, int start, int end)
{
    const double w = 2.0 * juce::MathConstants<double>::pi * freq / fs, coeff = 2.0 * std::cos (w);
    double s1 = 0.0, s2 = 0.0;
    for (int i = start; i < end; ++i)
    {
        const double s0 = b.getSample (0, i) + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    return std::sqrt (s1 * s1 + s2 * s2 - coeff * s1 * s2) * 2.0 / (end - start);
}

//==============================================================================
void testLayouts()
{
    section ("Bus layouts");
    BassForgeProcessor p;
    auto layout = [] (juce::AudioChannelSet in, juce::AudioChannelSet out)
    {
        BassForgeProcessor::BusesLayout l;
        l.inputBuses.add (in);
        l.outputBuses.add (out);
        return l;
    };
    using S = juce::AudioChannelSet;
    check (p.checkBusesLayoutSupported (layout (S::stereo(), S::stereo())), "stereo -> stereo supported");
    check (p.checkBusesLayoutSupported (layout (S::mono(), S::stereo())), "mono -> stereo supported");
    check (p.checkBusesLayoutSupported (layout (S::mono(), S::mono())), "mono -> mono supported");
    check (! p.checkBusesLayoutSupported (layout (S::stereo(), S::mono())), "stereo -> mono rejected");
    check (! p.checkBusesLayoutSupported (layout (S::create5point1(), S::create5point1())), "5.1 rejected");
}

void testLatencyAndTransparency()
{
    section ("Latency and transparency (all modules off)");

    for (double fs : { 44100.0, 48000.0, 96000.0, 192000.0 })
    {
        auto p = makeProcessor (fs, 512);
        allModulesOff (*p);
        prepare (*p, fs, 512);
        const int latency = p->getLatencySamples();

        juce::AudioBuffer<float> impulse (2, 4096);
        impulse.clear();
        impulse.setSample (0, 1000, 1.0f);
        impulse.setSample (1, 1000, 1.0f);
        run (*p, impulse, 512);

        int peakIndex = 0;
        for (int i = 0; i < impulse.getNumSamples(); ++i)
            if (std::abs (impulse.getSample (0, i)) > std::abs (impulse.getSample (0, peakIndex)))
                peakIndex = i;

        check (peakIndex - 1000 == latency, juce::String (fs / 1000.0, 1) + " kHz: reported latency "
                                               + juce::String (latency) + " matches measured " + juce::String (peakIndex - 1000));

        for (float freq : { 220.0f, 5000.0f })
        {
            for (float mixValue : { 1.0f, 0.5f, 0.0f })
            {
                auto q = makeProcessor (fs, 256);
                allModulesOff (*q);
                set (*q, ParamID::mix, mixValue);
                prepare (*q, fs, 256);

                const int n = (int) fs;
                auto in = sine (fs, n, freq, 0.5f, 2);
                auto out = in;
                run (*q, out, 256);

                double err = 0.0, ref = 0.0;
                for (int i = n / 2; i < n; ++i)
                {
                    const double d = out.getSample (0, i) - in.getSample (0, i - latency);
                    err += d * d;
                    ref += (double) in.getSample (0, i - latency) * in.getSample (0, i - latency);
                }
                const double residualDb = 10.0 * std::log10 (err / ref + 1.0e-30);
                const double limit = mixValue <= 0.0f ? -140.0 : -45.0;
                check (residualDb < limit, juce::String (fs / 1000.0, 1) + " kHz, " + juce::String (freq) + " Hz, mix "
                                               + juce::String (mixValue) + ": null residual " + juce::String (residualDb, 1) + " dB");
            }
        }
    }
}

void testStress()
{
    section ("Stress: every module on, extreme settings, many rates and block sizes");
    using namespace ParamID;

    for (double fs : { 44100.0, 48000.0, 96000.0, 192000.0 })
    {
        for (int block : { 1, 31, 64, 480, 2048 })
        {
            auto p = makeProcessor (fs, block);
            allModulesOn (*p);
            set (*p, inputGain, 24.0f);
            set (*p, envReso, 1.0f);
            set (*p, envSens, 1.0f);
            set (*p, driveAmount, 1.0f);
            set (*p, eqBass, 15.0f);
            set (*p, eqTreble, 15.0f);
            set (*p, octSub, 1.0f);
            set (*p, octUp, 1.0f);
            set (*p, outputGain, 12.0f);
            prepare (*p, fs, block);

            auto audio = bassLine (fs, block == 1 ? 0.6 : 1.5, 2, 0.9f);
            const float ceiling = juce::Decibels::decibelsToGain (-0.3f);
            bool ok = true;

            // Cycle the choice parameters while running, as automation would.
            for (int type = 0; type < 5; ++type)
            {
                set (*p, driveType, (float) type);
                set (*p, envMode, (float) (type % 3));
                set (*p, cabType, (float) (type % 4));
                auto chunk = audio;
                run (*p, chunk, block);
                ok = ok && allFinite (chunk) && peak (chunk) <= ceiling + 1.0e-4f;
            }

            check (ok, juce::String (fs / 1000.0, 1) + " kHz, block " + juce::String (block)
                           + ": finite and below the -0.3 dB ceiling");
        }
    }
}

void testPresets()
{
    section ("Factory presets");
    const double fs = 48000.0;
    const auto input = bassLine (fs, 3.0, 2);
    const double inRms = rms (input);

    const auto& presets = getFactoryPresets();
    for (int i = 0; i < (int) presets.size(); ++i)
    {
        auto p = makeProcessor (fs, 256);
        p->loadFactoryPreset (i);
        prepare (*p, fs, 256);

        auto out = input;
        run (*p, out, 256);

        const double ratio = rms (out) / inRms;
        const bool ok = allFinite (out) && peak (out) <= juce::Decibels::decibelsToGain (-0.3f) + 1.0e-4f
                        && ratio > juce::Decibels::decibelsToGain (-12.0) && ratio < juce::Decibels::decibelsToGain (9.0);
        check (ok, juce::String (presets[(size_t) i].name).paddedRight (' ', 16) + " level vs input " + db (ratio)
                       + ", peak " + db (peak (out)));
        check (p->getCurrentPresetIndex() == i, "  preset index remembered");
    }
}

void testState()
{
    section ("State save / restore");
    auto a = makeProcessor (48000.0, 256);
    a->loadFactoryPreset (3);
    set (*a, ParamID::eqBass, 4.5f);
    set (*a, ParamID::driveType, 3.0f);
    set (*a, ParamID::chorusOn, 1.0f);

    juce::MemoryBlock data;
    a->getStateInformation (data);

    auto b = makeProcessor (48000.0, 256);
    b->setStateInformation (data.getData(), (int) data.getSize());

    bool same = true;
    for (auto* param : a->getParameters())
    {
        auto* ranged = dynamic_cast<juce::RangedAudioParameter*> (param);
        auto* other = b->getState().getParameter (ranged->getParameterID());
        if (std::abs (ranged->getValue() - other->getValue()) > 1.0e-6f)
        {
            same = false;
            std::cout << "        mismatch: " << ranged->getParameterID() << std::endl;
        }
    }
    check (same, "all " + juce::String (a->getParameters().size()) + " parameters restored");
    check (b->getCurrentPresetIndex() == 3, "preset name restored");

    // Garbage must not crash or change anything.
    const char junk[] = "definitely not a preset";
    b->setStateInformation (junk, (int) sizeof (junk));
    check (std::abs (b->getState().getParameter (ParamID::eqBass)->convertFrom0to1 (
               b->getState().getParameter (ParamID::eqBass)->getValue()) - 4.5f) < 0.01f,
           "corrupt state ignored");
}

void testModules()
{
    section ("Module behaviour");
    using namespace ParamID;
    const double fs = 48000.0;
    const int n = (int) fs;

    // Compressor reduces a loud signal.
    {
        auto p = makeProcessor (fs, 256);
        allModulesOff (*p);
        set (*p, compOn, 1.0f);
        set (*p, compThreshold, -30.0f);
        set (*p, compRatio, 10.0f);
        set (*p, compMakeup, 0.0f);
        prepare (*p, fs, 256);
        auto in = sine (fs, n, 110.0f, 0.7f, 2);
        auto out = in;
        run (*p, out, 256);
        const double reduction = rms (in, 0, n / 2) / rms (out, 0, n / 2);
        check (juce::Decibels::gainToDecibels (reduction) > 12.0, "compressor: -30 dB threshold, 10:1 reduces by " + db (reduction));
        check (p->getMeters().compReductionDb.load() > 12.0f, "compressor: gain reduction meter reports "
                                                                   + juce::String (p->getMeters().compReductionDb.load(), 1) + " dB");
    }

    // Gate closes on low-level noise.
    {
        auto p = makeProcessor (fs, 256);
        allModulesOff (*p);
        set (*p, gateOn, 1.0f);
        set (*p, gateThreshold, -50.0f);
        prepare (*p, fs, 256);
        juce::AudioBuffer<float> noise (2, n);
        juce::Random r (1);
        for (int i = 0; i < n; ++i)
            noise.setSample (0, i, (r.nextFloat() - 0.5f) * 0.002f), noise.setSample (1, i, noise.getSample (0, i));
        const double inLevel = rms (noise, 0, n / 2);
        run (*p, noise, 256);
        const double attenuation = inLevel / std::max (1.0e-12, rms (noise, 0, n / 2));
        check (juce::Decibels::gainToDecibels (attenuation) > 40.0, "gate: -60 dBFS hiss attenuated by " + db (attenuation));
    }

    // Octaver: sub-only output sits an octave below the input.
    {
        auto p = makeProcessor (fs, 256);
        allModulesOff (*p);
        set (*p, octOn, 1.0f);
        set (*p, octSub, 1.0f);
        set (*p, octDry, 0.0f);
        set (*p, octTone, 400.0f);
        prepare (*p, fs, 256);
        auto out = sine (fs, n, 110.0f, 0.5f, 2);
        run (*p, out, 256);
        const double sub = toneLevel (out, fs, 55.0, n / 2, n), orig = toneLevel (out, fs, 110.0, n / 2, n);
        check (sub > 0.2 && sub > orig * 10.0, "octaver: 110 Hz in -> 55 Hz at " + db (sub) + ", 110 Hz at " + db (orig));

        set (*p, octSub, 0.0f);
        set (*p, octUp, 1.0f);
        prepare (*p, fs, 256);
        auto up = sine (fs, n, 110.0f, 0.5f, 2);
        run (*p, up, 256);
        const double octUpLevel = toneLevel (up, fs, 220.0, n / 2, n);
        check (octUpLevel > 0.1, "octaver: octave-up voice at 220 Hz is " + db (octUpLevel));
    }

    // Envelope filter: a loud note opens the low-pass, letting the upper harmonics through.
    {
        auto p = makeProcessor (fs, 256);
        allModulesOff (*p);
        set (*p, envOn, 1.0f);
        set (*p, envFreq, 150.0f);
        set (*p, envRange, 1.0f);
        set (*p, envSens, 0.9f);
        prepare (*p, fs, 256);
        juce::AudioBuffer<float> quiet (2, n), loud (2, n);
        for (int i = 0; i < n; ++i)
        {
            const float sq = std::sin (2.0f * bf::pi * 110.0f * (float) i / (float) fs) > 0.0f ? 1.0f : -1.0f;
            for (int c = 0; c < 2; ++c)
            {
                quiet.setSample (c, i, sq * 0.001f);
                loud.setSample (c, i, sq * 0.5f);
            }
        }
        run (*p, quiet, 256);
        prepare (*p, fs, 256);
        run (*p, loud, 256);
        const double quietBright = toneLevel (quiet, fs, 1210.0, n / 2, n) / 0.001;
        const double loudBright = toneLevel (loud, fs, 1210.0, n / 2, n) / 0.5;
        check (loudBright > quietBright * 10.0, "envelope filter: 11th harmonic quiet " + db (quietBright) + " vs loud " + db (loudBright));
    }

    // Drive adds harmonics but keeps the low band clean.
    {
        auto p = makeProcessor (fs, 256);
        allModulesOff (*p);
        set (*p, driveOn, 1.0f);
        set (*p, driveAmount, 0.7f);
        set (*p, driveXover, 40.0f);
        prepare (*p, fs, 256);
        auto out = sine (fs, n, 220.0f, 0.3f, 2);
        run (*p, out, 256);
        double harmonics = 0.0;
        for (int h = 2; h <= 7; ++h)
            harmonics += std::pow (toneLevel (out, fs, 220.0 * h, n / 2, n), 2.0);
        const double thd = std::sqrt (harmonics) / toneLevel (out, fs, 220.0, n / 2, n);
        check (thd > 0.1, "drive: THD at 70% drive is " + juce::String (thd * 100.0, 1) + " %");

        for (int type = 0; type < bf::Drive::numTypes; ++type)
        {
            auto q = makeProcessor (fs, 256);
            allModulesOff (*q);
            set (*q, driveOn, 1.0f);
            set (*q, driveType, (float) type);
            set (*q, driveAmount, 1.0f);
            prepare (*q, fs, 256);
            auto line = bassLine (fs, 2.0, 2);
            const double inLevel = rms (line);
            run (*q, line, 256);
            const double ratio = rms (line) / inLevel;
            check (allFinite (line) && ratio > juce::Decibels::decibelsToGain (-10.0) && ratio < juce::Decibels::decibelsToGain (8.0),
                   "drive: " + Choices::driveTypes[type] + " at 100% stays level-matched (" + db (ratio) + ")");
        }

        // Aliasing: hard-clip a 2.7 kHz tone and measure everything that is not
        // a harmonic. 4x oversampling alone gets about -32 dB on this worst
        // case; antiderivative anti-aliasing takes it below -55 dB.
        {
            auto a = makeProcessor (fs, 256);
            allModulesOff (*a);
            set (*a, driveOn, 1.0f);
            set (*a, driveType, 2.0f);
            set (*a, driveAmount, 1.0f);
            set (*a, driveXover, 40.0f);
            set (*a, driveTone, 1.0f);
            prepare (*a, fs, 256);
            constexpr int order = 15, size = 1 << order;
            const float f0 = 2700.0f;
            auto tone = sine (fs, size * 2, f0, 0.5f, 2);
            run (*a, tone, 256);

            juce::dsp::FFT fft (order);
            std::vector<float> data ((size_t) size * 2, 0.0f);
            for (int i = 0; i < size; ++i)
            {
                const float window = 0.5f - 0.5f * std::cos (2.0f * bf::pi * (float) i / (float) size);
                data[(size_t) i] = tone.getSample (0, size + i) * window;
            }
            fft.performFrequencyOnlyForwardTransform (data.data());

            double harmonic = 0.0, alias = 0.0;
            for (int bin = 1; bin < size / 2; ++bin)
            {
                const double f = bin * fs / size;
                if (f > 20000.0)
                    break;
                const double ratio = f / f0;
                const bool nearHarmonic = std::abs (ratio - std::round (ratio)) * f0 < 60.0;
                (nearHarmonic ? harmonic : alias) += (double) data[(size_t) bin] * data[(size_t) bin];
            }
            const double aliasDb = 10.0 * std::log10 (alias / harmonic);
            check (aliasDb < -50.0, "drive: aliasing from a hard-clipped 2.7 kHz tone is " + juce::String (aliasDb, 1) + " dB");
        }

        // Clean low band: with a high crossover, a 50 Hz tone passes almost undistorted.
        auto q = makeProcessor (fs, 256);
        allModulesOff (*q);
        set (*q, driveOn, 1.0f);
        set (*q, driveAmount, 1.0f);
        set (*q, driveXover, 400.0f);
        prepare (*q, fs, 256);
        auto low = sine (fs, n, 50.0f, 0.4f, 2);
        run (*q, low, 256);
        double lowHarm = 0.0;
        for (int h = 2; h <= 5; ++h)
            lowHarm += std::pow (toneLevel (low, fs, 50.0 * h, n / 2, n), 2.0);
        const double lowThd = std::sqrt (lowHarm) / toneLevel (low, fs, 50.0, n / 2, n);
        check (lowThd < 0.05, "drive: 50 Hz below a 400 Hz crossover stays clean (THD " + juce::String (lowThd * 100.0, 2) + " %)");
    }

    // EQ: +12 dB bass shelf.
    {
        auto p = makeProcessor (fs, 256);
        allModulesOff (*p);
        set (*p, eqOn, 1.0f);
        set (*p, eqLowCut, 20.0f);
        set (*p, eqBass, 12.0f);
        prepare (*p, fs, 256);
        auto out = sine (fs, n, 40.0f, 0.05f, 2);
        run (*p, out, 256);
        const double gain = toneLevel (out, fs, 40.0, n / 2, n) / 0.05;
        check (std::abs (juce::Decibels::gainToDecibels (gain) - 12.0) < 1.5, "EQ: +12 dB bass shelf gives " + db (gain) + " at 40 Hz");
    }

    // Limiter holds the ceiling on a hot signal.
    {
        auto p = makeProcessor (fs, 256);
        allModulesOff (*p);
        set (*p, limiterOn, 1.0f);
        set (*p, limiterCeiling, -6.0f);
        set (*p, outputGain, 12.0f);
        prepare (*p, fs, 256);
        auto out = bassLine (fs, 2.0, 2, 0.9f);
        run (*p, out, 256);
        check (peak (out) <= juce::Decibels::decibelsToGain (-6.0f) + 1.0e-5f, "limiter: +12 dB into a -6 dB ceiling peaks at " + db (peak (out)));
    }

    // Chorus turns a mono input into stereo, but keeps the lows centred.
    {
        auto p = makeProcessor (fs, 256, 1, 2);
        allModulesOff (*p);
        set (*p, chorusOn, 1.0f);
        set (*p, chorusDepth, 1.0f);
        prepare (*p, fs, 256);
        juce::AudioBuffer<float> out (2, n);
        auto mono = sine (fs, n, 880.0f, 0.3f, 1);
        out.copyFrom (0, 0, mono, 0, 0, n);
        out.clear (1, 0, n);
        run (*p, out, 256);
        double side = 0.0;
        for (int i = n / 2; i < n; ++i)
            side += std::pow (out.getSample (0, i) - out.getSample (1, i), 2.0);
        check (std::sqrt (side / (n / 2)) > 0.02, "chorus: mono in -> stereo out");

        auto q = makeProcessor (fs, 256, 1, 2);
        allModulesOff (*q);
        set (*q, chorusOn, 1.0f);
        set (*q, chorusDepth, 1.0f);
        set (*q, chorusXover, 400.0f);
        prepare (*q, fs, 256);
        juce::AudioBuffer<float> lows (2, n);
        auto low = sine (fs, n, 45.0f, 0.3f, 1);
        lows.copyFrom (0, 0, low, 0, 0, n);
        run (*q, lows, 256);
        double lowSide = 0.0;
        for (int i = n / 2; i < n; ++i)
            lowSide += std::pow (lows.getSample (0, i) - lows.getSample (1, i), 2.0);
        check (std::sqrt (lowSide / (n / 2)) < 0.003, "chorus: 45 Hz below the crossover stays mono");
    }
}

void testSwitchingClicks()
{
    section ("Switching modules on and off mid-note");
    using namespace ParamID;
    const double fs = 48000.0;

    for (auto* id : { gateOn, compOn, octOn, envOn, driveOn, eqOn, cabOn, chorusOn, limiterOn })
    {
        auto p = makeProcessor (fs, 128);
        allModulesOff (*p);
        set (*p, driveAmount, 0.2f);
        set (*p, eqBass, 6.0f);
        prepare (*p, fs, 128);

        auto audio = sine (fs, (int) fs * 2, 82.4f, 0.4f, 2);
        juce::MidiBuffer midi;
        float steadyMax = 0.0f, switchMax = 0.0f, last = 0.0f;
        const int blocks = audio.getNumSamples() / 128;

        for (int b = 0; b < blocks; ++b)
        {
            const bool switching = b % 40 == 20;
            if (switching)
                set (*p, id, ((b / 40) % 2) == 0 ? 1.0f : 0.0f);

            juce::AudioBuffer<float> view (audio.getArrayOfWritePointers(), 2, b * 128, 128);
            p->processBlock (view, midi);

            float blockMax = 0.0f;
            for (int i = 0; i < 128; ++i)
            {
                const float x = view.getSample (0, i);
                blockMax = std::max (blockMax, std::abs (x - last));
                last = x;
            }

            if (b < 10)
                continue;
            if ((b % 40) >= 20 && (b % 40) < 26)
                switchMax = std::max (switchMax, blockMax);
            else
                steadyMax = std::max (steadyMax, blockMax);
        }

        check (switchMax < steadyMax * 1.5f + 0.01f, juce::String (id).paddedRight (' ', 10)
                                                         + " largest step while switching " + juce::String (switchMax, 4)
                                                         + " vs steady " + juce::String (steadyMax, 4));
    }
}

void testTuner()
{
    section ("Tuner");
    for (double fs : { 44100.0, 48000.0, 96000.0 })
    {
        for (float freq : { 30.87f, 41.2f, 55.0f, 73.42f, 98.0f, 146.83f, 196.0f, 392.0f })
        {
            bf::TunerFeed feed;
            feed.prepare (fs);
            std::vector<float> history;

            // Bass-like tone: strong second harmonic, as a plucked string has.
            const int n = (int) (fs * 0.4);
            std::vector<float> x ((size_t) n);
            for (int i = 0; i < n; ++i)
            {
                const float t = (float) i / (float) fs;
                x[(size_t) i] = 0.3f * std::sin (2.0f * bf::pi * freq * t) + 0.25f * std::sin (2.0f * bf::pi * 2.0f * freq * t)
                              + 0.1f * std::sin (2.0f * bf::pi * 3.0f * freq * t);
            }
            for (int i = 0; i < n; i += 256)
                feed.push (x.data() + i, std::min (256, n - i));
            feed.pull (history);

            bf::PitchDetector detector;
            const int use = std::min ((int) history.size(), 2048);
            const auto hz = detector.detect (history.data() + history.size() - (size_t) use, use, feed.getRate());
            const float cents = hz.has_value() ? 1200.0f * std::log2 (*hz / freq) : 9999.0f;
            check (std::abs (cents) < 2.0f, juce::String (fs / 1000.0, 1) + " kHz: " + juce::String (freq, 2) + " Hz read as "
                                                + (hz ? juce::String (*hz, 2) : juce::String ("nothing")) + " ("
                                                + juce::String (cents, 2) + " cents)");
        }
    }

    bf::PitchDetector detector;
    std::vector<float> silence (2048, 0.0f);
    check (! detector.detect (silence.data(), 2048, 12000.0).has_value(), "silence reads as no note");
}

void testPerformance()
{
    section ("Performance");
    const double fs = 48000.0;
    auto p = makeProcessor (fs, 256);
    allModulesOn (*p);
    prepare (*p, fs, 256);
    auto audio = bassLine (fs, 10.0, 2);

    const auto start = std::chrono::steady_clock::now();
    run (*p, audio, 256);
    const double seconds = std::chrono::duration<double> (std::chrono::steady_clock::now() - start).count();
    const double realtime = 10.0 / seconds;
    std::cout << "        every module on, 48 kHz stereo: " << juce::String (realtime, 0) << "x realtime ("
              << juce::String (100.0 / realtime, 2) << " % of one core)" << std::endl;
    check (realtime > 10.0, "under 10 % of one core");
}

void renderEditor (const juce::File& directory)
{
    section ("Editor screenshots");
    const double fs = 48000.0;

    for (auto [presetIndex, fileName] : { std::pair { 0, "editor-clean-di.png" }, std::pair { 2, "editor-modern-grind.png" },
                                          std::pair { 3, "editor-synth-funk.png" } })
    {
        auto p = makeProcessor (fs, 512);
        p->loadFactoryPreset (presetIndex);
        prepare (*p, fs, 512);

        std::unique_ptr<juce::AudioProcessorEditor> editor (p->createEditorAndMakeActive());
        check (editor != nullptr, "editor created for preset " + juce::String (presetIndex));
        if (editor == nullptr)
            continue;

        // Play a sustained A (55 Hz) so the tuner and meters have something to show.
        auto note = sine (fs, (int) fs * 3, 55.0f, 0.35f, 2);
        juce::MidiBuffer midi;
        for (int b = 0; b < note.getNumSamples() / 512; ++b)
        {
            juce::AudioBuffer<float> view (note.getArrayOfWritePointers(), 2, b * 512, 512);
            p->processBlock (view, midi);
            if (b % 3 == 0)
            {
                juce::Thread::sleep (34);
                juce::Timer::callPendingTimersSynchronously();
            }
        }

        const auto image = editor->createComponentSnapshot (editor->getLocalBounds(), true, 1.5f);
        const auto file = directory.getChildFile (fileName);
        file.deleteFile();
        juce::FileOutputStream out (file);
        const bool written = out.openedOk() && juce::PNGImageFormat().writeImageToStream (image, out);
        check (written, "wrote " + file.getFullPathName());

        editor.reset();
    }
}
} // namespace

int main (int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI juce;

    std::cout << "BassForge tests" << std::endl;
    testLayouts();
    testLatencyAndTransparency();
    testModules();
    testSwitchingClicks();
    testPresets();
    testState();
    testTuner();
    testStress();
    testPerformance();

    const auto shots = argc > 1 ? juce::File::getCurrentWorkingDirectory().getChildFile (argv[1])
                                : juce::File::getCurrentWorkingDirectory();
    shots.createDirectory();
    renderEditor (shots);

    std::cout << "\n" << (failures == 0 ? "All checks passed." : juce::String (failures) + " check(s) FAILED.") << std::endl;
    return failures == 0 ? 0 : 1;
}
