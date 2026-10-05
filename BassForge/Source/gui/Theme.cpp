#include "Theme.h"

namespace bf::ui
{
BassForgeLookAndFeel::BassForgeLookAndFeel()
{
    setColour (juce::ResizableWindow::backgroundColourId, Palette::background);
    setColour (juce::Label::textColourId, Palette::text);
    setColour (juce::Label::textWhenEditingColourId, Palette::text);
    setColour (juce::Label::outlineWhenEditingColourId, Palette::panelEdge);
    setColour (juce::Label::backgroundWhenEditingColourId, Palette::background);
    setColour (juce::TextEditor::highlightColourId, Accent::comp.withAlpha (0.4f));
    setColour (juce::TextEditor::highlightedTextColourId, Palette::text);
    setColour (juce::CaretComponent::caretColourId, Palette::text);
    setColour (juce::ComboBox::backgroundColourId, Palette::background);
    setColour (juce::ComboBox::textColourId, Palette::text);
    setColour (juce::ComboBox::outlineColourId, Palette::panelEdge);
    setColour (juce::ComboBox::arrowColourId, Palette::dimText);
    setColour (juce::PopupMenu::backgroundColourId, Palette::panel);
    setColour (juce::PopupMenu::textColourId, Palette::text);
    setColour (juce::PopupMenu::highlightedBackgroundColourId, Palette::track);
    setColour (juce::PopupMenu::highlightedTextColourId, Palette::text);
    setColour (juce::TextButton::buttonColourId, Palette::titleBar);
    setColour (juce::TextButton::textColourOffId, Palette::text);
    setColour (juce::TextButton::textColourOnId, Palette::text);
    setColour (juce::TooltipWindow::backgroundColourId, Palette::panel);
    setColour (juce::TooltipWindow::textColourId, Palette::text);
    setColour (juce::TooltipWindow::outlineColourId, Palette::panelEdge);
}

void BassForgeLookAndFeel::drawRotarySlider (juce::Graphics& g, int x, int y, int width, int height,
                                             float sliderPos, float startAngle, float endAngle,
                                             juce::Slider& slider)
{
    const auto accent = slider.findColour (juce::Slider::rotarySliderFillColourId);
    const auto bounds = juce::Rectangle<int> (x, y, width, height).toFloat();
    const float radius = std::min (bounds.getWidth(), bounds.getHeight()) * 0.5f - 2.0f;
    const auto centre = bounds.getCentre();
    const float arcRadius = radius - 2.0f;
    const float lineWidth = std::max (2.5f, radius * 0.11f);
    const auto stroke = juce::PathStrokeType (lineWidth, juce::PathStrokeType::curved, juce::PathStrokeType::rounded);

    // track
    juce::Path track;
    track.addCentredArc (centre.x, centre.y, arcRadius, arcRadius, 0.0f, startAngle, endAngle, true);
    g.setColour (Palette::track);
    g.strokePath (track, stroke);

    // value arc, drawn from 12 o'clock for bipolar controls such as EQ gains
    const bool bipolar = slider.getProperties().getWithDefault ("bipolar", false);
    const float angle = startAngle + sliderPos * (endAngle - startAngle);
    const float from = bipolar ? (startAngle + endAngle) * 0.5f : startAngle;

    if (std::abs (angle - from) > 0.01f)
    {
        juce::Path value;
        value.addCentredArc (centre.x, centre.y, arcRadius, arcRadius, 0.0f,
                             std::min (from, angle), std::max (from, angle), true);
        g.setColour (accent);
        g.strokePath (value, stroke);
    }

    // body
    const float bodyRadius = arcRadius - lineWidth - 3.0f;
    const auto body = juce::Rectangle<float> (bodyRadius * 2.0f, bodyRadius * 2.0f).withCentre (centre);
    g.setColour (juce::Colours::black.withAlpha (0.35f));
    g.fillEllipse (body.translated (0.0f, 2.0f));
    g.setGradientFill (juce::ColourGradient (Palette::knobTop, body.getX(), body.getY(),
                                             Palette::knobBottom, body.getRight(), body.getBottom(), false));
    g.fillEllipse (body);
    g.setColour (juce::Colours::white.withAlpha (0.08f));
    g.drawEllipse (body.reduced (0.5f), 1.0f);

    // pointer
    juce::Path pointer;
    const float pointerWidth = std::max (2.0f, bodyRadius * 0.14f);
    pointer.addRoundedRectangle (-pointerWidth * 0.5f, -bodyRadius + 3.0f, pointerWidth, bodyRadius * 0.55f,
                                 pointerWidth * 0.5f);
    g.setColour (slider.isMouseOverOrDragging() ? accent.brighter (0.4f) : Palette::text);
    g.fillPath (pointer, juce::AffineTransform::rotation (angle).translated (centre));
}

void BassForgeLookAndFeel::drawToggleButton (juce::Graphics& g, juce::ToggleButton& button,
                                             bool highlighted, bool)
{
    const auto accent = button.findColour (juce::ToggleButton::tickColourId);
    const bool on = button.getToggleState();
    auto bounds = button.getLocalBounds().toFloat();

    if (button.getButtonText().isEmpty())
    {
        // power switch: an LED with a halo when on
        const float d = std::min (bounds.getWidth(), bounds.getHeight()) - 4.0f;
        const auto led = juce::Rectangle<float> (d, d).withCentre (bounds.getCentre());

        if (on)
        {
            g.setColour (accent.withAlpha (0.25f));
            g.fillEllipse (led.expanded (2.5f));
        }

        g.setColour (on ? accent : Palette::track.brighter (highlighted ? 0.4f : 0.15f));
        g.fillEllipse (led);
        g.setColour (juce::Colours::black.withAlpha (0.4f));
        g.drawEllipse (led, 1.0f);
        return;
    }

    // labelled pill switch
    const auto pill = bounds.reduced (1.0f);
    g.setColour (on ? accent.withAlpha (0.18f) : Palette::background);
    g.fillRoundedRectangle (pill, pill.getHeight() * 0.5f);
    g.setColour (on ? accent : Palette::panelEdge.brighter (highlighted ? 0.3f : 0.0f));
    g.drawRoundedRectangle (pill, pill.getHeight() * 0.5f, 1.0f);

    const float d = pill.getHeight() * 0.38f;
    const auto led = juce::Rectangle<float> (d, d).withCentre ({ pill.getX() + pill.getHeight() * 0.55f, pill.getCentreY() });
    g.setColour (on ? accent : Palette::track.brighter (0.2f));
    g.fillEllipse (led);

    g.setColour (on ? Palette::text : Palette::dimText);
    g.setFont (font (pill.getHeight() * 0.48f, true));
    g.drawText (button.getButtonText(), pill.withTrimmedLeft (pill.getHeight()).toNearestInt(),
                juce::Justification::centredLeft, false);
}

void BassForgeLookAndFeel::drawButtonBackground (juce::Graphics& g, juce::Button& button, const juce::Colour&,
                                                 bool highlighted, bool down)
{
    const auto r = button.getLocalBounds().toFloat().reduced (0.5f);
    g.setColour (Palette::titleBar.brighter (down ? 0.25f : (highlighted ? 0.12f : 0.0f)));
    g.fillRoundedRectangle (r, 4.0f);
    g.setColour (Palette::panelEdge);
    g.drawRoundedRectangle (r, 4.0f, 1.0f);
}

juce::Font BassForgeLookAndFeel::getTextButtonFont (juce::TextButton&, int buttonHeight)
{
    return font ((float) buttonHeight * 0.5f, true);
}

void BassForgeLookAndFeel::drawComboBox (juce::Graphics& g, int width, int height, bool, int, int, int, int,
                                         juce::ComboBox& box)
{
    const auto r = juce::Rectangle<int> (width, height).toFloat().reduced (0.5f);
    g.setColour (box.findColour (juce::ComboBox::backgroundColourId));
    g.fillRoundedRectangle (r, 4.0f);
    g.setColour (box.isMouseOver (true) ? box.findColour (juce::ComboBox::arrowColourId)
                                        : box.findColour (juce::ComboBox::outlineColourId));
    g.drawRoundedRectangle (r, 4.0f, 1.0f);

    const float arrowSize = (float) height * 0.22f;
    const float cx = (float) width - (float) height * 0.5f, cy = (float) height * 0.5f;
    juce::Path arrow;
    arrow.addTriangle (cx - arrowSize, cy - arrowSize * 0.5f, cx + arrowSize, cy - arrowSize * 0.5f, cx, cy + arrowSize * 0.6f);
    g.setColour (box.findColour (juce::ComboBox::arrowColourId));
    g.fillPath (arrow);
}

juce::Font BassForgeLookAndFeel::getComboBoxFont (juce::ComboBox& box)
{
    return font (std::min (14.0f, (float) box.getHeight() * 0.58f), true);
}

void BassForgeLookAndFeel::positionComboBoxText (juce::ComboBox& box, juce::Label& label)
{
    label.setBounds (6, 0, box.getWidth() - box.getHeight() - 4, box.getHeight());
    label.setFont (getComboBoxFont (box));
}

void BassForgeLookAndFeel::drawPopupMenuBackground (juce::Graphics& g, int width, int height)
{
    g.fillAll (Palette::panel);
    g.setColour (Palette::panelEdge);
    g.drawRect (0, 0, width, height);
}

juce::Font BassForgeLookAndFeel::getPopupMenuFont()
{
    return font (15.0f);
}

juce::Font BassForgeLookAndFeel::getLabelFont (juce::Label& label)
{
    return label.getFont();
}
} // namespace bf::ui
