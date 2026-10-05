#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <utility>
#include <vector>

/** A factory preset: a name plus the parameters that differ from the default
    patch. Values are in real units (dB, Hz, ms, 0..1 for percentages, 0/1 for
    switches and the item index for choices). */
struct FactoryPreset
{
    juce::String name;
    std::vector<std::pair<const char*, float>> values;
};

const std::vector<FactoryPreset>& getFactoryPresets();

/** Resets every parameter to its default and then applies the preset, telling
    the host about each change so automation and undo see it. Message thread
    only. */
void applyFactoryPreset (juce::AudioProcessorValueTreeState& state, const FactoryPreset& preset);
