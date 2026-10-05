#include "PluginProcessor.h"
#include "PluginEditor.h"
#include "Presets.h"

namespace
{
const juce::Identifier presetProperty { "factoryPreset" };

void storeMax (std::atomic<float>& target, float value) noexcept
{
    auto current = target.load (std::memory_order_relaxed);
    while (value > current && ! target.compare_exchange_weak (current, value, std::memory_order_relaxed)) {}
}
} // namespace

//==============================================================================
/** Raw parameter values, looked up once so the audio thread never searches. */
struct BassForgeProcessor::ParameterPointers
{
    explicit ParameterPointers (juce::AudioProcessorValueTreeState& s)
    {
        auto get = [&s] (const char* id)
        {
            auto* p = s.getRawParameterValue (id);
            jassert (p != nullptr);
            return p;
        };

        using namespace ParamID;
        inGain = get (ParamID::inputGain);
        gOn = get (gateOn); gThresh = get (gateThreshold); gRelease = get (gateRelease);
        cOn = get (compOn); cThresh = get (compThreshold); cRatio = get (compRatio); cAttack = get (compAttack);
        cRelease = get (compRelease); cMakeup = get (compMakeup); cMix = get (compMix);
        oOn = get (octOn); oSub = get (octSub); oUp = get (octUp); oDry = get (octDry); oTone = get (octTone);
        eOn = get (envOn); eMode = get (envMode); eSens = get (envSens); eFreq = get (envFreq);
        eRange = get (envRange); eReso = get (envReso); eDecay = get (envDecay); eMix = get (envMix);
        dOn = get (driveOn); dType = get (driveType); dAmount = get (driveAmount); dTone = get (driveTone);
        dXover = get (driveXover); dBlend = get (driveBlend); dLow = get (driveLow); dLevel = get (driveLevel);
        qOn = get (eqOn); qLowCut = get (eqLowCut); qBass = get (eqBass); qLowMid = get (eqLowMid);
        qLowMidFreq = get (eqLowMidFreq); qHighMid = get (eqHighMid); qHighMidFreq = get (eqHighMidFreq);
        qTreble = get (eqTreble); qHighCut = get (eqHighCut);
        kOn = get (cabOn); kType = get (cabType); kMix = get (cabMix);
        hOn = get (chorusOn); hRate = get (chorusRate); hDepth = get (chorusDepth); hLevel = get (chorusLevel);
        hXover = get (chorusXover);
        lOn = get (limiterOn); lCeiling = get (limiterCeiling); outGain = get (ParamID::outputGain); dryWet = get (ParamID::mix);
    }

    static float v (const std::atomic<float>* p) noexcept   { return p->load (std::memory_order_relaxed); }
    static bool on (const std::atomic<float>* p) noexcept   { return v (p) >= 0.5f; }
    static int idx (const std::atomic<float>* p) noexcept   { return juce::roundToInt (v (p)); }

    std::atomic<float> *inGain, *gOn, *gThresh, *gRelease,
                       *cOn, *cThresh, *cRatio, *cAttack, *cRelease, *cMakeup, *cMix,
                       *oOn, *oSub, *oUp, *oDry, *oTone,
                       *eOn, *eMode, *eSens, *eFreq, *eRange, *eReso, *eDecay, *eMix,
                       *dOn, *dType, *dAmount, *dTone, *dXover, *dBlend, *dLow, *dLevel,
                       *qOn, *qLowCut, *qBass, *qLowMid, *qLowMidFreq, *qHighMid, *qHighMidFreq, *qTreble, *qHighCut,
                       *kOn, *kType, *kMix,
                       *hOn, *hRate, *hDepth, *hLevel, *hXover,
                       *lOn, *lCeiling, *outGain, *dryWet;
};

//==============================================================================
BassForgeProcessor::BassForgeProcessor()
    : AudioProcessor (BusesProperties()
                          .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      state (*this, nullptr, "BassForge", createParameterLayout()),
      params (std::make_unique<ParameterPointers> (state))
{
}

BassForgeProcessor::~BassForgeProcessor() = default;

bool BassForgeProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto in  = layouts.getMainInputChannelSet();
    const auto out = layouts.getMainOutputChannelSet();
    const auto mono = juce::AudioChannelSet::mono(), stereo = juce::AudioChannelSet::stereo();

    if (out != mono && out != stereo)
        return false;

    // mono -> mono, mono -> stereo (the chorus widens) and stereo -> stereo
    return in == mono || (in == stereo && out == stereo);
}

//==============================================================================
void BassForgeProcessor::prepareToPlay (double sampleRate, int)
{
    const int numChannels = bf::maxChannels;

    gate.prepare (sampleRate);
    compressor.prepare (sampleRate);
    octaver.prepare (sampleRate);
    envFilter.prepare (sampleRate);
    drive.prepare (sampleRate, chunkSize, numChannels);
    eq.prepare (sampleRate);
    cab.prepare (sampleRate);
    chorus.prepare (sampleRate);
    limiter.prepare (sampleRate);
    tunerFeed.prepare (sampleRate);

    for (auto* f : { &gateFade, &compFade, &octFade, &envFade, &eqFade, &cabFade, &chorusFade })
        f->prepare (sampleRate);

    inputGain.prepare (sampleRate, 20.0f);
    outputGain.prepare (sampleRate, 20.0f);
    mix.prepare (sampleRate, 20.0f);

    dryDelayLength = drive.getLatencySamples();
    dryDelaySize = dryDelayLength + 1;
    dryDelay.assign ((size_t) (dryDelaySize * numChannels), 0.0f);
    dryWritePos = 0;

    const int latency = dryDelayLength + limiter.getLatencySamples();
    bypassDelaySize = latency + 1;
    bypassDelay.assign ((size_t) (bypassDelaySize * numChannels), 0.0f);
    bypassWritePos = 0;
    setLatencySamples (latency);

    // Start every smoother and switch at its current setting, then clear state.
    readParameters (true);
    resetDsp();
}

void BassForgeProcessor::resetDsp() noexcept
{
    gate.reset();
    compressor.reset();
    octaver.reset();
    envFilter.reset();
    drive.reset();
    eq.reset();
    cab.reset();
    chorus.reset();
    limiter.reset();
    std::fill (dryDelay.begin(), dryDelay.end(), 0.0f);
    std::fill (bypassDelay.begin(), bypassDelay.end(), 0.0f);
}

void BassForgeProcessor::readParameters (bool snap)
{
    using P = ParameterPointers;
    const auto& p = *params;

    auto setFade = [snap] (bf::ModuleFade& fade, bool on)
    {
        fade.setEnabled (on);
        if (snap)
            fade.snap (on);
    };

    inputGain.setTarget (bf::dbToGain (P::v (p.inGain)));
    outputGain.setTarget (bf::dbToGain (P::v (p.outGain)));
    mix.setTarget (P::v (p.dryWet));

    setFade (gateFade, P::on (p.gOn));
    gate.setParameters (P::v (p.gThresh), P::v (p.gRelease));

    setFade (compFade, P::on (p.cOn));
    compressor.setParameters (P::v (p.cThresh), P::v (p.cRatio), P::v (p.cAttack), P::v (p.cRelease),
                              P::v (p.cMakeup), P::v (p.cMix));

    setFade (octFade, P::on (p.oOn));
    octaver.setParameters (P::v (p.oSub), P::v (p.oUp), P::v (p.oDry), P::v (p.oTone));

    setFade (envFade, P::on (p.eOn));
    envFilter.setParameters (P::v (p.eSens), P::v (p.eFreq), P::v (p.eRange), P::v (p.eReso),
                             P::v (p.eDecay), P::idx (p.eMode), P::v (p.eMix));

    drive.setParameters (P::on (p.dOn), P::idx (p.dType), P::v (p.dAmount), P::v (p.dTone), P::v (p.dXover),
                         P::v (p.dBlend), P::v (p.dLow), P::v (p.dLevel));
    if (snap)
        drive.snapEnabled (P::on (p.dOn));

    setFade (eqFade, P::on (p.qOn));
    eq.setParameters (P::v (p.qLowCut), P::v (p.qBass), P::v (p.qLowMid), P::v (p.qLowMidFreq),
                      P::v (p.qHighMid), P::v (p.qHighMidFreq), P::v (p.qTreble), P::v (p.qHighCut));

    setFade (cabFade, P::on (p.kOn));
    cab.setParameters (P::idx (p.kType), P::v (p.kMix));

    setFade (chorusFade, P::on (p.hOn));
    chorus.setParameters (P::v (p.hRate), P::v (p.hDepth), P::v (p.hLevel), P::v (p.hXover));

    limiter.setParameters (P::on (p.lOn), P::v (p.lCeiling));
    if (snap)
    {
        limiter.snapEnabled (P::on (p.lOn));
        inputGain.snapToTarget();
        outputGain.snapToTarget();
        mix.snapToTarget();
    }
}

//==============================================================================
template <typename Module>
void BassForgeProcessor::runModule (bf::ModuleFade& fade, Module& module, float* const* ch,
                                    int numChannels, int numSamples)
{
    fade.advance (numSamples);

    if (fade.isSilent())
        return;

    if (fade.justWokeUp())
        module.reset();

    if (fade.isFullyOn())
    {
        module.process (ch, numChannels, numSamples);
        return;
    }

    for (int c = 0; c < numChannels; ++c)
        std::copy (ch[c], ch[c] + numSamples, scratch[(size_t) c].begin());

    module.process (ch, numChannels, numSamples);

    for (int c = 0; c < numChannels; ++c)
        for (int i = 0; i < numSamples; ++i)
        {
            const float dry = scratch[(size_t) c][(size_t) i];
            ch[c][i] = dry + fade.at (i, numSamples) * (ch[c][i] - dry);
        }
}

void BassForgeProcessor::processChunk (float* const* ch, int numChannels, int numSamples)
{
    // --- input gain, metering, tuner feed and the dry copy for the global mix
    inputGain.advance (numSamples);
    float inPeak = 0.0f;

    for (int i = 0; i < numSamples; ++i)
    {
        const float g = inputGain.at (i, numSamples);
        float sum = 0.0f;

        for (int c = 0; c < numChannels; ++c)
        {
            ch[c][i] *= g;
            inPeak = std::max (inPeak, std::abs (ch[c][i]));
            sum += ch[c][i];

            float* line = dryDelay.data() + (size_t) (c * dryDelaySize);
            line[dryWritePos] = ch[c][i];
            dryScratch[(size_t) c][(size_t) i] = line[(dryWritePos + 1) % dryDelaySize];
        }

        monoScratch[(size_t) i] = sum / (float) numChannels;
        dryWritePos = (dryWritePos + 1) % dryDelaySize;
    }

    storeMax (meters.inputPeak, inPeak);
    tunerFeed.push (monoScratch.data(), numSamples);

    // --- the effects chain
    runModule (gateFade, gate, ch, numChannels, numSamples);
    runModule (compFade, compressor, ch, numChannels, numSamples);
    runModule (octFade, octaver, ch, numChannels, numSamples);
    runModule (envFade, envFilter, ch, numChannels, numSamples);
    drive.process (ch, numChannels, numSamples);   // always runs: it carries the oversampling latency
    runModule (eqFade, eq, ch, numChannels, numSamples);
    runModule (cabFade, cab, ch, numChannels, numSamples);
    runModule (chorusFade, chorus, ch, numChannels, numSamples);

    // --- dry/wet, output gain, limiter
    mix.advance (numSamples);
    outputGain.advance (numSamples);
    const bool fullyWet = ! mix.isMoving() && mix.end() >= 1.0f;

    for (int c = 0; c < numChannels; ++c)
        for (int i = 0; i < numSamples; ++i)
        {
            float y = ch[c][i];
            if (! fullyWet)
            {
                const float dry = dryScratch[(size_t) c][(size_t) i];
                y = dry + mix.at (i, numSamples) * (y - dry);
            }
            ch[c][i] = y * outputGain.at (i, numSamples);
        }

    limiter.process (ch, numChannels, numSamples);

    float outPeak = 0.0f;
    for (int c = 0; c < numChannels; ++c)
        for (int i = 0; i < numSamples; ++i)
            outPeak = std::max (outPeak, std::abs (ch[c][i]));
    storeMax (meters.outputPeak, outPeak);
}

void BassForgeProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;

    const int numIn = getTotalNumInputChannels();
    const int numOut = getTotalNumOutputChannels();
    const int numSamples = buffer.getNumSamples();

    if (numIn == 1)
        for (int c = 1; c < numOut; ++c)
            buffer.copyFrom (c, 0, buffer, 0, 0, numSamples);
    else
        for (int c = numIn; c < numOut; ++c)
            buffer.clear (c, 0, numSamples);

    const int numChannels = std::min (numOut, bf::maxChannels);
    if (numChannels == 0 || numSamples == 0)
        return;

    readParameters (false);

    for (int start = 0; start < numSamples; start += chunkSize)
    {
        const int n = std::min (chunkSize, numSamples - start);
        std::array<float*, bf::maxChannels> ch {};
        for (int c = 0; c < numChannels; ++c)
            ch[(size_t) c] = buffer.getWritePointer (c, start);

        processChunk (ch.data(), numChannels, n);
    }

    // A filter blowing up must never reach the speakers: if anything went
    // non-finite, mute this block and start the chain from a clean state.
    bool finite = true;
    for (int c = 0; c < numChannels && finite; ++c)
    {
        const float* x = buffer.getReadPointer (c);
        for (int i = 0; i < numSamples; ++i)
            if (! std::isfinite (x[i])) { finite = false; break; }
    }

    if (! finite)
    {
        buffer.clear();
        resetDsp();
    }

    storeMax (meters.compReductionDb, compFade.isSilent() ? 0.0f : compressor.popMaxReductionDb());
    storeMax (meters.limiterReductionDb, limiter.popMaxReductionDb());
}

void BassForgeProcessor::processBlockBypassed (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    // Keep the same latency while bypassed so the track stays in time.
    const int numIn = getTotalNumInputChannels();
    const int numOut = getTotalNumOutputChannels();
    const int numSamples = buffer.getNumSamples();

    if (numIn == 1)
        for (int c = 1; c < numOut; ++c)
            buffer.copyFrom (c, 0, buffer, 0, 0, numSamples);
    else
        for (int c = numIn; c < numOut; ++c)
            buffer.clear (c, 0, numSamples);

    const int numChannels = std::min (numOut, bf::maxChannels);
    if (bypassDelay.empty())
        return;

    for (int i = 0; i < numSamples; ++i)
    {
        for (int c = 0; c < numChannels; ++c)
        {
            float* line = bypassDelay.data() + (size_t) (c * bypassDelaySize);
            float* x = buffer.getWritePointer (c);
            line[bypassWritePos] = x[i];
            x[i] = line[(bypassWritePos + 1) % bypassDelaySize];
        }
        bypassWritePos = (bypassWritePos + 1) % bypassDelaySize;
    }
}

//==============================================================================
void BassForgeProcessor::loadFactoryPreset (int index)
{
    const auto& presets = getFactoryPresets();
    if (! juce::isPositiveAndBelow (index, (int) presets.size()))
        return;

    applyFactoryPreset (state, presets[(size_t) index]);
    state.state.setProperty (presetProperty, index, nullptr);
}

int BassForgeProcessor::getCurrentPresetIndex() const
{
    return state.state.getProperty (presetProperty, 0);
}

void BassForgeProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    if (auto xml = state.copyState().createXml())
        copyXmlToBinary (*xml, destData);
}

void BassForgeProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    if (auto xml = getXmlFromBinary (data, sizeInBytes))
        if (xml->hasTagName (state.state.getType()))
            state.replaceState (juce::ValueTree::fromXml (*xml));
}

juce::AudioProcessorEditor* BassForgeProcessor::createEditor()
{
    return new BassForgeEditor (*this);
}

//==============================================================================
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new BassForgeProcessor();
}
