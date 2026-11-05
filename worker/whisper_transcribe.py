#!/usr/bin/env python3
"""Local transcription helper for AutoClipper.

Runs faster-whisper on the machine that owns the worker: no API key, no paid
service, no network after the model is cached.

    python whisper_transcribe.py --audio clip.mp3 --model base \
        --device cpu --compute-type int8 --ffmpeg /path/to/ffmpeg \
        --output /tmp/out.json

Audio is decoded with the project's own FFmpeg into 16 kHz mono float32 and
passed to the model as an array. That keeps PyAV (and its copy of FFmpeg) out of
the audio path entirely, so container/codec support matches the rest of the app.

Success: JSON written to --output, exit 0.
Failure: JSON {"error": {"code": ..., "message": ...}} on stderr, exit 2.
"""

import argparse
import json
import os
import subprocess
import sys

# Rough resident-memory needs for int8 CPU inference, in MiB. Used to fail with a
# useful message instead of being OOM-killed by the kernel.
MODEL_MEMORY_MB = {
    "tiny": 900,
    "tiny.en": 900,
    "base": 1300,
    "base.en": 1300,
    "small": 2200,
    "small.en": 2200,
    "medium": 4500,
    "medium.en": 4500,
    "large": 9000,
    "large-v1": 9000,
    "large-v2": 9000,
    "large-v3": 9000,
    "large-v3-turbo": 6000,
}

MIN_HEADROOM_MB = 300


class HelperError(Exception):
    def __init__(self, code: str, message: str, hint: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint


def fail(error: HelperError) -> None:
    payload = {"error": {"code": error.code, "message": error.message}}
    if error.hint:
        payload["error"]["hint"] = error.hint
    sys.stderr.write(json.dumps(payload) + "\n")
    sys.exit(2)


def available_memory_mb() -> int | None:
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        return None
    return None


def required_memory_mb(model_name: str) -> int:
    key = model_name.lower()
    if key in MODEL_MEMORY_MB:
        return MODEL_MEMORY_MB[key]
    for prefix, value in MODEL_MEMORY_MB.items():
        if key.startswith(prefix):
            return value
    return 2200


def decode_audio(audio_path: str, ffmpeg: str):
    import numpy as np

    command = [
        ffmpeg,
        "-nostdin",
        "-v",
        "error",
        "-i",
        audio_path,
        "-f",
        "f32le",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-",
    ]
    try:
        result = subprocess.run(command, capture_output=True, check=False)
    except FileNotFoundError as error:
        raise HelperError(
            "FFMPEG_MISSING",
            f"FFmpeg could not be executed: {ffmpeg}",
            "Set FFMPEG_PATH to a working ffmpeg binary.",
        ) from error
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or ["unknown error"]
        raise HelperError(
            "DECODE_FAILED",
            f"FFmpeg could not decode {os.path.basename(audio_path)}: {detail[0][:200]}",
        )
    audio = np.frombuffer(result.stdout, dtype=np.float32)
    if audio.size == 0:
        raise HelperError("DECODE_EMPTY", "Decoded audio was empty; the file has no usable audio track.")
    return audio


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe audio locally with faster-whisper")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", default="base")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default="")
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--model-dir", default="")
    parser.add_argument("--threads", type=int, default=0)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    try:
        import numpy  # noqa: F401  (checked here so the error message is actionable)
    except ImportError as error:
        raise HelperError(
            "MISSING_DEPENDENCY",
            "numpy is not installed in the transcription environment.",
            "Run `npm run setup:whisper` to rebuild .venv-whisper.",
        ) from error

    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise HelperError(
            "MISSING_DEPENDENCY",
            "faster-whisper is not installed in the transcription environment.",
            "Run `npm run setup:whisper` (creates .venv-whisper) or point WHISPER_PYTHON at a Python with faster-whisper installed.",
        ) from error

    needed = required_memory_mb(args.model)
    free = available_memory_mb()
    if free is not None and free + MIN_HEADROOM_MB < needed:
        raise HelperError(
            "INSUFFICIENT_MEMORY",
            f"Not enough memory for the '{args.model}' model: {free} MiB free, about {needed} MiB needed.",
            "Use a smaller WHISPER_MODEL (tiny or base), free memory on the host, or move the worker to a machine with more RAM.",
        )

    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            download_root=args.model_dir or None,
            cpu_threads=args.threads or 0,
        )
    except MemoryError as error:
        raise HelperError(
            "INSUFFICIENT_MEMORY",
            f"The '{args.model}' model could not fit in memory.",
            "Use a smaller WHISPER_MODEL, or give the worker more RAM.",
        ) from error
    except Exception as error:  # model download / unsupported model name
        raise HelperError(
            "MODEL_LOAD_FAILED",
            f"Could not load the '{args.model}' model: {str(error)[:300]}",
            "The first run downloads the model from Hugging Face, which needs network access once. Check WHISPER_MODEL and WHISPER_MODEL_DIR.",
        ) from error

    audio = decode_audio(args.audio, args.ffmpeg)

    try:
        segments, info = model.transcribe(
            audio,
            language=args.language or None,
            word_timestamps=True,
            vad_filter=True,
            beam_size=5,
            condition_on_previous_text=False,
        )
        collected = []
        for segment in segments:
            words = [
                {
                    "word": word.word,
                    "start": float(word.start),
                    "end": float(word.end),
                }
                for word in (segment.words or [])
            ]
            collected.append(
                {
                    "start": float(segment.start),
                    "end": float(segment.end),
                    "text": segment.text.strip(),
                    "words": words,
                }
            )
    except MemoryError as error:
        raise HelperError(
            "INSUFFICIENT_MEMORY",
            "Ran out of memory while transcribing.",
            "Use a smaller WHISPER_MODEL or a host with more RAM.",
        ) from error
    except Exception as error:
        raise HelperError("TRANSCRIPTION_FAILED", f"faster-whisper failed: {str(error)[:300]}") from error

    payload = {
        "language": getattr(info, "language", None),
        "languageProbability": float(getattr(info, "language_probability", 0.0) or 0.0),
        "durationSeconds": float(getattr(info, "duration", len(audio) / 16000) or 0.0),
        "segments": collected,
    }
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    sys.stdout.write(
        f"transcribed {len(collected)} segments in {payload['durationSeconds']:.1f}s of audio\n"
    )


if __name__ == "__main__":
    try:
        main()
    except HelperError as error:
        fail(error)
    except Exception as error:  # pragma: no cover - defensive
        fail(HelperError("HELPER_FAILED", f"Transcription helper crashed: {str(error)[:300]}"))
