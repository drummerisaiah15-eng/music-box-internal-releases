#include "Parameters.h"

namespace
{
using Attributes = juce::AudioParameterFloatAttributes;

juce::String formatHz (float hz, int)
{
    return hz >= 1000.0f ? juce::String (hz / 1000.0f, hz >= 10000.0f ? 1 : 2) + " kHz"
                         : juce::String (juce::roundToInt (hz)) + " Hz";
}

juce::String formatDb (float db, int)       { return (db > 0.05f ? "+" : "") + juce::String (db, 1) + " dB"; }
juce::String formatPercent (float v, int)   { return juce::String (juce::roundToInt (v * 100.0f)) + " %"; }
juce::String formatMs (float ms, int)       { return ms < 10.0f ? juce::String (ms, 1) + " ms" : juce::String (juce::roundToInt (ms)) + " ms"; }
juce::String formatRatio (float r, int)     { return r >= 19.95f ? juce::String ("Limit") : juce::String (r, 1) + ":1"; }
juce::String formatRate (float hz, int)     { return juce::String (hz, 2) + " Hz"; }

float parseNumber (const juce::String& text)
{
    auto t = text.trim();
    const bool kilo = t.containsIgnoreCase ("k");
    const auto v = t.retainCharacters ("-+.0123456789").getFloatValue();
    return kilo ? v * 1000.0f : v;
}

float parsePercent (const juce::String& text) { return parseNumber (text) / 100.0f; }

juce::NormalisableRange<float> skewed (float lo, float hi, float centre, float step = 0.0f)
{
    juce::NormalisableRange<float> r (lo, hi, step);
    r.setSkewForCentre (centre);
    return r;
}

struct LayoutBuilder
{
    juce::AudioProcessorValueTreeState::ParameterLayout layout;

    void toggle (const char* id, const juce::String& name, bool def)
    {
        layout.add (std::make_unique<juce::AudioParameterBool> (juce::ParameterID { id, 1 }, name, def));
    }

    void choice (const char* id, const juce::String& name, const juce::StringArray& items, int def)
    {
        layout.add (std::make_unique<juce::AudioParameterChoice> (juce::ParameterID { id, 1 }, name, items, def));
    }

    void real (const char* id, const juce::String& name, juce::NormalisableRange<float> range, float def,
               juce::String (*toText) (float, int), float (*fromText) (const juce::String&) = parseNumber,
               const juce::String& unit = {})
    {
        layout.add (std::make_unique<juce::AudioParameterFloat> (
            juce::ParameterID { id, 1 }, name, range, def,
            Attributes().withLabel (unit)
                        .withStringFromValueFunction (toText)
                        .withValueFromStringFunction (fromText)));
    }

    void percent (const char* id, const juce::String& name, float def)
    {
        real (id, name, { 0.0f, 1.0f }, def, formatPercent, parsePercent);
    }

    void decibels (const char* id, const juce::String& name, float lo, float hi, float def)
    {
        real (id, name, { lo, hi }, def, formatDb, parseNumber, "dB");
    }

    void hertz (const char* id, const juce::String& name, float lo, float hi, float centre, float def)
    {
        real (id, name, skewed (lo, hi, centre), def, formatHz, parseNumber, "Hz");
    }
};
} // namespace

juce::AudioProcessorValueTreeState::ParameterLayout createParameterLayout()
{
    LayoutBuilder b;

    b.decibels (ParamID::inputGain, "Input Gain", -24.0f, 24.0f, 0.0f);
    b.toggle   (ParamID::gateOn, "Gate On", false);
    b.decibels (ParamID::gateThreshold, "Gate Threshold", -90.0f, -20.0f, -60.0f);
    b.real     (ParamID::gateRelease, "Gate Release", skewed (5.0f, 500.0f, 80.0f), 80.0f, formatMs, parseNumber, "ms");

    b.toggle   (ParamID::compOn, "Comp On", true);
    b.decibels (ParamID::compThreshold, "Comp Threshold", -50.0f, 0.0f, -18.0f);
    b.real     (ParamID::compRatio, "Comp Ratio", skewed (1.0f, 20.0f, 4.0f), 4.0f, formatRatio);
    b.real     (ParamID::compAttack, "Comp Attack", skewed (0.1f, 100.0f, 10.0f), 10.0f, formatMs, parseNumber, "ms");
    b.real     (ParamID::compRelease, "Comp Release", skewed (10.0f, 1000.0f, 150.0f), 150.0f, formatMs, parseNumber, "ms");
    b.decibels (ParamID::compMakeup, "Comp Makeup", 0.0f, 24.0f, 3.0f);
    b.percent  (ParamID::compMix, "Comp Mix", 1.0f);

    b.toggle   (ParamID::octOn, "Octave On", false);
    b.percent  (ParamID::octSub, "Octave Sub", 0.5f);
    b.percent  (ParamID::octUp, "Octave Up", 0.0f);
    b.percent  (ParamID::octDry, "Octave Dry", 1.0f);
    b.hertz    (ParamID::octTone, "Octave Tone", 60.0f, 1000.0f, 250.0f, 250.0f);

    b.toggle   (ParamID::envOn, "Env Filter On", false);
    b.choice   (ParamID::envMode, "Env Filter Mode", Choices::envModes, 0);
    b.percent  (ParamID::envSens, "Env Sensitivity", 0.5f);
    b.hertz    (ParamID::envFreq, "Env Frequency", 80.0f, 2000.0f, 300.0f, 250.0f);
    b.percent  (ParamID::envRange, "Env Range", 0.6f);
    b.percent  (ParamID::envReso, "Env Resonance", 0.5f);
    b.real     (ParamID::envDecay, "Env Decay", skewed (20.0f, 1000.0f, 150.0f), 150.0f, formatMs, parseNumber, "ms");
    b.percent  (ParamID::envMix, "Env Mix", 1.0f);

    b.toggle   (ParamID::driveOn, "Drive On", false);
    b.choice   (ParamID::driveType, "Drive Type", Choices::driveTypes, 0);
    b.percent  (ParamID::driveAmount, "Drive Amount", 0.4f);
    b.percent  (ParamID::driveTone, "Drive Tone", 0.5f);
    b.hertz    (ParamID::driveXover, "Drive X-Over", 40.0f, 600.0f, 150.0f, 150.0f);
    b.percent  (ParamID::driveBlend, "Drive Blend", 1.0f);
    b.decibels (ParamID::driveLow, "Drive Low Level", -24.0f, 6.0f, 0.0f);
    b.decibels (ParamID::driveLevel, "Drive Level", -24.0f, 12.0f, 0.0f);

    b.toggle   (ParamID::eqOn, "EQ On", true);
    b.hertz    (ParamID::eqLowCut, "EQ Low Cut", 20.0f, 300.0f, 60.0f, 20.0f);   // 20 Hz keeps a low B intact
    b.decibels (ParamID::eqBass, "EQ Bass", -15.0f, 15.0f, 0.0f);
    b.decibels (ParamID::eqLowMid, "EQ Low Mid", -15.0f, 15.0f, 0.0f);
    b.hertz    (ParamID::eqLowMidFreq, "EQ Low Mid Freq", 100.0f, 1000.0f, 300.0f, 250.0f);
    b.decibels (ParamID::eqHighMid, "EQ High Mid", -15.0f, 15.0f, 0.0f);
    b.hertz    (ParamID::eqHighMidFreq, "EQ High Mid Freq", 500.0f, 5000.0f, 1500.0f, 1500.0f);
    b.decibels (ParamID::eqTreble, "EQ Treble", -15.0f, 15.0f, 0.0f);
    b.hertz    (ParamID::eqHighCut, "EQ High Cut", 1000.0f, 20000.0f, 5000.0f, 20000.0f);

    b.toggle   (ParamID::cabOn, "Cab On", false);
    b.choice   (ParamID::cabType, "Cab Type", Choices::cabTypes, 0);
    b.percent  (ParamID::cabMix, "Cab Mix", 1.0f);

    b.toggle   (ParamID::chorusOn, "Chorus On", false);
    b.real     (ParamID::chorusRate, "Chorus Rate", skewed (0.05f, 5.0f, 0.8f), 0.6f, formatRate, parseNumber, "Hz");
    b.percent  (ParamID::chorusDepth, "Chorus Depth", 0.5f);
    b.percent  (ParamID::chorusLevel, "Chorus Level", 0.7f);
    b.hertz    (ParamID::chorusXover, "Chorus X-Over", 50.0f, 600.0f, 200.0f, 200.0f);

    b.toggle   (ParamID::limiterOn, "Limiter On", true);
    b.decibels (ParamID::limiterCeiling, "Limiter Ceiling", -24.0f, 0.0f, -0.3f);
    b.decibels (ParamID::outputGain, "Output Gain", -24.0f, 12.0f, 0.0f);
    b.percent  (ParamID::mix, "Mix", 1.0f);

    return std::move (b.layout);
}
