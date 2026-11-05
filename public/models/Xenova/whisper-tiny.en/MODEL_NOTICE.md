# Whisper tiny.en model assets

These files are pinned copies of:

- Model: `Xenova/whisper-tiny.en`
- Revision: `79fb389fc764e7c395bd330e9531d9d32ada7049`
- Source: https://huggingface.co/Xenova/whisper-tiny.en/tree/79fb389fc764e7c395bd330e9531d9d32ada7049
- Base model: `openai/whisper-tiny.en`
- License: Apache-2.0 (as declared by the model repository)

AutoClipper serves these files from this origin so browser model loading does
not depend on a third-party CDN. The application uses:

- `onnx/encoder_model_quantized.onnx` and `onnx/decoder_model_merged_quantized.onnx` for WASM
- `onnx/encoder_model_fp16.onnx` and `onnx/decoder_model_merged_q4.onnx` for WebGPU

Transformers.js 3.8.1 performs preprocessing, tokenization, and inference.
