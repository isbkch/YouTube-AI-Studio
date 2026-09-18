"""Trusted local acoustic analysis. Input/output JSON; diagnostics on stderr."""
import argparse
import contextlib
import json
import sys
from importlib.metadata import version


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.probe:
        import torch
        import whisperx
        import silero_vad
        print(json.dumps({"whisperx": version("whisperx"), "silero": version("silero-vad"),
                          "torch": torch.__version__, "device": "cpu"}))
        return
    with open(args.input, encoding="utf8") as source:
        request = json.load(source)
    # Some dependencies print during model loading; stdout is never diagnostics.
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import torch
        import whisperx
        from silero_vad import load_silero_vad, get_speech_timestamps
        torch.set_num_threads(4)
        audio = whisperx.load_audio(request["file"])
        duration = len(audio) / 16000
        if request["action"] == "analyze":
            model = load_silero_vad()
            speech = get_speech_timestamps(torch.from_numpy(audio), model, sampling_rate=16000,
                                          return_seconds=True, min_speech_duration_ms=150,
                                          min_silence_duration_ms=250, speech_pad_ms=100)
            result = {"duration": duration, "speech": speech,
                      "clippedFraction": float(np.mean(np.abs(audio) >= 0.999)),
                      "engine": "silero-vad-" + version("silero-vad")}
        elif request["action"] == "align":
            language = request.get("language", "en")
            from whisperx.alignment import DEFAULT_ALIGN_MODELS_TORCH, DEFAULT_ALIGN_MODELS_HF
            model_name = DEFAULT_ALIGN_MODELS_TORCH.get(language) or DEFAULT_ALIGN_MODELS_HF.get(language) or language
            model, metadata = whisperx.load_align_model(language_code=language, device="cpu")
            aligned = whisperx.align(request["segments"], model, metadata, audio, "cpu",
                                     return_char_alignments=False, print_progress=False)
            # WhisperX interpolates unalignable words, but leaves their score absent.
            # Remove those estimates so they cannot become edit or caption evidence.
            for segment in aligned["segments"]:
                for word in segment["words"]:
                    if "score" not in word:
                        word.pop("start", None)
                        word.pop("end", None)
            result = {"segments": aligned["segments"], "engine": "whisperx-" + version("whisperx"),
                      "model": model_name, "duration": duration}
        else:
            raise ValueError("Unsupported acoustic operation")
    with open(args.output, "w", encoding="utf8") as target:
        json.dump(result, target, allow_nan=False)


if __name__ == "__main__":
    main()
