# BassForge: build description and verification brief

This brief is for an independent reviewer who is checking the BassForge
plug-in. It covers what was built, how to build it, what I verified and how,
and where a second pair of eyes is most useful. Every claim below can be
reproduced with the commands given.

- Repository: `drummerisaiah15-eng/music-box-internal-releases`
- Branch: `bassforge-plugin`
- Location: everything is in `BassForge/`, plus the CI workflow at
  `.github/workflows/bassforge.yml`. Nothing outside those paths was changed.
  The rest of the repository is an unrelated Electron app, and its release
  packaging only picks up named files, so this folder doesn't affect it.

## 1. What it is

BassForge is an all-in-one bass effects plug-in for Ableton Live 12, written in
C++20 on JUCE 9.0.3.

- **Formats:** VST3, AU (macOS only) and a standalone app.
- **Platforms:** macOS 11+ as universal arm64 + x86_64 binaries, and Windows
  10+ x64. It also builds on Linux, which is used for development and tests
  only, since Live doesn't run there.
- **Identity:**
  - Company "The Music Box", bundle ID `com.themusicbox.bassforge`
  - Manufacturer code `TMbx`, plug-in code `Bfrg`
  - AU type `aufx`
  - VST3 categories `Fx Distortion Dynamics EQ`
- **Bus layouts:** mono→mono, mono→stereo and stereo→stereo. The default is
  stereo→stereo; stereo→mono is rejected.

### Signal chain (fixed order)

```
Input gain → Gate → Compressor → Octaver → Envelope Filter → Drive → EQ → Cab → Chorus
  → Dry/Wet mix (dry path latency-compensated) → Output gain → Look-ahead limiter
```

| Module | Implementation (file) |
| --- | --- |
| Gate | Stereo-linked peak detector, open/close hysteresis of 6 dB, 25 ms hold, release from the Release control (`dsp/Dynamics.h`) |
| Compressor | Feed-forward, stereo-linked. A short peak-hold detector feeds a 6 dB soft-knee gain computer with smooth-branching attack/release in the log domain. Makeup gain and parallel mix (`dsp/Dynamics.h`) |
| Octaver | Sub: 4th-order low-pass tracking filter, Schmitt trigger and flip-flop, scaled by the envelope, then a 4th-order "Tone" low-pass. Up: full-wave rectifier on a band-limited copy, then a DC blocker. Tracks the mono sum and adds the result to every channel (`dsp/Octaver.h`) |
| Envelope Filter | TPT state-variable filter with its coefficients updated every sample. The cutoff is Freq × 2^(Range·5 oct·amount), where amount maps the envelope level in dB over a 30 dB window whose start is set by Sens (−30 to −60 dBFS) (`dsp/EnvelopeFilter.h`) |
| Drive | Runs at 4x (2x at 88.2/96k, 1x at 176.4k and up) with JUCE FIR equiripple oversampling. A Linkwitz-Riley crossover splits off the band above X-Over, and only that band is shaped. Five shapers, each with first-order ADAA (antiderivative anti-aliasing), then a DC blocker, Tone low-pass and Blend. The low band passes through clean (`dsp/Drive.h`) |
| EQ | Six Simper SVF stages: HPF, low shelf at 90 Hz, two sweepable bells (Q 0.9), high shelf at 4 kHz, LPF (`dsp/Tone.h`) |
| Cab | A fixed seven-stage SVF voicing per cabinet type (4 types), blended against the DI (`dsp/Tone.h`) |
| Chorus | LR4 crossover. Only the high band is chorused, through a Hermite-interpolated modulated delay (7 ms ± 3.5 ms). Right-channel LFO is +90°. The wet path waits out a warm-up after a reset (`dsp/Chorus.h`) |
| Limiter | 1 ms look-ahead. A sliding-window minimum of the required gain (monotonic deque) feeds release smoothing, then a box filter of the same window length. This guarantees the output never exceeds the ceiling, and there is a final clamp when the limiter is fully on (`dsp/Dynamics.h`) |
| Tuner | The audio thread anti-alias filters and decimates the input to about 12 kHz into a lock-free `AbstractFifo`. The message thread runs YIN over 25–500 Hz with parabolic interpolation, then takes the median of the last three readings (`dsp/Tuner.h`, `PluginEditor.cpp`) |

### Processor design decisions (`PluginProcessor.cpp`)

- **Chunked processing.** `processBlock` works in chunks of at most 32
  samples. Parameters are read once per host block and smoothed per chunk:
  gains ramp linearly within a chunk, and filter coefficients refresh once per
  chunk. Automation is therefore smooth but not sample-accurate.
- **Click-free module switches.** Each module switch goes through a
  `ModuleFade` (15 ms linear crossfade). When a module is fully off it is
  skipped, and when it wakes up its state is reset.
- **Fixed latency** = Drive oversampling latency + limiter look-ahead,
  regardless of which modules are on:

  | Sample rate | Latency |
  | --- | --- |
  | 44.1 kHz | 104 samples |
  | 48 kHz | 108 samples |
  | 96 kHz | 145 samples |
  | 192 kHz | 192 samples |

  JUCE's own integer-latency mode uses a Thiran fractional-delay filter, which
  is only phase-accurate at low frequencies (I measured a −28 dB null residual
  at 5 kHz). Instead, the oversampler runs without it, and an integer delay
  of `(ceil(L) − L) × factor` samples at the oversampled rate makes the
  latency whole exactly (`Drive::prepare`). This assumes the FIR stages'
  latency is a multiple of 1/factor base samples. A `jassert` checks that
  assumption in debug builds, and the latency tests confirm it at all four
  rates.
- **Mix alignment.** The global dry path is delayed by the Drive latency, so
  Mix 0–100% never comb-filters.
- **Host bypass.** `processBlockBypassed` delays the audio by the full
  latency, so host bypass stays in time.
- **NaN guard.** If any output sample is non-finite, the block is muted and
  all DSP state is reset without allocating.
- **Presets.** The 15 factory presets live in the editor's preset menu, and
  `getNumPrograms()` returns 1. This is deliberate: some hosts re-send a
  program change while restoring a session, which would overwrite the user's
  tweaks. The last preset index is stored as a property of the APVTS state
  tree.
- **State.** The APVTS `ValueTree` is stored as XML in binary. All 53
  parameter IDs carry version hint 1. Corrupt state is ignored.
- **Threading:**
  - The audio thread only reads cached `std::atomic<float>*` parameter
    pointers. These are looked up once in the `ParameterPointers` constructor.
  - Meters are atomics: the audio thread updates them with a CAS max, and the
    GUI reads them with `exchange(0)`.
  - The tuner uses an SPSC FIFO.
  - Presets are applied on the message thread with
    `setValueNotifyingHost` inside change gestures, so the host sees each
    change.

### Editor (`PluginEditor.cpp`, `gui/`)

- **Size and scaling.** The layout is drawn at a fixed base size of 1220×566
  and scaled with an `AffineTransform`. The window is resizable from 60% to
  200% with a fixed aspect ratio.
- **Controls.** Every knob is bound with a `SliderAttachment`. Double-click
  resets a knob, and double-clicking the value label lets you type a value.
  Power switches and choice menus use `ButtonAttachment` and
  `ComboBoxAttachment`.
- **Timer.** A 30 Hz timer drives the meters, dims sections that are switched
  off, keeps the preset menu in sync, and runs the tuner.

## 2. How to build

Requirements:

- CMake 3.22 or newer.
- macOS: Xcode, or the Command Line Tools.
- Windows: Visual Studio 2022 with the C++ workload.
- Linux: GCC 13 or Clang, plus `libasound2-dev libx11-dev libxrandr-dev
  libxinerama-dev libxcursor-dev libxi-dev libfreetype-dev libfontconfig1-dev
  libgl1-mesa-dev`.
- JUCE 9.0.3 is fetched by CMake `FetchContent` (a shallow git clone of the
  `9.0.3` tag). To use a local checkout instead, pass
  `-DFETCHCONTENT_SOURCE_DIR_JUCE=/path/to/JUCE`.

```sh
cd BassForge
cmake -B build -DCMAKE_BUILD_TYPE=Release            # add -G Ninja if available
cmake --build build --config Release --parallel      # all targets
ctest --test-dir build -C Release --output-on-failure
```

Targets:

| Target | Output (under `build/BassForge_artefacts/Release/`) |
| --- | --- |
| `BassForge_VST3` | `VST3/BassForge.vst3` |
| `BassForge_AU` (macOS) | `AU/BassForge.component` |
| `BassForge_Standalone` | `Standalone/BassForge(.app/.exe)` |
| `BassForgeTests` | `build/BassForgeTests_artefacts/Release/BassForgeTests` |

Options:

- `BASSFORGE_COPY_AFTER_BUILD` is ON by default on macOS (it installs into
  `~/Library/Audio/Plug-Ins`) and OFF elsewhere.
- `BASSFORGE_BUILD_TESTS` is ON by default.
- `CMAKE_OSX_ARCHITECTURES` defaults to `arm64;x86_64`.
- `CMAKE_OSX_DEPLOYMENT_TARGET` defaults to `11.0`.

Compile definitions: `JUCE_WEB_BROWSER=0`, `JUCE_USE_CURL=0`,
`JUCE_VST3_CAN_REPLACE_VST2=0`. Builds use JUCE's recommended config, LTO and
warning flags.

The test runner compiles the same `Source/*.cpp` files into a console app.
It does not use any `JucePlugin_*` macros, so the processor builds outside the
plug-in wrapper.

### CI (`.github/workflows/bassforge.yml`)

The workflow runs on pushes and pull requests that touch `BassForge/**` or the
workflow file, and can also be started manually. It has two jobs:

- **macOS (universal):** builds the VST3, AU, Standalone and tests, then runs
  `ctest` and `auval -v aufx Bfrg TMbx`. It ad-hoc codesigns the bundles,
  zips them with `ditto`, and uploads the zips plus editor screenshots.
- **Windows:** builds the VST3, Standalone and tests, runs `ctest`, then zips
  and uploads the results.

## 3. What I verified, and the results

I did all of the following on Linux x86_64 (Ubuntu 24.04, GCC 13.3) with JUCE
9.0.3.

1. **Build.** The test runner, VST3 and Standalone compile with **zero
   warnings** under JUCE's recommended warning flags, which include
   `-Wfloat-equal`, `-Wshadow`, `-Wsign-conversion` and others.
2. **Test runner (`BassForgeTests`): 145 checks, all passing.**
   - **Latency:** an impulse's measured delay equals the reported latency at
     44.1, 48, 96 and 192 kHz.
   - **Null tests** with all modules off:
     - Mix 0 is an exact delay (−300 dB residual).
     - Mix 100% and Mix 50% leave −66 to −75 dB residual at 44.1/48 kHz.
       This is the FIR passband ripple; 192 kHz is exact.
   - **Module behaviour:**
     - Compressor reduces a −3 dBFS tone by 24 dB at −30 dB threshold and
       10:1, and the GR meter agrees.
     - Gate attenuates −60 dBFS hiss by 62 dB.
     - Octaver: 110 Hz in gives 55 Hz at −2.4 dB, with 110 Hz at −37 dB.
       The octave-up voice is present at 220 Hz.
     - Envelope filter opens on loud input (11th harmonic −51 → −18 dB).
     - Drive THD is 34% at 70% drive. All five drive types stay within
       +3 dB of the input level at 100% drive.
     - A 50 Hz tone below a 400 Hz crossover stays clean (THD 0.00%).
     - **Aliasing:** a hard-clipped 2.7 kHz tone shows −56.7 dB of
       non-harmonic energy. This was −31.6 dB before ADAA; 8x oversampling
       alone only reached −41.4 dB.
     - EQ: +12 dB bass shelf measures +11.1 dB at 40 Hz.
     - Limiter: +12 dB into a −6 dB ceiling peaks at −6.0 dB.
     - Chorus turns mono into stereo, and 45 Hz below its crossover stays
       mono.
   - **Switching clicks:** toggling each module mid-note never produces a
     sample-to-sample step bigger than 1.5× the steady-state maximum + 0.01.
   - **Presets:** all 15 come out between −3.8 and −2.9 dB relative to the
     input (level-matched to the Clean DI preset), stay finite, and stay
     under the ceiling.
   - **State:** save → restore round-trips all 53 parameters and the preset
     index, and corrupt data is ignored.
   - **Tuner:** 30.87–392 Hz with a strong 2nd harmonic is read within
     1.2 cents at 44.1, 48 and 96 kHz. Silence reads as no note.
   - **Stress:** every module on, extreme settings, choice parameters cycled
     while running, at 44.1, 48, 96 and 192 kHz × block sizes 1, 31, 64, 480
     and 2048. The output is always finite and at or below the −0.3 dB
     ceiling.
   - **CPU:** with every module on at 48 kHz stereo, it uses about 4.3% of
     one core in the test container (about 23x realtime).
   - **Screenshots:** the editor renders to PNG for three presets.
3. **pluginval v1.0.4** (built from source) at `--strictness-level 10
   --validate-in-process` on the Linux VST3 under Xvfb: **SUCCESS**. 23 of
   its 25 test groups did real work; the "auval" group is macOS-only, and the
   "vst3 validator" group printed "Skipping vst3 validator as validator path
   hasn't been set". The groups that ran include:
   - state restoration
   - automation
   - parameter fuzzing
   - parameter thread safety
   - background-thread state
   - opening the editor while processing
   - bus enable/disable
4. **CI on macOS and Windows:** see the workflow runs on the
   `bassforge-plugin` branch. The handoff message records the result of the
   first run.

What I could **not** do from a Linux container: load the plug-in in Ableton
Live, listen to it, or run `auval` locally. CI covers `auval`; the Live and
listening checks are in section 4.

## 4. Verification checklist

### A. Reproduce the automated results

1. Do a clean build on macOS (the commands are in section 2). Expect no
   errors. On macOS, also expect the VST3 and AU to be copied into
   `~/Library/Audio/Plug-Ins`.
2. Run `ctest --test-dir build -C Release --output-on-failure`. Expect
   `All checks passed.` and exit code 0. The PNGs are written to
   `build/screenshots/`.
3. Run `auval -v aufx Bfrg TMbx`. Expect `AU VALIDATION SUCCEEDED`.
4. Run pluginval on the VST3 and the AU:
   `pluginval --strictness-level 10 --validate <path to .vst3 or .component>`.
   Expect `SUCCESS`.

### B. Check the plug-in in Ableton Live 12

1. **Scan.** Open **Settings → Plug-Ins**, rescan, and check that BassForge
   appears under **The Music Box** for both the AU and the VST3.
2. **Insert.** Put it on a mono audio track and on a stereo track. Both
   should pass audio. On the mono track, the chorus should widen the sound.
3. **Delay compensation.** Duplicate the track, put BassForge with all
   modules off on one copy, and flip the phase of the other with Utility.
   They should cancel to roughly −60 dB or better at 44.1/48 kHz, which shows
   Live is compensating the reported latency.
4. **Presets.** Step through every preset. Loudness should stay roughly
   constant.
5. **Automation.** Automate a few knobs and the module power switches. There
   should be no clicks.
6. **Save and reload.** Tweak some knobs, save the set, close it and reopen
   it. All settings and the preset name should be restored.
7. **Window.** Resize the editor, reopen it, and check that the tuner reads
   an open E (41.2 Hz) and A (55 Hz).

### C. Code review: where a second opinion is most useful

1. **Real-time safety.** Check that nothing on the audio thread allocates,
   locks or does I/O. Look at `processBlock`, `processChunk`,
   `readParameters`, every `dsp/*` `process()`, and `TunerFeed::push`.
   Potential concerns:
   - JUCE `Oversampling::processSamplesUp/Down` after `initProcessing`.
   - `EnvelopeFollower::setTimes`, which calls `exp` once per block.
2. **Drive latency alignment** (`Drive::prepare`). Is the assumption that the
   FIR latency's fractional part is a multiple of 1/factor sound for every
   factor JUCE 9.0.3 builds here? Release builds have no runtime fallback if
   it isn't.
3. **ADAA antiderivatives** (`Drive::antiderivative`). Check that F′ equals
   `shape` and F(0) = 0 for all five types. Also check the precision of the
   ill-conditioned fallback (|dx| < 1e-6) and the antiderivative cache that
   is invalidated when the type changes.
4. **Limiter guarantee** (`Limiter::process`). The claim is that a sliding
   minimum over L+1 samples, release smoothing that only rises, and a box
   average over L+1 samples guarantee gain ≤ required gain at the delayed
   sample. Check the delay and box indexing and the drift-recompute logic.
5. **SVF formulas** (`Svf::set`). Check them against Simper's
   SvfLinearTrapOptimised2 for each of the six response types.
6. **Thread safety of preset state.** `getCurrentPresetIndex()` and
   `loadFactoryPreset()` touch `state.state` on the message thread, while
   hosts may call `getStateInformation()` from another thread. JUCE's
   `copyState()` takes a lock; confirm this is safe.
7. **Mono→stereo.** In `processBlock`, channel 0 is copied into the other
   output channels before processing. Check this in every supported layout.
8. **ModuleFade edge cases.** Rapid on/off toggling within one 15 ms ramp,
   and the moment `justWokeUp()` triggers a reset.

### D. Known limitations

These are deliberate, not oversights:

- **Choice switches are instant.** Changing the drive type, envelope mode or
  cab type takes effect immediately, without a crossfade. Automating them
  mid-note can click slightly. The power switches do crossfade.
- **Octaver is monophonic** by design, like an OC-2, so chords glitch.
- **Factory presets are not host programs** (`getNumPrograms() == 1`); see
  section 1. Users save their own sounds with Live's device presets.
- **Automation resolution.** Parameters update per 32-sample chunk with
  smoothing, not per sample.
- **Bypass state.** After host bypass ends, module state resumes from where
  it was before bypass rather than being reset.
- **Unsigned builds.** CI builds are ad-hoc signed and not notarised, so
  macOS quarantines downloaded copies. The README gives the `xattr` command
  to unblock them.
- **Tuner only runs while the editor is open.** It does its analysis on the
  message thread.
