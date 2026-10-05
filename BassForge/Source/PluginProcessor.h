#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include "Parameters.h"
#include "dsp/Chorus.h"
#include "dsp/Drive.h"
#include "dsp/Dynamics.h"
#include "dsp/EnvelopeFilter.h"
#include "dsp/Octaver.h"
#include "dsp/Tone.h"
#include "dsp/Tuner.h"

#include <atomic>

/** BassForge: an all-in-one bass effects chain.

    Signal flow:
        Input -> Gate -> Compressor -> Octaver -> Envelope Filter -> Drive
              -> EQ -> Cab -> Chorus -> Dry/Wet Mix -> Output Gain -> Limiter

    Audio is processed in chunks of up to 32 samples so parameter changes are
    smoothed at a fixed resolution regardless of the host's buffer size. */
class BassForgeProcessor final : public juce::AudioProcessor
{
public:
    BassForgeProcessor();
    ~BassForgeProcessor() override;

    //==============================================================================
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;

    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void processBlockBypassed (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock;
    using AudioProcessor::processBlockBypassed;

    //==============================================================================
    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    //==============================================================================
    const juce::String getName() const override { return "BassForge"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.05; }

    //==============================================================================
    // Factory presets live in the editor's preset menu rather than the host's
    // program list: hosts that re-send a program change while restoring a set
    // would otherwise overwrite the user's tweaks with the factory values.
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return "Default"; }
    void changeProgramName (int, const juce::String&) override {}

    /** Loads a factory preset (message thread only). */
    void loadFactoryPreset (int index);
    /** Index of the last factory preset loaded, saved with the session. */
    int getCurrentPresetIndex() const;

    //==============================================================================
    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    //==============================================================================
    juce::AudioProcessorValueTreeState& getState() noexcept { return state; }

    /** Meter values for the editor, written by the audio thread. */
    struct Meters
    {
        std::atomic<float> inputPeak { 0.0f }, outputPeak { 0.0f };
        std::atomic<float> compReductionDb { 0.0f }, limiterReductionDb { 0.0f };
    };

    Meters& getMeters() noexcept { return meters; }
    bf::TunerFeed& getTunerFeed() noexcept { return tunerFeed; }

    static constexpr int chunkSize = 32;

private:
    struct ParameterPointers;
    void readParameters (bool snap);
    void resetDsp() noexcept;
    void processChunk (float* const* ch, int numChannels, int numSamples);

    template <typename Module>
    void runModule (bf::ModuleFade& fade, Module& module, float* const* ch, int numChannels, int numSamples);

    juce::AudioProcessorValueTreeState state;
    std::unique_ptr<ParameterPointers> params;

    // DSP
    bf::NoiseGate gate;
    bf::Compressor compressor;
    bf::Octaver octaver;
    bf::EnvelopeFilter envFilter;
    bf::Drive drive;
    bf::AmpEq eq;
    bf::CabSim cab;
    bf::Chorus chorus;
    bf::Limiter limiter;
    bf::TunerFeed tunerFeed;

    bf::ModuleFade gateFade, compFade, octFade, envFade, eqFade, cabFade, chorusFade;
    bf::Smoother inputGain, outputGain, mix;

    // Dry path for the global mix, delayed to line up with the wet path.
    std::vector<float> dryDelay;
    int dryDelayLength = 0, dryDelaySize = 1, dryWritePos = 0;

    // Delay used when the host bypasses us, so bypass keeps the same latency.
    std::vector<float> bypassDelay;
    int bypassDelaySize = 1, bypassWritePos = 0;

    std::array<std::array<float, chunkSize>, bf::maxChannels> scratch {}, dryScratch {};
    std::array<float, chunkSize> monoScratch {};

    Meters meters;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (BassForgeProcessor)
};
