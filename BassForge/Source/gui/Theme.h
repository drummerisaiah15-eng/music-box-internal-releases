#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

namespace bf::ui
{
namespace Palette
{
    inline const juce::Colour background { 0xff101217 };
    inline const juce::Colour header     { 0xff171a21 };
    inline const juce::Colour panel      { 0xff1b1f27 };
    inline const juce::Colour panelEdge  { 0xff2b313d };
    inline const juce::Colour titleBar   { 0xff222733 };
    inline const juce::Colour text       { 0xffe9ebf1 };
    inline const juce::Colour dimText    { 0xff8d95a7 };
    inline const juce::Colour track      { 0xff303643 };
    inline const juce::Colour knobTop    { 0xff3a404d };
    inline const juce::Colour knobBottom { 0xff1f232b };
    inline const juce::Colour good       { 0xff3ddc97 };
    inline const juce::Colour warn       { 0xffffcf4a };
    inline const juce::Colour hot        { 0xffff4d5e };
}

namespace Accent
{
    inline const juce::Colour gate     { 0xff8fd3c1 };
    inline const juce::Colour comp     { 0xff5aa9ff };
    inline const juce::Colour octave   { 0xffb38cff };
    inline const juce::Colour envelope { 0xff3ddc97 };
    inline const juce::Colour drive    { 0xffff7849 };
    inline const juce::Colour eq       { 0xffffcf4a };
    inline const juce::Colour cab      { 0xffd9a46c };
    inline const juce::Colour chorus   { 0xff4dd6e8 };
    inline const juce::Colour output   { 0xffff5c7a };
}

inline juce::Font font (float height, bool bold = false)
{
    return juce::Font (juce::FontOptions (height).withStyle (bold ? "Bold" : "Regular"));
}

/** Shared look for knobs, switches, menus and buttons. */
class BassForgeLookAndFeel final : public juce::LookAndFeel_V4
{
public:
    BassForgeLookAndFeel();

    void drawRotarySlider (juce::Graphics&, int x, int y, int width, int height, float sliderPos,
                           float startAngle, float endAngle, juce::Slider&) override;

    void drawToggleButton (juce::Graphics&, juce::ToggleButton&, bool highlighted, bool down) override;

    void drawButtonBackground (juce::Graphics&, juce::Button&, const juce::Colour& background,
                               bool highlighted, bool down) override;
    juce::Font getTextButtonFont (juce::TextButton&, int buttonHeight) override;

    void drawComboBox (juce::Graphics&, int width, int height, bool down, int buttonX, int buttonY,
                       int buttonW, int buttonH, juce::ComboBox&) override;
    juce::Font getComboBoxFont (juce::ComboBox&) override;
    void positionComboBoxText (juce::ComboBox&, juce::Label&) override;

    void drawPopupMenuBackground (juce::Graphics&, int width, int height) override;
    juce::Font getPopupMenuFont() override;

    juce::Font getLabelFont (juce::Label&) override;
};
} // namespace bf::ui
