#include "PluginEditor.h"
#include "Presets.h"
#include "gui/Widgets.h"

using namespace bf::ui;

//==============================================================================
/** Everything inside the window, laid out at the base size. The editor scales
    this component with a transform, so resizing stays crisp. */
class BassForgeEditor::Content final : public juce::Component
{
public:
    explicit Content (BassForgeProcessor& p) : processor (p), state (p.getState())
    {
        using namespace ParamID;

        // --- header
        for (const auto& preset : getFactoryPresets())
            presetBox.addItem (preset.name, presetBox.getNumItems() + 1);
        presetBox.setSelectedItemIndex (processor.getCurrentPresetIndex(), juce::dontSendNotification);
        presetBox.setTitle ("Preset");
        presetBox.onChange = [this] { processor.loadFactoryPreset (presetBox.getSelectedItemIndex()); };
        addAndMakeVisible (presetBox);

        prevPreset.setButtonText ("<");
        nextPreset.setButtonText (">");
        prevPreset.setTooltip ("Previous preset");
        nextPreset.setTooltip ("Next preset");
        prevPreset.onClick = [this] { stepPreset (-1); };
        nextPreset.onClick = [this] { stepPreset (1); };
        addAndMakeVisible (prevPreset);
        addAndMakeVisible (nextPreset);
        addAndMakeVisible (tuner);

        // --- row 1
        auto& gate = addSection ("Gate", Accent::gate, gateOn);
        gate.addControl (knob (gateThreshold, "Thresh", Accent::gate));
        gate.addControl (knob (gateRelease, "Release", Accent::gate));

        auto& comp = addSection ("Compressor", Accent::comp, compOn);
        comp.addControl (knob (compThreshold, "Thresh", Accent::comp));
        comp.addControl (knob (compRatio, "Ratio", Accent::comp));
        comp.addControl (knob (compAttack, "Attack", Accent::comp));
        comp.addControl (knob (compRelease, "Release", Accent::comp));
        comp.addControl (knob (compMakeup, "Makeup", Accent::comp));
        comp.addControl (knob (compMix, "Mix", Accent::comp));
        auto gr = std::make_unique<Meter> ("GR", Meter::Mode::reduction, Accent::comp);
        compMeter = gr.get();
        comp.addControl (std::move (gr), 0.42f);

        auto& oct = addSection ("Octaver", Accent::octave, octOn);
        oct.addControl (knob (octSub, "Sub", Accent::octave));
        oct.addControl (knob (octUp, "Up", Accent::octave));
        oct.addControl (knob (octDry, "Dry", Accent::octave));
        oct.addControl (knob (octTone, "Tone", Accent::octave));

        // --- row 2
        auto& env = addSection ("Envelope Filter", Accent::envelope, envOn, envMode);
        env.addControl (knob (envSens, "Sens", Accent::envelope));
        env.addControl (knob (envFreq, "Freq", Accent::envelope));
        env.addControl (knob (envRange, "Range", Accent::envelope));
        env.addControl (knob (envReso, "Reso", Accent::envelope));
        env.addControl (knob (envDecay, "Decay", Accent::envelope));
        env.addControl (knob (envMix, "Mix", Accent::envelope));

        auto& drv = addSection ("Drive", Accent::drive, driveOn, driveType);
        drv.addControl (knob (driveAmount, "Drive", Accent::drive));
        drv.addControl (knob (driveTone, "Tone", Accent::drive));
        drv.addControl (knob (driveXover, "X-Over", Accent::drive));
        drv.addControl (knob (driveBlend, "Blend", Accent::drive));
        drv.addControl (knob (driveLow, "Low", Accent::drive, true));
        drv.addControl (knob (driveLevel, "Level", Accent::drive, true));

        // --- row 3
        auto& eq = addSection ("EQ", Accent::eq, eqOn);
        eq.addControl (knob (eqLowCut, "Low Cut", Accent::eq));
        eq.addControl (knob (eqBass, "Bass", Accent::eq, true));
        eq.addControl (knob (eqLowMid, "Lo Mid", Accent::eq, true));
        eq.addControl (knob (eqLowMidFreq, "Lo Freq", Accent::eq));
        eq.addControl (knob (eqHighMid, "Hi Mid", Accent::eq, true));
        eq.addControl (knob (eqHighMidFreq, "Hi Freq", Accent::eq));
        eq.addControl (knob (eqTreble, "Treble", Accent::eq, true));
        eq.addControl (knob (eqHighCut, "High Cut", Accent::eq));

        auto& cab = addSection ("Cab", Accent::cab, cabOn, cabType);
        cab.addControl (knob (cabMix, "Mix", Accent::cab), 2.7f);

        auto& cho = addSection ("Chorus", Accent::chorus, chorusOn);
        cho.addControl (knob (chorusRate, "Rate", Accent::chorus));
        cho.addControl (knob (chorusDepth, "Depth", Accent::chorus));
        cho.addControl (knob (chorusLevel, "Level", Accent::chorus));
        cho.addControl (knob (chorusXover, "X-Over", Accent::chorus));

        rows = { { sections[0].get(), sections[1].get(), sections[2].get() },
                 { sections[3].get(), sections[4].get() },
                 { sections[5].get(), sections[6].get(), sections[7].get() } };

        // --- I/O column
        io = std::make_unique<Section> (state, "Output", Accent::output);
        addAndMakeVisible (*io);
        for (auto [id, name, bipolar] : { std::tuple { inputGain, "Input", true }, std::tuple { outputGain, "Output", true },
                                          std::tuple { mix, "Mix", false }, std::tuple { limiterCeiling, "Ceiling", false } })
        {
            ioKnobs.push_back (knob (id, name, Accent::output, bipolar));
            addAndMakeVisible (*ioKnobs.back());
        }

        limiterSwitch.setButtonText ("LIMITER");
        limiterSwitch.setColour (juce::ToggleButton::tickColourId, Accent::output);
        limiterSwitch.setTooltip ("Look-ahead brickwall limiter at the very end of the chain");
        addAndMakeVisible (limiterSwitch);
        limiterAttachment = std::make_unique<APVTS::ButtonAttachment> (state, limiterOn, limiterSwitch);

        addAndMakeVisible (inMeter);
        addAndMakeVisible (outMeter);
        addAndMakeVisible (limMeter);

        history.reserve (historySize * 2);
    }

    void tick()
    {
        auto& meters = processor.getMeters();
        inMeter.push (meters.inputPeak.exchange (0.0f));
        outMeter.push (meters.outputPeak.exchange (0.0f));
        limMeter.push (meters.limiterReductionDb.exchange (0.0f));
        compMeter->push (meters.compReductionDb.exchange (0.0f));

        for (auto& s : sections)
            s->refresh();

        const int preset = processor.getCurrentPresetIndex();
        if (preset != presetBox.getSelectedItemIndex())
            presetBox.setSelectedItemIndex (preset, juce::dontSendNotification);

        updateTuner();
    }

    void paint (juce::Graphics& g) override
    {
        g.fillAll (Palette::background);

        auto header = getLocalBounds().removeFromTop (headerHeight).toFloat();
        g.setColour (Palette::header);
        g.fillRect (header);
        g.setColour (Palette::panelEdge);
        g.fillRect (header.removeFromBottom (1.0f));

        // wordmark
        g.setFont (font (30.0f, true));
        g.setColour (Palette::text);
        g.drawText ("BASS", 20, 8, 80, 36, juce::Justification::centredLeft, false);
        g.setColour (Accent::drive);
        g.drawText ("FORGE", 95, 8, 110, 36, juce::Justification::centredLeft, false);
        g.setColour (Palette::dimText);
        g.setFont (font (11.0f, true));
        g.drawText ("ALL-IN-ONE BASS EFFECTS", 21, 40, 220, 14, juce::Justification::centredLeft, false);

        g.setFont (font (11.0f, true));
        g.drawText ("PRESET", prevPreset.getX() - 70, prevPreset.getY(), 62, prevPreset.getHeight(),
                    juce::Justification::centredRight, false);
    }

    void resized() override
    {
        constexpr int margin = 10, gap = 10, ioWidth = 168;

        // header
        const int cy = headerHeight / 2;
        prevPreset.setBounds (400, cy - 15, 30, 30);
        presetBox.setBounds (434, cy - 15, 250, 30);
        nextPreset.setBounds (688, cy - 15, 30, 30);
        tuner.setBounds (getWidth() - margin - 360, cy - 22, 360, 44);

        // module rows
        auto body = getLocalBounds().withTrimmedTop (headerHeight + margin).reduced (margin, 0)
                                    .withTrimmedBottom (margin);
        auto ioArea = body.removeFromRight (ioWidth);
        body.removeFromRight (gap);

        const int rowHeight = (body.getHeight() - gap * ((int) rows.size() - 1)) / (int) rows.size();

        for (auto& row : rows)
        {
            auto rowArea = body.removeFromTop (rowHeight);
            body.removeFromTop (gap);

            float totalWeight = 0.0f;
            for (auto* s : row)
                totalWeight += s->getPreferredWeight() + sectionPadding;

            const int available = rowArea.getWidth() - gap * ((int) row.size() - 1);
            for (size_t i = 0; i < row.size(); ++i)
            {
                const bool last = i + 1 == row.size();
                const int w = last ? rowArea.getWidth()
                                   : juce::roundToInt ((float) available * (row[i]->getPreferredWeight() + sectionPadding)
                                                       / totalWeight);
                row[i]->setBounds (rowArea.removeFromLeft (w));
                rowArea.removeFromLeft (gap);
            }
        }

        // I/O column: 2x2 knobs, limiter switch, meters
        io->setBounds (ioArea);
        auto inner = ioArea.withTrimmedTop (Section::titleHeight).reduced (8, 8);
        const int knobH = 108, knobW = inner.getWidth() / 2;

        for (int i = 0; i < (int) ioKnobs.size(); ++i)
            ioKnobs[(size_t) i]->setBounds (inner.getX() + (i % 2) * knobW, inner.getY() + (i / 2) * knobH, knobW, knobH);

        inner.removeFromTop (knobH * 2 + 6);
        limiterSwitch.setBounds (inner.removeFromTop (26).reduced (14, 0));
        inner.removeFromTop (10);

        const int meterW = 22, meterGap = 14;
        auto meters = inner.withSizeKeepingCentre (meterW * 3 + meterGap * 2, inner.getHeight());
        inMeter.setBounds (meters.removeFromLeft (meterW));
        meters.removeFromLeft (meterGap);
        outMeter.setBounds (meters.removeFromLeft (meterW));
        meters.removeFromLeft (meterGap);
        limMeter.setBounds (meters.removeFromLeft (meterW));
    }

private:
    static constexpr int headerHeight = 64;
    static constexpr float sectionPadding = 0.35f;
    static constexpr int historySize = 2048;

    Section& addSection (const juce::String& title, juce::Colour accent, const char* powerID,
                         const char* choiceID = nullptr)
    {
        sections.push_back (std::make_unique<Section> (state, title, accent, powerID,
                                                       choiceID != nullptr ? juce::String (choiceID) : juce::String()));
        addAndMakeVisible (*sections.back());
        return *sections.back();
    }

    std::unique_ptr<Knob> knob (const char* id, const juce::String& name, juce::Colour accent, bool bipolar = false)
    {
        return std::make_unique<Knob> (state, id, name, accent, bipolar);
    }

    void stepPreset (int delta)
    {
        const int n = presetBox.getNumItems();
        presetBox.setSelectedItemIndex ((presetBox.getSelectedItemIndex() + delta + n) % n, juce::sendNotificationSync);
    }

    void updateTuner()
    {
        auto& feed = processor.getTunerFeed();
        feed.pull (history);
        if ((int) history.size() > historySize)
            history.erase (history.begin(), history.end() - historySize);

        if (++tunerTick % 3 != 0 || (int) history.size() < historySize)
            return;

        const auto hz = detector.detect (history.data(), (int) history.size(), feed.getRate());

        if (hz.has_value())
        {
            // Median of the last three readings hides the odd octave slip.
            recent[(size_t) (recentIndex++ % (int) recent.size())] = *hz;
            missed = 0;

            auto sorted = recent;
            std::sort (sorted.begin(), sorted.end());
            const int valid = (int) std::count_if (sorted.begin(), sorted.end(), [] (float f) { return f > 0.0f; });
            tuner.setPitch (sorted[(size_t) (3 - valid + (valid - 1) / 2)]);
        }
        else if (++missed > 4)
        {
            recent.fill (0.0f);
            tuner.setPitch (std::nullopt);
        }
    }

    BassForgeProcessor& processor;
    APVTS& state;

    juce::ComboBox presetBox;
    juce::TextButton prevPreset, nextPreset;
    TunerDisplay tuner;

    std::vector<std::unique_ptr<Section>> sections;
    std::vector<std::vector<Section*>> rows;
    Meter* compMeter = nullptr;

    std::unique_ptr<Section> io;
    std::vector<std::unique_ptr<Knob>> ioKnobs;
    juce::ToggleButton limiterSwitch;
    std::unique_ptr<APVTS::ButtonAttachment> limiterAttachment;
    Meter inMeter { "IN", Meter::Mode::level, Accent::output },
          outMeter { "OUT", Meter::Mode::level, Accent::output },
          limMeter { "LIM", Meter::Mode::reduction, Accent::output };

    std::vector<float> history;
    bf::PitchDetector detector;
    std::array<float, 3> recent {};
    int recentIndex = 0, tunerTick = 0, missed = 0;
};

//==============================================================================
BassForgeEditor::BassForgeEditor (BassForgeProcessor& p)
    : AudioProcessorEditor (p), bassForge (p)
{
    setLookAndFeel (&lookAndFeel);
    content = std::make_unique<Content> (p);
    addAndMakeVisible (*content);

    setResizable (true, true);
    setResizeLimits (baseWidth * 6 / 10, baseHeight * 6 / 10, baseWidth * 2, baseHeight * 2);
    getConstrainer()->setFixedAspectRatio ((double) baseWidth / (double) baseHeight);
    setSize (baseWidth, baseHeight);

    startTimerHz (30);
}

BassForgeEditor::~BassForgeEditor()
{
    stopTimer();
    setLookAndFeel (nullptr);
}

void BassForgeEditor::paint (juce::Graphics& g)
{
    g.fillAll (Palette::background);
}

void BassForgeEditor::resized()
{
    content->setBounds (0, 0, baseWidth, baseHeight);
    content->setTransform (juce::AffineTransform::scale ((float) getWidth() / (float) baseWidth));
}

void BassForgeEditor::timerCallback()
{
    content->tick();
}
