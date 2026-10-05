#include "Widgets.h"

namespace bf::ui
{
//==============================================================================
Knob::Knob (APVTS& state, const juce::String& paramID, const juce::String& name, juce::Colour accent,
            bool bipolar)
    : param (*state.getParameter (paramID))
{
    slider.setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag);
    slider.setTextBoxStyle (juce::Slider::NoTextBox, false, 0, 0);
    slider.setRotaryParameters (juce::MathConstants<float>::pi * 1.25f, juce::MathConstants<float>::pi * 2.75f, true);
    slider.setColour (juce::Slider::rotarySliderFillColourId, accent);
    slider.setMouseDragSensitivity (220);
    slider.getProperties().set ("bipolar", bipolar);
    slider.setTitle (param.getName (64));
    slider.onValueChange = [this] { refreshText(); };
    addAndMakeVisible (slider);

    attachment = std::make_unique<APVTS::SliderAttachment> (state, paramID, slider);
    slider.setDoubleClickReturnValue (true, param.convertFrom0to1 (param.getDefaultValue()));

    nameLabel.setText (name.toUpperCase(), juce::dontSendNotification);
    nameLabel.setFont (font (11.5f, true));
    nameLabel.setColour (juce::Label::textColourId, Palette::dimText);
    nameLabel.setJustificationType (juce::Justification::centred);
    nameLabel.setInterceptsMouseClicks (false, false);
    addAndMakeVisible (nameLabel);

    valueLabel.setFont (font (12.5f));
    valueLabel.setJustificationType (juce::Justification::centred);
    valueLabel.setEditable (false, true, false);
    valueLabel.setTooltip ("Double-click to type a value");
    valueLabel.onTextChange = [this]
    {
        const auto normalised = param.getValueForText (valueLabel.getText());
        slider.setValue (param.convertFrom0to1 (normalised), juce::sendNotificationSync);
        refreshText();
    };
    addAndMakeVisible (valueLabel);

    refreshText();
}

void Knob::refreshText()
{
    const auto normalised = param.convertTo0to1 ((float) slider.getValue());
    valueLabel.setText (param.getText (normalised, 16), juce::dontSendNotification);
}

void Knob::resized()
{
    auto r = getLocalBounds();
    valueLabel.setBounds (r.removeFromBottom (16));
    nameLabel.setBounds (r.removeFromBottom (16));
    const int size = std::min (r.getWidth(), r.getHeight());
    slider.setBounds (r.withSizeKeepingCentre (size, size));
}

//==============================================================================
ChoiceBox::ChoiceBox (APVTS& state, const juce::String& paramID, juce::Colour accent)
{
    if (auto* choiceParam = dynamic_cast<juce::AudioParameterChoice*> (state.getParameter (paramID)))
        box.addItemList (choiceParam->choices, 1);

    box.setColour (juce::ComboBox::arrowColourId, accent);
    box.setTitle (state.getParameter (paramID)->getName (64));
    addAndMakeVisible (box);
    attachment = std::make_unique<APVTS::ComboBoxAttachment> (state, paramID, box);
}

//==============================================================================
Section::Section (APVTS& s, const juce::String& t, juce::Colour a, const juce::String& powerParamID,
                  const juce::String& choiceParamID)
    : state (s), title (t), powerID (powerParamID), accent (a)
{
    if (powerID.isNotEmpty())
    {
        power.setColour (juce::ToggleButton::tickColourId, accent);
        power.setTitle (title + " on/off");
        power.setTooltip ("Switch " + title.toLowerCase() + " on or off");
        addAndMakeVisible (power);
        powerAttachment = std::make_unique<APVTS::ButtonAttachment> (state, powerID, power);
    }

    if (choiceParamID.isNotEmpty())
    {
        choice = std::make_unique<ChoiceBox> (state, choiceParamID, accent);
        addAndMakeVisible (*choice);
    }
}

void Section::addControl (std::unique_ptr<juce::Component> control, float weight)
{
    addAndMakeVisible (*control);
    controls.emplace_back (std::move (control), weight);
}

float Section::getPreferredWeight() const noexcept
{
    float total = 0.0f;
    for (const auto& c : controls)
        total += c.second;
    return total;
}

void Section::refresh()
{
    const bool on = powerID.isEmpty() || state.getRawParameterValue (powerID)->load() >= 0.5f;
    if (on == lastOn)
        return;

    lastOn = on;
    for (auto& c : controls)
        c.first->setAlpha (on ? 1.0f : 0.4f);
    if (choice != nullptr)
        choice->setAlpha (on ? 1.0f : 0.5f);
    repaint();
}

void Section::paint (juce::Graphics& g)
{
    const auto r = getLocalBounds().toFloat().reduced (0.5f);
    g.setColour (Palette::panel);
    g.fillRoundedRectangle (r, 8.0f);

    auto bar = r.withHeight ((float) titleHeight);
    {
        juce::Graphics::ScopedSaveState save (g);
        juce::Path clip;
        clip.addRoundedRectangle (bar.getX(), bar.getY(), bar.getWidth(), bar.getHeight(), 8.0f, 8.0f,
                                  true, true, false, false);
        g.reduceClipRegion (clip);
        g.setColour (Palette::titleBar);
        g.fillRect (bar);
        g.setColour (accent.withAlpha (lastOn ? 0.9f : 0.3f));
        g.fillRect (bar.withY (bar.getBottom() - 2.0f).withHeight (2.0f));
    }

    g.setColour (Palette::panelEdge);
    g.drawRoundedRectangle (r, 8.0f, 1.0f);

    const int textX = powerID.isNotEmpty() ? 34 : 12;
    g.setColour (lastOn ? Palette::text : Palette::dimText);
    g.setFont (font (13.5f, true));
    g.drawText (title.toUpperCase(), textX, 0, getWidth() - textX - 8, titleHeight - 2,
                juce::Justification::centredLeft, false);
}

void Section::resized()
{
    auto r = getLocalBounds();
    auto bar = r.removeFromTop (titleHeight);

    if (powerID.isNotEmpty())
        power.setBounds (bar.getX() + 8, bar.getY() + 4, 20, 20);

    if (choice != nullptr)
        choice->setBounds (bar.removeFromRight (122).reduced (6, 4).translated (0, -1));

    r.reduce (6, 6);
    const float total = getPreferredWeight();
    float x = (float) r.getX();

    for (auto& [control, weight] : controls)
    {
        const float w = (float) r.getWidth() * weight / std::max (total, 1.0f);
        control->setBounds (juce::Rectangle<float> (x, (float) r.getY(), w, (float) r.getHeight()).toNearestInt());
        x += w;
    }
}

//==============================================================================
Meter::Meter (const juce::String& l, Mode m, juce::Colour c) : label (l), mode (m), colour (c) {}

void Meter::push (float value)
{
    // Convert to a 0..1 display position.
    float target;
    if (mode == Mode::level)
        target = juce::jlimit (0.0f, 1.0f, (juce::Decibels::gainToDecibels (value, -100.0f) + 60.0f) / 60.0f);
    else
        target = juce::jlimit (0.0f, 1.0f, value / 24.0f);

    shown = target > shown ? target : shown + (target - shown) * 0.18f;

    if (target >= peakHold)
    {
        peakHold = target;
        holdTicks = 40;
    }
    else if (--holdTicks < 0)
        peakHold = std::max (shown, peakHold - 0.01f);

    repaint();
}

void Meter::paint (juce::Graphics& g)
{
    auto r = getLocalBounds().toFloat();
    auto text = r.removeFromBottom (16.0f);
    const auto bar = r.reduced (1.0f, 0.0f);

    g.setColour (Palette::background);
    g.fillRoundedRectangle (bar, 3.0f);

    if (mode == Mode::level)
    {
        const auto fill = bar.withTop (bar.getBottom() - bar.getHeight() * shown);
        juce::ColourGradient grad (Palette::good, 0.0f, bar.getBottom(), Palette::hot, 0.0f, bar.getY(), false);
        grad.addColour (0.8, Palette::warn);   // -12 dBFS
        g.setGradientFill (grad);
        g.fillRoundedRectangle (fill, 3.0f);

        if (peakHold > 0.001f)
        {
            const float y = bar.getBottom() - bar.getHeight() * peakHold;
            g.setColour (peakHold > 0.995f ? Palette::hot : Palette::text.withAlpha (0.8f));
            g.fillRect (bar.getX(), y - 1.0f, bar.getWidth(), 2.0f);
        }
    }
    else
    {
        g.setColour (colour);
        g.fillRoundedRectangle (bar.withHeight (bar.getHeight() * shown), 3.0f);
        if (peakHold > 0.001f)
        {
            g.setColour (colour.brighter (0.5f));
            g.fillRect (bar.getX(), bar.getY() + bar.getHeight() * peakHold - 1.0f, bar.getWidth(), 2.0f);
        }
    }

    g.setColour (Palette::panelEdge);
    g.drawRoundedRectangle (bar, 3.0f, 1.0f);

    g.setColour (Palette::dimText);
    g.setFont (font (10.5f, true));
    g.drawText (label, text.toNearestInt(), juce::Justification::centred, false);
}

//==============================================================================
void TunerDisplay::setPitch (std::optional<float> hz)
{
    if (hz != frequency)
    {
        frequency = hz;
        repaint();
    }
}

void TunerDisplay::paint (juce::Graphics& g)
{
    static const char* names[] = { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" };

    const auto r = getLocalBounds().toFloat().reduced (0.5f);
    g.setColour (Palette::background);
    g.fillRoundedRectangle (r, 6.0f);
    g.setColour (Palette::panelEdge);
    g.drawRoundedRectangle (r, 6.0f, 1.0f);

    auto area = getLocalBounds().reduced (10, 6);
    auto noteArea = area.removeFromLeft (64);
    auto hzArea = area.removeFromRight (70);
    auto meter = area.reduced (6, 0);

    juce::String note = "-", octave, hz = "TUNER";
    float cents = 0.0f;

    if (frequency.has_value())
    {
        const float midi = 69.0f + 12.0f * std::log2 (*frequency / 440.0f);
        const int nearest = juce::roundToInt (midi);
        cents = (midi - (float) nearest) * 100.0f;
        note = names[((nearest % 12) + 12) % 12];
        octave = juce::String (nearest / 12 - 1);
        hz = juce::String (*frequency, 1) + " Hz";
    }

    const bool inTune = frequency.has_value() && std::abs (cents) < 3.0f;
    const auto noteColour = ! frequency.has_value() ? Palette::dimText : (inTune ? Palette::good : Palette::text);

    g.setColour (noteColour);
    g.setFont (font (28.0f, true));
    g.drawText (note, noteArea.withTrimmedRight (18), juce::Justification::centredRight, false);
    g.setFont (font (13.0f, true));
    g.drawText (octave, noteArea.withTrimmedLeft (noteArea.getWidth() - 16).withTrimmedTop (16),
                juce::Justification::centredLeft, false);

    g.setColour (Palette::dimText);
    g.setFont (font (12.0f, true));
    g.drawText (hz, hzArea, juce::Justification::centredRight, false);

    // cents scale
    const auto scale = meter.toFloat();
    const float cy = scale.getCentreY();
    for (int c = -50; c <= 50; c += 10)
    {
        const float x = scale.getX() + scale.getWidth() * ((float) c + 50.0f) / 100.0f;
        const float h = c == 0 ? 14.0f : (c % 50 == 0 ? 10.0f : 6.0f);
        g.setColour (c == 0 ? Palette::good.withAlpha (0.8f) : Palette::track.brighter (0.3f));
        g.fillRect (x - 0.75f, cy - h * 0.5f, 1.5f, h);
    }

    if (frequency.has_value())
    {
        const float x = scale.getX() + scale.getWidth() * (juce::jlimit (-50.0f, 50.0f, cents) + 50.0f) / 100.0f;
        g.setColour (inTune ? Palette::good : (std::abs (cents) < 15.0f ? Palette::warn : Palette::hot));
        g.fillRoundedRectangle (x - 2.0f, cy - 11.0f, 4.0f, 22.0f, 2.0f);
    }
}
} // namespace bf::ui
