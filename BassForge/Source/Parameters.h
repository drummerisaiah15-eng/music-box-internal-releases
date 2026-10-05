#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

/** Parameter IDs. These are saved in Live sets and presets, so never rename
    one once it has shipped - add new ones instead. */
namespace ParamID
{
    // Input / gate
    inline constexpr auto inputGain     = "in_gain";
    inline constexpr auto gateOn        = "gate_on";
    inline constexpr auto gateThreshold = "gate_thresh";
    inline constexpr auto gateRelease   = "gate_release";

    // Compressor
    inline constexpr auto compOn        = "comp_on";
    inline constexpr auto compThreshold = "comp_thresh";
    inline constexpr auto compRatio     = "comp_ratio";
    inline constexpr auto compAttack    = "comp_attack";
    inline constexpr auto compRelease   = "comp_release";
    inline constexpr auto compMakeup    = "comp_makeup";
    inline constexpr auto compMix       = "comp_mix";

    // Octaver
    inline constexpr auto octOn         = "oct_on";
    inline constexpr auto octSub        = "oct_sub";
    inline constexpr auto octUp         = "oct_up";
    inline constexpr auto octDry        = "oct_dry";
    inline constexpr auto octTone       = "oct_tone";

    // Envelope filter
    inline constexpr auto envOn         = "env_on";
    inline constexpr auto envMode       = "env_mode";
    inline constexpr auto envSens       = "env_sens";
    inline constexpr auto envFreq       = "env_freq";
    inline constexpr auto envRange      = "env_range";
    inline constexpr auto envReso       = "env_reso";
    inline constexpr auto envDecay      = "env_decay";
    inline constexpr auto envMix        = "env_mix";

    // Drive
    inline constexpr auto driveOn       = "drv_on";
    inline constexpr auto driveType     = "drv_type";
    inline constexpr auto driveAmount   = "drv_amount";
    inline constexpr auto driveTone     = "drv_tone";
    inline constexpr auto driveXover    = "drv_xover";
    inline constexpr auto driveBlend    = "drv_blend";
    inline constexpr auto driveLow      = "drv_low";
    inline constexpr auto driveLevel    = "drv_level";

    // EQ
    inline constexpr auto eqOn          = "eq_on";
    inline constexpr auto eqLowCut      = "eq_lowcut";
    inline constexpr auto eqBass        = "eq_bass";
    inline constexpr auto eqLowMid      = "eq_lmid";
    inline constexpr auto eqLowMidFreq  = "eq_lmid_freq";
    inline constexpr auto eqHighMid     = "eq_hmid";
    inline constexpr auto eqHighMidFreq = "eq_hmid_freq";
    inline constexpr auto eqTreble      = "eq_treble";
    inline constexpr auto eqHighCut     = "eq_highcut";

    // Cabinet
    inline constexpr auto cabOn         = "cab_on";
    inline constexpr auto cabType       = "cab_type";
    inline constexpr auto cabMix        = "cab_mix";

    // Chorus
    inline constexpr auto chorusOn      = "cho_on";
    inline constexpr auto chorusRate    = "cho_rate";
    inline constexpr auto chorusDepth   = "cho_depth";
    inline constexpr auto chorusLevel   = "cho_level";
    inline constexpr auto chorusXover   = "cho_xover";

    // Output
    inline constexpr auto limiterOn     = "lim_on";
    inline constexpr auto limiterCeiling= "lim_ceiling";
    inline constexpr auto outputGain    = "out_gain";
    inline constexpr auto mix           = "mix";
}

namespace Choices
{
    inline const juce::StringArray envModes   { "Low Pass", "Band Pass", "High Pass" };
    inline const juce::StringArray driveTypes { "Tube", "Overdrive", "Distortion", "Fuzz", "Fold" };
    inline const juce::StringArray cabTypes   { "1x15 Vintage", "4x10 Modern", "8x10 Classic", "2x12 Tight" };
}

juce::AudioProcessorValueTreeState::ParameterLayout createParameterLayout();
