#include "Presets.h"
#include "Parameters.h"

using namespace ParamID;

const std::vector<FactoryPreset>& getFactoryPresets()
{
    static const std::vector<FactoryPreset> presets {
        { "Clean DI", {} },

        { "Motown Warm", {
            { outputGain, 1.5f },
            { compThreshold, -20.0f }, { compRatio, 3.0f }, { compAttack, 25.0f }, { compRelease, 300.0f },
            { driveOn, 1 }, { driveType, 0 }, { driveAmount, 0.18f }, { driveXover, 40.0f }, { driveTone, 0.3f },
            { eqBass, 3.0f }, { eqLowMid, 2.0f }, { eqLowMidFreq, 250.0f }, { eqTreble, -6.0f }, { eqHighCut, 4500.0f },
            { cabOn, 1 }, { cabType, 0 }, { cabMix, 0.7f } } },

        { "Modern Grind", {
            { outputGain, 2.0f },
            { compThreshold, -22.0f }, { compAttack, 8.0f }, { compRelease, 120.0f }, { compMakeup, 4.0f },
            { driveOn, 1 }, { driveType, 2 }, { driveAmount, 0.62f }, { driveTone, 0.62f }, { driveXover, 180.0f },
            { driveBlend, 0.85f }, { driveLevel, -2.0f },
            { eqLowCut, 35.0f }, { eqBass, 2.0f }, { eqLowMid, -4.0f }, { eqLowMidFreq, 400.0f },
            { eqHighMid, 3.0f }, { eqHighMidFreq, 1600.0f }, { eqTreble, 2.0f },
            { cabOn, 1 }, { cabType, 1 }, { cabMix, 0.55f } } },

        { "Synth Funk", {
            { outputGain, -2.0f },
            { compThreshold, -20.0f },
            { octOn, 1 }, { octSub, 0.7f }, { octDry, 0.55f }, { octTone, 300.0f },
            { envOn, 1 }, { envMode, 0 }, { envSens, 0.6f }, { envFreq, 180.0f }, { envRange, 0.75f },
            { envReso, 0.7f }, { envDecay, 180.0f } } },

        { "Fuzz Sub", {
            { outputGain, -3.5f },
            { driveOn, 1 }, { driveType, 3 }, { driveAmount, 0.7f }, { driveTone, 0.45f }, { driveXover, 90.0f },
            { driveLow, -2.0f }, { driveLevel, -1.0f },
            { octOn, 1 }, { octSub, 0.55f }, { octTone, 200.0f },
            { eqLowMid, -3.0f }, { eqLowMidFreq, 500.0f },
            { cabOn, 1 }, { cabType, 2 }, { cabMix, 0.8f } } },

        { "Slap Bright", {
            { outputGain, 2.5f },
            { compThreshold, -24.0f }, { compRatio, 6.0f }, { compAttack, 1.5f }, { compRelease, 90.0f }, { compMakeup, 5.0f },
            { eqLowCut, 35.0f }, { eqBass, 4.0f }, { eqLowMid, -6.0f }, { eqLowMidFreq, 500.0f },
            { eqHighMid, 2.0f }, { eqHighMidFreq, 2500.0f }, { eqTreble, 5.0f } } },

        { "Dub Deep", {
            { outputGain, -5.0f },
            { compThreshold, -20.0f }, { compAttack, 20.0f }, { compRelease, 250.0f },
            { octOn, 1 }, { octSub, 0.35f }, { octTone, 150.0f },
            { eqBass, 5.0f }, { eqLowMid, 2.0f }, { eqLowMidFreq, 160.0f }, { eqHighMid, -4.0f }, { eqHighMidFreq, 1200.0f },
            { eqTreble, -10.0f }, { eqHighCut, 1500.0f } } },

        { "Fretless Chorus", {
            { compThreshold, -20.0f }, { compRatio, 3.0f }, { compAttack, 15.0f }, { compRelease, 200.0f },
            { chorusOn, 1 }, { chorusRate, 0.45f }, { chorusDepth, 0.55f }, { chorusLevel, 0.75f }, { chorusXover, 220.0f },
            { eqHighMid, 2.0f }, { eqHighMidFreq, 1200.0f }, { eqTreble, 1.0f } } },

        { "Octave Pop", {
            { outputGain, -4.0f },
            { compThreshold, -22.0f },
            { octOn, 1 }, { octSub, 0.85f }, { octDry, 0.6f }, { octTone, 160.0f },
            { eqBass, 2.0f } } },

        { "Rock Pick", {
            { outputGain, 3.5f },
            { compThreshold, -20.0f }, { compRatio, 5.0f }, { compAttack, 5.0f },
            { driveOn, 1 }, { driveType, 1 }, { driveAmount, 0.35f }, { driveTone, 0.55f }, { driveXover, 120.0f },
            { driveBlend, 0.6f },
            { eqLowMid, 1.0f }, { eqLowMidFreq, 250.0f }, { eqHighMid, 4.0f }, { eqHighMidFreq, 1000.0f }, { eqTreble, 2.0f },
            { cabOn, 1 }, { cabType, 1 }, { cabMix, 0.75f } } },

        { "Fold Synth", {
            { outputGain, 6.0f },
            { octOn, 1 }, { octSub, 0.5f }, { octDry, 0.8f },
            { envOn, 1 }, { envMode, 1 }, { envSens, 0.55f }, { envFreq, 300.0f }, { envRange, 0.6f },
            { envReso, 0.55f }, { envDecay, 220.0f }, { envMix, 0.6f },
            { driveOn, 1 }, { driveType, 4 }, { driveAmount, 0.5f }, { driveTone, 0.55f }, { driveXover, 110.0f },
            { driveBlend, 0.9f } } },

        { "Octave Up Fuzz", {
            { outputGain, -3.0f },
            { octOn, 1 }, { octSub, 0.0f }, { octUp, 0.75f }, { octDry, 0.8f },
            { driveOn, 1 }, { driveType, 3 }, { driveAmount, 0.6f }, { driveTone, 0.6f }, { driveXover, 150.0f } } },

        { "Doom", {
            { outputGain, -9.5f },
            { gateOn, 1 }, { gateThreshold, -60.0f },
            { octOn, 1 }, { octSub, 0.4f }, { octTone, 180.0f },
            { driveOn, 1 }, { driveType, 3 }, { driveAmount, 0.85f }, { driveTone, 0.35f }, { driveXover, 80.0f },
            { driveLow, 2.0f },
            { eqBass, 4.0f }, { eqLowMid, 3.0f }, { eqLowMidFreq, 200.0f }, { eqHighCut, 3000.0f },
            { cabOn, 1 }, { cabType, 2 } } },

        { "Reggae Round", {
            { outputGain, -3.0f },
            { compThreshold, -20.0f }, { compRatio, 3.0f }, { compAttack, 30.0f }, { compRelease, 400.0f },
            { eqBass, 6.0f }, { eqLowMid, 1.0f }, { eqLowMidFreq, 120.0f }, { eqHighMid, -5.0f }, { eqHighMidFreq, 900.0f },
            { eqTreble, -12.0f }, { eqHighCut, 1800.0f },
            { cabOn, 1 }, { cabType, 0 }, { cabMix, 0.5f } } },

        { "Gated Wah Funk", {
            { outputGain, 7.0f },
            { gateOn, 1 }, { gateThreshold, -55.0f }, { gateRelease, 40.0f },
            { compRatio, 6.0f }, { compAttack, 3.0f }, { compMakeup, 6.0f },
            { envOn, 1 }, { envMode, 1 }, { envSens, 0.7f }, { envFreq, 250.0f }, { envRange, 0.8f },
            { envReso, 0.65f }, { envDecay, 100.0f }, { envMix, 0.6f } } },
    };

    return presets;
}

void applyFactoryPreset (juce::AudioProcessorValueTreeState& state, const FactoryPreset& preset)
{
    auto setNormalised = [] (juce::RangedAudioParameter& p, float normalised)
    {
        if (juce::exactlyEqual (p.getValue(), normalised))
            return;
        p.beginChangeGesture();
        p.setValueNotifyingHost (normalised);
        p.endChangeGesture();
    };

    for (auto* p : state.processor.getParameters())
        if (auto* ranged = dynamic_cast<juce::RangedAudioParameter*> (p))
        {
            float value = ranged->getDefaultValue();

            for (const auto& [id, v] : preset.values)
                if (ranged->getParameterID() == id)
                    value = ranged->convertTo0to1 (v);

            setNormalised (*ranged, value);
        }
}
