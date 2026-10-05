#pragma once

#include "Theme.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <optional>

namespace bf::ui
{
using APVTS = juce::AudioProcessorValueTreeState;

//==============================================================================
/** Rotary control bound to a parameter, with its name and a value readout.
    Double-click the knob to reset it; double-click the value to type one. */
class Knob final : public juce::Component
{
public:
    Knob (APVTS& state, const juce::String& paramID, const juce::String& name, juce::Colour accent,
          bool bipolar = false);

    void resized() override;

private:
    void refreshText();

    juce::RangedAudioParameter& param;
    juce::Slider slider;
    juce::Label nameLabel, valueLabel;
    std::unique_ptr<APVTS::SliderAttachment> attachment;
};

//==============================================================================
/** Compact drop-down bound to a choice parameter. */
class ChoiceBox final : public juce::Component
{
public:
    ChoiceBox (APVTS& state, const juce::String& paramID, juce::Colour accent);
    void resized() override { box.setBounds (getLocalBounds()); }

private:
    juce::ComboBox box;
    std::unique_ptr<APVTS::ComboBoxAttachment> attachment;
};

//==============================================================================
/** A module panel: title bar with an optional power switch and an optional
    drop-down, then a row of controls. Controls dim when the module is off. */
class Section final : public juce::Component
{
public:
    Section (APVTS& state, const juce::String& title, juce::Colour accent,
             const juce::String& powerParamID = {}, const juce::String& choiceParamID = {});

    /** Adds a control; `weight` is its share of the row's width. */
    void addControl (std::unique_ptr<juce::Component> control, float weight = 1.0f);

    /** The width this section wants, used to share a row between sections. */
    float getPreferredWeight() const noexcept;

    /** Re-reads the power switch and dims the controls if the module is off. */
    void refresh();

    void paint (juce::Graphics&) override;
    void resized() override;

    static constexpr int titleHeight = 28;

private:
    APVTS& state;
    juce::String title, powerID;
    juce::Colour accent;
    juce::ToggleButton power;
    std::unique_ptr<APVTS::ButtonAttachment> powerAttachment;
    std::unique_ptr<ChoiceBox> choice;
    std::vector<std::pair<std::unique_ptr<juce::Component>, float>> controls;
    bool lastOn = true;
};

//==============================================================================
/** Vertical meter. Level mode fills upwards from -60 dBFS; reduction mode
    fills downwards from the top, for compressor and limiter gain reduction. */
class Meter final : public juce::Component
{
public:
    enum class Mode { level, reduction };

    Meter (const juce::String& label, Mode mode, juce::Colour colour);

    /** Level mode: linear peak. Reduction mode: dB of gain reduction. */
    void push (float value);
    void paint (juce::Graphics&) override;

private:
    juce::String label;
    Mode mode;
    juce::Colour colour;
    float shown = 0.0f, peakHold = 0.0f;
    int holdTicks = 0;
};

//==============================================================================
/** Chromatic tuner readout: note, octave, a cents needle and the frequency. */
class TunerDisplay final : public juce::Component
{
public:
    void setPitch (std::optional<float> hz);
    void paint (juce::Graphics&) override;

private:
    std::optional<float> frequency;
};
} // namespace bf::ui
