cmake_minimum_required(VERSION 3.22)

# Universal (Apple Silicon + Intel) macOS binaries by default. Both settings
# must be made before project(); pass -D to override either.
set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING "macOS architectures to build")
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Minimum macOS version")

project(BassForge VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# ---------------------------------------------------------------------------
# JUCE. Downloaded automatically; to use a local checkout instead, configure
# with -DFETCHCONTENT_SOURCE_DIR_JUCE=/path/to/JUCE
include(FetchContent)
FetchContent_Declare(JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        9.0.3
    GIT_SHALLOW    TRUE)
FetchContent_MakeAvailable(JUCE)

# ---------------------------------------------------------------------------
# Copy the built plug-ins into the system plug-in folders so Live finds them.
# On by default on macOS (user folders, no admin needed). On Windows the VST3
# folder needs an elevated prompt, so it is off by default there.
if(APPLE)
    set(_copy_default ON)
else()
    set(_copy_default OFF)
endif()
option(BASSFORGE_COPY_AFTER_BUILD "Install plug-ins into the system plug-in folders after building" ${_copy_default})

set(BASSFORGE_FORMATS VST3 Standalone)
if(APPLE)
    list(APPEND BASSFORGE_FORMATS AU)
endif()

juce_add_plugin(BassForge
    COMPANY_NAME                   "The Music Box"
    COMPANY_WEBSITE                ""
    BUNDLE_ID                      com.themusicbox.bassforge
    PLUGIN_MANUFACTURER_CODE       TMbx
    PLUGIN_CODE                    Bfrg
    FORMATS                        ${BASSFORGE_FORMATS}
    PRODUCT_NAME                   "BassForge"
    DESCRIPTION                    "All-in-one bass effects"
    IS_SYNTH                       FALSE
    NEEDS_MIDI_INPUT               FALSE
    NEEDS_MIDI_OUTPUT              FALSE
    IS_MIDI_EFFECT                 FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS    FALSE
    VST3_CATEGORIES                Fx Distortion Dynamics EQ
    AU_MAIN_TYPE                   kAudioUnitType_Effect
    MICROPHONE_PERMISSION_ENABLED  TRUE
    MICROPHONE_PERMISSION_TEXT     "BassForge's standalone app needs audio input to process your bass."
    COPY_PLUGIN_AFTER_BUILD        ${BASSFORGE_COPY_AFTER_BUILD}
    NEEDS_WEB_BROWSER              FALSE
    NEEDS_CURL                     FALSE)

set(BASSFORGE_SOURCES
    Source/Parameters.cpp
    Source/Presets.cpp
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp
    Source/gui/Theme.cpp
    Source/gui/Widgets.cpp)

set(BASSFORGE_DEFINITIONS
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0)

target_sources(BassForge PRIVATE ${BASSFORGE_SOURCES})
target_compile_definitions(BassForge PUBLIC ${BASSFORGE_DEFINITIONS})
target_link_libraries(BassForge
    PRIVATE
        juce::juce_audio_utils
        juce::juce_dsp
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)

# ---------------------------------------------------------------------------
# Headless test runner: DSP checks, latency, presets, state and a screenshot
# of the editor. Run it with:  ctest --test-dir build  (or the binary itself)
option(BASSFORGE_BUILD_TESTS "Build the BassForge test runner" ON)

if(BASSFORGE_BUILD_TESTS)
    juce_add_console_app(BassForgeTests PRODUCT_NAME "BassForgeTests")
    target_sources(BassForgeTests PRIVATE tests/BassForgeTests.cpp ${BASSFORGE_SOURCES})
    target_include_directories(BassForgeTests PRIVATE Source)
    target_compile_definitions(BassForgeTests PRIVATE ${BASSFORGE_DEFINITIONS})
    target_link_libraries(BassForgeTests
        PRIVATE
            juce::juce_audio_utils
            juce::juce_dsp
            juce::juce_recommended_config_flags
            juce::juce_recommended_warning_flags)

    enable_testing()
    add_test(NAME BassForgeTests COMMAND BassForgeTests screenshots)
endif()
