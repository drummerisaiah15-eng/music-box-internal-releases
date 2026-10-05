#pragma once

#include "PluginProcessor.h"
#include "gui/Theme.h"

class BassForgeEditor final : public juce::AudioProcessorEditor,
                              private juce::Timer
{
public:
    explicit BassForgeEditor (BassForgeProcessor&);
    ~BassForgeEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

    /** The layout is designed at this size and scaled to the window. */
    static constexpr int baseWidth = 1220;
    static constexpr int baseHeight = 566;

private:
    void timerCallback() override;

    class Content;

    BassForgeProcessor& bassForge;
    bf::ui::BassForgeLookAndFeel lookAndFeel;
    std::unique_ptr<Content> content;
    juce::TooltipWindow tooltips { this, 700 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (BassForgeEditor)
};
