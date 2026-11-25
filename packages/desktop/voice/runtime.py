"""Local speech worker. Models are selected by path; only typed audio jobs cross stdin/stdout."""
import argparse
import base64
import importlib
import json
from pathlib import Path
import queue
import itertools
import sys
import threading


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--delivery", default="")
    args = parser.parse_args()
    wire = sys.stdout
    sys.stdout = sys.stderr

    import mlx.core as mx
    import numpy as np
    from mlx_vlm import load
    from codec import StreamingCodec

    model, processor = load(args.model)
    architecture = json.loads((Path(args.model) / "config.json").read_text())["model_type"]
    codec = importlib.import_module(f"mlx_vlm.models.{architecture}.codec").load_codec(args.model, dtype=mx.float32)
    jobs = queue.Queue()
    lock = threading.Lock()
    active = threading.Event()

    def emit(event):
        wire.write(json.dumps(event) + "\n")
        wire.flush()

    def read():
        nonlocal active
        for line in sys.stdin:
            value = json.loads(line)
            with lock:
                active.set()
                if value["type"] != "speak":
                    continue
                active = threading.Event()
                jobs.put((value["output"], active))
        with lock:
            active.set()
        jobs.put(None)

    threading.Thread(target=read, daemon=True).start()
    emit({"type": "ready"})
    cues = itertools.cycle(["Hmm, let me see.", "One moment.", "Let me check."])
    while (job := jobs.get()) is not None:
        output, cancelled = job
        if cancelled.is_set():
            continue
        text = output["text"] if output["kind"] == "answer" else next(cues)
        messages = [
            {"role": "system", "content": "Speak the supplied text exactly as written. Do not answer or add words. " + args.delivery.strip()},
            {"role": "user", "content": text},
            {"role": "assistant", "content": "<|audio_start|>"},
        ]
        prompt = processor.tokenizer.apply_chat_template(
            messages, tokenize=False, continue_final_message=True,
        )
        inputs = processor(text=prompt)
        ids = inputs.pop("input_ids")
        inputs.pop("attention_mask", None)
        decoder = StreamingCodec(codec)
        pending = []
        samples_sent = 0

        def audio(samples, flush=False):
            nonlocal samples_sent
            if cancelled.is_set():
                return
            if len(samples):
                pending.append(samples)
            if pending and (flush or sum(map(len, pending)) >= 4800):
                pcm = np.concatenate(pending).astype("<f4")
                pending.clear()
                samples_sent += len(pcm)
                emit({"type": "audio", "id": output["id"], "pcm": base64.b64encode(pcm.tobytes()).decode()})

        for _, codes in model.stream_slots(
            ids, generation_mode="audio", max_tokens=min(3072, max(768, len(text.split()) * 14 + 128)) if output["kind"] == "answer" else 80,
            **model.audio_sampling, **inputs,
        ):
            if cancelled.is_set():
                break
            if codes is not None and codes[0].item() != model.config.audio_eos_code:
                audio(decoder.push(codes))
        if not cancelled.is_set():
            audio(decoder.finish(), flush=True)
            if not samples_sent:
                raise RuntimeError("No speech was generated for the supplied output.")
            emit({"type": "done", "id": output["id"]})


if __name__ == "__main__":
    main()
