"""Opt-in real-model verification. Writes only controlled fixture speech under build/."""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import wave

import numpy as np


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--delivery", default="")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    output = root.parent / "build" / "voice" / "verification"
    output.mkdir(parents=True, exist_ok=True)
    worker = subprocess.Popen(
        [sys.executable, "-u", str(root / "runtime.py"), "--model", args.model, "--delivery", args.delivery],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    try:
        assert json.loads(worker.stdout.readline())["type"] == "ready"
        for job in [
            {"id": "answer", "kind": "answer", "text": "The blue cup is beside the window."},
            {"id": "filler", "kind": "filler"},
        ]:
            worker.stdin.write(json.dumps({"type": "speak", "output": job}) + "\n")
            worker.stdin.flush()
            chunks = []
            while line := worker.stdout.readline():
                event = json.loads(line)
                assert event["id"] == job["id"], event
                assert event["type"] in ["audio", "done"], event
                if event["type"] == "done":
                    break
                chunks.append(np.frombuffer(base64.b64decode(event["pcm"]), dtype="<f4"))
            assert chunks, f"No audio for {job['kind']}"
            pcm = np.concatenate(chunks)
            assert np.isfinite(pcm).all() and np.sqrt(np.mean(pcm ** 2)) > 0.002
            with wave.open(str(output / (job["kind"] + ".wav")), "wb") as audio:
                audio.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
                audio.writeframes((np.clip(pcm, -1, 1) * 32767).astype("<i2").tobytes())
            print(json.dumps({"kind": job["kind"], "seconds": round(len(pcm) / 24000, 2), "transcript_events": 0}), flush=True)
    finally:
        worker.stdin.close()
        worker.wait(timeout=20)
        if worker.returncode:
            raise RuntimeError(f"Speech worker exited {worker.returncode}")


if __name__ == "__main__":
    main()
